import { defineConfig } from "@playwright/test";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

const apiPort = process.env.SINGULARITY_E2E_API_PORT ?? "3012";
const webPort = process.env.SINGULARITY_E2E_WEB_PORT ?? "4174";
const runtimeRoot = resolve(
  tmpdir(),
  `singularity-p5-e2e-runtime-${String(process.pid)}`,
);
const stateFile = resolve(runtimeRoot, "stack-state.json");
const schema = `singularity_p5_e2e_${String(process.pid)}`;

process.env.SINGULARITY_E2E_API_PORT = apiPort;
process.env.SINGULARITY_E2E_RUNTIME_ROOT = runtimeRoot;
process.env.SINGULARITY_E2E_SCHEMA = schema;
process.env.SINGULARITY_E2E_WEB_PORT = webPort;
process.env.SINGULARITY_E2E_STATE_FILE = stateFile;

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  forbidOnly: true,
  globalSetup: "./tests/e2e/global-setup.ts",
  outputDir: "./test-results/e2e",
  reporter: [
    ["line"],
    ["json", { outputFile: "./test-results/e2e-report.json" }],
  ],
  retries: 0,
  workers: 1,
  use: {
    baseURL: `https://127.0.0.1:${webPort}`,
    browserName: "chromium",
    ignoreHTTPSErrors: true,
    trace: "retain-on-failure",
  },
});
