import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/shell",
  fullyParallel: true,
  forbidOnly: true,
  retries: 0,
  reporter: "line",
  use: {
    baseURL: "http://127.0.0.1:4173",
    browserName: "chromium",
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
    command: "corepack pnpm dev",
    url: "http://127.0.0.1:4173",
    reuseExistingServer: false,
  },
});
