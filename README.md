# Ensombl Dev Relay

Canonical monorepo for the Cloudflare relay Worker, reusable relay sidecar, shared relay protocol types, and local demo target app.

## Workspace

- `apps/relay-worker`: Cloudflare Worker and Durable Object relay.
- `apps/relay-client`: reusable standalone Node sidecar that connects to `/subscribe` and forwards relayed HTTP requests to a target app.
- `apps/demo-target`: local HTTP app with a browser UI showing requests forwarded through the relay.
- `packages/relay-protocol`: shared WebSocket frame types, constants, and base64 helpers.

## Local Demo

```sh
pnpm install
pnpm dev:demo
```

Demo URLs:

- UI: `http://localhost:3000`
- Worker: `http://localhost:8787`
- Sidecar health: `http://localhost:8081/health`

Send a request through the relay. The first path segment is the relay room and is stripped before forwarding to the target app:

```sh
curl -X POST 'http://localhost:8787/demo/webhook/hello?source=relay' \
  -H 'Content-Type: text/plain' \
  --data 'hello through relay'
```

The request should appear in the demo UI.

## Relay Client Sidecar

The sidecar is configured by environment variables:

- `RELAY_BASE_URL`: relay Worker WebSocket origin, for example `wss://relay.dev.ensombl.io`
- `RELAY_ROOM`: relay room, for example `acme`
- `RELAY_PATHS`: comma- or newline-separated target path patterns, for example `/webhooks/*,/auth/stripe/webhook`
- `TARGET_URL` or `RELAY_TARGET_URL`: local app target URL, for example `http://host.docker.internal:3000`
- `TIMEOUT_MS` or `RELAY_TIMEOUT_MS`: target request timeout, default `15000`
- `RECONNECT_DELAY_MS` or `RELAY_RECONNECT_DELAY_MS`: reconnect delay after relay disconnect, default `1000`
- `HEALTH_PORT` or `RELAY_HEALTH_PORT`: health server port, default `8080`
- `LOG_LEVEL` or `RELAY_LOG_LEVEL`: `trace`, `debug`, `info`, `warn`, `error`, or `fatal`

The sidecar loads environment files in this order, with earlier values winning: `RELAY_ENV_FILE`, workspace root `.env`, then `apps/relay-client/.env`.

Build the sidecar image from the client directory as a standalone context:

```sh
docker build -t ensombl-relay-client apps/relay-client
```

## Checks

```sh
pnpm typecheck
pnpm test
pnpm coverage
pnpm build
```

Coverage reports are written to each tested package's `coverage/` directory, including:

- `apps/relay-worker/coverage/index.html`
- `apps/relay-client/coverage/index.html`
