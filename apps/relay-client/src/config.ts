export type RelayClientConfig = {
  relayPaths: string[];
  relayUrls: string[];
  targetUrl: string;
  timeoutMs: number;
  reconnectDelayMs: number;
  healthPort: number;
};

type RequiredEnvKey = "RELAY_BASE_URL" | "RELAY_ROOM";

const REQUIRED_ENV_MESSAGE =
  "RELAY_BASE_URL, RELAY_ROOM, RELAY_PATHS, TARGET_URL or RELAY_TARGET_URL are required";

function normalizeRelayPath(path: string): string {
  return path.startsWith("/") ? path : `/${path}`;
}

function parseRelayPaths(env: NodeJS.ProcessEnv): string[] {
  const paths =
    env.RELAY_PATHS
      ?.split(/[,\n]+/)
      .map((path) => path.trim())
      .filter((path) => path.length > 0) ?? [];

  if (paths.length === 0) throw new Error(REQUIRED_ENV_MESSAGE);

  return paths.map(normalizeRelayPath);
}

function requireEnv(
  env: NodeJS.ProcessEnv,
  key: RequiredEnvKey
): string {
  const value = env[key];
  if (!value) throw new Error(REQUIRED_ENV_MESSAGE);
  return value;
}

function envValue(env: NodeJS.ProcessEnv, keys: string[]): string | undefined {
  for (const key of keys) {
    if (env[key]) return env[key];
  }
}

function requireEnvValue(env: NodeJS.ProcessEnv, keys: string[]): string {
  const value = envValue(env, keys);
  if (!value) throw new Error(REQUIRED_ENV_MESSAGE);
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
  const baseUrl = requireEnv(env, "RELAY_BASE_URL");
  const room = requireEnv(env, "RELAY_ROOM");
  const relayPaths = parseRelayPaths(env);

  return {
    relayPaths,
    relayUrls: relayPaths.map((path) =>
      buildRelaySubscribeUrl({
        baseUrl,
        room,
        path,
      })
    ),
    targetUrl: requireEnvValue(env, ["TARGET_URL", "RELAY_TARGET_URL"]),
    timeoutMs: Number(envValue(env, ["TIMEOUT_MS", "RELAY_TIMEOUT_MS"]) || 15000),
    reconnectDelayMs: Number(
      envValue(env, ["RECONNECT_DELAY_MS", "RELAY_RECONNECT_DELAY_MS"]) || 1000
    ),
    healthPort: Number(envValue(env, ["HEALTH_PORT", "RELAY_HEALTH_PORT"]) || 8080),
  };
}
