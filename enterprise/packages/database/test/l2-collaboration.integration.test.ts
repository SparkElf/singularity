import { randomUUID } from "node:crypto";

import { createIsolatedPostgres, type IsolatedPostgres } from "@singularity/database/testing/postgres";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { DatabaseClient, Prisma } from "../src/index.js";

const notebookId = "20260721090000-bookabc";
const documentId = "20260721090001-docabcd";

describe("L2 collaboration PostgreSQL contracts", () => {
  let database: DatabaseClient;
  let isolated: IsolatedPostgres;
  let organizationId: string;
  let spaceId: string;
  let userId: string;

  beforeAll(async () => {
    isolated = await createIsolatedPostgres({ purpose: "l2_collaboration" });
    database = new DatabaseClient(isolated.databaseUrl);
    await database.$connect();
    const user = await database.user.create({
      data: { loginIdentifier: `l2-${randomUUID()}@example.com`, passwordDigest: "digest", status: "active" },
    });
    userId = user.id;
    const organization = await database.organization.create({
      data: { name: `L2 ${randomUUID()}`, status: "active" },
    });
    organizationId = organization.id;
    await database.organizationMembership.create({
      data: { organizationId, role: "owner", status: "active", userId },
    });
    const space = await database.space.create({
      data: { name: `Space ${randomUUID()}`, organizationId, status: "active" },
    });
    spaceId = space.id;
    await database.spaceMembership.create({
      data: { organizationId, role: "admin", spaceId, status: "active", userId },
    });
  });

  afterAll(async () => {
    await database.$disconnect();
    await isolated.dispose();
  });

  test("binds policy grants to the complete document identity", async () => {
    const policy = await database.documentAccessPolicy.create({
      data: { documentId, mode: "restricted", notebookId, organizationId, spaceId },
    });
    await database.documentAccessGrant.create({
      data: {
        documentId,
        kind: "user",
        notebookId,
        organizationId,
        policyId: policy.id,
        role: "viewer",
        spaceId,
        userId,
      },
    });
    await expect(
      database.$executeRaw(
        Prisma.sql`
          INSERT INTO "document_access_grants" (
            "policy_id", "organization_id", "space_id", "notebook_id", "document_id",
            "kind", "user_id", "role"
          ) VALUES (
            ${policy.id}::uuid, ${organizationId}::uuid, ${spaceId}::uuid,
            ${notebookId}, '20260721090002-otherdoc', 'user', ${userId}::uuid, 'viewer'
          )
        `,
      ),
    ).rejects.toThrow();
  });

  test("rejects invalid block anchors at the database boundary", async () => {
    await expect(
      database.$executeRaw(
        Prisma.sql`
          INSERT INTO "comment_threads" (
            "organization_id", "space_id", "notebook_id", "document_id",
            "anchor_block_id", "status", "created_by_user_id"
          ) VALUES (
            ${organizationId}::uuid, ${spaceId}::uuid, ${notebookId}, ${documentId},
            'not-a-block', 'open', ${userId}::uuid
          )
        `,
      ),
    ).rejects.toThrow();
  });

  test("enforces notification idempotency per recipient and event", async () => {
    await database.notification.create({
      data: {
        documentId,
        eventKey: `mention:${randomUUID()}`,
        kind: "mention",
        notebookId,
        organizationId,
        recipientUserId: userId,
        spaceId,
      },
    });
    const eventKey = `mention:${randomUUID()}`;
    await database.notification.create({
      data: {
        documentId,
        eventKey,
        kind: "mention",
        notebookId,
        organizationId,
        recipientUserId: userId,
        spaceId,
      },
    });
    await expect(
      database.notification.create({
        data: {
          documentId,
          eventKey,
          kind: "mention",
          notebookId,
          organizationId,
          recipientUserId: userId,
          spaceId,
        },
      }),
    ).rejects.toThrow();
  });
});
