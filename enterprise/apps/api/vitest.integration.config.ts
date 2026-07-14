import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    fileParallelism: false,
    globalSetup: [
      fileURLToPath(
        new URL(
          "../../packages/database/test/support/postgres.ts",
          import.meta.url,
        ),
      ),
    ],
    hookTimeout: 30_000,
    include: [
      "test/**/*.http.test.ts",
      "test/**/*.operations.test.ts",
    ],
    name: "api-http-contract-operations-integration",
    testTimeout: 15_000,
  },
});
