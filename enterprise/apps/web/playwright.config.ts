import { defineConfig } from "@playwright/test";
import { existsSync } from "node:fs";

const configuredBrowser = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
const systemChrome = configuredBrowser
  ?? (existsSync("/usr/bin/google-chrome") ? "/usr/bin/google-chrome" : undefined);

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: true,
  forbidOnly: true,
  retries: 0,
  reporter: "line",
  use: {
    baseURL: "http://127.0.0.1:4173",
    browserName: "chromium",
    launchOptions: systemChrome ? { executablePath: systemChrome } : {},
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "desktop",
      use: { viewport: { width: 1440, height: 900 } },
    },
    {
      name: "mobile",
      use: { viewport: { width: 390, height: 844 } },
    },
  ],
  webServer: {
    command: "corepack pnpm@11.9.0 dev",
    url: "http://127.0.0.1:4173",
    reuseExistingServer: false,
  },
});
