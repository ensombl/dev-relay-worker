import {
  base64ToBytes,
  bytesToBase64,
  type ReqBodyFrame,
  type ReqHeaderFrame,
} from "@ensombl/relay-protocol";
import { SELF } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import handler from "../src/index";
import { RelayRoom } from "../src/relayRoom";

const sockets: WebSocket[] = [];

async function subscribe(room: string, path: string): Promise<WebSocket> {
  const response = await SELF.fetch(
    `https://example.com/subscribe?room=${encodeURIComponent(room)}&path=${encodeURIComponent(path)}`,
    { headers: { Upgrade: "websocket" } }
  );
  expect(response.status).toBe(101);
  expect(response.webSocket).toBeDefined();

  const socket = response.webSocket!;
  socket.accept();
  sockets.push(socket);
  return socket;
}

function nextFrame<T>(socket: WebSocket): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.removeEventListener("message", onMessage);
      reject(new Error("timed out waiting for websocket frame"));
    }, 1000);

    const onMessage = (event: MessageEvent) => {
      clearTimeout(timeout);
      socket.removeEventListener("message", onMessage);
      resolve(JSON.parse(String(event.data)) as T);
    };

    socket.addEventListener("message", onMessage);
  });
}

function expectNoFrame(socket: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.removeEventListener("message", onMessage);
      resolve();
    }, 50);

    const onMessage = (event: MessageEvent) => {
      clearTimeout(timeout);
      socket.removeEventListener("message", onMessage);
      reject(new Error(`unexpected websocket frame: ${String(event.data)}`));
    };

    socket.addEventListener("message", onMessage);
  });
}

function sendResponse(socket: WebSocket, id: number, body: string): void {
  socket.send(
    JSON.stringify({
      id,
      type: "res",
      s: 201,
      h: { "content-type": "text/plain" },
    })
  );
  socket.send(
    JSON.stringify({
      id,
      type: "res_body",
      b64: bytesToBase64(new TextEncoder().encode(body)),
      more: true,
    })
  );
  socket.send(
    JSON.stringify({
      id,
      type: "res_body",
      b64: "",
      more: false,
    })
  );
}

function roomSockets(room: RelayRoom): Set<WebSocket> {
  return (room as unknown as { sockets: Set<WebSocket> }).sockets;
}

function fakeSocket(options: {
  readyState: number;
  send?: (message: string) => void;
}): WebSocket {
  return {
    readyState: options.readyState,
    send: vi.fn(options.send ?? (() => {})),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    close: vi.fn(),
  } as unknown as WebSocket;
}

afterEach(() => {
  for (const socket of sockets.splice(0)) {
    socket.close();
  }
});

describe("relay worker", () => {
  it("rejects subscriptions without a room or path", async () => {
    const missingRoom = await SELF.fetch(
      "https://example.com/subscribe?path=/webhook",
      { headers: { Upgrade: "websocket" } }
    );
    expect(missingRoom.status).toBe(400);
    expect(await missingRoom.text()).toBe("bad room");

    const missingPath = await SELF.fetch(
      "https://example.com/subscribe?room=demo",
      { headers: { Upgrade: "websocket" } }
    );
    expect(missingPath.status).toBe(400);
    expect(await missingPath.text()).toBe("bad path");
  });

  it("rejects invalid and reserved room names", async () => {
    const missingRoom = await SELF.fetch("https://example.com/");
    expect(missingRoom.status).toBe(400);
    expect(await missingRoom.text()).toBe("bad room");

    const invalidRoom = await SELF.fetch(
      "https://example.com/subscribe?room=bad:room&path=/webhook",
      { headers: { Upgrade: "websocket" } }
    );
    expect(invalidRoom.status).toBe(400);
    expect(await invalidRoom.text()).toBe("bad room");

    const reservedRoom = await SELF.fetch("https://example.com/health/webhook");
    expect(reservedRoom.status).toBe(400);
    expect(await reservedRoom.text()).toBe("bad room");
  });

  it("returns 400 when no client is subscribed in the requested room", async () => {
    await subscribe("other", "/webhook");

    const response = await SELF.fetch("https://example.com/demo/webhook");

    expect(response.status).toBe(400);
    expect(await response.text()).toBe("No relay client for path");
  });

  it("does not count retained closed sockets as active connections", async () => {
    const room = new RelayRoom({} as DurableObjectState, {} as Env);
    roomSockets(room).add(fakeSocket({ readyState: 3 }));

    const check = await room.fetch(
      new Request("http://internal/check-connections")
    );
    expect(await check.json()).toBe(false);
    expect(roomSockets(room).size).toBe(0);

    const response = await room.fetch(new Request("http://internal/stale"));
    expect(response.status).toBe(400);
    expect(await response.text()).toBe("No relay client for path");
  });

  it("drops sockets that fail while forwarding a request", async () => {
    vi.useFakeTimers();

    try {
      const room = new RelayRoom({} as DurableObjectState, {} as Env);
      const socket = fakeSocket({
        readyState: 1,
        send: () => {
          throw new Error("dead socket");
        },
      });
      roomSockets(room).add(socket);

      const responsePromise = room.fetch(new Request("http://internal/fails"));

      await vi.advanceTimersByTimeAsync(15000);

      const response = await responsePromise;
      expect(response.status).toBe(504);
      expect(await response.text()).toBe("relay timeout");
      expect(socket.send).toHaveBeenCalled();
      expect(roomSockets(room).size).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("relays exact requests and strips the room prefix", async () => {
    const socket = await subscribe("demo", "/exact");
    const responsePromise = SELF.fetch("https://example.com/demo/exact?x=1", {
      method: "POST",
      headers: { "X-Test": "yes" },
      body: "hello",
    });

    const reqFrame = await nextFrame<ReqHeaderFrame>(socket);
    expect(reqFrame.type).toBe("req");
    expect(reqFrame.m).toBe("POST");
    expect(reqFrame.p).toBe("/exact");
    expect(reqFrame.q).toBe("?x=1");
    expect(reqFrame.h["x-test"]).toBe("yes");

    const bodyFrame = await nextFrame<ReqBodyFrame>(socket);
    expect(new TextDecoder().decode(base64ToBytes(bodyFrame.b64))).toBe(
      "hello"
    );
    expect(bodyFrame.more).toBe(true);

    const endFrame = await nextFrame<ReqBodyFrame>(socket);
    expect(endFrame.more).toBe(false);

    sendResponse(socket, reqFrame.id, "from target");

    const response = await responsePromise;
    expect(response.status).toBe(201);
    expect(await response.text()).toBe("from target");
  });

  it("keeps identical paths isolated across rooms", async () => {
    const alphaSocket = await subscribe("alpha", "/webhook");
    const betaSocket = await subscribe("beta", "/webhook");

    const alphaResponsePromise = SELF.fetch("https://example.com/alpha/webhook");
    const alphaFrame = await nextFrame<ReqHeaderFrame>(alphaSocket);
    expect(alphaFrame.p).toBe("/webhook");
    await nextFrame<ReqBodyFrame>(alphaSocket);
    await expectNoFrame(betaSocket);
    sendResponse(alphaSocket, alphaFrame.id, "alpha ok");

    const alphaResponse = await alphaResponsePromise;
    expect(await alphaResponse.text()).toBe("alpha ok");

    const betaResponsePromise = SELF.fetch("https://example.com/beta/webhook");
    const betaFrame = await nextFrame<ReqHeaderFrame>(betaSocket);
    expect(betaFrame.p).toBe("/webhook");
    await nextFrame<ReqBodyFrame>(betaSocket);
    sendResponse(betaSocket, betaFrame.id, "beta ok");

    const betaResponse = await betaResponsePromise;
    expect(await betaResponse.text()).toBe("beta ok");
  });

  it("routes wildcard subscriptions within a room", async () => {
    const socket = await subscribe("demo", "/webhook/*");
    const responsePromise = SELF.fetch(
      "https://example.com/demo/webhook/anything",
      {
        method: "GET",
      }
    );

    const reqFrame = await nextFrame<ReqHeaderFrame>(socket);
    expect(reqFrame.p).toBe("/webhook/anything");

    const endFrame = await nextFrame<ReqBodyFrame>(socket);
    expect(endFrame.more).toBe(false);

    sendResponse(socket, reqFrame.id, "wildcard ok");

    const response = await responsePromise;
    expect(response.status).toBe(201);
    expect(await response.text()).toBe("wildcard ok");
  });

  it("normalizes subscription paths before routing", async () => {
    const socket = await subscribe("demo", "trailing/");
    const responsePromise = SELF.fetch("https://example.com/demo/trailing/");

    const reqFrame = await nextFrame<ReqHeaderFrame>(socket);
    expect(reqFrame.p).toBe("/trailing");

    const endFrame = await nextFrame<ReqBodyFrame>(socket);
    expect(endFrame.more).toBe(false);

    sendResponse(socket, reqFrame.id, "normalized ok");

    const response = await responsePromise;
    expect(response.status).toBe(201);
    expect(await response.text()).toBe("normalized ok");
  });

  it("returns 504 when a subscribed client does not send response headers", async () => {
    vi.useFakeTimers();

    try {
      const room = new RelayRoom({} as DurableObjectState, {} as Env);
      const socket = fakeSocket({ readyState: 1 });
      roomSockets(room).add(socket);

      const responsePromise = room.fetch(new Request("http://internal/timeout"));
      await vi.advanceTimersByTimeAsync(15000);

      const response = await responsePromise;
      expect(response.status).toBe(504);
      expect(await response.text()).toBe("relay timeout");
      expect(socket.send).toHaveBeenCalledWith(
        expect.stringContaining('"type":"req"')
      );
      expect(socket.send).toHaveBeenCalledWith(
        expect.stringContaining('"type":"req_body"')
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("falls back to the exact path DO when connection checks fail", async () => {
    const checkedIds: string[] = [];
    const fallbackIds: string[] = [];
    const env = {
      RELAY_ROOM: {
        idFromName: (name: string) => name,
        get: (id: string) => ({
          fetch: async (request: Request) => {
            const pathname = new URL(request.url).pathname;

            if (pathname === "/check-connections") {
              checkedIds.push(id);
              throw new Error("connection check failed");
            }

            fallbackIds.push(id);
            return new Response(pathname, { status: 299 });
          },
        }),
      },
    } as unknown as Env;

    const response = await handler.fetch(
      new Request("https://example.com/demo/fallback"),
      env
    );

    expect(response.status).toBe(299);
    expect(await response.text()).toBe("/fallback");
    expect(checkedIds.length).toBeGreaterThan(0);
    expect(fallbackIds).toEqual(["demo:/fallback"]);
  });
});
