import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, test } from "node:test";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");

async function source(relativePath) {
  return readFile(resolve(root, relativePath), "utf8");
}

async function packageJson() {
  return JSON.parse(await source("package.json"));
}

describe("L3.1 production collaboration boundary", () => {
  test("runs the Kernel matrix with the repository-required CGO features", async () => {
    const packageData = await packageJson();
    const script = packageData.scripts["verify:l3-production"];
    assert.match(script, /CGO_ENABLED=1 go -C \.\.\/kernel test -vet=off -tags [\"']fts5 sqlcipher[\"']/);
  });

  test("persists only control-plane collaboration metadata", async () => {
    const schema = await source("packages/database/prisma/schema.prisma");
    assert.match(schema, /model CollaborationFeature/);
    assert.match(schema, /model CollaborationSession/);
    assert.match(schema, /model CollaborationAuditEvent/);
    assert.doesNotMatch(schema, /operationPayload|crdtSnapshot|documentContent/i);
  });

  test("keeps the production protocol on the dedicated WSS and Kernel bridge", async () => {
    const gateway = await source("apps/api/src/collaboration/realtime-websocket.gateway.ts");
    const port = await source("apps/api/src/collaboration/kernel-production-collaboration.port.ts");
    const kernel = await source("../kernel/collab/production.go");
    assert.match(gateway, /\/api\/v1\/collaboration\/ws/);
    assert.match(port, /\/internal\/enterprise\/collaboration/);
    assert.match(kernel, /persistJournal/);
    assert.match(kernel, /ErrEncryptedCollaborationUnavailable/);
  });

  test("does not put the prototype into the default React route tree", async () => {
    const appSource = await source("apps/web/src/app/App.tsx");
    assert.doesNotMatch(appSource, /l3-prototype/);
  });
});
