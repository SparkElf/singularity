import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/l3-prototype",
  fullyParallel: false,
  forbidOnly: true,
  outputDir: "./test-results/l3-prototype",
  retries: 0,
  workers: 1,
  reporter: "line",
  use: {
    baseURL: "http://127.0.0.1:4173",
    browserName: "chromium",
    trace: "retain-on-failure",
  },
  projects: [
    { name: "desktop", use: { viewport: { width: 1440, height: 900 } } },
    { name: "narrow-320", use: { viewport: { width: 320, height: 568 } } },
  ],
  webServer: {
    command: "pnpm build && pnpm preview",
    reuseExistingServer: false,
    url: "http://127.0.0.1:4173/l3-prototype.html",
  },
});
