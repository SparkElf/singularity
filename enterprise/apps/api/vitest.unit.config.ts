import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.unit.test.ts"],
    name: "api-unit",
    testTimeout: 10_000,
  },
});
