import pino from "pino";
import {
  loadRelayClientConfig,
  type RelayClientConfig,
} from "./config.js";
import { loadRelayEnv } from "./env.js";
import { startHealthServer } from "./health.js";
import { RelayClient } from "./relayClient.js";

loadRelayEnv();

const logger = pino({
  level: process.env.LOG_LEVEL || process.env.RELAY_LOG_LEVEL || "info",
  ...(process.env.NODE_ENV !== "production" &&
  (process.env.LOG_PRETTY ?? process.env.RELAY_LOG_PRETTY) !== "false"
    ? {
        transport: {
          target: "pino-pretty",
          options: {
            colorize: true,
            translateTime: "SYS:standard",
          },
        },
      }
    : {}),
});

let config: RelayClientConfig;
try {
  config = loadRelayClientConfig(process.env);
} catch (error) {
  logger.error(
    { error: error instanceof Error ? error.message : error },
    "invalid relay client config"
  );
  process.exit(1);
}

const clients = config.relayUrls.map(
  (relayUrl) =>
    new RelayClient({
      relayUrl,
      targetUrl: config.targetUrl,
      timeoutMs: config.timeoutMs,
      reconnectDelayMs: config.reconnectDelayMs,
      logger,
    })
);

function latestTimestamp(values: Array<string | undefined>): string | undefined {
  const defined = values.filter((value): value is string => Boolean(value));
  return defined.sort().at(-1);
}

function getStatus() {
  const subscriptions = clients.map((client) => client.getStatus());
  const lastConnectedAt = latestTimestamp(
    subscriptions.map((status) => status.lastConnectedAt)
  );
  const lastDisconnectedAt = latestTimestamp(
    subscriptions.map((status) => status.lastDisconnectedAt)
  );

  return {
    connected: subscriptions.every((status) => status.connected),
    inflight: subscriptions.reduce((total, status) => total + status.inflight, 0),
    relayPaths: config.relayPaths,
    relayUrls: config.relayUrls,
    targetUrl: config.targetUrl,
    reconnectAttempts: subscriptions.reduce(
      (total, status) => total + status.reconnectAttempts,
      0
    ),
    subscriptions,
    ...(lastConnectedAt ? { lastConnectedAt } : {}),
    ...(lastDisconnectedAt ? { lastDisconnectedAt } : {}),
  };
}

const healthServer = startHealthServer(
  config.healthPort,
  getStatus,
  logger
);

function shutdown(signal: NodeJS.Signals): void {
  logger.info({ signal }, "shutting down relay clients");
  for (const client of clients) client.stop();
  healthServer.close(() => {
    process.exit(0);
  });
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

logger.info(config, "starting relay clients");
for (const client of clients) client.start();
