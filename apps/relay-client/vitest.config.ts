import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      provider: "istanbul",
      include: ["src/**/*.ts"],
      exclude: ["src/index.ts"],
      reporter: ["text", "html", "lcov"],
      thresholds: {
        statements: 90,
        branches: 80,
        functions: 95,
        lines: 90,
        "src/config.ts": { 100: true },
        "src/health.ts": { 100: true },
        "src/protocol.ts": { 100: true },
        "src/relayClient.ts": {
          statements: 88,
          branches: 82,
          functions: 97,
          lines: 89,
        },
      },
    },
  },
});
