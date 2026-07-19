import { execFile } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  createIsolatedPostgres,
  type IsolatedPostgres,
} from "@singularity/database/testing/postgres";
import { Client, escapeIdentifier, escapeLiteral } from "pg";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { DatabaseClient } from "../src/index.js";

const execFileAsync = promisify(execFile);
const auditPrivilegesPath = fileURLToPath(
  new URL("../deploy/audit-privileges.sql", import.meta.url),
);

function ownerConnectionUrl(databaseUrl: string): string {
  const url = new URL(databaseUrl);
  url.searchParams.delete("schema");
  return url.toString();
}

function roleConnectionUrl(
  databaseUrl: string,
  role: string,
  password: string,
): string {
  const url = new URL(ownerConnectionUrl(databaseUrl));
  url.username = role;
  url.password = password;
  return url.toString();
}

describe("ADR-017 PostgreSQL audit ACL deployment", () => {
  let database: DatabaseClient;
  let isolated: IsolatedPostgres;

  beforeAll(async () => {
    isolated = await createIsolatedPostgres({ purpose: "audit_acl" });
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

  test("applies the deployment ACL and enforces append-only access for restricted logins", async () => {
    const suffix = randomBytes(6).toString("hex");
    const writerRole = `sg_audit_writer_${suffix}`;
    const readerRole = `sg_audit_reader_${suffix}`;
    const writerPassword = randomBytes(24).toString("base64url");
    const readerPassword = randomBytes(24).toString("base64url");
    const owner = new Client({
      connectionString: ownerConnectionUrl(isolated.databaseUrl),
    });
    const writer = new Client({
      connectionString: roleConnectionUrl(
        isolated.databaseUrl,
        writerRole,
        writerPassword,
      ),
    });
    const reader = new Client({
      connectionString: roleConnectionUrl(
        isolated.databaseUrl,
        readerRole,
        readerPassword,
      ),
    });
    const auditEvents = `${escapeIdentifier(isolated.schemaName)}.${escapeIdentifier("audit_events")}`;
    const contentAuditIntents = `${escapeIdentifier(isolated.schemaName)}.${escapeIdentifier("content_audit_intents")}`;
    const auditSequences = `${escapeIdentifier(isolated.schemaName)}.${escapeIdentifier("organization_audit_sequences")}`;
    let readerRoleCreated = false;
    let writerRoleCreated = false;
    let writerConnected = false;
    let readerConnected = false;

    await owner.connect();
    try {
      await owner.query(
        `CREATE ROLE ${escapeIdentifier(writerRole)} LOGIN PASSWORD ${escapeLiteral(writerPassword)} NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS`,
      );
      writerRoleCreated = true;
      await owner.query(
        `CREATE ROLE ${escapeIdentifier(readerRole)} LOGIN PASSWORD ${escapeLiteral(readerPassword)} NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS`,
      );
      readerRoleCreated = true;

      const actor = await database.user.create({
        data: {
          loginIdentifier: `audit-acl-${randomUUID()}@example.test`,
          passwordDigest: "digest",
          status: "active",
        },
      });
      const organization = await database.organization.create({
        data: { name: `Audit ACL ${randomUUID()}`, status: "active" },
      });
      await database.organizationMembership.create({
        data: {
          organizationId: organization.id,
          role: "owner",
          status: "active",
          userId: actor.id,
        },
      });

      await execFileAsync(
        "psql",
        [
          "--no-psqlrc",
          "--set=ON_ERROR_STOP=1",
          "--single-transaction",
          `--set=singularity_schema=${isolated.schemaName}`,
          `--set=audit_writer_role=${writerRole}`,
          `--set=audit_reader_role=${readerRole}`,
          ownerConnectionUrl(isolated.databaseUrl),
          "--file",
          auditPrivilegesPath,
        ],
        { maxBuffer: 1024 * 1024, timeout: 10_000 },
      );

      await writer.connect();
      writerConnected = true;
      await reader.connect();
      readerConnected = true;

      const roleAttributes = await Promise.all(
        [writer, reader].map((client) =>
          client.query<{
            rolbypassrls: boolean;
            rolcreatedb: boolean;
            rolcreaterole: boolean;
            rolsuper: boolean;
          }>(`
            SELECT "rolbypassrls", "rolcreatedb", "rolcreaterole", "rolsuper"
            FROM "pg_roles"
            WHERE "rolname" = current_user
          `),
        ),
      );
      expect(roleAttributes.map((result) => result.rows[0])).toEqual([
        {
          rolbypassrls: false,
          rolcreatedb: false,
          rolcreaterole: false,
          rolsuper: false,
        },
        {
          rolbypassrls: false,
          rolcreatedb: false,
          rolcreaterole: false,
          rolsuper: false,
        },
      ]);

      const eventId = randomUUID();
      const requestId = randomUUID();
      const mac = "a".repeat(64);
      await writer.query("BEGIN");
      try {
        await writer.query(
          `INSERT INTO ${auditSequences} ("organization_id", "last_sequence", "last_mac") VALUES ($1::uuid, 0, NULL)`,
          [organization.id],
        );
        await writer.query(
          `
            INSERT INTO ${auditEvents} (
              "id", "organization_id", "sequence", "actor_user_id", "action",
              "target_type", "target_id", "outcome", "occurred_at", "request_id",
              "previous_mac", "mac", "key_version"
            ) VALUES (
              $1::uuid, $2::uuid, 1, $3::uuid, 'permission.change',
              'membership', $3, 'succeeded', $4, $5::uuid, NULL, $6, 'audit-v1'
            )
          `,
          [
            eventId,
            organization.id,
            actor.id,
            new Date("2026-07-19T00:00:00.000Z"),
            requestId,
            mac,
          ],
        );
        await writer.query(
          `UPDATE ${auditSequences} SET "last_sequence" = 1, "last_mac" = $2 WHERE "organization_id" = $1::uuid`,
          [organization.id, mac],
        );
        await writer.query("COMMIT");
      } catch (error) {
        await writer.query("ROLLBACK");
        throw error;
      }

      await expect(
        reader.query(
          `SELECT "id", "sequence", "action"::text AS "action" FROM ${auditEvents} WHERE "id" = $1::uuid`,
          [eventId],
        ),
      ).resolves.toMatchObject({
        rows: [{ action: "permission.change", id: eventId, sequence: "1" }],
      });
      await expect(
        writer.query(`SELECT "id" FROM ${auditEvents} WHERE "id" = $1::uuid`, [
          eventId,
        ]),
      ).rejects.toMatchObject({ code: "42501" });
      await expect(
        writer.query(`UPDATE ${auditEvents} SET "outcome" = 'failed' WHERE "id" = $1::uuid`, [
          eventId,
        ]),
      ).rejects.toMatchObject({ code: "42501" });
      await expect(
        writer.query(`DELETE FROM ${auditEvents} WHERE "id" = $1::uuid`, [eventId]),
      ).rejects.toMatchObject({ code: "42501" });
      await expect(
        writer.query(`TRUNCATE TABLE ${auditEvents}`),
      ).rejects.toMatchObject({ code: "42501" });
      await expect(
        writer.query(
          `
            INSERT INTO ${auditEvents} (
              "id", "organization_id", "sequence", "actor_user_id", "action",
              "target_type", "target_id", "outcome", "occurred_at", "request_id",
              "previous_mac", "mac", "key_version"
            ) VALUES (
              $1::uuid, $2::uuid, 2, $3::uuid, 'permission.change',
              'raw-request', $3, 'succeeded', now(), $4::uuid, $5, $6, 'audit-v1'
            )
          `,
          [
            randomUUID(),
            organization.id,
            actor.id,
            randomUUID(),
            mac,
            "b".repeat(64),
          ],
        ),
      ).rejects.toMatchObject({ code: "23514" });
      await expect(
        writer.query(
          `
            INSERT INTO ${auditEvents} (
              "id", "organization_id", "sequence", "actor_user_id", "action",
              "target_type", "target_id", "outcome", "occurred_at", "request_id",
              "previous_mac", "mac", "key_version"
            ) VALUES (
              $1::uuid, $2::uuid, 2, $3::uuid, 'permission.change',
              'organization', ' ', 'succeeded', now(), $4::uuid, $5, $6, 'audit-v1'
            )
          `,
          [
            randomUUID(),
            organization.id,
            actor.id,
            randomUUID(),
            mac,
            "b".repeat(64),
          ],
        ),
      ).rejects.toMatchObject({ code: "23514" });
      await expect(
        reader.query(`SELECT "organization_id" FROM ${auditSequences} LIMIT 1`),
      ).rejects.toMatchObject({ code: "42501" });
      await expect(
        reader.query(`SELECT "request_id" FROM ${contentAuditIntents} LIMIT 1`),
      ).rejects.toMatchObject({ code: "42501" });
      await expect(
        writer.query(`SELECT "request_id" FROM ${contentAuditIntents} LIMIT 1`),
      ).rejects.toMatchObject({ code: "42501" });
      await expect(
        reader.query(
          `
            INSERT INTO ${auditEvents} (
              "id", "organization_id", "sequence", "action", "target_type",
              "target_id", "outcome", "occurred_at", "request_id", "mac", "key_version"
            ) VALUES (
              $1::uuid, $2::uuid, 2, 'permission.change', 'organization', $2,
              'succeeded', now(), $3::uuid, $4, 'audit-v1'
            )
          `,
          [randomUUID(), organization.id, randomUUID(), "b".repeat(64)],
        ),
      ).rejects.toMatchObject({ code: "42501" });
      await expect(
        writer.query(
          `
            INSERT INTO ${auditEvents} (
              "id", "organization_id", "sequence", "action", "target_type",
              "target_id", "outcome", "occurred_at", "request_id",
              "previous_mac", "mac", "key_version"
            ) VALUES (
              $1::uuid, $2::uuid, 3, 'permission.change', 'organization', $2,
              'succeeded', now(), $3::uuid, $4, $5, 'audit-v1'
            )
          `,
          [
            randomUUID(),
            organization.id,
            randomUUID(),
            mac,
            "c".repeat(64),
          ],
        ),
      ).rejects.toMatchObject({ code: "23514" });
    } finally {
      if (readerConnected) {
        await reader.end();
      }
      if (writerConnected) {
        await writer.end();
      }
      const createdRoles = [
        ...(writerRoleCreated ? [writerRole] : []),
        ...(readerRoleCreated ? [readerRole] : []),
      ];
      if (createdRoles.length > 0) {
        const roleList = createdRoles.map(escapeIdentifier).join(", ");
        await owner.query(`DROP OWNED BY ${roleList}`);
        await owner.query(`DROP ROLE ${roleList}`);
      }
      await owner.end();
    }
  });
});
