import { describe, expect, it, vi } from "vitest";

import {
  CollaborationCoordinator,
  type CollaborationFeatureGate,
  type KernelCollaborationPort,
} from "../src/collaboration/realtime-coordinator.js";

const identity = {
  documentId: "20260722090000-docabcd",
  notebookId: "20260722090001-bookabc",
  organizationId: "11111111-1111-4111-8111-111111111111",
  spaceId: "22222222-2222-4222-8222-222222222222",
} as const;
const clientId = "33333333-3333-4333-8333-333333333333";
const operationId = "44444444-4444-4444-8444-444444444444";

function operationEnvelope() {
  return {
    causalContext: {},
    clientId,
    clientSequence: 1,
    identity,
    operation: {
      blockId: "20260722090002-block01",
      kind: "text.insert" as const,
      position: 0,
      text: "hello",
    },
    operationId,
    sessionGeneration: 1,
  };
}

function createCoordinator() {
  const handler = {
    execute: vi.fn().mockResolvedValue({
      broadcast: null,
      result: {
        identity,
        operationId,
        outcome: "accepted" as const,
        serverSequence: 1,
        sessionGeneration: 1,
      },
    }),
  };
  const access = {
    requireDocumentRole: vi.fn().mockResolvedValue(undefined),
  };
  const kernel: KernelCollaborationPort = {
    admit: vi.fn().mockResolvedValue({ sessionGeneration: 1, version: {} }),
    apply: vi.fn(),
    replay: vi.fn().mockResolvedValue([]),
  };
  const featureGate: CollaborationFeatureGate = {
    closeSession: vi.fn().mockResolvedValue(undefined),
    isEnabled: vi.fn().mockResolvedValue(true),
    openSession: vi.fn().mockResolvedValue(undefined),
    recordOperation: vi.fn().mockResolvedValue(undefined),
    recordResume: vi.fn().mockResolvedValue(undefined),
  };
  const clock = { now: () => new Date(0) };
  const discovery = { handlers: () => new Map([["text.insert:v1", handler]]) };
  const coordinator = new CollaborationCoordinator(
    access as never,
    kernel,
    featureGate,
    clock,
    discovery as never,
  );
  return { coordinator, featureGate, handler };
}

async function join(
  coordinator: CollaborationCoordinator,
  actorUserId = "user-1",
  connectionId = "55555555-5555-4555-8555-555555555555",
) {
  return coordinator.join({
    actorUserId,
    authSessionId: "auth-session-1",
    connectionId,
    requestId: "request-1",
    value: {
      capability: "editor",
      clientId,
      featureMode: "standard",
      identity,
      protocolVersion: 1,
    },
  });
}

describe("production collaboration session binding", () => {
  it("reserves a client admission before asynchronous checks complete", async () => {
    const { coordinator, featureGate } = createCoordinator();
    let releaseAdmission!: () => void;
    const admissionPaused = new Promise<void>((resolve) => {
      releaseAdmission = resolve;
    });
    vi.mocked(featureGate.isEnabled).mockImplementationOnce(async () => {
      await admissionPaused;
      return true;
    });

    const first = join(coordinator);
    const duplicate = join(coordinator, "user-2", "66666666-6666-4666-8666-666666666666");
    await expect(duplicate).rejects.toMatchObject({ code: "duplicate-session" });
    releaseAdmission();
    await expect(first).resolves.toMatchObject({ sessionState: "ready" });
  });

  it("rejects submit from a different authenticated user", async () => {
    const { coordinator, handler } = createCoordinator();
    await join(coordinator);

    const submitted = await coordinator.submit({
      actorUserId: "user-2",
      clientId,
      connectionId: "55555555-5555-4555-8555-555555555555",
      requestId: "request-2",
      value: operationEnvelope(),
    });

    expect(submitted.result).toMatchObject({ code: "permission-revoked", outcome: "rejected" });
    expect(handler.execute).not.toHaveBeenCalled();
  });

  it("removes revoked sessions before late submit or resume can consume them", async () => {
    const { coordinator, featureGate } = createCoordinator();
    await join(coordinator);

    expect(coordinator.revoke(clientId, "55555555-5555-4555-8555-555555555555")).toMatchObject({
      identity,
      sessionState: "revoked",
    });
    const submitted = await coordinator.submit({
      actorUserId: "user-1",
      clientId,
      connectionId: "55555555-5555-4555-8555-555555555555",
      requestId: "request-2",
      value: operationEnvelope(),
    });
    const resumed = await coordinator.resume({
      actorUserId: "user-1",
      connectionId: "55555555-5555-4555-8555-555555555555",
      requestId: "request-3",
      value: {
        causalContext: {},
        clientId,
        identity,
        sessionGeneration: 1,
      },
    });

    expect(submitted.result).toMatchObject({ code: "session-not-ready", outcome: "rejected" });
    expect(resumed).toEqual([]);
    expect(featureGate.closeSession).toHaveBeenCalledWith(expect.objectContaining({ status: "revoked" }));
  });

  it("removes revoked presence without affecting other identities", async () => {
    const { coordinator } = createCoordinator();
    await join(coordinator);
    expect(coordinator.updatePresence({
      actorUserId: "user-1",
      connectionId: "55555555-5555-4555-8555-555555555555",
      requestId: "request-5",
      value: {
        clientId,
        cursor: null,
        identity,
        sessionGeneration: 1,
        ttlMs: 10_000,
      },
    })).toHaveLength(1);

    coordinator.revoke(clientId, "55555555-5555-4555-8555-555555555555");
    expect(coordinator.presence(identity)).toEqual([]);
    expect(coordinator.presence({
      ...identity,
      documentId: "20260722090003-otherdoc",
    })).toEqual([]);
  });

  it("does not let an old connection close or submit through a replacement session", async () => {
    const { coordinator, handler } = createCoordinator();
    await join(coordinator);
    coordinator.close(clientId, "55555555-5555-4555-8555-555555555555");
    await join(coordinator, "user-1", "66666666-6666-4666-8666-666666666666");

    coordinator.close(clientId, "55555555-5555-4555-8555-555555555555");
    const submitted = await coordinator.submit({
      actorUserId: "user-1",
      clientId,
      connectionId: "55555555-5555-4555-8555-555555555555",
      requestId: "request-4",
      value: operationEnvelope(),
    });

    expect(submitted.result).toMatchObject({ code: "permission-revoked", outcome: "rejected" });
    expect(handler.execute).not.toHaveBeenCalled();
  });

  it("records a canonical-history resume against the bound session", async () => {
    const { coordinator, featureGate } = createCoordinator();
    await join(coordinator);

    await expect(coordinator.resume({
      actorUserId: "user-1",
      connectionId: "55555555-5555-4555-8555-555555555555",
      requestId: "request-6",
      value: {
        causalContext: {},
        clientId,
        identity,
        sessionGeneration: 1,
      },
    })).resolves.toEqual([]);
    expect(featureGate.recordResume).toHaveBeenCalledWith(expect.objectContaining({
      clientId,
      identity,
      sessionGeneration: 1,
    }));
  });
});
