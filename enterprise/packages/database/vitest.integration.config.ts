import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    fileParallelism: false,
    // 数据库集成共享固定测试库，单 worker 才能隔离连接池和超时合同。
    maxWorkers: 1,
    globalSetup: [
      fileURLToPath(new URL("./test/support/postgres.ts", import.meta.url)),
    ],
    hookTimeout: 30_000,
    include: ["test/**/*.integration.test.ts"],
    name: "database-integration",
    testTimeout: 15_000,
  },
});
