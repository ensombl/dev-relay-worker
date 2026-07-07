import {
  WS_CHUNK,
  base64ToBytes,
  bytesToBase64,
  type RelayFrame,
  type ReqBodyFrame,
  type ReqHeaderFrame,
  type ResBodyFrame,
  type ResHeaderFrame,
} from "@ensombl/relay-protocol";

const WS_READY_STATE_OPEN = 1;
const RELAY_TIMEOUT_MS = 15000;

type PendingRelayRequest = {
  sockets: Set<WebSocket>;
  winner?: WebSocket;
  resHeaders?: Record<string, string>;
  resStatus: number;
  bodyController: ReadableStreamDefaultController<Uint8Array> | null;
  resolveHeaders: () => void;
  completed: boolean;
};

export class RelayRoom {
  private nextId = 1;
  private readonly inflight = new Map<number, PendingRelayRequest>();

  constructor(private state: DurableObjectState, _env: Env) {}

  private openSockets(): WebSocket[] {
    return this.state
      .getWebSockets()
      .filter((socket) => socket.readyState === WS_READY_STATE_OPEN);
  }

  private sendToSockets(sockets: WebSocket[], message: string): void {
    for (const socket of sockets) {
      try {
        socket.send(message);
      } catch {
        try {
          socket.close(1011, "relay send failed");
        } catch {
          // Socket is already unusable.
        }
      }
    }
  }

  private completeInflight(id: number): void {
    const pending = this.inflight.get(id);
    if (!pending || pending.completed) return;

    pending.completed = true;
    this.inflight.delete(id);
    if (pending.bodyController) {
      pending.bodyController.close();
    }
  }

  webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): void {
    let frame: RelayFrame & { id: number };

    try {
      const text =
        typeof message === "string" ? message : new TextDecoder().decode(message);
      frame = JSON.parse(text) as RelayFrame & { id: number };
    } catch {
      return;
    }

    const pending = this.inflight.get(frame.id);
    if (!pending || !pending.sockets.has(ws)) return;

    if (!pending.winner && frame.type === "res") {
      pending.winner = ws;
      pending.resStatus = (frame as ResHeaderFrame).s || 200;
      pending.resHeaders = (frame as ResHeaderFrame).h || {};
      pending.resolveHeaders();
      return;
    }

    if (
      ws === pending.winner &&
      frame.type === "res_body" &&
      pending.bodyController
    ) {
      const b64 = (frame as ResBodyFrame).b64 || "";
      const more = (frame as ResBodyFrame).more;
      const chunk = base64ToBytes(b64);
      if (chunk.length) pending.bodyController.enqueue(chunk);
      if (!more) {
        this.completeInflight(frame.id);
      }
    }
  }

  webSocketClose(ws: WebSocket, code: number, reason: string): void {
    try {
      ws.close(code, reason);
    } catch {
      // The runtime may have already closed the connection.
    }
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);

    // Internal endpoint to check if there are active connections
    if (url.pathname === "/check-connections") {
      return new Response(JSON.stringify(this.openSockets().length > 0), {
        headers: { "Content-Type": "application/json" },
      });
    }

    // WebSocket subscribe (Worker routed this DO by the *path* param already)
    if (url.pathname === "/subscribe") {
      const pair = new WebSocketPair();
      const client = (pair as any)[0] as WebSocket;
      const server = (pair as any)[1] as WebSocket;

      this.state.acceptWebSocket(server);

      return new Response(null, { status: 101, webSocket: client });
    }

    // No client listening on this path → 400 (your spec)
    const sockets = this.openSockets();
    if (sockets.length === 0) {
      return new Response("No relay client for path", { status: 400 });
    }

    // Relay the inbound request (first client response wins)
    const rid = this.nextId++;
    const method = req.method;
    const path = url.pathname; // original path
    const query = url.search; // includes leading "?" if present

    // Capture headers 1:1 (lower-cased); client will rewrite only Host/Content-Length
    const headers: Record<string, string> = {};
    for (const [k, v] of req.headers) headers[k.toLowerCase()] = v;

    // Winner state + streaming back to caller
    let bodyController: ReadableStreamDefaultController<Uint8Array> | null =
      null;
    const bodyStream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        bodyController = controller;
      },
    });

    let headerTimeout: ReturnType<typeof setTimeout> | undefined;
    let resolveHeaders: () => void = () => {};
    const headerWait = new Promise<boolean>((resolve) => {
      resolveHeaders = () => {
        if (headerTimeout) clearTimeout(headerTimeout);
        resolve(true);
      };
      headerTimeout = setTimeout(() => resolve(false), RELAY_TIMEOUT_MS);
    });
    const pending: PendingRelayRequest = {
      sockets: new Set(sockets),
      resStatus: 200,
      bodyController,
      resolveHeaders,
      completed: false,
    };
    this.inflight.set(rid, pending);

    // Send request header frame
    const headerFrame: ReqHeaderFrame = {
      id: rid,
      type: "req",
      m: method,
      p: path,
      q: query,
      h: headers,
    };
    const headerJson = JSON.stringify(headerFrame);
    this.sendToSockets(sockets, headerJson);

    // Stream request body to all subscribers in safe-sized WS frames
    if (req.body) {
      const reader = req.body.getReader();
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        let off = 0;
        while (off < value!.length) {
          const slice = value!.subarray(
            off,
            Math.min(off + WS_CHUNK, value!.length)
          );
          const frame: ReqBodyFrame = {
            id: rid,
            type: "req_body",
            b64: bytesToBase64(slice),
            more: true,
          };
          const json = JSON.stringify(frame);
          this.sendToSockets(sockets, json);
          off += slice.length;
        }
      }
    }
    // End-of-body signal
    {
      const endFrame: ReqBodyFrame = {
        id: rid,
        type: "req_body",
        b64: "",
        more: false,
      };
      const endJson = JSON.stringify(endFrame);
      this.sendToSockets(sockets, endJson);
    }

    // Wait up to 15s for first response headers
    await headerWait;

    // Timeout -> 504
    if (!pending.winner || !pending.resHeaders) {
      this.completeInflight(rid);
      return new Response("relay timeout", { status: 504 });
    }

    // Stream winner’s response to caller
    const outHeaders = new Headers();
    for (const [k, v] of Object.entries(pending.resHeaders))
      outHeaders.set(k, String(v));
    return new Response(bodyStream, {
      status: pending.resStatus,
      headers: outHeaders,
    });
  }
}
