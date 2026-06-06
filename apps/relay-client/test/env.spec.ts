import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { loadRelayEnv, relayEnvFiles } from "../src/env.js";

function createRelayPackageFixture() {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "relay-env-"));
  const packageRoot = path.join(workspaceRoot, "apps", "relay-client");
  const srcDir = path.join(packageRoot, "src");

  fs.mkdirSync(srcDir, { recursive: true });

  return {
    workspaceRoot,
    packageRoot,
    moduleUrl: pathToFileURL(path.join(srcDir, "env.ts")).href,
  };
}

describe("relay env loading", () => {
  it("loads the workspace root .env before the package-local .env", () => {
    const fixture = createRelayPackageFixture();
    fs.writeFileSync(
      path.join(fixture.workspaceRoot, ".env"),
      "RELAY_ROOM=root-room\nRELAY_TARGET_URL=http://root.example\n"
    );
    fs.writeFileSync(
      path.join(fixture.packageRoot, ".env"),
      "RELAY_ROOM=package-room\nRELAY_PATHS=/package\n"
    );
    const env: NodeJS.ProcessEnv = {};

    loadRelayEnv({ env, moduleUrl: fixture.moduleUrl });

    expect(env.RELAY_ROOM).toBe("root-room");
    expect(env.RELAY_TARGET_URL).toBe("http://root.example");
    expect(env.RELAY_PATHS).toBe("/package");
  });

  it("loads RELAY_ENV_FILE before default env files", () => {
    const fixture = createRelayPackageFixture();
    const envFile = path.join(fixture.workspaceRoot, "custom.env");
    fs.writeFileSync(
      path.join(fixture.workspaceRoot, ".env"),
      "RELAY_ROOM=root-room\n"
    );
    fs.writeFileSync(envFile, "RELAY_ROOM=custom-room\n");
    const env: NodeJS.ProcessEnv = { RELAY_ENV_FILE: envFile };

    expect(relayEnvFiles({ env, moduleUrl: fixture.moduleUrl })[0]).toBe(
      envFile
    );

    loadRelayEnv({ env, moduleUrl: fixture.moduleUrl });

    expect(env.RELAY_ROOM).toBe("custom-room");
  });
});
