import { randomUUID } from "node:crypto";

import type { OrganizationRole } from "@singularity/authorization";
import {
  AUTH_LOGIN_PATH,
  ENTERPRISE_MANAGEMENT_ACCESS_PATH,
  enterpriseManagementAccessResponseSchema,
  loginResponseSchema,
  type EnterpriseManagementAccessResponse,
} from "@singularity/contracts";
import { DatabaseRuntime, Prisma, type DatabaseClient } from "@singularity/database";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";

import { PasswordHasher } from "../src/identity/password-hasher.js";
import { truncateTestDatabase } from "./support/database.js";
import {
  startTestApiApplication,
  TEST_PUBLIC_ORIGIN,
  type TestApiApplication,
} from "./support/test-app.js";

const USER_PASSWORD = "correct horse battery staple";
const LOCK_OBSERVATION_TIMEOUT_MS = 10_000;
const LOCK_TRANSACTION_TIMEOUT_MS = 30_000;

interface AuthenticatedUser {
  cookie: string;
  userId: string;
}

interface HeldSpaceTableLock {
  commitWith(
    mutation: (transaction: Prisma.TransactionClient) => Promise<void>,
  ): void;
  completed: Promise<void>;
  lockerPid: number;
}

function cookiePair(response: Response): string {
  const pair = response.headers.get("set-cookie")?.split(";", 1)[0];
  if (pair === undefined || pair.length === 0) {
    throw new Error("Login response cookie is unavailable");
  }
  return pair;
}

async function holdSpaceTableLock(
  database: DatabaseClient,
): Promise<HeldSpaceTableLock> {
  let resolveReady!: (pid: number) => void;
  let rejectReady!: (error: unknown) => void;
  const ready = new Promise<number>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  let resolveMutation!: (
    mutation: (transaction: Prisma.TransactionClient) => Promise<void>,
  ) => void;
  const mutation = new Promise<
    (transaction: Prisma.TransactionClient) => Promise<void>
  >((resolve) => {
    resolveMutation = resolve;
  });
  let completedMutation = false;
  const commitWith = (
    callback: (transaction: Prisma.TransactionClient) => Promise<void>,
  ): void => {
    if (!completedMutation) {
      completedMutation = true;
      resolveMutation(callback);
    }
  };
  const completed = database.$transaction(
    async (transaction) => {
      await transaction.$executeRaw(
        Prisma.sql`LOCK TABLE "spaces" IN ACCESS EXCLUSIVE MODE`,
      );
      const rows = await transaction.$queryRaw<Array<{ pid: number }>>(
        Prisma.sql`SELECT pg_backend_pid() AS "pid"`,
      );
      const backend = rows[0];
      if (backend === undefined) {
        throw new Error("The PostgreSQL table-lock backend is unavailable");
      }
      resolveReady(backend.pid);
      const applyMutation = await mutation;
      await applyMutation(transaction);
    },
    { maxWait: 2_000, timeout: LOCK_TRANSACTION_TIMEOUT_MS },
  );
  void completed.catch(rejectReady);

  try {
    return { commitWith, completed, lockerPid: await ready };
  } catch (error) {
    commitWith(async () => undefined);
    await Promise.allSettled([completed]);
    throw error;
  }
}

async function waitForBlockedBackend(
  database: DatabaseClient,
  lockerPid: number,
): Promise<void> {
  const deadline = Date.now() + LOCK_OBSERVATION_TIMEOUT_MS;
  for (;;) {
    const rows = await database.$queryRaw<Array<{ pid: number }>>(
      Prisma.sql`
        SELECT activity.pid AS "pid"
        FROM pg_stat_activity AS activity
        WHERE ${lockerPid} = ANY(pg_blocking_pids(activity.pid))
          AND activity.wait_event_type = 'Lock'
      `,
    );
    if (rows.length === 1) {
      return;
    }
    if (rows.length > 1) {
      throw new Error(
        `Observed ${String(rows.length)} blocked backends; expected 1`,
      );
    }
    if (Date.now() >= deadline) {
      throw new Error("Did not observe the management request waiting for spaces");
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

describe("enterprise management access HTTP contract with PostgreSQL", () => {
  let database: DatabaseClient;
  let passwordDigest: string;
  let testApi: TestApiApplication;

  beforeAll(async () => {
    testApi = await startTestApiApplication();
    database = testApi.app.get(DatabaseRuntime).client;
    passwordDigest = await testApi.app
      .get(PasswordHasher)
      .hashPassword(USER_PASSWORD);
  });

  afterEach(async () => {
    await truncateTestDatabase(database);
  });

  afterAll(async () => {
    await testApi.dispose();
  });

  async function createOrganization(name: string): Promise<string> {
    const organization = await database.organization.create({
      data: { name, status: "active" },
      select: { id: true },
    });
    return organization.id;
  }

  async function createSpace(
    organizationId: string,
    name: string,
  ): Promise<string> {
    const space = await database.space.create({
      data: { name, organizationId, status: "active" },
      select: { id: true },
    });
    return space.id;
  }

  async function createAuthenticatedMember(
    organizationId: string,
    role: OrganizationRole,
    label: string,
  ): Promise<AuthenticatedUser> {
    const loginIdentifier = `${label}-${randomUUID()}@example.test`;
    const user = await database.user.create({
      data: { loginIdentifier, passwordDigest, status: "active" },
      select: { id: true },
    });
    await database.organizationMembership.create({
      data: {
        organizationId,
        role,
        status: "active",
        userId: user.id,
      },
    });
    const response = await fetch(`${testApi.baseUrl}${AUTH_LOGIN_PATH}`, {
      body: JSON.stringify({ loginIdentifier, password: USER_PASSWORD }),
      headers: {
        "Content-Type": "application/json",
        Origin: TEST_PUBLIC_ORIGIN,
      },
      method: "POST",
    });
    expect(response.status).toBe(200);
    loginResponseSchema.parse(await response.json());
    return { cookie: cookiePair(response), userId: user.id };
  }

  async function readManagementAccess(
    user: AuthenticatedUser,
  ): Promise<EnterpriseManagementAccessResponse> {
    const response = await fetch(
      `${testApi.baseUrl}${ENTERPRISE_MANAGEMENT_ACCESS_PATH}`,
      { headers: { Cookie: user.cookie } },
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    return enterpriseManagementAccessResponseSchema.parse(await response.json());
  }

  test("projects organization capabilities and every manageable space for owners and admins", async () => {
    const organizationId = await createOrganization("Management organization");
    const alphaSpaceId = await createSpace(organizationId, "Alpha space");
    const betaSpaceId = await createSpace(organizationId, "Beta space");
    const owner = await createAuthenticatedMember(organizationId, "owner", "owner");
    const admin = await createAuthenticatedMember(organizationId, "admin", "admin");
    const restoreTargetId = await createSpace(
      organizationId,
      "Unactivated restore target",
    );
    await database.space.update({
      data: { status: "archived" },
      where: { id: restoreTargetId },
    });
    const backup = await database.spaceBackup.create({
      data: {
        createdByUserId: owner.userId,
        organizationId,
        sourceSpaceId: alphaSpaceId,
        status: "queued",
      },
      select: { id: true },
    });
    await database.spaceRestoreJob.create({
      data: {
        backupId: backup.id,
        completedAt: new Date("2026-07-19T00:00:00.000Z"),
        createdByUserId: owner.userId,
        organizationId,
        sourceSpaceId: alphaSpaceId,
        status: "ready_for_activation",
        targetSpaceId: restoreTargetId,
      },
    });

    const ownerAccess = (await readManagementAccess(owner)).organizations[0];
    expect(ownerAccess).toBeDefined();
    expect(ownerAccess?.organizationId).toBe(organizationId);
    expect(ownerAccess?.organizationCapabilities).toHaveLength(7);
    expect(ownerAccess?.organizationCapabilities).toEqual(
      expect.arrayContaining([
        "members",
        "groups",
        "spaces",
        "oidc",
        "audit",
        "governance",
        "ownership",
      ]),
    );
    expect(ownerAccess?.spaces.map((space) => space.spaceId)).toEqual([
      alphaSpaceId,
      betaSpaceId,
    ]);
    for (const space of ownerAccess?.spaces ?? []) {
      expect(space.capabilities).toHaveLength(6);
      expect(space.capabilities).toEqual(
        expect.arrayContaining([
          "access",
          "shares",
          "audit",
          "backups",
          "observability",
          "governance",
        ]),
      );
    }

    const adminAccess = (await readManagementAccess(admin)).organizations[0];
    expect(adminAccess?.organizationId).toBe(organizationId);
    expect(adminAccess?.organizationCapabilities).toHaveLength(5);
    expect(adminAccess?.organizationCapabilities).toEqual(
      expect.arrayContaining(["members", "groups", "spaces", "audit", "governance"]),
    );
    expect(adminAccess?.organizationCapabilities).not.toContain("oidc");
    expect(adminAccess?.organizationCapabilities).not.toContain("ownership");
    expect(adminAccess?.spaces.map((space) => space.spaceId)).toEqual([
      alphaSpaceId,
      betaSpaceId,
    ]);
  });

  test("limits organization members to spaces they administer directly or through a group", async () => {
    const organizationId = await createOrganization("Delegated organization");
    const directSpaceId = await createSpace(organizationId, "Direct administration");
    const groupSpaceId = await createSpace(organizationId, "Group administration");
    const editorSpaceId = await createSpace(organizationId, "Unmanaged editor space");
    const delegated = await createAuthenticatedMember(
      organizationId,
      "member",
      "delegated",
    );
    const ordinary = await createAuthenticatedMember(
      organizationId,
      "member",
      "ordinary",
    );
    await database.spaceMembership.createMany({
      data: [
        {
          organizationId,
          role: "admin",
          spaceId: directSpaceId,
          status: "active",
          userId: delegated.userId,
        },
        {
          organizationId,
          role: "editor",
          spaceId: editorSpaceId,
          status: "active",
          userId: delegated.userId,
        },
      ],
    });
    const group = await database.userGroup.create({
      data: { name: "Space administrators", organizationId, status: "active" },
      select: { id: true },
    });
    await database.userGroupMembership.create({
      data: { groupId: group.id, organizationId, userId: delegated.userId },
    });
    await database.spaceGroupGrant.create({
      data: {
        groupId: group.id,
        organizationId,
        role: "admin",
        spaceId: groupSpaceId,
      },
    });

    expect(await readManagementAccess(delegated)).toEqual({
      organizations: [
        {
          organizationCapabilities: [],
          organizationId,
          organizationName: "Delegated organization",
          spaces: [
            expect.objectContaining({
              capabilities: expect.arrayContaining([
                "access",
                "shares",
                "audit",
                "backups",
                "observability",
                "governance",
              ]),
              spaceId: directSpaceId,
              spaceName: "Direct administration",
            }),
            expect.objectContaining({
              capabilities: expect.arrayContaining([
                "access",
                "shares",
                "audit",
                "backups",
                "observability",
                "governance",
              ]),
              spaceId: groupSpaceId,
              spaceName: "Group administration",
            }),
          ],
        },
      ],
    });
    expect(await readManagementAccess(ordinary)).toEqual({ organizations: [] });
  });

  test("returns one management snapshot across a concurrent role and space change", async () => {
    const organizationId = await createOrganization("Snapshot organization");
    const spaceId = await createSpace(organizationId, "Snapshot space");
    const admin = await createAuthenticatedMember(
      organizationId,
      "admin",
      "snapshot-admin",
    );
    const heldLock = await holdSpaceTableLock(database);
    let response: Promise<Response> | undefined;

    try {
      response = fetch(
        `${testApi.baseUrl}${ENTERPRISE_MANAGEMENT_ACCESS_PATH}`,
        { headers: { Cookie: admin.cookie } },
      );
      void response.catch(() => undefined);
      await waitForBlockedBackend(database, heldLock.lockerPid);
      heldLock.commitWith(async (transaction) => {
        await transaction.organizationMembership.update({
          where: {
            organizationId_userId: {
              organizationId,
              userId: admin.userId,
            },
          },
          data: { role: "member" },
        });
        await transaction.space.update({
          where: { id: spaceId },
          data: { name: "Changed space" },
        });
      });
      await heldLock.completed;

      const snapshotResponse = await response;
      expect(snapshotResponse.status).toBe(200);
      expect(
        enterpriseManagementAccessResponseSchema.parse(
          await snapshotResponse.json(),
        ),
      ).toEqual({
        organizations: [
          {
            organizationCapabilities: ["members", "groups", "spaces", "audit", "governance"],
            organizationId,
            organizationName: "Snapshot organization",
            spaces: [
              {
                capabilities: [
                  "access",
                  "shares",
                  "audit",
                  "backups",
                  "observability",
                  "governance",
                ],
                spaceId,
                spaceName: "Snapshot space",
              },
            ],
          },
        ],
      });
    } finally {
      heldLock.commitWith(async () => undefined);
      await Promise.allSettled([
        heldLock.completed,
        ...(response === undefined ? [] : [response]),
      ]);
    }

    expect(await readManagementAccess(admin)).toEqual({ organizations: [] });
  });
});
