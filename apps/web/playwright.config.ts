import path from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig, devices } from "@playwright/test";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../..");

const WEB_PORT = 5189;
const SERVER_PORT = 8797;

export default defineConfig({
  testDir: "./tests/e2e/specs",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 30_000,
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : [["list"]],
  use: {
    baseURL: `http://127.0.0.1:${WEB_PORT}`,
    trace: "retain-on-failure",
    screenshot: "only-on-failure"
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] }
    }
  ],
  webServer: [
    {
      command: "node apps/web/tests/e2e/mock-llm-server.mjs",
      cwd: repoRoot,
      url: "http://127.0.0.1:8798/v1/models",
      reuseExistingServer: false,
      timeout: 30_000,
      stdout: "pipe",
      stderr: "pipe"
    },
    {
      command: `pnpm exec tsx --tsconfig apps/server/tsconfig.json apps/server/src/index.ts --config apps/web/tests/e2e/fixtures/test-server.config.yaml`,
      cwd: repoRoot,
      url: `http://127.0.0.1:${SERVER_PORT}/healthz`,
      reuseExistingServer: false,
      timeout: 60_000,
      stdout: "pipe",
      stderr: "pipe"
    },
    {
      command: `pnpm --filter @oah/web exec vite --port ${WEB_PORT} --strictPort --host 127.0.0.1`,
      cwd: repoRoot,
      url: `http://127.0.0.1:${WEB_PORT}`,
      reuseExistingServer: false,
      timeout: 60_000,
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        OAH_WEB_PROXY_TARGET: `http://127.0.0.1:${SERVER_PORT}`
      }
    }
  ]
});
