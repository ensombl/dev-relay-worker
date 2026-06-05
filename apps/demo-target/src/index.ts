import { randomUUID } from "node:crypto";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import { URL } from "node:url";

type CapturedRequest = {
  id: string;
  receivedAt: string;
  method: string;
  path: string;
  query: string;
  headers: Record<string, string>;
  bodyPreview: string;
  bodyBytes: number;
  truncated: boolean;
  responseStatus: number;
};

const port = Number(process.env.PORT || 3000);
const maxBodyPreviewBytes = Number(process.env.MAX_BODY_PREVIEW_BYTES || 65536);
let requests: CapturedRequest[] = [];
const eventClients = new Set<ServerResponse>();

function normalizeHeaders(
  headers: IncomingMessage["headers"]
): Record<string, string> {
  const normalized: Record<string, string> = {};

  for (const [key, value] of Object.entries(headers)) {
    if (Array.isArray(value)) normalized[key] = value.join(", ");
    else if (value !== undefined) normalized[key] = String(value);
  }

  return normalized;
}

async function readBody(req: IncomingMessage): Promise<{
  bodyPreview: string;
  bodyBytes: number;
  truncated: boolean;
}> {
  const chunks: Buffer[] = [];
  let bodyBytes = 0;
  let previewBytes = 0;

  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bodyBytes += buffer.length;

    if (previewBytes < maxBodyPreviewBytes) {
      const remaining = maxBodyPreviewBytes - previewBytes;
      const previewChunk = buffer.subarray(0, remaining);
      chunks.push(previewChunk);
      previewBytes += previewChunk.length;
    }
  }

  return {
    bodyPreview: Buffer.concat(chunks).toString("utf8"),
    bodyBytes,
    truncated: bodyBytes > previewBytes,
  };
}

function sendJson(
  res: ServerResponse,
  status: number,
  payload: unknown,
  headers: Record<string, string> = {}
): void {
  res.writeHead(status, {
    "Content-Type": "application/json",
    ...headers,
  });
  res.end(JSON.stringify(payload));
}

function sendEvent(
  res: ServerResponse,
  event: string,
  payload: unknown
): void {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function broadcast(event: string, payload: unknown): void {
  for (const client of eventClients) {
    sendEvent(client, event, payload);
  }
}

function serveEvents(req: IncomingMessage, res: ServerResponse): void {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  res.write(": connected\n\n");
  eventClients.add(res);
  sendEvent(res, "snapshot", requests);

  req.on("close", () => {
    eventClients.delete(res);
  });
}

async function captureRequest(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL
): Promise<void> {
  const body = await readBody(req);
  const responseStatus = 200;
  const entry: CapturedRequest = {
    id: randomUUID(),
    receivedAt: new Date().toISOString(),
    method: req.method || "GET",
    path: url.pathname,
    query: url.search,
    headers: normalizeHeaders(req.headers),
    responseStatus,
    ...body,
  };

  requests = [entry, ...requests].slice(0, 50);
  broadcast("request", entry);

  sendJson(
    res,
    responseStatus,
    {
      ok: true,
      id: entry.id,
      receivedAt: entry.receivedAt,
      method: entry.method,
      path: entry.path,
      query: entry.query,
      bodyBytes: entry.bodyBytes,
    },
    { "X-Demo-Request-Id": entry.id }
  );
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "local"}`);

  if (req.method === "GET" && url.pathname === "/") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(renderHtml());
    return;
  }

  if (req.method === "GET" && url.pathname === "/events") {
    serveEvents(req, res);
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/requests") {
    sendJson(res, 200, requests);
    return;
  }

  if (req.method === "DELETE" && url.pathname === "/api/requests") {
    requests = [];
    broadcast("snapshot", requests);
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method === "GET" && url.pathname === "/health") {
    sendJson(res, 200, { status: "ok" });
    return;
  }

  void captureRequest(req, res, url).catch((error) => {
    sendJson(res, 500, {
      ok: false,
      error: error instanceof Error ? error.message : "unknown error",
    });
  });
});

server.listen(port, () => {
  console.log(`demo target listening on http://localhost:${port}`);
});

function renderHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Relay Demo Target</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f6f7f9;
      --panel: #ffffff;
      --line: #d9dee7;
      --text: #18202c;
      --muted: #667085;
      --accent: #147d64;
      --accent-soft: #e6f4f0;
      --warn: #b54708;
      --shadow: 0 1px 2px rgba(16, 24, 40, 0.08);
    }

    * {
      box-sizing: border-box;
    }

    body {
      margin: 0;
      min-height: 100vh;
      background: var(--bg);
      color: var(--text);
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }

    header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      min-height: 72px;
      padding: 18px 24px;
      border-bottom: 1px solid var(--line);
      background: var(--panel);
    }

    h1 {
      margin: 0;
      font-size: 20px;
      font-weight: 700;
      letter-spacing: 0;
    }

    .subtle {
      color: var(--muted);
      font-size: 13px;
    }

    .status {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      min-height: 32px;
      padding: 0 12px;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: #fbfcfe;
      color: var(--muted);
      font-size: 13px;
      white-space: nowrap;
    }

    .dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: var(--warn);
    }

    .status.connected .dot {
      background: var(--accent);
    }

    main {
      display: grid;
      grid-template-columns: minmax(280px, 380px) minmax(0, 1fr);
      gap: 16px;
      padding: 16px;
      height: calc(100vh - 72px);
      min-height: 520px;
    }

    .pane {
      min-width: 0;
      overflow: hidden;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: var(--panel);
      box-shadow: var(--shadow);
    }

    .pane-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      height: 52px;
      padding: 0 14px;
      border-bottom: 1px solid var(--line);
    }

    .pane-title {
      font-size: 14px;
      font-weight: 700;
    }

    button {
      min-height: 32px;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: #ffffff;
      color: var(--text);
      font: inherit;
      cursor: pointer;
    }

    button:hover {
      border-color: #a8b2c1;
    }

    #clear {
      padding: 0 10px;
      font-size: 13px;
    }

    #list {
      height: calc(100% - 52px);
      overflow: auto;
    }

    .request {
      display: grid;
      grid-template-columns: auto minmax(0, 1fr);
      gap: 8px 10px;
      width: 100%;
      padding: 12px 14px;
      border: 0;
      border-bottom: 1px solid var(--line);
      border-radius: 0;
      text-align: left;
    }

    .request.active {
      background: var(--accent-soft);
    }

    .method {
      align-self: start;
      min-width: 58px;
      padding: 3px 7px;
      border-radius: 7px;
      background: #eef2f6;
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 12px;
      font-weight: 700;
      text-align: center;
    }

    .path {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 13px;
      font-weight: 650;
    }

    .meta {
      grid-column: 2;
      color: var(--muted);
      font-size: 12px;
    }

    #detail {
      height: calc(100% - 52px);
      overflow: auto;
      padding: 16px;
    }

    .empty {
      display: grid;
      place-items: center;
      height: 100%;
      color: var(--muted);
      text-align: center;
      padding: 24px;
    }

    .grid {
      display: grid;
      grid-template-columns: 140px minmax(0, 1fr);
      gap: 10px 14px;
      margin-bottom: 18px;
    }

    .label {
      color: var(--muted);
      font-size: 13px;
    }

    .value {
      min-width: 0;
      overflow-wrap: anywhere;
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 13px;
    }

    pre {
      min-height: 160px;
      margin: 8px 0 0;
      padding: 12px;
      overflow: auto;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: #101828;
      color: #f8fafc;
      white-space: pre-wrap;
      word-break: break-word;
      font-size: 12px;
      line-height: 1.5;
    }

    @media (max-width: 820px) {
      header {
        align-items: flex-start;
        flex-direction: column;
      }

      main {
        grid-template-columns: 1fr;
        height: auto;
        min-height: 0;
      }

      .pane {
        min-height: 320px;
      }

      .grid {
        grid-template-columns: 1fr;
      }
    }
  </style>
</head>
<body>
  <header>
    <div>
      <h1>Relay Demo Target</h1>
      <div class="subtle">Listening for forwarded requests on this local app.</div>
    </div>
    <div id="status" class="status"><span class="dot"></span><span id="statusText">Connecting</span></div>
  </header>
  <main>
    <section class="pane">
      <div class="pane-header">
        <div class="pane-title">Requests <span id="count" class="subtle">0</span></div>
        <button id="clear" type="button">Clear</button>
      </div>
      <div id="list"></div>
    </section>
    <section class="pane">
      <div class="pane-header">
        <div class="pane-title">Selected Request</div>
        <div id="selectedTime" class="subtle"></div>
      </div>
      <div id="detail" class="empty">No requests yet.</div>
    </section>
  </main>
  <script>
    const state = { requests: [], selectedId: null };
    const list = document.getElementById("list");
    const detail = document.getElementById("detail");
    const count = document.getElementById("count");
    const status = document.getElementById("status");
    const statusText = document.getElementById("statusText");
    const selectedTime = document.getElementById("selectedTime");

    function shortTime(value) {
      return new Date(value).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    }

    function setConnected(connected) {
      status.classList.toggle("connected", connected);
      statusText.textContent = connected ? "Live" : "Disconnected";
    }

    function renderList() {
      count.textContent = String(state.requests.length);
      list.replaceChildren(...state.requests.map((item) => {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "request" + (item.id === state.selectedId ? " active" : "");
        button.addEventListener("click", () => {
          state.selectedId = item.id;
          render();
        });

        const method = document.createElement("div");
        method.className = "method";
        method.textContent = item.method;

        const path = document.createElement("div");
        path.className = "path";
        path.textContent = item.path + item.query;

        const meta = document.createElement("div");
        meta.className = "meta";
        meta.textContent = shortTime(item.receivedAt) + " / " + item.bodyBytes + " bytes / " + item.responseStatus;

        button.append(method, path, meta);
        return button;
      }));
    }

    function row(label, value) {
      const key = document.createElement("div");
      key.className = "label";
      key.textContent = label;
      const val = document.createElement("div");
      val.className = "value";
      val.textContent = value;
      return [key, val];
    }

    function renderDetail() {
      const selected = state.requests.find((item) => item.id === state.selectedId) || state.requests[0];
      if (!selected) {
        selectedTime.textContent = "";
        detail.className = "empty";
        detail.textContent = "No requests yet.";
        return;
      }

      state.selectedId = selected.id;
      selectedTime.textContent = shortTime(selected.receivedAt);
      detail.className = "";
      const grid = document.createElement("div");
      grid.className = "grid";
      grid.append(
        ...row("Method", selected.method),
        ...row("Path", selected.path + selected.query),
        ...row("Received", selected.receivedAt),
        ...row("Body bytes", String(selected.bodyBytes)),
        ...row("Response", String(selected.responseStatus))
      );

      const headersTitle = document.createElement("div");
      headersTitle.className = "pane-title";
      headersTitle.textContent = "Headers";
      const headers = document.createElement("pre");
      headers.textContent = JSON.stringify(selected.headers, null, 2);

      const bodyTitle = document.createElement("div");
      bodyTitle.className = "pane-title";
      bodyTitle.textContent = selected.truncated ? "Body Preview (truncated)" : "Body Preview";
      const body = document.createElement("pre");
      body.textContent = selected.bodyPreview || "(empty)";

      detail.replaceChildren(grid, headersTitle, headers, bodyTitle, body);
    }

    function render() {
      renderList();
      renderDetail();
    }

    document.getElementById("clear").addEventListener("click", async () => {
      await fetch("/api/requests", { method: "DELETE" });
    });

    const source = new EventSource("/events");
    source.addEventListener("open", () => setConnected(true));
    source.addEventListener("error", () => setConnected(false));
    source.addEventListener("snapshot", (event) => {
      state.requests = JSON.parse(event.data);
      if (!state.requests.some((item) => item.id === state.selectedId)) {
        state.selectedId = state.requests[0]?.id || null;
      }
      render();
    });
    source.addEventListener("request", (event) => {
      const request = JSON.parse(event.data);
      state.requests = [request, ...state.requests.filter((item) => item.id !== request.id)].slice(0, 50);
      state.selectedId = request.id;
      render();
    });
  </script>
</body>
</html>`;
}
