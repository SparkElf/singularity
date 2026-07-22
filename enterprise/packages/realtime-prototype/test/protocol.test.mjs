import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { PrototypeCoordinator, RecordingSemanticCore } from "../dist/index.js";

const identity = {
  documentId: "20260722090000-docabcd",
  notebookId: "20260722090001-bookabc",
  organizationId: "11111111-1111-4111-8111-111111111111",
  spaceId: "22222222-2222-4222-8222-222222222222",
};
const editor = "33333333-3333-4333-8333-333333333333";
const viewer = "44444444-4444-4444-8444-444444444444";

function operation(clientId, operationId, sequence = 1) {
  return {
    causalContext: {},
    clientId,
    clientSequence: sequence,
    identity,
    operation: { blockId: identity.documentId, kind: "text.insert", position: 0, text: operationId.slice(0, 1) },
    operationId,
    sessionGeneration: 1,
  };
}

describe("L3 protocol coordinator", () => {
  test("keeps editor writes, viewer projection, duplicate replay and resume explicit", () => {
    const core = new RecordingSemanticCore();
    const coordinator = new PrototypeCoordinator(core);
    coordinator.join({ capability: "editor", clientId: editor, featureMode: "standard", identity, protocolVersion: 1 });
    coordinator.join({ capability: "viewer", clientId: viewer, featureMode: "standard", identity, protocolVersion: 1 });
    const first = coordinator.submit(editor, operation(editor, "55555555-5555-4555-8555-555555555555"));
    assert.equal(first.result.outcome, "accepted");
    assert.equal(first.broadcast?.identity.documentId, identity.documentId);
    const duplicate = coordinator.submit(editor, operation(editor, "55555555-5555-4555-8555-555555555555"));
    assert.equal(duplicate.result.outcome, "duplicate");
    const resumed = coordinator.resume({ causalContext: {}, clientId: viewer, identity, sessionGeneration: 1 });
    assert.equal(resumed.length, 1);
    const denied = coordinator.submit(viewer, operation(viewer, "66666666-6666-4666-8666-666666666666"));
    assert.equal(denied.result.outcome, "rejected");
    assert.equal(denied.result.code, "permission-revoked");
  });

  test("expires presence and closes all sessions on ACL revoke", () => {
    let now = 1_000;
    const core = new RecordingSemanticCore();
    const coordinator = new PrototypeCoordinator(core, { now: () => now });
    coordinator.join({ capability: "editor", clientId: editor, featureMode: "standard", identity, protocolVersion: 1 });
    coordinator.join({ capability: "viewer", clientId: viewer, featureMode: "standard", identity, protocolVersion: 1 });
    coordinator.updatePresence({ clientId: editor, cursor: { blockId: identity.documentId, offset: 1 }, identity, sessionGeneration: 1, ttlMs: 1_000 });
    assert.equal(coordinator.presence(identity).length, 1);
    now += 1_001;
    assert.equal(coordinator.presence(identity).length, 0);
    coordinator.updatePresence({ clientId: editor, cursor: null, identity, sessionGeneration: 1, ttlMs: 10_000 });
    assert.equal(coordinator.revoke(identity).length, 2);
    const denied = coordinator.submit(editor, operation(editor, "77777777-7777-4777-8777-777777777777"));
    assert.equal(denied.result.code, "permission-revoked");
    assert.equal(coordinator.presence(identity).length, 0);
  });

  test("rejects a late operation carrying another document identity", () => {
    const core = new RecordingSemanticCore();
    const coordinator = new PrototypeCoordinator(core);
    coordinator.join({ capability: "editor", clientId: editor, featureMode: "standard", identity, protocolVersion: 1 });
    const otherIdentity = { ...identity, documentId: "20260722090002-otherdo" };
    const rejected = coordinator.submit(editor, { ...operation(editor, "88888888-8888-4888-8888-888888888888"), identity: otherIdentity });
    assert.equal(rejected.result.outcome, "rejected");
    assert.equal(rejected.result.code, "missing-identity");
    assert.equal(coordinator.logs().at(-1)?.identity.documentId, otherIdentity.documentId);
  });
});
