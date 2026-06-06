import { once } from "node:events";
import http, { type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  bytesToBase64,
  type ResBodyFrame,
  type ResHeaderFrame,
} from "../src/protocol.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket, { WebSocketServer } from "ws";
import { RelayClient } from "../src/relayClient.js";

const servers: Array<Server | WebSocketServer> = [];
const clients: RelayClient[] = [];

function noopLogger() {
  return {
    trace: () => {},
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  };
}

function listenHttp(server: Server): Promise<number> {
  servers.push(server);

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve((server.address() as AddressInfo).port);
    });
  });
}

async function createRelayServer(): Promise<{
  relayServer: WebSocketServer;
  relayPort: number;
}> {
  const relayServer = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  servers.push(relayServer);
  await once(relayServer, "listening");

  return {
    relayServer,
    relayPort: (relayServer.address() as AddressInfo).port,
  };
}

function collectResponseFrames(socket: WebSocket): {
  frames: Array<ResHeaderFrame | ResBodyFrame>;
  complete: Promise<void>;
} {
  const frames: Array<ResHeaderFrame | ResBodyFrame> = [];
  const complete = new Promise<void>((resolve) => {
    socket.on("message", (data) => {
      const frame = JSON.parse(String(data)) as ResHeaderFrame | ResBodyFrame;
      frames.push(frame);

      if (frame.type === "res_body" && !frame.more) {
        resolve();
      }
    });
  });

  return { frames, complete };
}

function closeServer(server: Server | WebSocketServer): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
  });
}

async function waitFor(
  predicate: () => boolean,
  message: string
): Promise<void> {
  const startedAt = Date.now();

  while (!predicate()) {
    if (Date.now() - startedAt > 1000) {
      throw new Error(message);
    }

    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

afterEach(async () => {
  for (const client of clients.splice(0)) {
    client.stop();
  }

  await Promise.all(servers.splice(0).map((server) => closeServer(server)));
});

describe("RelayClient", () => {
  it("forwards relay request frames to the configured HTTP target", async () => {
    const targetServer = http.createServer((req, res) => {
      let body = "";
      req.setEncoding("utf8");
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        res.writeHead(202, {
          "Content-Type": "application/json",
          "X-Target": "demo",
          "Set-Cookie": ["a=1", "b=2"],
        });
        res.end(
          JSON.stringify({
            method: req.method,
            url: req.url,
            body,
            header: req.headers["x-test"],
          })
        );
      });
    });
    const targetPort = await listenHttp(targetServer);

    const { relayServer, relayPort } = await createRelayServer();

    const receivedFrames: Array<ResHeaderFrame | ResBodyFrame> = [];
    const complete = new Promise<void>((resolve) => {
      relayServer.once("connection", async (socket) => {
        const collector = collectResponseFrames(socket);
        socket.send(
          JSON.stringify({
            id: 1,
            type: "req",
            m: "POST",
            p: "demo/hit",
            q: "?x=1",
            h: { "x-test": "yes", host: "relay.example" },
          })
        );
        socket.send(
          JSON.stringify({
            id: 1,
            type: "req_body",
            b64: bytesToBase64(Buffer.from("hello")),
            more: true,
          })
        );
        socket.send(
          JSON.stringify({
            id: 1,
            type: "req_body",
            b64: "",
            more: false,
          })
        );

        await collector.complete;
        receivedFrames.push(...collector.frames);
        resolve();
      });
    });

    const client = new RelayClient({
      relayUrl: `ws://127.0.0.1:${relayPort}`,
      targetUrl: `http://127.0.0.1:${targetPort}`,
      reconnectDelayMs: 25,
      timeoutMs: 1000,
      logger: noopLogger(),
    });
    clients.push(client);
    client.start();

    await complete;

    const headerFrame = receivedFrames.find(
      (frame): frame is ResHeaderFrame => frame.type === "res"
    );
    const bodyFrames = receivedFrames.filter(
      (frame): frame is ResBodyFrame => frame.type === "res_body"
    );
    const body = Buffer.concat(
      bodyFrames
        .filter((frame) => frame.b64)
        .map((frame) => Buffer.from(frame.b64, "base64"))
    ).toString("utf8");

    expect(headerFrame?.s).toBe(202);
    expect(headerFrame?.h["x-target"]).toBe("demo");
    expect(headerFrame?.h["set-cookie"]).toBe("a=1, b=2");
    expect(JSON.parse(body)).toMatchObject({
      method: "POST",
      url: "/demo/hit?x=1",
      body: "hello",
      header: "yes",
    });
  });

  it("keeps forwarded double-slash paths on the configured HTTP target origin", async () => {
    const targetServer = http.createServer((req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          host: req.headers.host,
          url: req.url,
        })
      );
    });
    const targetPort = await listenHttp(targetServer);
    const { relayServer, relayPort } = await createRelayServer();

    const receivedFrames: Array<ResHeaderFrame | ResBodyFrame> = [];
    const complete = new Promise<void>((resolve) => {
      relayServer.once("connection", async (socket) => {
        const collector = collectResponseFrames(socket);
        socket.send(
          JSON.stringify({
            id: 5,
            type: "req",
            m: "GET",
            p: "//169.254.169.254/latest",
            q: "?x=1",
            h: { host: "relay.example" },
          })
        );
        socket.send(
          JSON.stringify({
            id: 5,
            type: "req_body",
            b64: "",
            more: false,
          })
        );

        await collector.complete;
        receivedFrames.push(...collector.frames);
        resolve();
      });
    });

    const client = new RelayClient({
      relayUrl: `ws://127.0.0.1:${relayPort}`,
      targetUrl: `http://127.0.0.1:${targetPort}`,
      reconnectDelayMs: 25,
      timeoutMs: 1000,
      logger: noopLogger(),
    });
    clients.push(client);
    client.start();

    await complete;

    const headerFrame = receivedFrames.find(
      (frame): frame is ResHeaderFrame => frame.type === "res"
    );
    const body = Buffer.concat(
      receivedFrames
        .filter((frame): frame is ResBodyFrame => frame.type === "res_body")
        .filter((frame) => frame.b64)
        .map((frame) => Buffer.from(frame.b64, "base64"))
    ).toString("utf8");

    expect(headerFrame?.s).toBe(200);
    expect(JSON.parse(body)).toEqual({
      host: `127.0.0.1:${targetPort}`,
      url: "//169.254.169.254/latest?x=1",
    });
  });

  it("sends a synthetic 502 response when the target is unreachable", async () => {
    const { relayServer, relayPort } = await createRelayServer();
    const unusedTargetPort = 9;

    const receivedFrames: Array<ResHeaderFrame | ResBodyFrame> = [];
    const complete = new Promise<void>((resolve) => {
      relayServer.once("connection", async (socket) => {
        const collector = collectResponseFrames(socket);
        socket.send(
          JSON.stringify({
            id: 2,
            type: "req",
            m: "GET",
            p: "/missing",
            q: "",
            h: {},
          })
        );
        socket.send(
          JSON.stringify({
            id: 2,
            type: "req_body",
            b64: "",
            more: false,
          })
        );

        await collector.complete;
        receivedFrames.push(...collector.frames);
        resolve();
      });
    });

    const client = new RelayClient({
      relayUrl: `ws://127.0.0.1:${relayPort}`,
      targetUrl: `http://127.0.0.1:${unusedTargetPort}`,
      reconnectDelayMs: 25,
      timeoutMs: 100,
      logger: noopLogger(),
    });
    clients.push(client);
    client.start();

    await complete;

    const headerFrame = receivedFrames.find(
      (frame): frame is ResHeaderFrame => frame.type === "res"
    );
    const endFrame = receivedFrames.at(-1);

    expect(headerFrame?.s).toBe(502);
    expect(endFrame?.type).toBe("res_body");
    expect((endFrame as ResBodyFrame).more).toBe(false);
  });

  it("sends a synthetic 504 response when the target times out", async () => {
    const targetServer = http.createServer((_req, _res) => {
      // Keep the socket open so the client-side request timeout fires.
    });
    const targetPort = await listenHttp(targetServer);
    const { relayServer, relayPort } = await createRelayServer();

    const receivedFrames: Array<ResHeaderFrame | ResBodyFrame> = [];
    const complete = new Promise<void>((resolve) => {
      relayServer.once("connection", async (socket) => {
        const collector = collectResponseFrames(socket);
        socket.send(
          JSON.stringify({
            id: 3,
            type: "req",
            m: "GET",
            p: "/slow",
            q: "",
            h: {},
          })
        );
        socket.send(
          JSON.stringify({
            id: 3,
            type: "req_body",
            b64: "",
            more: false,
          })
        );

        await collector.complete;
        receivedFrames.push(...collector.frames);
        resolve();
      });
    });

    const client = new RelayClient({
      relayUrl: `ws://127.0.0.1:${relayPort}`,
      targetUrl: `http://127.0.0.1:${targetPort}`,
      reconnectDelayMs: 25,
      timeoutMs: 20,
      logger: noopLogger(),
    });
    clients.push(client);
    client.start();

    await complete;

    const headerFrame = receivedFrames.find(
      (frame): frame is ResHeaderFrame => frame.type === "res"
    );
    const body = Buffer.concat(
      receivedFrames
        .filter((frame): frame is ResBodyFrame => frame.type === "res_body")
        .filter((frame) => frame.b64)
        .map((frame) => Buffer.from(frame.b64, "base64"))
    ).toString("utf8");

    expect(headerFrame?.s).toBe(504);
    expect(body).toBe("Gateway Timeout\n");
  });

  it("tracks connection status, ignores malformed frames, and schedules reconnects", async () => {
    const { relayServer, relayPort } = await createRelayServer();
    const warn = vi.fn();
    let connectedSocket: WebSocket | undefined;
    const connected = new Promise<void>((resolve) => {
      relayServer.once("connection", (socket) => {
        connectedSocket = socket;
        resolve();
      });
    });

    const client = new RelayClient({
      relayUrl: `ws://127.0.0.1:${relayPort}`,
      targetUrl: "http://127.0.0.1:9",
      reconnectDelayMs: 25,
      logger: { warn },
    });
    clients.push(client);

    client.start();
    client.start();
    await connected;
    await waitFor(
      () => client.getStatus().connected,
      "client did not mark websocket as connected"
    );

    expect(client.getStatus()).toMatchObject({
      connected: true,
      inflight: 0,
      reconnectAttempts: 0,
    });
    expect(client.getStatus().lastConnectedAt).toBeDefined();

    connectedSocket!.send("not-json");
    connectedSocket!.send(JSON.stringify({ id: 1, type: "unknown" }));
    connectedSocket!.send(JSON.stringify({ id: 2, type: "req" }));
    connectedSocket!.send(
      JSON.stringify({ id: 99, type: "req_body", b64: "", more: false })
    );

    await waitFor(
      () => warn.mock.calls.some((call) => call[1] === "ignored malformed relay frame"),
      "malformed relay frame was not logged"
    );

    const reconnected = new Promise<void>((resolve) => {
      relayServer.once("connection", () => resolve());
    });

    connectedSocket!.close(1000, "test close");
    await waitFor(
      () =>
        client.getStatus().lastDisconnectedAt !== undefined &&
        client.getStatus().reconnectAttempts >= 1,
      "client did not record close and schedule reconnect"
    );

    await reconnected;
    await waitFor(
      () => client.getStatus().connected,
      "client did not reconnect"
    );
  });

  it("logs websocket errors", async () => {
    const error = vi.fn();
    const client = new RelayClient({
      relayUrl: "ws://127.0.0.1:9",
      targetUrl: "http://127.0.0.1:9",
      reconnectDelayMs: 1000,
      logger: { error },
    });
    clients.push(client);

    client.start();

    await waitFor(
      () => error.mock.calls.some((call) => call[1] === "websocket error"),
      "websocket error was not logged"
    );

    expect(client.getStatus().connected).toBe(false);
  });

  it("keeps completed target requests inflight until response completion or relay disconnect", async () => {
    const targetServer = http.createServer((req, _res) => {
      req.resume();
    });
    const targetPort = await listenHttp(targetServer);
    const { relayServer, relayPort } = await createRelayServer();
    let relaySocket: WebSocket | undefined;

    const connected = new Promise<void>((resolve) => {
      relayServer.once("connection", (socket) => {
        relaySocket = socket;
        socket.send(
          JSON.stringify({
            id: 4,
            type: "req",
            m: "POST",
            p: "/cleanup",
            q: "",
            h: {},
          })
        );
        socket.send(
          JSON.stringify({
            id: 4,
            type: "req_body",
            b64: "",
            more: false,
          })
        );
        resolve();
      });
    });

    const client = new RelayClient({
      relayUrl: `ws://127.0.0.1:${relayPort}`,
      targetUrl: `http://127.0.0.1:${targetPort}`,
      reconnectDelayMs: 1000,
      timeoutMs: 1000,
      logger: noopLogger(),
    });
    clients.push(client);
    client.start();

    await connected;
    await waitFor(
      () => client.getStatus().inflight === 1,
      "request was not kept inflight after body completion"
    );

    relaySocket!.close(1000, "disconnect");

    await waitFor(
      () =>
        client.getStatus().inflight === 0 &&
        client.getStatus().lastDisconnectedAt !== undefined,
      "inflight request was not cleaned up"
    );
  });
});
