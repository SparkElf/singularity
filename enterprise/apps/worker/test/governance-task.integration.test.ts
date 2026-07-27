import { createSecretKey, randomUUID } from "node:crypto";

import { AuditWriter, DatabaseRuntime } from "@singularity/database";
import { isolatedDatabaseUrl } from "@singularity/database/testing/postgres";
import { beforeAll, afterAll, describe, expect, it } from "vitest";

import { GovernanceTaskHandler } from "../src/governance-task-handler.js";
import type { WorkerJobLogger } from "../src/worker.js";

const logger: WorkerJobLogger = {
  debug: () => undefined,
  error: () => undefined,
  info: () => undefined,
  warn: () => undefined,
};

describe("governance task worker integration", () => {
  let database: DatabaseRuntime;
  const audit = new AuditWriter({ hmacKey: createSecretKey(Buffer.alloc(32, 7)), keyVersion: "governance-worker-test-v1" });

  beforeAll(() => {
    database = new DatabaseRuntime(isolatedDatabaseUrl());
  });

  afterAll(async () => {
    await database.onApplicationShutdown();
  });

  it("executes a verification task exactly once and records its state", async () => {
    const organizationId = randomUUID();
    const userId = randomUUID();
    const spaceId = randomUUID();
    const notebookId = "20260723120000-worker1";
    const documentId = "20260723120001-worker1";
    await database.client.organization.create({ data: { id: organizationId, name: "Worker Governance", status: "active" } });
    await database.client.user.create({ data: { id: userId, loginIdentifier: `${randomUUID()}@example.test`, passwordDigest: null, status: "active" } });
    await database.client.organizationMembership.create({ data: { organizationId, role: "owner", status: "active", userId } });
    await database.client.space.create({ data: { id: spaceId, name: "Worker Space", organizationId, status: "active" } });
    await database.client.governancePolicy.create({ data: { archiveAfterDays: 365, createdByUserId: userId, defaultClassification: "internal", governanceEnabled: true, organizationId, retentionDays: 2555, spaceId, verificationGraceDays: 30, verificationIntervalDays: 180, watermarkEnabled: true } });
    const document = await database.client.documentGovernance.create({ data: { classification: "internal", documentId, lifecycle: "draft", nextVerificationAt: new Date(), notebookId, organizationId, ownerUserId: userId, spaceId, verification: "needs_review" } });
    const task = await database.client.governanceTask.create({ data: { documentId, idempotencyKey: `worker:${randomUUID()}`, kind: "verify", notebookId, organizationId, spaceId, status: "queued" } });
    const handler = new GovernanceTaskHandler(database, audit, logger);
    await handler.execute({ attempt: 1, documentId, id: randomUUID(), kind: "governance-task", leaseExpiresAt: new Date(Date.now() + 30_000), notebookId, organizationId, requestId: randomUUID(), spaceId, taskId: task.id, taskKind: "verify" }, new AbortController().signal);
    const updated = await database.client.documentGovernance.findUnique({ where: { id: document.id } });
    const completed = await database.client.governanceTask.findUnique({ where: { id: task.id } });
    expect(updated?.verification).toBe("verified");
    expect(completed?.status).toBe("succeeded");
    expect(await database.client.auditEvent.count({ where: { organizationId, targetId: documentId, outcome: "succeeded" } })).toBe(1);
    await handler.execute({ attempt: 2, documentId, id: randomUUID(), kind: "governance-task", leaseExpiresAt: new Date(Date.now() + 30_000), notebookId, organizationId, requestId: randomUUID(), spaceId, taskId: task.id, taskKind: "verify" }, new AbortController().signal);
    expect((await database.client.documentGovernance.findUnique({ where: { id: document.id } }))?.verification).toBe("verified");
  });

  it("fails closed when an export watermark task reaches the worker", async () => {
    const organizationId = randomUUID();
    const userId = randomUUID();
    const spaceId = randomUUID();
    const notebookId = "20260723120002-worker2";
    const documentId = "20260723120003-worker2";
    await database.client.organization.create({ data: { id: organizationId, name: "Worker Export", status: "active" } });
    await database.client.user.create({ data: { id: userId, loginIdentifier: `${randomUUID()}@example.test`, passwordDigest: null, status: "active" } });
    await database.client.organizationMembership.create({ data: { organizationId, role: "owner", status: "active", userId } });
    await database.client.space.create({ data: { id: spaceId, name: "Worker Export Space", organizationId, status: "active" } });
    await database.client.governancePolicy.create({ data: { archiveAfterDays: 365, createdByUserId: userId, defaultClassification: "internal", governanceEnabled: true, organizationId, retentionDays: 2555, spaceId, verificationGraceDays: 30, verificationIntervalDays: 180, watermarkEnabled: true } });
    await database.client.documentGovernance.create({ data: { classification: "internal", documentId, lifecycle: "draft", notebookId, organizationId, ownerUserId: userId, spaceId, verification: "needs_review" } });
    const task = await database.client.governanceTask.create({ data: { documentId, idempotencyKey: `worker:${randomUUID()}`, kind: "export_watermark", notebookId, organizationId, spaceId, status: "queued" } });
    const handler = new GovernanceTaskHandler(database, audit, logger);

    await expect(handler.execute({ attempt: 1, documentId, id: randomUUID(), kind: "governance-task", leaseExpiresAt: new Date(Date.now() + 30_000), notebookId, organizationId, requestId: randomUUID(), spaceId, taskId: task.id, taskKind: "export_watermark" }, new AbortController().signal)).rejects.toThrow("governance-task-kind-unsupported");
    expect((await database.client.governanceTask.findUnique({ where: { id: task.id } }))?.status).toBe("queued");
    expect(await database.client.auditEvent.count({ where: { organizationId, targetId: documentId, outcome: "failed" } })).toBe(1);
  });

  it("cancels an in-flight task when the governance gate is closed and honors legal hold", async () => {
    const organizationId = randomUUID();
    const userId = randomUUID();
    const spaceId = randomUUID();
    const notebookId = "20260723120004-worker3";
    const documentId = "20260723120005-worker3";
    await database.client.organization.create({ data: { id: organizationId, name: "Worker Retention", status: "active" } });
    await database.client.user.create({ data: { id: userId, loginIdentifier: `${randomUUID()}@example.test`, passwordDigest: null, status: "active" } });
    await database.client.organizationMembership.create({ data: { organizationId, role: "owner", status: "active", userId } });
    await database.client.space.create({ data: { id: spaceId, name: "Worker Retention Space", organizationId, status: "active" } });
    await database.client.governancePolicy.create({ data: { archiveAfterDays: 365, createdByUserId: userId, defaultClassification: "internal", governanceEnabled: true, organizationId, retentionDays: 2555, spaceId, verificationGraceDays: 30, verificationIntervalDays: 180, watermarkEnabled: true } });
    const document = await database.client.documentGovernance.create({ data: { classification: "internal", documentId, lifecycle: "published", legalHold: true, notebookId, organizationId, ownerUserId: userId, spaceId, verification: "needs_review" } });
    const task = await database.client.governanceTask.create({ data: { documentId, idempotencyKey: `worker:${randomUUID()}`, kind: "archive", notebookId, organizationId, spaceId, status: "queued" } });
    const handler = new GovernanceTaskHandler(database, audit, logger);

    await handler.execute({ attempt: 1, documentId, id: randomUUID(), kind: "governance-task", leaseExpiresAt: new Date(Date.now() + 30_000), notebookId, organizationId, requestId: randomUUID(), spaceId, taskId: task.id, taskKind: "archive" }, new AbortController().signal);

    expect((await database.client.governanceTask.findUnique({ where: { id: task.id } }))?.status).toBe("succeeded");
    expect((await database.client.documentGovernance.findUnique({ where: { id: document.id } }))?.lifecycle).toBe("published");
    expect(await database.client.auditEvent.count({ where: { organizationId, targetId: documentId, outcome: "succeeded" } })).toBe(1);

    await database.client.governancePolicy.update({ where: { organizationId_spaceId: { organizationId, spaceId } }, data: { governanceEnabled: false } });
    const cancelledTask = await database.client.governanceTask.create({ data: { documentId, idempotencyKey: `worker:${randomUUID()}`, kind: "retain", notebookId, organizationId, spaceId, status: "queued" } });
    await handler.execute({ attempt: 1, documentId, id: randomUUID(), kind: "governance-task", leaseExpiresAt: new Date(Date.now() + 30_000), notebookId, organizationId, requestId: randomUUID(), spaceId, taskId: cancelledTask.id, taskKind: "retain" }, new AbortController().signal);

    expect((await database.client.governanceTask.findUnique({ where: { id: cancelledTask.id } }))?.status).toBe("cancelled");
    expect(await database.client.auditEvent.count({ where: { organizationId, targetId: documentId, outcome: "denied" } })).toBe(1);
  });
});
