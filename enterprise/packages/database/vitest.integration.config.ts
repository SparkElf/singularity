import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    fileParallelism: false,
    globalSetup: [
      fileURLToPath(new URL("./test/support/postgres.ts", import.meta.url)),
    ],
    hookTimeout: 30_000,
    include: ["test/**/*.integration.test.ts"],
    name: "database-integration",
    testTimeout: 15_000,
  },
});
