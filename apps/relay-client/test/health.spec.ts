import { once } from "node:events";
import type http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startHealthServer } from "../src/health.js";
import type { RelayClientStatus } from "../src/relayClient.js";

const servers: http.Server[] = [];

function baseStatus(connected: boolean): RelayClientStatus {
  return {
    connected,
    inflight: 0,
    relayUrl: "ws://relay.test/subscribe?room=demo&path=%2Fwebhook",
    targetUrl: "http://target.test",
    reconnectAttempts: 0,
  };
}

async function startServer(
  getStatus: () => RelayClientStatus
): Promise<{ server: http.Server; baseUrl: string; logger: ReturnType<typeof loggerSpy> }> {
  const logger = loggerSpy();
  const server = startHealthServer(0, getStatus, logger);
  servers.push(server);
  await once(server, "listening");

  const port = (server.address() as AddressInfo).port;
  return { server, baseUrl: `http://127.0.0.1:${port}`, logger };
}

function loggerSpy() {
  return {
    info: vi.fn(),
    error: vi.fn(),
  };
}

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        })
    )
  );
});

describe("health server", () => {
  it("reports liveness with the current relay status", async () => {
    const { baseUrl, logger } = await startServer(() => baseStatus(true));

    const response = await fetch(`${baseUrl}/health`);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({ status: "ok", connected: true });
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ port: expect.any(Number) }),
      "health server listening"
    );
  });

  it("reports readiness based on relay connectivity", async () => {
    let connected = false;
    const { baseUrl } = await startServer(() => baseStatus(connected));

    const disconnected = await fetch(`${baseUrl}/ready`);
    expect(disconnected.status).toBe(503);
    expect(await disconnected.json()).toMatchObject({ connected: false });

    connected = true;
    const ready = await fetch(`${baseUrl}/ready`);
    expect(ready.status).toBe(200);
    expect(await ready.json()).toMatchObject({ connected: true });
  });

  it("returns 404 for non-control endpoints and logs server errors", async () => {
    const { server, baseUrl, logger } = await startServer(() => baseStatus(true));

    const missing = await fetch(`${baseUrl}/missing`);
    expect(missing.status).toBe(404);
    expect(await missing.text()).toBe("");

    const error = new Error("port conflict");
    server.emit("error", error);

    expect(logger.error).toHaveBeenCalledWith(
      { error, port: 0 },
      "health server error"
    );
  });
});
