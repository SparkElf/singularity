import { defineConfig } from "@playwright/test";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

const apiPort = process.env.SINGULARITY_E2E_API_PORT ?? "3012";
const webPort = process.env.SINGULARITY_E2E_WEB_PORT ?? "4174";
const stateFile = process.env.SINGULARITY_E2E_STATE_FILE ??
  resolve(tmpdir(), `singularity-p5-e2e-state-${String(process.pid)}.json`);

process.env.SINGULARITY_E2E_API_PORT = apiPort;
process.env.SINGULARITY_E2E_WEB_PORT = webPort;
process.env.SINGULARITY_E2E_STATE_FILE = stateFile;

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  forbidOnly: true,
  globalSetup: "./tests/e2e/global-setup.ts",
  outputDir: "./test-results/e2e",
  reporter: "line",
  retries: 0,
  workers: 1,
  use: {
    baseURL: `https://127.0.0.1:${webPort}`,
    browserName: "chromium",
    ignoreHTTPSErrors: true,
    trace: "retain-on-failure",
  },
  webServer: [
    {
      command: "node tests/e2e/support/start-stack.mjs",
      reuseExistingServer: false,
      timeout: 300_000,
      url: `http://127.0.0.1:${apiPort}/api/v1/health/database`,
    },
    {
      command: "node tests/e2e/support/start-web.mjs",
      ignoreHTTPSErrors: true,
      reuseExistingServer: false,
      timeout: 300_000,
      url: `https://127.0.0.1:${webPort}`,
    },
  ],
});
