import { randomUUID } from "node:crypto";

import {
  createIsolatedPostgres,
  type IsolatedPostgres,
} from "@singularity/database/testing/postgres";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { DatabaseClient, Prisma } from "../src/index.js";

interface ManagedSpaceFixture {
  organizationId: string;
  spaceId: string;
  userId: string;
}

async function createManagedSpace(
  database: DatabaseClient,
  status: "active" | "archived" = "active",
): Promise<ManagedSpaceFixture> {
  const user = await database.user.create({
    data: {
      loginIdentifier: `l1-${randomUUID()}@example.com`,
      passwordDigest: "digest",
      status: "active",
    },
  });
  const organization = await database.organization.create({
    data: { name: `L1 ${randomUUID()}`, status: "active" },
  });
  await database.organizationMembership.create({
    data: {
      organizationId: organization.id,
      role: "owner",
      status: "active",
      userId: user.id,
    },
  });
  const space = await database.space.create({
    data: {
      name: `Space ${randomUUID()}`,
      organizationId: organization.id,
      status,
    },
  });
  await database.spaceMembership.create({
    data: {
      organizationId: organization.id,
      role: "admin",
      spaceId: space.id,
      status: "active",
      userId: user.id,
    },
  });
  return {
    organizationId: organization.id,
    spaceId: space.id,
    userId: user.id,
  };
}

describe("L1 PostgreSQL control-plane contracts", () => {
  let database: DatabaseClient;
  let isolated: IsolatedPostgres;

  beforeAll(async () => {
    isolated = await createIsolatedPostgres({ purpose: "l1_contracts" });
    database = new DatabaseClient(isolated.databaseUrl);
    try {
      await database.$connect();
    } catch (error) {
      await isolated.dispose();
      throw error;
    }
  });

  afterAll(async () => {
    await database.$disconnect();
    await isolated.dispose();
  });

  test("binds document shares and challenges to one tenant and credential", async () => {
    const owner = await createManagedSpace(database);
    const other = await createManagedSpace(database);
    const shareId = randomUUID();
    const tokenDigest = "a".repeat(64);
    const createdAt = new Date("2026-07-18T00:00:00.000Z");
    const expiresAt = new Date("2026-07-19T00:00:00.000Z");

    await database.$executeRaw(
      Prisma.sql`
        INSERT INTO "document_shares" (
          "id", "organization_id", "space_id", "notebook_id", "document_id",
          "token_digest", "password_version", "expires_at",
          "created_by_user_id", "created_at"
        ) VALUES (
          ${shareId}::uuid, ${owner.organizationId}::uuid,
          ${owner.spaceId}::uuid, '20260718010101-abcdefg',
          '20260718010102-hijklmn', ${tokenDigest}, 1, ${expiresAt},
          ${owner.userId}::uuid, ${createdAt}
        )
      `,
    );
    await database.$executeRaw(
      Prisma.sql`
        INSERT INTO "share_challenges" (
          "id", "share_id", "token_digest", "password_version",
          "absolute_expires_at", "created_at"
        ) VALUES (
          ${randomUUID()}::uuid, ${shareId}::uuid, ${"b".repeat(64)}, 1,
          ${expiresAt}, ${createdAt}
        )
      `,
    );

    await expect(
      database.$executeRaw(
        Prisma.sql`
          INSERT INTO "document_shares" (
            "id", "organization_id", "space_id", "notebook_id", "document_id",
            "token_digest", "password_version", "expires_at",
            "created_by_user_id", "created_at"
          ) VALUES (
            ${randomUUID()}::uuid, ${owner.organizationId}::uuid,
            ${owner.spaceId}::uuid, '20260718010101-abcdefg',
            '20260718010102-hijklmn', ${tokenDigest}, 1, ${expiresAt},
            ${owner.userId}::uuid, ${createdAt}
          )
        `,
      ),
    ).rejects.toThrow();
    await expect(
      database.$executeRaw(
        Prisma.sql`
          INSERT INTO "document_shares" (
            "id", "organization_id", "space_id", "notebook_id", "document_id",
            "token_digest", "password_version", "expires_at",
            "created_by_user_id", "created_at"
          ) VALUES (
            ${randomUUID()}::uuid, ${owner.organizationId}::uuid,
            ${other.spaceId}::uuid, '20260718010101-abcdefg',
            '20260718010102-hijklmn', ${"c".repeat(64)}, 1, ${expiresAt},
            ${owner.userId}::uuid, ${createdAt}
          )
        `,
      ),
    ).rejects.toThrow();
  });

  test("accepts only the next audit link and rejects event mutation", async () => {
    const fixture = await createManagedSpace(database);
    const eventId = randomUUID();
    const mac = "d".repeat(64);

    await database.$executeRaw(
      Prisma.sql`
        INSERT INTO "organization_audit_sequences" (
          "organization_id", "last_sequence", "last_mac"
        ) VALUES (${fixture.organizationId}::uuid, 0, NULL)
      `,
    );
    await database.$executeRaw(
      Prisma.sql`
        INSERT INTO "audit_events" (
          "id", "organization_id", "sequence", "space_id", "actor_user_id",
          "action", "target_type", "target_id", "outcome", "occurred_at",
          "request_id", "previous_mac", "mac", "key_version"
        ) VALUES (
          ${eventId}::uuid, ${fixture.organizationId}::uuid, 1,
          ${fixture.spaceId}::uuid, ${fixture.userId}::uuid,
          'permission.change', 'group', ${randomUUID()}, 'succeeded',
          ${new Date("2026-07-18T00:00:00.000Z")}, ${randomUUID()}::uuid,
          NULL, ${mac}, 'audit-v1'
        )
      `,
    );
    await database.$executeRaw(
      Prisma.sql`
        UPDATE "organization_audit_sequences"
        SET "last_sequence" = 1, "last_mac" = ${mac}
        WHERE "organization_id" = ${fixture.organizationId}::uuid
      `,
    );

    await expect(
      database.$executeRaw(
        Prisma.sql`
          UPDATE "audit_events"
          SET "outcome" = 'failed'
          WHERE "id" = ${eventId}::uuid
        `,
      ),
    ).rejects.toThrow();
    await expect(
      database.$executeRaw(
        Prisma.sql`
          INSERT INTO "audit_events" (
            "id", "organization_id", "sequence", "actor_user_id", "action",
            "target_type", "target_id", "outcome", "occurred_at", "request_id",
            "previous_mac", "mac", "key_version"
          ) VALUES (
            ${randomUUID()}::uuid, ${fixture.organizationId}::uuid, 3,
            ${fixture.userId}::uuid, 'permission.change', 'user',
            ${fixture.userId}, 'denied', ${new Date()}, ${randomUUID()}::uuid,
            ${mac}, ${"e".repeat(64)}, 'audit-v1'
          )
        `,
      ),
    ).rejects.toThrow();
  });

  test("enforces worker payload and lease lifecycle states", async () => {
    const fixture = await createManagedSpace(database);
    const now = new Date("2026-07-18T00:00:00.000Z");

    await database.$executeRaw(
      Prisma.sql`
        INSERT INTO "worker_jobs" (
          "id", "organization_id", "kind", "status", "payload", "request_id",
          "attempt", "available_at", "created_at", "updated_at"
        ) VALUES (
          ${randomUUID()}::uuid, ${fixture.organizationId}::uuid,
          'sample-kernel', 'queued', ${JSON.stringify({
            kernelInstanceId: randomUUID(),
            spaceId: fixture.spaceId,
          })}::jsonb, ${randomUUID()}::uuid, 0, ${now}, ${now}, ${now}
        )
      `,
    );

    await expect(
      database.$executeRaw(
        Prisma.sql`
          INSERT INTO "worker_jobs" (
            "id", "organization_id", "kind", "status", "payload", "request_id",
            "attempt", "available_at", "worker_id", "created_at", "updated_at"
          ) VALUES (
            ${randomUUID()}::uuid, ${fixture.organizationId}::uuid,
            'backup-space', 'queued', '{}'::jsonb, ${randomUUID()}::uuid,
            0, ${now}, 'worker-1', ${now}, ${now}
          )
        `,
      ),
    ).rejects.toThrow();
    await expect(
      database.$executeRaw(
        Prisma.sql`
          INSERT INTO "worker_jobs" (
            "id", "organization_id", "kind", "status", "payload", "request_id",
            "attempt", "available_at", "created_at", "updated_at"
          ) VALUES (
            ${randomUUID()}::uuid, ${fixture.organizationId}::uuid,
            'archive-audit', 'queued', '[]'::jsonb, ${randomUUID()}::uuid,
            0, ${now}, ${now}, ${now}
          )
        `,
      ),
    ).rejects.toThrow();
  });

  test("enforces backup and isolated-restore terminal states", async () => {
    const fixture = await createManagedSpace(database);
    const target = await database.space.create({
      data: {
        name: `Restored ${randomUUID()}`,
        organizationId: fixture.organizationId,
        status: "archived",
      },
    });
    const invalidTarget = await database.space.create({
      data: {
        name: `Invalid ${randomUUID()}`,
        organizationId: fixture.organizationId,
        status: "archived",
      },
    });
    const backupId = randomUUID();
    const createdAt = new Date("2026-07-18T00:00:00.000Z");
    const completedAt = new Date("2026-07-18T00:01:00.000Z");

    await database.$executeRaw(
      Prisma.sql`
        INSERT INTO "space_backups" (
          "id", "organization_id", "source_space_id", "status", "object_key",
          "format_version", "kernel_version", "sha256", "size_bytes",
          "created_by_user_id", "created_at", "completed_at"
        ) VALUES (
          ${backupId}::uuid, ${fixture.organizationId}::uuid,
          ${fixture.spaceId}::uuid, 'succeeded', ${"A".repeat(43)}, 1,
          '3.7.2', ${"f".repeat(64)}, 1024, ${fixture.userId}::uuid,
          ${createdAt}, ${completedAt}
        )
      `,
    );
    await database.$executeRaw(
      Prisma.sql`
        INSERT INTO "space_restore_jobs" (
          "id", "organization_id", "backup_id", "source_space_id",
          "target_space_id", "status", "created_by_user_id", "created_at",
          "completed_at"
        ) VALUES (
          ${randomUUID()}::uuid, ${fixture.organizationId}::uuid,
          ${backupId}::uuid, ${fixture.spaceId}::uuid, ${target.id}::uuid,
          'ready-for-activation', ${fixture.userId}::uuid, ${createdAt},
          ${completedAt}
        )
      `,
    );

    await expect(
      database.$executeRaw(
        Prisma.sql`
          INSERT INTO "space_restore_jobs" (
            "id", "organization_id", "backup_id", "source_space_id",
            "target_space_id", "status", "created_by_user_id", "created_at"
          ) VALUES (
            ${randomUUID()}::uuid, ${fixture.organizationId}::uuid,
            ${backupId}::uuid, ${fixture.spaceId}::uuid,
            ${invalidTarget.id}::uuid, 'ready-for-activation',
            ${fixture.userId}::uuid, ${createdAt}
          )
        `,
      ),
    ).rejects.toThrow();
  });

  test("binds capacity observations to the Kernel instance space", async () => {
    const fixture = await createManagedSpace(database);
    const otherSpace = await database.space.create({
      data: {
        name: `Other ${randomUUID()}`,
        organizationId: fixture.organizationId,
        status: "active",
      },
    });
    const kernel = await database.kernelInstance.create({
      data: {
        deploymentHandle: `kernel-${randomUUID()}`,
        spaceId: fixture.spaceId,
        status: "ready",
        version: "3.7.2",
      },
    });

    await database.$executeRaw(
      Prisma.sql`
        INSERT INTO "space_capacity_observations" (
          "id", "kernel_instance_id", "space_id", "data_bytes", "asset_bytes",
          "file_count", "sample_duration_milliseconds", "sampled_at"
        ) VALUES (
          ${randomUUID()}::uuid, ${kernel.id}::uuid, ${fixture.spaceId}::uuid,
          10, 2, 3, 4, ${new Date()}
        )
      `,
    );
    await expect(
      database.$executeRaw(
        Prisma.sql`
          INSERT INTO "space_capacity_observations" (
            "id", "kernel_instance_id", "space_id", "data_bytes", "asset_bytes",
            "file_count", "sample_duration_milliseconds", "sampled_at"
          ) VALUES (
            ${randomUUID()}::uuid, ${kernel.id}::uuid, ${otherSpace.id}::uuid,
            10, 2, 3, 4, ${new Date()}
          )
        `,
      ),
    ).rejects.toThrow();
  });
});
