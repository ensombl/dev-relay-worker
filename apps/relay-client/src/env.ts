import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv, { type DotenvPopulateInput } from "dotenv";

function relayPackageRoot(moduleUrl: string): string {
  return path.resolve(path.dirname(fileURLToPath(moduleUrl)), "..");
}

export function relayEnvFiles(
  options: {
    env?: NodeJS.ProcessEnv;
    moduleUrl?: string;
  } = {}
): string[] {
  const env = options.env ?? process.env;
  const packageRoot = relayPackageRoot(options.moduleUrl ?? import.meta.url);

  return [
    env.RELAY_ENV_FILE,
    path.resolve(packageRoot, "../..", ".env"),
    path.resolve(packageRoot, ".env"),
  ].filter((envFile): envFile is string => Boolean(envFile));
}

export function loadRelayEnv(
  options: {
    env?: NodeJS.ProcessEnv;
    moduleUrl?: string;
  } = {}
): void {
  dotenv.config({
    path: relayEnvFiles(options),
    processEnv: (options.env ?? process.env) as DotenvPopulateInput,
    quiet: true,
  });
}
