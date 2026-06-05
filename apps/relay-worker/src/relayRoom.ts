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

export class RelayRoom {
  private sockets = new Set<WebSocket>();
  private nextId = 1;

  constructor(private state: DurableObjectState, _env: Env) {}

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);

    // Internal endpoint to check if there are active connections
    if (url.pathname === "/check-connections") {
      return new Response(JSON.stringify(this.sockets.size > 0), {
        headers: { "Content-Type": "application/json" },
      });
    }

    // WebSocket subscribe (Worker routed this DO by the *path* param already)
    if (url.pathname === "/subscribe") {
      const pair = new WebSocketPair();
      const client = (pair as any)[0] as WebSocket;
      const server = (pair as any)[1] as WebSocket;

      server.accept();
      this.sockets.add(server);

      const cleanup = () => {
        this.sockets.delete(server);
      };
      server.addEventListener("close", cleanup);
      server.addEventListener("error", cleanup);

      return new Response(null, { status: 101, webSocket: client });
    }

    // No client listening on this path → 400 (your spec)
    if (this.sockets.size === 0) {
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
    let winner: WebSocket | undefined;
    let resHeaders: Record<string, string> | undefined;
    let resStatus = 200;

    let bodyController: ReadableStreamDefaultController<Uint8Array> | null =
      null;
    const bodyStream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        bodyController = controller;
      },
    });

    // Per-socket message handling
    const socketHandlers = new Map<WebSocket, (e: MessageEvent) => void>();
    const onMessage = (ws: WebSocket, evt: MessageEvent) => {
      try {
        const msg = JSON.parse(
          typeof evt.data === "string" ? evt.data : ""
        ) as RelayFrame & { id: number };
        if (msg.id !== rid) return;

        if (!winner && msg.type === "res") {
          winner = ws;
          resStatus = (msg as ResHeaderFrame).s || 200;
          resHeaders = (msg as ResHeaderFrame).h || {};
          return;
        }

        if (ws === winner && msg.type === "res_body" && bodyController) {
          const b64 = (msg as ResBodyFrame).b64 || "";
          const more = (msg as ResBodyFrame).more;
          const chunk = base64ToBytes(b64);
          if (chunk.length) bodyController.enqueue(chunk);
          if (!more) {
            bodyController.close();
            // cleanup listeners
            for (const sock of this.sockets) {
              const h = socketHandlers.get(sock);
              if (h) sock.removeEventListener("message", h as any);
            }
            socketHandlers.clear();
          }
        }
      } catch {
        // ignore malformed frames
      }
    };

    for (const ws of this.sockets) {
      const handler = onMessage.bind(this, ws) as (e: MessageEvent) => void;
      ws.addEventListener("message", handler);
      socketHandlers.set(ws, handler);
    }

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
    for (const ws of this.sockets) {
      try {
        ws.send(headerJson);
      } catch {}
    }

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
          for (const ws of this.sockets) {
            try {
              ws.send(json);
            } catch {}
          }
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
      for (const ws of this.sockets) {
        try {
          ws.send(endJson);
        } catch {}
      }
    }

    // Wait up to 15s for first response headers
    const headerWait = new Promise<void>((resolve) => {
      const deadline = Date.now() + 15000;
      const tick = () => {
        if (winner && resHeaders) return resolve();
        if (Date.now() >= deadline) return resolve();
        setTimeout(tick, 5);
      };
      tick();
    });
    await headerWait;

    // Timeout -> 504
    if (!winner || !resHeaders) {
      for (const sock of this.sockets) {
        const h = socketHandlers.get(sock);
        if (h) sock.removeEventListener("message", h as any);
      }
      socketHandlers.clear();
      if (bodyController) bodyController.close();
      return new Response("relay timeout", { status: 504 });
    }

    // Stream winner’s response to caller
    const outHeaders = new Headers();
    for (const [k, v] of Object.entries(resHeaders))
      outHeaders.set(k, String(v));
    return new Response(bodyStream, { status: resStatus, headers: outHeaders });
  }
}
