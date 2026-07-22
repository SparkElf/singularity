import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  COLLABORATION_OPERATION_ENVELOPE_OPENAPI_SCHEMA,
  collaborationBroadcastSchema,
  collaborationJoinRequestSchema,
  collaborationOperationEnvelopeSchema,
  collaborationOperationResultSchema,
  collaborationPresenceSchema,
} from "../dist/index.js";

const identity = {
  documentId: "20260722090000-docabcd",
  notebookId: "20260722090001-bookabc",
  organizationId: "11111111-1111-4111-8111-111111111111",
  spaceId: "22222222-2222-4222-8222-222222222222",
};
const envelope = {
  causalContext: {},
  clientId: "33333333-3333-4333-8333-333333333333",
  clientSequence: 1,
  identity,
  operation: { blockId: identity.documentId, kind: "text.insert", position: 0, text: "A" },
  operationId: "44444444-4444-4444-8444-444444444444",
  sessionGeneration: 1,
};

describe("L3 realtime collaboration contracts", () => {
  test("requires one explicit four-part identity on every operation message", () => {
    assert.deepEqual(collaborationOperationEnvelopeSchema.parse(envelope), envelope);
    assert.equal(
      collaborationOperationEnvelopeSchema.safeParse({
        ...envelope,
        identity: { ...identity, notebookId: undefined },
      }).success,
      false,
    );
    assert.equal(
      collaborationOperationEnvelopeSchema.safeParse({ ...envelope, documentId: identity.documentId }).success,
      false,
    );
  });

  test("keeps operation outcomes explicit and serializable", () => {
    assert.equal(
      collaborationOperationResultSchema.safeParse({ identity, operationId: envelope.operationId, outcome: "accepted", serverSequence: 1, sessionGeneration: 1 }).success,
      true,
    );
    assert.equal(
      collaborationOperationResultSchema.safeParse({ identity, operationId: envelope.operationId, outcome: "rejected", code: "structure-conflict", sessionGeneration: 1 }).success,
      true,
    );
    assert.equal(
      collaborationOperationResultSchema.safeParse({ identity, operationId: envelope.operationId, outcome: "accepted", serverSequence: 1, sessionGeneration: 1, code: "structure-conflict" }).success,
      false,
    );
  });

  test("keeps presence ephemeral and bound to the same document", () => {
    assert.equal(collaborationPresenceSchema.safeParse({
      clientId: envelope.clientId,
      cursor: { blockId: identity.documentId, offset: 2 },
      identity,
      sessionGeneration: 1,
      ttlMs: 10_000,
    }).success, true);
    assert.equal(collaborationPresenceSchema.safeParse({
      clientId: envelope.clientId,
      cursor: null,
      identity: { ...identity, documentId: "20260722090002-otherdo" },
      sessionGeneration: 1,
      ttlMs: 10_000,
    }).success, true);
  });

  test("keeps viewer capability explicit and OpenAPI strict", () => {
    assert.equal(collaborationJoinRequestSchema.safeParse({ ...identity, clientId: envelope.clientId, capability: "viewer" }).success, false);
    assert.equal(collaborationJoinRequestSchema.safeParse({ featureMode: "standard", identity, clientId: envelope.clientId, capability: "viewer", protocolVersion: 1 }).success, true);
    assert.equal(COLLABORATION_OPERATION_ENVELOPE_OPENAPI_SCHEMA.additionalProperties, false);
    assert.equal(collaborationBroadcastSchema.safeParse({ identity, operation: envelope, serverSequence: 1 }).success, true);
  });
});
