export type RelayClientConfig = {
  relayUrl: string;
  targetUrl: string;
  timeoutMs: number;
  reconnectDelayMs: number;
  healthPort: number;
};

const REQUIRED_ENV = [
  "RELAY_BASE_URL",
  "RELAY_ROOM",
  "RELAY_PATH",
  "TARGET_URL",
] as const;

function normalizeRelayPath(path: string): string {
  return path.startsWith("/") ? path : `/${path}`;
}

function requireEnv(
  env: NodeJS.ProcessEnv,
  key: (typeof REQUIRED_ENV)[number]
): string {
  const value = env[key];
  if (!value) throw new Error(`${REQUIRED_ENV.join(", ")} are required`);
  return value;
}

export function buildRelaySubscribeUrl(options: {
  baseUrl: string;
  room: string;
  path: string;
}): string {
  const url = new URL(options.baseUrl);
  const basePath = url.pathname === "/" ? "" : url.pathname.replace(/\/$/, "");

  url.pathname = `${basePath}/subscribe`;
  url.search = "";
  url.searchParams.set("room", options.room);
  url.searchParams.set("path", normalizeRelayPath(options.path));

  return url.toString();
}

export function loadRelayClientConfig(
  env: NodeJS.ProcessEnv
): RelayClientConfig {
  const relayUrl = buildRelaySubscribeUrl({
    baseUrl: requireEnv(env, "RELAY_BASE_URL"),
    room: requireEnv(env, "RELAY_ROOM"),
    path: requireEnv(env, "RELAY_PATH"),
  });

  return {
    relayUrl,
    targetUrl: requireEnv(env, "TARGET_URL"),
    timeoutMs: Number(env.TIMEOUT_MS || 15000),
    reconnectDelayMs: Number(env.RECONNECT_DELAY_MS || 1000),
    healthPort: Number(env.HEALTH_PORT || 8080),
  };
}
