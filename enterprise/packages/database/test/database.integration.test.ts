import { randomUUID } from "node:crypto";
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

import { DatabaseClient } from "../src/index.js";

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const [organizationOwnerRole, organizationAdminRole, organizationMemberRole] =
  organizationRoles;
const [, spaceEditorRole, spaceViewerRole] = spaceRoles;
const [kernelStartingState, kernelReadyState] = kernelInstanceStates;

async function countSchemas(pool: Pool, prefix: string): Promise<number> {
  const result = await pool.query<{ count: string }>(
    "SELECT COUNT(*)::text AS count FROM pg_namespace WHERE nspname LIKE $1",
    [`${prefix}%`],
  );
  return Number(result.rows[0]?.count ?? "0");
}

describe("S0 PostgreSQL contracts", () => {
  let database: DatabaseClient;

  beforeAll(async () => {
    database = new DatabaseClient(isolatedDatabaseUrl());
    await database.$connect();
  });

  afterEach(async () => {
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

        expect(user.id).toMatch(uuidPattern);
      } finally {
        await replayDatabase.$disconnect();
        await replay.dispose();
        await replay.dispose();
      }
    },
  );

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
        AND table_name <> '_prisma_migrations'
      ORDER BY table_name
    `;

    expect(defaults).toHaveLength(7);
    expect(defaults.every(({ columnDefault }) => columnDefault === "gen_random_uuid()"))
      .toBe(true);
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
          deploymentHandle: `kernel-${status}-${randomUUID()}`,
          version: "3.7.1",
        },
      });

      expect(kernelInstance.status).toBe(status);
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
          deploymentHandle: `kernel-${randomUUID()}`,
          version: "3.7.1",
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
