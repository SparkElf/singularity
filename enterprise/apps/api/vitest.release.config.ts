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
    include: ["test/l3-release-certification.integration.test.ts"],
    name: "api-l3-release-certification",
    reporters: [
      "default",
      ["json", { outputFile: "test-results/l3-release-certification/api-report.json" }],
    ],
    testTimeout: 30_000,
  },
});
