import dotenv from "dotenv";
import pino from "pino";
import { loadRelayClientConfig } from "./config.js";
import { startHealthServer } from "./health.js";
import { RelayClient } from "./relayClient.js";

dotenv.config();

const logger = pino({
  level: process.env.LOG_LEVEL || "info",
  ...(process.env.NODE_ENV !== "production" &&
  process.env.LOG_PRETTY !== "false"
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

let config;
try {
  config = loadRelayClientConfig(process.env);
} catch (error) {
  logger.error(
    { error: error instanceof Error ? error.message : error },
    "invalid relay client config"
  );
  process.exit(1);
}

const client = new RelayClient({
  relayUrl: config.relayUrl,
  targetUrl: config.targetUrl,
  timeoutMs: config.timeoutMs,
  reconnectDelayMs: config.reconnectDelayMs,
  logger,
});
const healthServer = startHealthServer(
  config.healthPort,
  () => client.getStatus(),
  logger
);

function shutdown(signal: NodeJS.Signals): void {
  logger.info({ signal }, "shutting down relay client");
  client.stop();
  healthServer.close(() => {
    process.exit(0);
  });
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

logger.info(config, "starting relay client");
client.start();
