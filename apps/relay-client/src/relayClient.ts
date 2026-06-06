import http, {
  type ClientRequest,
  type IncomingHttpHeaders,
  type IncomingMessage,
} from "node:http";
import https from "node:https";
import { URL } from "node:url";
import {
  base64ToBytes,
  bytesToBase64,
  type ReqBodyFrame,
  type ReqHeaderFrame,
  type ResBodyFrame,
  type ResHeaderFrame,
} from "./protocol.js";
import WebSocket, { type RawData } from "ws";

export type RelayLogger = {
  trace: (context: unknown, message?: string) => void;
  debug: (context: unknown, message?: string) => void;
  info: (context: unknown, message?: string) => void;
  warn: (context: unknown, message?: string) => void;
  error: (context: unknown, message?: string) => void;
};

export type RelayClientOptions = {
  relayUrl: string;
  targetUrl: string;
  timeoutMs?: number;
  reconnectDelayMs?: number;
  logger?: Partial<RelayLogger>;
};

export type RelayClientStatus = {
  connected: boolean;
  inflight: number;
  relayUrl: string;
  targetUrl: string;
  reconnectAttempts: number;
  lastConnectedAt?: string;
  lastDisconnectedAt?: string;
};

type InflightRequest = {
  req: ClientRequest;
  wrote: number;
};

type ResponseHandler = (
  status: number,
  headers: Record<string, string>,
  resStream: IncomingMessage | null,
  syntheticBody?: string
) => void;

const noop = () => {};

function createLogger(logger?: Partial<RelayLogger>): RelayLogger {
  const bind = <Method extends keyof RelayLogger>(method: Method) => {
    const log = logger?.[method];
    return log ? log.bind(logger) : noop;
  };

  return {
    trace: bind("trace"),
    debug: bind("debug"),
    info: bind("info"),
    warn: bind("warn"),
    error: bind("error"),
  };
}

function normalizeHeaders(headers: IncomingHttpHeaders): Record<string, string> {
  const normalized: Record<string, string> = {};

  for (const [key, value] of Object.entries(headers)) {
    if (Array.isArray(value)) normalized[key.toLowerCase()] = value.join(", ");
    else if (value !== undefined) normalized[key.toLowerCase()] = String(value);
  }

  return normalized;
}

function isReqHeaderFrame(frame: unknown): frame is ReqHeaderFrame {
  const candidate = frame as Partial<ReqHeaderFrame> | null;
  return (
    typeof frame === "object" &&
    frame !== null &&
    candidate?.type === "req" &&
    typeof candidate.id === "number" &&
    typeof candidate.m === "string" &&
    typeof candidate.p === "string" &&
    typeof candidate.q === "string" &&
    isStringRecord(candidate.h)
  );
}

function isReqBodyFrame(frame: unknown): frame is ReqBodyFrame {
  const candidate = frame as Partial<ReqBodyFrame> | null;
  return (
    typeof frame === "object" &&
    frame !== null &&
    candidate?.type === "req_body" &&
    typeof candidate.id === "number" &&
    typeof candidate.b64 === "string" &&
    typeof candidate.more === "boolean"
  );
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every((entry) => typeof entry === "string")
  );
}

export class RelayClient {
  private readonly timeoutMs: number;
  private readonly reconnectDelayMs: number;
  private readonly logger: RelayLogger;
  private readonly inflight = new Map<number, InflightRequest>();

  private ws: WebSocket | undefined;
  private reconnectTimer: NodeJS.Timeout | undefined;
  private stopped = true;
  private connected = false;
  private reconnectAttempts = 0;
  private lastConnectedAt: string | undefined;
  private lastDisconnectedAt: string | undefined;

  constructor(private readonly options: RelayClientOptions) {
    this.timeoutMs = options.timeoutMs ?? 15000;
    this.reconnectDelayMs = options.reconnectDelayMs ?? 1000;
    this.logger = createLogger(options.logger);
  }

  start(): void {
    if (!this.stopped) return;

    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }

    for (const [id, { req }] of this.inflight.entries()) {
      try {
        req.destroy();
      } catch (error) {
        this.logger.debug({ id, error }, "error destroying inflight request");
      }
    }
    this.inflight.clear();

    if (this.ws && this.ws.readyState < WebSocket.CLOSING) {
      this.ws.close();
    }
    this.ws = undefined;
    this.connected = false;
  }

  getStatus(): RelayClientStatus {
    return {
      connected: this.connected,
      inflight: this.inflight.size,
      relayUrl: this.options.relayUrl,
      targetUrl: this.options.targetUrl,
      reconnectAttempts: this.reconnectAttempts,
      ...(this.lastConnectedAt ? { lastConnectedAt: this.lastConnectedAt } : {}),
      ...(this.lastDisconnectedAt
        ? { lastDisconnectedAt: this.lastDisconnectedAt }
        : {}),
    };
  }

  private connect(): void {
    const ws = new WebSocket(this.options.relayUrl);
    this.ws = ws;

    ws.on("open", () => {
      this.connected = true;
      this.reconnectAttempts = 0;
      this.lastConnectedAt = new Date().toISOString();
      this.logger.info({ url: this.options.relayUrl }, "relay connected");
    });

    ws.on("message", (data) => this.handleMessage(ws, data));

    ws.on("close", (code, reason) => {
      this.connected = false;
      this.lastDisconnectedAt = new Date().toISOString();
      this.logger.warn(
        { code, reason: reason.toString() },
        "relay closed"
      );
      this.cleanupInflight();

      if (!this.stopped) {
        this.scheduleReconnect();
      }
    });

    ws.on("error", (error) => {
      this.logger.error({ error }, "websocket error");
      if (ws.readyState < WebSocket.CLOSING) ws.close();
    });
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;

    this.reconnectAttempts += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      if (!this.stopped) this.connect();
    }, this.reconnectDelayMs);
  }

  private cleanupInflight(): void {
    for (const [id, { req }] of this.inflight.entries()) {
      try {
        req.destroy();
      } catch (error) {
        this.logger.debug({ id, error }, "error destroying inflight request");
      }
    }
    this.inflight.clear();
  }

  private handleMessage(ws: WebSocket, data: RawData): void {
    let frame: unknown;

    try {
      frame = JSON.parse(String(data));
    } catch (error) {
      this.logger.warn({ error }, "ignored malformed relay frame");
      return;
    }

    if (isReqHeaderFrame(frame)) {
      this.handleRequestHeader(ws, frame);
      return;
    }

    if (isReqBodyFrame(frame)) {
      this.handleRequestBody(frame);
    }
  }

  private handleRequestHeader(ws: WebSocket, frame: ReqHeaderFrame): void {
    const req = this.replayToTarget(frame, (status, headers, resStream, body) => {
      this.sendFrame(ws, {
        id: frame.id,
        type: "res",
        s: status,
        h: headers,
      });

      if (body !== undefined) {
        this.sendBody(ws, frame.id, body);
        this.inflight.delete(frame.id);
        return;
      }

      if (!resStream) {
        this.sendBodyEnd(ws, frame.id);
        this.inflight.delete(frame.id);
        return;
      }

      let completed = false;
      const completeResponse = () => {
        if (completed) return;
        completed = true;
        this.sendBodyEnd(ws, frame.id);
        this.inflight.delete(frame.id);
      };

      resStream.on("data", (chunk: Buffer) => {
        this.sendFrame(ws, {
          id: frame.id,
          type: "res_body",
          b64: bytesToBase64(chunk),
          more: true,
        });
      });

      resStream.on("end", () => {
        completeResponse();
      });

      resStream.on("error", (error) => {
        this.logger.error({ id: frame.id, error }, "response stream error");
        completeResponse();
      });
    });

    this.inflight.set(frame.id, { req, wrote: 0 });
    this.logger.debug(
      { id: frame.id, method: frame.m, path: frame.p, query: frame.q },
      "incoming request from relay"
    );
  }

  private handleRequestBody(frame: ReqBodyFrame): void {
    const inflight = this.inflight.get(frame.id);
    if (!inflight) return;

    const bytes = base64ToBytes(frame.b64);
    if (bytes.length) {
      try {
        inflight.req.write(bytes);
        inflight.wrote += bytes.length;
      } catch (error) {
        this.logger.error(
          { id: frame.id, error },
          "failed to write request chunk"
        );
        inflight.req.destroy();
        this.inflight.delete(frame.id);
        return;
      }
    }

    if (!frame.more) {
      try {
        inflight.req.end();
      } catch (error) {
        this.logger.error({ id: frame.id, error }, "failed to end request");
      }
      this.logger.debug(
        { id: frame.id, totalBytes: inflight.wrote },
        "request body complete and forwarded"
      );
    }
  }

  private replayToTarget(frame: ReqHeaderFrame, onHeaders: ResponseHandler) {
    const target = this.resolveTarget(frame);
    const headers: Record<string, string | number | string[]> = {
      ...(frame.h ?? {}),
    };
    delete headers.host;
    delete headers["content-length"];

    const isHttps = target.protocol === "https:";
    const mod = isHttps ? https : http;
    const port = target.port ? Number(target.port) : isHttps ? 443 : 80;
    let responded = false;

    const respondOnce: ResponseHandler = (
      status,
      responseHeaders,
      resStream,
      syntheticBody
    ) => {
      if (responded) return;
      responded = true;
      onHeaders(status, responseHeaders, resStream, syntheticBody);
    };

    const req = mod.request(
      {
        method: frame.m,
        hostname: target.hostname,
        port,
        path: target.pathname + target.search,
        headers,
        timeout: this.timeoutMs,
      },
      (res) => {
        respondOnce(
          res.statusCode || 200,
          normalizeHeaders(res.headers),
          res
        );
      }
    );

    req.on("error", (error) => {
      this.logger.warn(
        { error, target: target.toString() },
        "error proxying to target"
      );
      respondOnce(502, { "content-type": "text/plain" }, null, "Bad Gateway\n");
    });

    req.on("timeout", () => {
      this.logger.warn(
        { target: target.toString(), timeoutMs: this.timeoutMs },
        "target request timeout"
      );
      respondOnce(
        504,
        { "content-type": "text/plain" },
        null,
        "Gateway Timeout\n"
      );
      req.destroy();
    });

    this.logger.debug(
      { method: frame.m, url: target.toString() },
      "forwarding request to target"
    );

    return req;
  }

  private resolveTarget(frame: ReqHeaderFrame): URL {
    const target = new URL(this.options.targetUrl);
    target.pathname = frame.p.startsWith("/") ? frame.p : `/${frame.p}`;
    target.search = frame.q || "";
    target.hash = "";
    return target;
  }

  private sendBody(ws: WebSocket, id: number, body: string): void {
    const bytes = new TextEncoder().encode(body);
    this.sendFrame(ws, {
      id,
      type: "res_body",
      b64: bytesToBase64(bytes),
      more: true,
    });
    this.sendBodyEnd(ws, id);
  }

  private sendBodyEnd(ws: WebSocket, id: number): void {
    this.sendFrame(ws, {
      id,
      type: "res_body",
      b64: "",
      more: false,
    });
  }

  private sendFrame(
    ws: WebSocket,
    frame: ResHeaderFrame | ResBodyFrame
  ): boolean {
    if (ws.readyState !== WebSocket.OPEN) return false;

    try {
      ws.send(JSON.stringify(frame));
      return true;
    } catch (error) {
      this.logger.error({ error }, "failed to send relay frame");
      return false;
    }
  }
}
