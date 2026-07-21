import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, test } from "node:test";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");

async function readJson(relativePath) {
  return JSON.parse(await readFile(resolve(root, relativePath), "utf8"));
}

describe("L3 prototype production boundary", () => {
  test("keeps protocol package dependent only on contracts", async () => {
    const packageJson = await readJson("packages/realtime-prototype/package.json");
    assert.deepEqual(Object.keys(packageJson.dependencies).sort(), ["@singularity/contracts", "zod"]);
    assert.equal(packageJson.dependencies["@singularity/database"], undefined);
    assert.equal(packageJson.dependencies["@singularity/kernel-client"], undefined);
  });

  test("keeps the browser prototype outside the default React route tree", async () => {
    const appSource = await readFile(resolve(root, "apps/web/src/app/App.tsx"), "utf8");
    assert.equal(appSource.includes("l3-prototype"), false);
    const viteSource = await readFile(resolve(root, "apps/web/vite.config.ts"), "utf8");
    assert.equal(viteSource.includes("l3-prototype.html"), true);
  });

  test("does not add a PostgreSQL schema or production WebSocket route", async () => {
    const packageJson = await readJson("package.json");
    assert.equal(packageJson.scripts["verify:l3-prototype"].includes("pnpm --filter @singularity/api"), false);
    const schema = await readFile(resolve(root, "packages/database/prisma/schema.prisma"), "utf8");
    assert.equal(schema.includes("RealtimeCollaboration"), false);
  });
});
