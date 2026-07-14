import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { Pool } from "pg";
import {
  organizationRoles,
  spaceRoles,
} from "@singularity/authorization";
import { kernelInstanceStates } from "@singularity/contracts";
import {
  createPostgresHandshakeBlackhole,
  createIsolatedPostgres,
  isolatedDatabaseUrl,
} from "@singularity/database/testing/postgres";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";

import {
  DatabaseClient,
  DatabaseConfigurationError,
} from "../src/index.js";

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const [organizationOwnerRole, organizationAdminRole, organizationMemberRole] =
  organizationRoles;
const [, spaceEditorRole, spaceViewerRole] = spaceRoles;
const [kernelStartingState, kernelReadyState, kernelUnavailableState] =
  kernelInstanceStates;
const s0MigrationPath = fileURLToPath(
  new URL(
    "../prisma/migrations/20260714000000_s0_enterprise_control_plane/migration.sql",
    import.meta.url,
  ),
);
const s1MigrationPath = fileURLToPath(
  new URL(
    "../prisma/migrations/20260715000000_s1_identity_space_access/migration.sql",
    import.meta.url,
  ),
);
const s1NonemptyMigrationDiagnostic =
  "SINGULARITY_S1_REQUIRES_EMPTY_S0_DOMAIN_TABLES";

async function countSchemas(pool: Pool, prefix: string): Promise<number> {
  const result = await pool.query<{ count: string }>(
    "SELECT COUNT(*)::text AS count FROM pg_namespace WHERE nspname LIKE $1",
    [`${prefix}%`],
  );
  return Number(result.rows[0]?.count ?? "0");
}

describe("S0-S1 PostgreSQL contracts", () => {
  let database: DatabaseClient;

  beforeAll(async () => {
    database = new DatabaseClient(isolatedDatabaseUrl());
    await database.$connect();
  });

  afterEach(async () => {
    await database.systemInstallation.deleteMany();
    await database.kernelInstance.deleteMany();
    await database.spaceMembership.deleteMany();
    await database.authSession.deleteMany();
    await database.space.deleteMany();
    await database.organizationMembership.deleteMany();
    await database.organization.deleteMany();
    await database.user.deleteMany();
  });

  afterAll(async () => {
    await database.$disconnect();
  });

  test(
    "replays all migrations into an independent empty schema",
    { timeout: 60_000 },
    async () => {
      const replay = await createIsolatedPostgres({ purpose: "migration" });
      const replayDatabase = new DatabaseClient(replay.databaseUrl);

      try {
        const user = await replayDatabase.user.create({
          data: {
            loginIdentifier: `migration-${randomUUID()}`,
            passwordDigest: "digest",
            status: "active",
          },
        });
        const installation = await replayDatabase.systemInstallation.create({
          data: { id: 1, initializedAt: new Date() },
        });

        expect(user.id).toMatch(uuidPattern);
        expect(installation.id).toBe(1);
      } finally {
        await replayDatabase.$disconnect();
        await replay.dispose();
        await replay.dispose();
      }
    },
  );

  test("uses the configured schema for generated and raw queries", async () => {
    const configuredUrl = new URL(isolatedDatabaseUrl());
    configuredUrl.searchParams.set("options", "-c search_path=public");
    const rawDatabase = new DatabaseClient(configuredUrl.toString());

    try {
      const user = await rawDatabase.user.create({
        data: {
          loginIdentifier: `raw-schema-${randomUUID()}`,
          passwordDigest: "digest",
          status: "active",
        },
      });

      const rows = await rawDatabase.$queryRaw<Array<{ id: string }>>`
        SELECT "id"::text
        FROM "users"
        WHERE "id" = ${user.id}::uuid
      `;

      expect(rows).toEqual([{ id: user.id }]);
    } finally {
      await rawDatabase.$disconnect();
    }
  });

  test("rejects schema names that cannot be safe startup options", () => {
    const configuredUrl = new URL(isolatedDatabaseUrl());
    configuredUrl.searchParams.set("schema", "public -c role=postgres");

    expect(() => new DatabaseClient(configuredUrl.toString())).toThrow(
      DatabaseConfigurationError,
    );
  });

  test("rejects an S1 migration over nonempty S0 domain data without rewriting it", async () => {
    const configuredUrl = new URL(process.env.SINGULARITY_TEST_DATABASE_URL!);
    configuredUrl.searchParams.delete("schema");
    const schemaName = `sg_s1_guard_${randomUUID().replaceAll("-", "")}`;
    const pool = new Pool({ connectionString: configuredUrl.toString() });
    const client = await pool.connect();

    try {
      await client.query(`CREATE SCHEMA "${schemaName}"`);
      await client.query(`SET search_path TO "${schemaName}"`);
      await client.query(await readFile(s0MigrationPath, "utf8"));
      const inserted = await client.query<{ id: string }>(`
        INSERT INTO "users" ("login_identifier", "password_digest", "status")
        VALUES ('manual-s0-user', 'sensitive-digest-sentinel', 'active')
        RETURNING "id"::text
      `);

      await expect(
        client.query(await readFile(s1MigrationPath, "utf8")),
      ).rejects.toThrow(s1NonemptyMigrationDiagnostic);

      const retained = await client.query<{ passwordDigest: string }>(`
        SELECT "password_digest" AS "passwordDigest"
        FROM "users"
        WHERE "id" = $1::uuid
      `, [inserted.rows[0]?.id]);
      const deploymentColumns = await client.query<{ isNullable: string }>(`
        SELECT is_nullable AS "isNullable"
        FROM information_schema.columns
        WHERE table_schema = $1
          AND table_name = 'kernel_instances'
          AND column_name IN ('deployment_handle', 'version')
        ORDER BY column_name
      `, [schemaName]);
      const installationTable = await client.query<{ tableName: string | null }>(`
        SELECT to_regclass($1)::text AS "tableName"
      `, [`${schemaName}.system_installations`]);

      expect(retained.rows).toEqual([
        { passwordDigest: "sensitive-digest-sentinel" },
      ]);
      expect(deploymentColumns.rows).toEqual([
        { isNullable: "NO" },
        { isNullable: "NO" },
      ]);
      expect(installationTable.rows).toEqual([{ tableName: null }]);
    } finally {
      try {
        await client.query("SET search_path TO public");
        await client.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
      } finally {
        client.release();
        await pool.end();
      }
    }
  });

  test("rejects a test database URL whose database name is not isolated", async () => {
    const originalUrl = process.env.SINGULARITY_TEST_DATABASE_URL!;
    process.env.SINGULARITY_TEST_DATABASE_URL =
      "postgresql://singularity:singularity@127.0.0.1:5432/singularity";

    try {
      await expect(
        createIsolatedPostgres({ purpose: "unsafe" }),
      ).rejects.toThrow("must end with _test");
    } finally {
      process.env.SINGULARITY_TEST_DATABASE_URL = originalUrl;
    }
  });

  test("bounds setup when PostgreSQL accepts TCP without completing its handshake", async () => {
    const originalUrl = process.env.SINGULARITY_TEST_DATABASE_URL!;
    const blackhole = await createPostgresHandshakeBlackhole();
    const blackholeUrl = new URL(originalUrl);
    blackholeUrl.hostname = "127.0.0.1";
    blackholeUrl.port = String(blackhole.port);
    blackholeUrl.searchParams.delete("schema");
    process.env.SINGULARITY_TEST_DATABASE_URL = blackholeUrl.toString();

    const setup = createIsolatedPostgres({ purpose: "blackhole" });
    const watchdogError = new Error(
      "PostgreSQL test support exceeded its cleanup watchdog",
    );
    let watchdogTimer!: ReturnType<typeof setTimeout>;
    const watchdog = new Promise<never>((_resolve, reject) => {
      watchdogTimer = setTimeout(() => reject(watchdogError), 8_000);
    });
    let failure: unknown;
    const startedAt = performance.now();

    try {
      try {
        await Promise.race([setup, watchdog]);
      } catch (error) {
        failure = error;
      }
    } finally {
      const elapsedMilliseconds = performance.now() - startedAt;
      clearTimeout(watchdogTimer);
      process.env.SINGULARITY_TEST_DATABASE_URL = originalUrl;
      await blackhole.dispose();
      const [setupResult] = await Promise.allSettled([setup]);
      if (setupResult?.status === "fulfilled") {
        await setupResult.value.dispose();
      }

      expect(failure).toBeInstanceOf(Error);
      expect(failure).not.toBe(watchdogError);
      expect(elapsedMilliseconds).toBeGreaterThanOrEqual(2_500);
      expect(elapsedMilliseconds).toBeLessThan(5_000);
    }
  });

  test("removes a newly-created schema when migration setup fails", async () => {
    const configuredUrl = process.env.SINGULARITY_TEST_DATABASE_URL!;
    const baseUrl = new URL(configuredUrl);
    baseUrl.searchParams.delete("schema");
    const pool = new Pool({ connectionString: baseUrl.toString() });

    try {
      const before = await countSchemas(pool, "sg_failure_");
      const missingConfigPath = fileURLToPath(
        new URL("./fixtures/missing-prisma.config.ts", import.meta.url),
      );

      await expect(
        createIsolatedPostgres({
          purpose: "failure",
          prismaConfigPath: missingConfigPath,
        }),
      ).rejects.toThrow("Prisma migrate deploy exited");

      expect(await countSchemas(pool, "sg_failure_")).toBe(before);
    } finally {
      await pool.end();
    }
  });

  test("removes a newly-created schema when migration setup times out", async () => {
    const configuredUrl = process.env.SINGULARITY_TEST_DATABASE_URL!;
    const baseUrl = new URL(configuredUrl);
    baseUrl.searchParams.delete("schema");
    const pool = new Pool({ connectionString: baseUrl.toString() });

    try {
      const before = await countSchemas(pool, "sg_timeout_");

      await expect(
        createIsolatedPostgres({
          migrationTimeoutMilliseconds: 1,
          purpose: "timeout",
        }),
      ).rejects.toThrow("Prisma migrate deploy timed out");

      expect(await countSchemas(pool, "sg_timeout_")).toBe(before);
    } finally {
      await pool.end();
    }
  });

  test("uses PostgreSQL UUID defaults for every domain primary key", async () => {
    const schema = new URL(isolatedDatabaseUrl()).searchParams.get("schema");
    const defaults = await database.$queryRaw<
      Array<{ tableName: string; columnDefault: string | null }>
    >`
      SELECT table_name AS "tableName", column_default AS "columnDefault"
      FROM information_schema.columns
      WHERE table_schema = ${schema}
        AND column_name = 'id'
        AND table_name IN (
          'users',
          'auth_sessions',
          'organizations',
          'organization_memberships',
          'spaces',
          'space_memberships',
          'kernel_instances'
        )
      ORDER BY table_name
    `;

    expect(defaults).toHaveLength(7);
    expect(defaults.every(({ columnDefault }) => columnDefault === "gen_random_uuid()"))
      .toBe(true);
  });

  test("accepts only the fixed SystemInstallation key", async () => {
    const initializedAt = new Date();
    const installation = await database.systemInstallation.create({
      data: { id: 1, initializedAt },
    });

    expect(installation).toEqual({ id: 1, initializedAt });
    await expect(
      database.systemInstallation.create({
        data: { id: 2, initializedAt },
      }),
    ).rejects.toThrow();
  });

  test("serializes concurrent SystemInstallation creation to one row", async () => {
    const attempts = await Promise.allSettled([
      database.systemInstallation.create({
        data: { id: 1, initializedAt: new Date("2026-07-15T00:00:00.000Z") },
      }),
      database.systemInstallation.create({
        data: { id: 1, initializedAt: new Date("2026-07-15T00:00:01.000Z") },
      }),
    ]);

    expect(attempts.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    expect(attempts.filter(({ status }) => status === "rejected")).toHaveLength(1);
    expect(await database.systemInstallation.count()).toBe(1);
  });

  test("keeps the Space composite ownership key in PostgreSQL", async () => {
    const schema = new URL(isolatedDatabaseUrl()).searchParams.get("schema");
    const indexes = await database.$queryRaw<Array<{ count: bigint }>>`
      SELECT COUNT(*) AS count
      FROM pg_indexes
      WHERE schemaname = ${schema}
        AND indexname = 'spaces_id_organization_id_key'
        AND indexdef LIKE 'CREATE UNIQUE INDEX%'
    `;

    expect(indexes[0]?.count).toBe(1n);
  });

  test.each(organizationRoles)(
    "round-trips public organization role %s through PostgreSQL",
    async (role) => {
      const user = await database.user.create({
        data: {
          loginIdentifier: `organization-role-${role}-${randomUUID()}`,
          passwordDigest: "digest",
          status: "active",
        },
      });
      const organization = await database.organization.create({
        data: { name: `Organization ${role}`, status: "active" },
      });

      const membership = await database.organizationMembership.create({
        data: {
          organizationId: organization.id,
          userId: user.id,
          role,
          status: "active",
        },
      });

      expect(membership.role).toBe(role);
    },
  );

  test.each(spaceRoles)(
    "round-trips public space role %s through PostgreSQL",
    async (role) => {
      const user = await database.user.create({
        data: {
          loginIdentifier: `space-role-${role}-${randomUUID()}`,
          passwordDigest: "digest",
          status: "active",
        },
      });
      const organization = await database.organization.create({
        data: { name: `Organization ${role}`, status: "active" },
      });
      await database.organizationMembership.create({
        data: {
          organizationId: organization.id,
          userId: user.id,
          role: organizationMemberRole,
          status: "active",
        },
      });
      const space = await database.space.create({
        data: {
          organizationId: organization.id,
          name: `Space ${role}`,
          status: "active",
        },
      });

      const membership = await database.spaceMembership.create({
        data: {
          organizationId: organization.id,
          spaceId: space.id,
          userId: user.id,
          role,
          status: "active",
        },
      });

      expect(membership.role).toBe(role);
    },
  );

  test.each(kernelInstanceStates)(
    "round-trips public Kernel state %s through PostgreSQL",
    async (status) => {
      const organization = await database.organization.create({
        data: { name: `Organization ${status}`, status: "active" },
      });
      const space = await database.space.create({
        data: {
          organizationId: organization.id,
          name: `Space ${status}`,
          status: "active",
        },
      });

      const kernelInstance = await database.kernelInstance.create({
        data: {
          spaceId: space.id,
          status,
          ...(status === kernelStartingState
            ? { deploymentHandle: null, version: null }
            : {
                deploymentHandle: `kernel-${status}-${randomUUID()}`,
                version: "3.7.1",
              }),
        },
      });

      expect(kernelInstance.status).toBe(status);
      expect(kernelInstance.deploymentHandle === null).toBe(
        status === kernelStartingState,
      );
      expect(kernelInstance.version === null).toBe(
        status === kernelStartingState,
      );
    },
  );

  test.each([
    {
      deploymentHandle: "kernel-starting",
      label: "starting with deployment metadata",
      status: kernelStartingState,
      version: "3.7.1",
    },
    {
      deploymentHandle: null,
      label: "ready without deployment metadata",
      status: kernelReadyState,
      version: null,
    },
    {
      deploymentHandle: "kernel-ready",
      label: "ready without a version",
      status: kernelReadyState,
      version: null,
    },
    {
      deploymentHandle: null,
      label: "unavailable without a deployment handle",
      status: kernelUnavailableState,
      version: "3.7.1",
    },
    {
      deploymentHandle: "",
      label: "ready with an empty deployment handle",
      status: kernelReadyState,
      version: "3.7.1",
    },
    {
      deploymentHandle: " \t\n",
      label: "unavailable with a whitespace deployment handle",
      status: kernelUnavailableState,
      version: "3.7.1",
    },
    {
      deploymentHandle: "kernel-ready",
      label: "ready with an empty version",
      status: kernelReadyState,
      version: "",
    },
    {
      deploymentHandle: "kernel-unavailable",
      label: "unavailable with a whitespace version",
      status: kernelUnavailableState,
      version: " \t\n",
    },
  ])(
    "rejects Kernel state $label",
    async ({ deploymentHandle, status, version }) => {
      const organization = await database.organization.create({
        data: { name: `Invalid Kernel ${randomUUID()}`, status: "active" },
      });
      const space = await database.space.create({
        data: {
          organizationId: organization.id,
          name: "Invalid Kernel Space",
          status: "active",
        },
      });

      await expect(
        database.kernelInstance.create({
          data: { deploymentHandle, spaceId: space.id, status, version },
        }),
      ).rejects.toThrow();
    },
  );

  test("rejects duplicate user login identifiers", async () => {
    const loginIdentifier = `user-${randomUUID()}`;
    await database.user.create({
      data: { loginIdentifier, passwordDigest: "digest-a", status: "active" },
    });

    await expect(
      database.user.create({
        data: { loginIdentifier, passwordDigest: "digest-b", status: "active" },
      }),
    ).rejects.toMatchObject({ code: "P2002" });
  });

  test("rejects duplicate authentication token digests", async () => {
    const user = await database.user.create({
      data: {
        loginIdentifier: `auth-${randomUUID()}`,
        passwordDigest: "digest",
        status: "active",
      },
    });
    const tokenDigest = `token-${randomUUID()}`;
    const expiresAt = new Date(Date.now() + 60_000);
    await database.authSession.create({
      data: {
        userId: user.id,
        tokenDigest,
        csrfDigest: `csrf-${randomUUID()}`,
        absoluteExpiresAt: expiresAt,
        idleExpiresAt: expiresAt,
      },
    });

    await expect(
      database.authSession.create({
        data: {
          userId: user.id,
          tokenDigest,
          csrfDigest: `csrf-${randomUUID()}`,
          absoluteExpiresAt: expiresAt,
          idleExpiresAt: expiresAt,
        },
      }),
    ).rejects.toMatchObject({ code: "P2002" });
  });

  test("rejects duplicate organization memberships", async () => {
    const user = await database.user.create({
      data: {
        loginIdentifier: `member-${randomUUID()}`,
        passwordDigest: "digest",
        status: "active",
      },
    });
    const organization = await database.organization.create({
      data: { name: "Organization", status: "active" },
    });
    await database.organizationMembership.create({
      data: {
        organizationId: organization.id,
        userId: user.id,
        role: organizationMemberRole,
        status: "active",
      },
    });

    await expect(
      database.organizationMembership.create({
        data: {
          organizationId: organization.id,
          userId: user.id,
          role: organizationAdminRole,
          status: "active",
        },
      }),
    ).rejects.toMatchObject({ code: "P2002" });
  });

  test("rejects duplicate users inside one space", async () => {
    const user = await database.user.create({
      data: {
        loginIdentifier: `space-member-${randomUUID()}`,
        passwordDigest: "digest",
        status: "active",
      },
    });
    const organization = await database.organization.create({
      data: { name: "Organization", status: "active" },
    });
    await database.organizationMembership.create({
      data: {
        organizationId: organization.id,
        userId: user.id,
        role: organizationMemberRole,
        status: "active",
      },
    });
    const space = await database.space.create({
      data: {
        organizationId: organization.id,
        name: "Space",
        status: "active",
      },
    });
    await database.spaceMembership.create({
      data: {
        organizationId: organization.id,
        spaceId: space.id,
        userId: user.id,
        role: spaceEditorRole,
        status: "active",
      },
    });

    await expect(
      database.spaceMembership.create({
        data: {
          organizationId: organization.id,
          spaceId: space.id,
          userId: user.id,
          role: spaceViewerRole,
          status: "active",
        },
      }),
    ).rejects.toMatchObject({ code: "P2002" });
  });

  test("rejects a second Kernel instance for the same space", async () => {
    const organization = await database.organization.create({
      data: { name: "Organization", status: "active" },
    });
    const space = await database.space.create({
      data: {
        organizationId: organization.id,
        name: "Space",
        status: "active",
      },
    });
    await database.kernelInstance.create({
      data: {
        spaceId: space.id,
        status: kernelReadyState,
        deploymentHandle: `kernel-${randomUUID()}`,
        version: "3.7.1",
      },
    });

    await expect(
      database.kernelInstance.create({
        data: {
          spaceId: space.id,
          status: kernelStartingState,
          deploymentHandle: null,
          version: null,
        },
      }),
    ).rejects.toMatchObject({ code: "P2002" });
  });

  test("rejects a space member whose organization does not own the space", async () => {
    const user = await database.user.create({
      data: {
        loginIdentifier: `cross-space-${randomUUID()}`,
        passwordDigest: "digest",
        status: "active",
      },
    });
    const [membershipOrganization, spaceOrganization] = await Promise.all([
      database.organization.create({
        data: { name: "Membership Org", status: "active" },
      }),
      database.organization.create({
        data: { name: "Space Org", status: "active" },
      }),
    ]);
    await database.organizationMembership.create({
      data: {
        organizationId: membershipOrganization.id,
        userId: user.id,
        role: organizationMemberRole,
        status: "active",
      },
    });
    const space = await database.space.create({
      data: {
        organizationId: spaceOrganization.id,
        name: "Space",
        status: "active",
      },
    });

    await expect(
      database.spaceMembership.create({
        data: {
          organizationId: membershipOrganization.id,
          spaceId: space.id,
          userId: user.id,
          role: spaceViewerRole,
          status: "active",
        },
      }),
    ).rejects.toMatchObject({ code: "P2003" });
  });

  test("rejects a space member without membership in the owning organization", async () => {
    const user = await database.user.create({
      data: {
        loginIdentifier: `cross-member-${randomUUID()}`,
        passwordDigest: "digest",
        status: "active",
      },
    });
    const organization = await database.organization.create({
      data: { name: "Organization", status: "active" },
    });
    const space = await database.space.create({
      data: {
        organizationId: organization.id,
        name: "Space",
        status: "active",
      },
    });

    await expect(
      database.spaceMembership.create({
        data: {
          organizationId: organization.id,
          spaceId: space.id,
          userId: user.id,
          role: spaceViewerRole,
          status: "active",
        },
      }),
    ).rejects.toMatchObject({ code: "P2003" });
  });

  test("restricts deleting a user that owns an authentication session", async () => {
    const user = await database.user.create({
      data: {
        loginIdentifier: `session-owner-${randomUUID()}`,
        passwordDigest: "digest",
        status: "active",
      },
    });
    const expiresAt = new Date(Date.now() + 60_000);
    await database.authSession.create({
      data: {
        userId: user.id,
        tokenDigest: `token-${randomUUID()}`,
        csrfDigest: `csrf-${randomUUID()}`,
        absoluteExpiresAt: expiresAt,
        idleExpiresAt: expiresAt,
      },
    });

    await expect(database.user.delete({ where: { id: user.id } })).rejects.toMatchObject({
      code: "P2003",
    });
  });

  test("restricts deleting an organization that owns a membership", async () => {
    const user = await database.user.create({
      data: {
        loginIdentifier: `org-owner-${randomUUID()}`,
        passwordDigest: "digest",
        status: "active",
      },
    });
    const organization = await database.organization.create({
      data: { name: "Organization", status: "active" },
    });
    await database.organizationMembership.create({
      data: {
        organizationId: organization.id,
        userId: user.id,
        role: organizationOwnerRole,
        status: "active",
      },
    });

    await expect(
      database.organization.delete({ where: { id: organization.id } }),
    ).rejects.toMatchObject({ code: "P2003" });
  });

  test("restricts deleting a user that owns an organization membership", async () => {
    const user = await database.user.create({
      data: {
        loginIdentifier: `membership-owner-${randomUUID()}`,
        passwordDigest: "digest",
        status: "active",
      },
    });
    const organization = await database.organization.create({
      data: { name: "Organization", status: "active" },
    });
    await database.organizationMembership.create({
      data: {
        organizationId: organization.id,
        userId: user.id,
        role: organizationMemberRole,
        status: "active",
      },
    });

    await expect(database.user.delete({ where: { id: user.id } })).rejects.toMatchObject({
      code: "P2003",
    });
  });

  test("restricts deleting an organization that owns a space", async () => {
    const organization = await database.organization.create({
      data: { name: "Organization", status: "active" },
    });
    await database.space.create({
      data: {
        organizationId: organization.id,
        name: "Space",
        status: "active",
      },
    });

    await expect(
      database.organization.delete({ where: { id: organization.id } }),
    ).rejects.toMatchObject({ code: "P2003" });
  });

  test("restricts deleting a space that owns a Kernel instance", async () => {
    const organization = await database.organization.create({
      data: { name: "Organization", status: "active" },
    });
    const space = await database.space.create({
      data: {
        organizationId: organization.id,
        name: "Space",
        status: "active",
      },
    });
    await database.kernelInstance.create({
      data: {
        spaceId: space.id,
        status: kernelReadyState,
        deploymentHandle: `kernel-${randomUUID()}`,
        version: "3.7.1",
      },
    });

    await expect(database.space.delete({ where: { id: space.id } })).rejects.toMatchObject({
      code: "P2003",
    });
  });
});
