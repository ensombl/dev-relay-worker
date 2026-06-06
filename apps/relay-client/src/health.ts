import http from "node:http";
import type { RelayClientStatus, RelayLogger } from "./relayClient.js";

export function startHealthServer(
  port: number,
  getStatus: () => RelayClientStatus,
  logger: Pick<RelayLogger, "info" | "error">
): http.Server {
  const server = http.createServer((req, res) => {
    if (req.url === "/health" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", ...getStatus() }));
      return;
    }

    if (req.url === "/ready" && req.method === "GET") {
      const status = getStatus();
      res.writeHead(status.connected ? 200 : 503, {
        "Content-Type": "application/json",
      });
      res.end(JSON.stringify(status));
      return;
    }

    res.writeHead(404);
    res.end();
  });

  server.listen(port, () => {
    logger.info({ port }, "health server listening");
  });

  server.on("error", (error) => {
    logger.error({ error, port }, "health server error");
  });

  return server;
}
