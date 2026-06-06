import { describe, expect, it } from "vitest";
import {
  buildRelaySubscribeUrl,
  loadRelayClientConfig,
} from "../src/config.js";

describe("relay client config", () => {
  it("builds a room-scoped subscribe URL", () => {
    const relayUrl = buildRelaySubscribeUrl({
      baseUrl: "ws://localhost:8787",
      room: "demo",
      path: "/webhook/*",
    });
    const url = new URL(relayUrl);

    expect(url.origin).toBe("ws://localhost:8787");
    expect(url.pathname).toBe("/subscribe");
    expect(url.searchParams.get("room")).toBe("demo");
    expect(url.searchParams.get("path")).toBe("/webhook/*");
  });

  it("keeps relay base paths and normalizes path input", () => {
    const relayUrl = buildRelaySubscribeUrl({
      baseUrl: "wss://relay.example.com/base/",
      room: "demo.room",
      path: "webhook",
    });
    const url = new URL(relayUrl);

    expect(url.origin).toBe("wss://relay.example.com");
    expect(url.pathname).toBe("/base/subscribe");
    expect(url.searchParams.get("room")).toBe("demo.room");
    expect(url.searchParams.get("path")).toBe("/webhook");
  });

  it("loads defaults and numeric overrides from the environment", () => {
    const defaults = loadRelayClientConfig({
      RELAY_BASE_URL: "ws://localhost:8787",
      RELAY_ROOM: "demo",
      RELAY_PATHS: "webhook/*",
      TARGET_URL: "http://localhost:3000",
    });

    expect(defaults).toMatchObject({
      relayPaths: ["/webhook/*"],
      relayUrls: [
        "ws://localhost:8787/subscribe?room=demo&path=%2Fwebhook%2F*",
      ],
      targetUrl: "http://localhost:3000",
      timeoutMs: 15000,
      reconnectDelayMs: 1000,
      healthPort: 8080,
    });

    const overrides = loadRelayClientConfig({
      RELAY_BASE_URL: "ws://localhost:8787",
      RELAY_ROOM: "demo",
      RELAY_PATHS: "/webhook/*",
      TARGET_URL: "http://localhost:3000",
      TIMEOUT_MS: "42",
      RECONNECT_DELAY_MS: "7",
      HEALTH_PORT: "9090",
    });

    expect(overrides.timeoutMs).toBe(42);
    expect(overrides.reconnectDelayMs).toBe(7);
    expect(overrides.healthPort).toBe(9090);
  });

  it("loads target and numeric values from relay-prefixed environment aliases", () => {
    const config = loadRelayClientConfig({
      RELAY_BASE_URL: "ws://localhost:8787",
      RELAY_ROOM: "demo",
      RELAY_PATHS: "/webhook/*",
      RELAY_TARGET_URL: "http://localhost:3000",
      RELAY_TIMEOUT_MS: "42",
      RELAY_RECONNECT_DELAY_MS: "7",
      RELAY_HEALTH_PORT: "9090",
    });

    expect(config).toMatchObject({
      targetUrl: "http://localhost:3000",
      timeoutMs: 42,
      reconnectDelayMs: 7,
      healthPort: 9090,
    });
  });

  it("loads multiple relay paths from RELAY_PATHS", () => {
    const config = loadRelayClientConfig({
      RELAY_BASE_URL: "ws://localhost:8787",
      RELAY_ROOM: "demo",
      RELAY_PATHS: "/webhook/*, auth/stripe/webhook\n/webhooks/didit",
      TARGET_URL: "http://localhost:3000",
    });

    expect(config.relayPaths).toEqual([
      "/webhook/*",
      "/auth/stripe/webhook",
      "/webhooks/didit",
    ]);
    expect(config.relayUrls).toEqual([
      "ws://localhost:8787/subscribe?room=demo&path=%2Fwebhook%2F*",
      "ws://localhost:8787/subscribe?room=demo&path=%2Fauth%2Fstripe%2Fwebhook",
      "ws://localhost:8787/subscribe?room=demo&path=%2Fwebhooks%2Fdidit",
    ]);
  });

  it("fails config loading when required env vars are missing", () => {
    expect(() =>
      loadRelayClientConfig({
        RELAY_ROOM: "demo",
        RELAY_PATHS: "/webhook/*",
        TARGET_URL: "http://localhost:3000",
      })
    ).toThrow(
      "RELAY_BASE_URL, RELAY_ROOM, RELAY_PATHS, TARGET_URL or RELAY_TARGET_URL are required"
    );

    expect(() =>
      loadRelayClientConfig({
        RELAY_BASE_URL: "ws://localhost:8787",
        RELAY_PATHS: "/webhook/*",
        TARGET_URL: "http://localhost:3000",
      })
    ).toThrow(
      "RELAY_BASE_URL, RELAY_ROOM, RELAY_PATHS, TARGET_URL or RELAY_TARGET_URL are required"
    );

    expect(() =>
      loadRelayClientConfig({
        RELAY_BASE_URL: "ws://localhost:8787",
        RELAY_ROOM: "demo",
        TARGET_URL: "http://localhost:3000",
      })
    ).toThrow(
      "RELAY_BASE_URL, RELAY_ROOM, RELAY_PATHS, TARGET_URL or RELAY_TARGET_URL are required"
    );

    expect(() =>
      loadRelayClientConfig({
        RELAY_BASE_URL: "ws://localhost:8787",
        RELAY_ROOM: "demo",
        RELAY_PATH: "/webhook/*",
        TARGET_URL: "http://localhost:3000",
      })
    ).toThrow(
      "RELAY_BASE_URL, RELAY_ROOM, RELAY_PATHS, TARGET_URL or RELAY_TARGET_URL are required"
    );

    expect(() =>
      loadRelayClientConfig({
        RELAY_BASE_URL: "ws://localhost:8787",
        RELAY_ROOM: "demo",
        RELAY_PATHS: "/webhook/*",
      })
    ).toThrow(
      "RELAY_BASE_URL, RELAY_ROOM, RELAY_PATHS, TARGET_URL or RELAY_TARGET_URL are required"
    );
  });
});
