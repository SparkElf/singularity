import { randomUUID } from "node:crypto";

import { createIsolatedPostgres, type IsolatedPostgres } from "@singularity/database/testing/postgres";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { DatabaseClient, Prisma } from "../src/index.js";

const notebookId = "20260723090000-l4book1";
const documentId = "20260723090001-l4doc01";

describe("L4 governance PostgreSQL contracts", () => {
  let database: DatabaseClient;
  let isolated: IsolatedPostgres;
  let organizationId: string;
  let spaceId: string;
  let userId: string;

  beforeAll(async () => {
    isolated = await createIsolatedPostgres({ purpose: "l4_governance" });
    database = new DatabaseClient(isolated.databaseUrl);
    await database.$connect();
    const user = await database.user.create({
      data: { loginIdentifier: `l4-${randomUUID()}@example.com`, passwordDigest: "digest", status: "active" },
    });
    userId = user.id;
    const organization = await database.organization.create({ data: { name: `L4 ${randomUUID()}`, status: "active" } });
    organizationId = organization.id;
    await database.organizationMembership.create({ data: { organizationId, role: "owner", status: "active", userId } });
    const space = await database.space.create({ data: { name: `L4 space ${randomUUID()}`, organizationId, status: "active" } });
    spaceId = space.id;
    await database.spaceMembership.create({ data: { organizationId, role: "admin", status: "active", spaceId, userId } });
  });

  afterAll(async () => {
    await database.$disconnect();
    await isolated.dispose();
  });

  test("keeps governance policy and document facts in one tenant scope", async () => {
    await database.governancePolicy.create({ data: { organizationId, spaceId, createdByUserId: userId } });
    await database.documentGovernance.create({
      data: { organizationId, spaceId, notebookId, documentId, classification: "internal", lifecycle: "draft", verification: "needs_review", ownerUserId: userId },
    });
    await expect(database.documentGovernance.create({
      data: { organizationId, spaceId, notebookId, documentId, classification: "internal", lifecycle: "draft", verification: "needs_review", ownerUserId: userId },
    })).rejects.toThrow();
    await expect(database.$executeRaw(Prisma.sql`
      INSERT INTO "document_governance" ("organization_id", "space_id", "notebook_id", "document_id", "lifecycle", "verification", "classification")
      VALUES (${organizationId}::uuid, ${spaceId}::uuid, ${notebookId}, 'invalid-document', 'draft', 'needs_review', 'internal')
    `)).rejects.toThrow();
  });

  test("makes approval requests and governance tasks idempotent by explicit version and key", async () => {
    const versionToken = "kernel-version-1";
    await database.governanceApprovalRequest.create({ data: { organizationId, spaceId, notebookId, documentId: "20260723090002-l4doc02", versionToken, submittedByUserId: userId, status: "pending" } });
    await expect(database.governanceApprovalRequest.create({ data: { organizationId, spaceId, notebookId, documentId: "20260723090002-l4doc02", versionToken, submittedByUserId: userId, status: "pending" } })).rejects.toThrow();
    const idempotencyKey = `verify:${organizationId}:${spaceId}:${notebookId}:${documentId}:${versionToken}`;
    await database.governanceTask.create({ data: { organizationId, spaceId, notebookId, documentId, idempotencyKey, kind: "verify", status: "queued" } });
    await expect(database.governanceTask.create({ data: { organizationId, spaceId, notebookId, documentId, idempotencyKey, kind: "verify", status: "queued" } })).rejects.toThrow();
  });

  test("keeps machine credentials and MFA material outside plaintext audit fields", async () => {
    await database.enterpriseApiKey.create({ data: { organizationId, userId, name: "automation", keyPrefix: "sk_sing_test", secretDigest: "a".repeat(64), scopes: ["governance.read"] } });
    await database.mfaFactor.create({ data: { userId, label: "primary", encryptedSecret: "v1:encrypted-envelope" } });
    const key = await database.enterpriseApiKey.findFirstOrThrow({ where: { organizationId, userId } });
    const factor = await database.mfaFactor.findFirstOrThrow({ where: { userId, label: "primary" } });
    expect(key.secretDigest).toHaveLength(64);
    expect(factor.encryptedSecret).toMatch(/^v1:/);
  });

  test("requires a personal space owner to remain in the same organization", async () => {
    const otherUser = await database.user.create({
      data: { loginIdentifier: `l4-other-${randomUUID()}@example.com`, passwordDigest: "digest", status: "active" },
    });
    const unownedSpace = await database.space.create({
      data: { name: `unowned ${randomUUID()}`, organizationId, status: "active" },
    });
    await expect(database.personalSpace.create({
      data: { organizationId, userId: otherUser.id, spaceId: unownedSpace.id },
    })).rejects.toThrow();
  });
});
