import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/browser-integration",
  outputDir: "./test-results/browser-integration",
  // 真实 Protyle 会持续维护编辑器 DOM；跨视口并行会让 actionability 失去稳定性。
  fullyParallel: false,
  forbidOnly: true,
  retries: 0,
  workers: 1,
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
      use: { hasTouch: true, viewport: { width: 390, height: 844 } },
    },
    {
      name: "narrow-320",
      use: { hasTouch: true, viewport: { width: 320, height: 568 } },
    },
  ],
  webServer: {
    command: "pnpm build && pnpm preview",
    reuseExistingServer: false,
    url: "http://127.0.0.1:4173",
  },
});
