import { randomUUID } from "node:crypto";

import {
  AUTH_INVITATION_ACCEPT_LOCAL_PATH,
  AUTH_INVITATION_ACCEPT_PATH,
  AUTH_LOGIN_PATH,
  CSRF_HEADER_NAME,
  ORGANIZATION_AUDIT_EVENTS_PATH_TEMPLATE,
  ORGANIZATION_GROUP_MEMBER_PATH_TEMPLATE,
  ORGANIZATION_GROUP_MEMBERS_PATH_TEMPLATE,
  ORGANIZATION_GROUP_PATH_TEMPLATE,
  ORGANIZATION_GROUPS_PATH_TEMPLATE,
  ORGANIZATION_INVITATION_PATH_TEMPLATE,
  ORGANIZATION_INVITATIONS_PATH_TEMPLATE,
  ORGANIZATION_MEMBER_PATH_TEMPLATE,
  ORGANIZATION_MEMBER_SESSIONS_PATH_TEMPLATE,
  ORGANIZATION_MEMBERS_PATH_TEMPLATE,
  ORGANIZATION_OWNERSHIP_PATH_TEMPLATE,
  apiProblemSchema,
  auditEventsResponseSchema,
  createdOrganizationInvitationSchema,
  loginResponseSchema,
  organizationMemberSummarySchema,
  organizationInvitationsResponseSchema,
  organizationMembersResponseSchema,
  userGroupMembersResponseSchema,
  userGroupsResponseSchema,
  userGroupSummarySchema,
} from "@singularity/contracts";
import { DatabaseRuntime, Prisma, type DatabaseClient } from "@singularity/database";
import { RateLimiterMemory } from "rate-limiter-flexible";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";

import type { Clock } from "../src/identity/clock.js";
import { LoginRateLimiter } from "../src/identity/login-rate-limiter.js";
import { PasswordHasher } from "../src/identity/password-hasher.js";
import { ACCESS_CHANGE_CHANNEL } from "../src/kernel/access-changed.js";
import { captureAccessChanges } from "./support/access-change-barrier.js";
import { truncateTestDatabase } from "./support/database.js";
import {
  startTestApiApplication,
  TEST_PUBLIC_ORIGIN,
  type TestApiApplication,
} from "./support/test-app.js";

const USER_PASSWORD = "correct horse battery staple";
const INITIAL_TIME = new Date("2026-07-19T00:00:00.000Z");
const NOTIFICATION_TIMEOUT_MS = 5_000;
const LOCK_OBSERVATION_TIMEOUT_MS = 10_000;
const LOCK_TRANSACTION_TIMEOUT_MS = 30_000;

class MutableClock implements Clock {
  #milliseconds: number;

  constructor(value: Date) {
    this.#milliseconds = value.getTime();
  }

  now(): Date {
    return new Date(this.#milliseconds);
  }

  set(value: Date): void {
    this.#milliseconds = value.getTime();
  }
}

interface AuthenticatedUser {
  cookie: string;
  csrfToken: string;
  loginIdentifier: string;
  userId: string;
}

interface OrganizationGraph {
  organizationId: string;
  owner: AuthenticatedUser;
}

interface HeldRowLock {
  completed: Promise<void>;
  lockerPid: number;
  release(): void;
}

function buildPath(
  template: string,
  parameters: Readonly<Record<string, string>>,
): string {
  let path = template;
  for (const [name, value] of Object.entries(parameters)) {
    path = path.replace(`{${name}}`, encodeURIComponent(value));
  }
  if (path.includes("{")) {
    throw new Error("Test API path parameters are incomplete");
  }
  return path;
}

function cookiePair(response: Response): string {
  const setCookie = response.headers.get("set-cookie");
  const pair = setCookie?.split(";", 1)[0];
  if (pair === undefined || pair.length === 0) {
    throw new Error("Login response cookie is unavailable");
  }
  return pair;
}

function mutationHeaders(user: AuthenticatedUser): Record<string, string> {
  return {
    [CSRF_HEADER_NAME]: user.csrfToken,
    "Content-Type": "application/json",
    Cookie: user.cookie,
    Origin: TEST_PUBLIC_ORIGIN,
  };
}

async function holdRowLock(
  database: DatabaseClient,
  statement: Prisma.Sql,
  missingTargetMessage: string,
): Promise<HeldRowLock> {
  let resolveLocked!: (pid: number) => void;
  let rejectLocked!: (error: unknown) => void;
  const locked = new Promise<number>((resolve, reject) => {
    resolveLocked = resolve;
    rejectLocked = reject;
  });
  let resolveRelease!: () => void;
  const released = new Promise<void>((resolve) => {
    resolveRelease = resolve;
  });
  let didRelease = false;
  const release = (): void => {
    if (!didRelease) {
      didRelease = true;
      resolveRelease();
    }
  };
  const completed = database.$transaction(
    async (transaction) => {
      const rows = await transaction.$queryRaw<Array<{ pid: number }>>(statement);
      const backend = rows[0];
      if (backend === undefined) {
        throw new Error(missingTargetMessage);
      }
      resolveLocked(backend.pid);
      await released;
    },
    { maxWait: 2_000, timeout: LOCK_TRANSACTION_TIMEOUT_MS },
  );
  void completed.catch(rejectLocked);

  try {
    return { completed, lockerPid: await locked, release };
  } catch (error) {
    release();
    await Promise.allSettled([completed]);
    throw error;
  }
}

function holdInvitationRowLock(
  database: DatabaseClient,
  invitationId: string,
): Promise<HeldRowLock> {
  return holdRowLock(
    database,
    Prisma.sql`
      SELECT pg_backend_pid() AS "pid"
      FROM "organization_invitations"
      WHERE "id" = ${invitationId}
      FOR UPDATE
    `,
    "The invitation row lock target does not exist",
  );
}

function holdOrganizationRowLock(
  database: DatabaseClient,
  organizationId: string,
): Promise<HeldRowLock> {
  return holdRowLock(
    database,
    Prisma.sql`
      SELECT pg_backend_pid() AS "pid"
      FROM "organizations"
      WHERE "id" = ${organizationId}
      FOR UPDATE
    `,
    "The organization row lock target does not exist",
  );
}

async function waitForBlockedBackendCount(
  database: DatabaseClient,
  lockerPid: number,
  expectedCount: number,
): Promise<void> {
  // 沿 PostgreSQL 锁等待链统计最终等待目标事务的后端，覆盖排队请求互相转发阻塞者的情况。
  const deadline = Date.now() + LOCK_OBSERVATION_TIMEOUT_MS;
  for (;;) {
    const rows = await database.$queryRaw<
      Array<{
        blockingPids: number[];
        pid: number;
        waitEvent: string | null;
        waitEventType: string | null;
      }>
    >(
      Prisma.sql`
        WITH RECURSIVE lock_chain AS (
          SELECT
            activity.pid AS "pid",
            blocker.pid AS "blockerPid",
            ARRAY[activity.pid, blocker.pid]::bigint[] AS "path"
          FROM pg_stat_activity AS activity
          CROSS JOIN LATERAL unnest(pg_blocking_pids(activity.pid)) AS blocker(pid)
          WHERE activity.wait_event_type = 'Lock'
          UNION ALL
          SELECT
            lock_chain."pid",
            blocker.pid AS "blockerPid",
            lock_chain."path" || blocker.pid
          FROM lock_chain
          INNER JOIN pg_stat_activity AS activity
            ON activity.pid = lock_chain."blockerPid"
          CROSS JOIN LATERAL unnest(pg_blocking_pids(activity.pid)) AS blocker(pid)
          WHERE NOT blocker.pid = ANY(lock_chain."path")
        ),
        blocked_pids AS (
          SELECT DISTINCT "pid"
          FROM lock_chain
          WHERE "blockerPid" = ${lockerPid}
        )
        SELECT
          activity.pid AS "pid",
          activity.wait_event AS "waitEvent",
          activity.wait_event_type AS "waitEventType",
          pg_blocking_pids(activity.pid) AS "blockingPids"
        FROM pg_stat_activity AS activity
        INNER JOIN blocked_pids
          ON blocked_pids."pid" = activity.pid
        WHERE activity.wait_event_type = 'Lock'
      `,
    );
    if (rows.length === expectedCount) {
      return;
    }
    if (rows.length > expectedCount) {
      throw new Error(
        `Observed ${String(rows.length)} blocked backends; expected ${String(expectedCount)}`,
      );
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `Did not observe ${String(expectedCount)} PostgreSQL lock waiters; ` +
          `observed ${String(rows.length)}: ${JSON.stringify(rows)}`,
      );
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

describe("organization membership, invitation, and group HTTP contracts with PostgreSQL", () => {
  let clock: MutableClock;
  let database: DatabaseClient;
  let databaseRuntime: DatabaseRuntime;
  let passwordDigest: string;
  let testApi: TestApiApplication;

  beforeAll(async () => {
    clock = new MutableClock(INITIAL_TIME);
    testApi = await startTestApiApplication({
      clock,
      // 该套件验证组织并发合同；限流器行为由身份测试单独覆盖。
      loginRateLimiter: new LoginRateLimiter(
        new RateLimiterMemory({ duration: 900, points: 1_000 }),
        new RateLimiterMemory({ duration: 900, points: 1_000 }),
      ),
    });
    databaseRuntime = testApi.app.get(DatabaseRuntime);
    database = databaseRuntime.client;
    passwordDigest = await testApi.app
      .get(PasswordHasher)
      .hashPassword(USER_PASSWORD);
  });

  afterEach(async () => {
    clock.set(INITIAL_TIME);
    await truncateTestDatabase(database);
  });

  afterAll(async () => {
    await testApi.dispose();
  });

  async function createUser(loginIdentifier: string): Promise<string> {
    const user = await database.user.create({
      data: { loginIdentifier, passwordDigest, status: "active" },
      select: { id: true },
    });
    return user.id;
  }

  async function login(
    userId: string,
    loginIdentifier: string,
  ): Promise<AuthenticatedUser> {
    const response = await fetch(`${testApi.baseUrl}${AUTH_LOGIN_PATH}`, {
      body: JSON.stringify({ loginIdentifier, password: USER_PASSWORD }),
      headers: {
        "Content-Type": "application/json",
        Origin: TEST_PUBLIC_ORIGIN,
      },
      method: "POST",
    });
    expect(response.status).toBe(200);
    const { csrfToken } = loginResponseSchema.parse(await response.json());
    return {
      cookie: cookiePair(response),
      csrfToken,
      loginIdentifier,
      userId,
    };
  }

  async function createOrganizationGraph(): Promise<OrganizationGraph> {
    const organizationId = randomUUID();
    const loginIdentifier = `owner-${randomUUID()}@example.test`;
    const userId = await createUser(loginIdentifier);
    await database.organization.create({
      data: { id: organizationId, name: "Organization management", status: "active" },
    });
    await database.organizationMembership.create({
      data: { organizationId, role: "owner", status: "active", userId },
    });
    return { organizationId, owner: await login(userId, loginIdentifier) };
  }

  test("revokes an invitation durably and prevents the revoked token from creating an account", async () => {
    const graph = await createOrganizationGraph();
    const loginIdentifier = `revoked-${randomUUID()}@example.test`;
    const invitationsPath = buildPath(ORGANIZATION_INVITATIONS_PATH_TEMPLATE, {
      organizationId: graph.organizationId,
    });
    const createdResponse = await fetch(`${testApi.baseUrl}${invitationsPath}`, {
      body: JSON.stringify({ expiresInHours: 24, loginIdentifier, role: "member" }),
      headers: mutationHeaders(graph.owner),
      method: "POST",
    });
    expect(createdResponse.status).toBe(201);
    const invitation = createdOrganizationInvitationSchema.parse(
      await createdResponse.json(),
    );

    const invitationPath = buildPath(ORGANIZATION_INVITATION_PATH_TEMPLATE, {
      invitationId: invitation.invitationId,
      organizationId: graph.organizationId,
    });
    const revoked = await fetch(`${testApi.baseUrl}${invitationPath}`, {
      headers: mutationHeaders(graph.owner),
      method: "DELETE",
    });
    expect(revoked.status).toBe(204);

    const listed = await fetch(`${testApi.baseUrl}${invitationsPath}`, {
      headers: { Cookie: graph.owner.cookie },
    });
    expect(listed.status).toBe(200);
    expect(
      organizationInvitationsResponseSchema.parse(await listed.json()),
    ).toEqual({
      invitations: [
        expect.objectContaining({
          invitationId: invitation.invitationId,
          loginIdentifier,
          revokedAt: INITIAL_TIME.toISOString(),
        }),
      ],
    });

    const rejectedAcceptance = await fetch(
      `${testApi.baseUrl}${AUTH_INVITATION_ACCEPT_LOCAL_PATH}`,
      {
        body: JSON.stringify({
          invitationToken: invitation.invitationToken,
          password: USER_PASSWORD,
        }),
        headers: {
          "Content-Type": "application/json",
          Origin: TEST_PUBLIC_ORIGIN,
        },
        method: "POST",
      },
    );
    expect(rejectedAcceptance.status).toBe(404);
    expect(apiProblemSchema.parse(await rejectedAcceptance.json()).code).toBe(
      "not-found",
    );
    await expect(
      database.user.findUnique({ where: { loginIdentifier } }),
    ).resolves.toBeNull();

    const invitationState = await database.organizationInvitation.findUniqueOrThrow({
      where: { id: invitation.invitationId },
      select: { acceptedAt: true, revokedAt: true },
    });
    expect(invitationState).toEqual({
      acceptedAt: null,
      revokedAt: INITIAL_TIME,
    });
    const audit = await fetch(
      `${testApi.baseUrl}${buildPath(ORGANIZATION_AUDIT_EVENTS_PATH_TEMPLATE, {
        organizationId: graph.organizationId,
      })}`,
      { headers: { Cookie: graph.owner.cookie } },
    );
    expect(audit.status).toBe(200);
    const invitationEvents = auditEventsResponseSchema
      .parse(await audit.json())
      .events.filter((event) => event.targetId === invitation.invitationId);
    expect(invitationEvents).toEqual([
      expect.objectContaining({
        action: "permission.change",
        targetType: "invitation",
      }),
      expect.objectContaining({
        action: "permission.change",
        targetType: "invitation",
      }),
    ]);
  });

  test("prevents an administrator from revoking an administrator invitation", async () => {
    const graph = await createOrganizationGraph();
    const invitationsPath = buildPath(ORGANIZATION_INVITATIONS_PATH_TEMPLATE, {
      organizationId: graph.organizationId,
    });
    const createdResponse = await fetch(`${testApi.baseUrl}${invitationsPath}`, {
      body: JSON.stringify({
        expiresInHours: 24,
        loginIdentifier: `invited-admin-${randomUUID()}@example.test`,
        role: "admin",
      }),
      headers: mutationHeaders(graph.owner),
      method: "POST",
    });
    expect(createdResponse.status).toBe(201);
    const invitation = createdOrganizationInvitationSchema.parse(
      await createdResponse.json(),
    );
    const adminLoginIdentifier = `invitation-admin-${randomUUID()}@example.test`;
    const adminUserId = await createUser(adminLoginIdentifier);
    await database.organizationMembership.create({
      data: {
        organizationId: graph.organizationId,
        role: "admin",
        status: "active",
        userId: adminUserId,
      },
    });
    const admin = await login(adminUserId, adminLoginIdentifier);
    const auditCount = await database.auditEvent.count({
      where: { organizationId: graph.organizationId },
    });

    const rejected = await fetch(
      `${testApi.baseUrl}${buildPath(ORGANIZATION_INVITATION_PATH_TEMPLATE, {
        invitationId: invitation.invitationId,
        organizationId: graph.organizationId,
      })}`,
      { headers: mutationHeaders(admin), method: "DELETE" },
    );

    expect(rejected.status).toBe(403);
    expect(apiProblemSchema.parse(await rejected.json()).code).toBe("forbidden");
    await expect(
      database.organizationInvitation.findUniqueOrThrow({
        where: { id: invitation.invitationId },
        select: { acceptedAt: true, revokedAt: true, role: true },
      }),
    ).resolves.toEqual({ acceptedAt: null, revokedAt: null, role: "admin" });
    await expect(
      database.auditEvent.count({
        where: { organizationId: graph.organizationId },
      }),
    ).resolves.toBe(auditCount);
  });

  test("accepts an authenticated invitation into the assigned organization role", async () => {
    const graph = await createOrganizationGraph();
    const loginIdentifier = `invitee-${randomUUID()}@example.test`;
    const userId = await createUser(loginIdentifier);
    const invitationsPath = buildPath(ORGANIZATION_INVITATIONS_PATH_TEMPLATE, {
      organizationId: graph.organizationId,
    });
    const createdResponse = await fetch(`${testApi.baseUrl}${invitationsPath}`, {
      body: JSON.stringify({ expiresInHours: 24, loginIdentifier, role: "admin" }),
      headers: mutationHeaders(graph.owner),
      method: "POST",
    });
    expect(createdResponse.status).toBe(201);
    const invitation = createdOrganizationInvitationSchema.parse(
      await createdResponse.json(),
    );
    const invitee = await login(userId, loginIdentifier);

    const accepted = await fetch(`${testApi.baseUrl}${AUTH_INVITATION_ACCEPT_PATH}`, {
      body: JSON.stringify({ invitationToken: invitation.invitationToken }),
      headers: mutationHeaders(invitee),
      method: "POST",
    });
    expect(accepted.status).toBe(204);

    const members = await fetch(
      `${testApi.baseUrl}${buildPath(ORGANIZATION_MEMBERS_PATH_TEMPLATE, {
        organizationId: graph.organizationId,
      })}`,
      { headers: { Cookie: graph.owner.cookie } },
    );
    expect(members.status).toBe(200);
    expect(
      organizationMembersResponseSchema.parse(await members.json()).members,
    ).toContainEqual({
      accountStatus: "active",
      loginIdentifier,
      role: "admin",
      status: "active",
      userId,
    });

    const membership = await database.organizationMembership.findUniqueOrThrow({
      where: { organizationId_userId: { organizationId: graph.organizationId, userId } },
      select: { role: true, status: true },
    });
    expect(membership).toEqual({ role: "admin", status: "active" });
    const invitationState = await database.organizationInvitation.findUniqueOrThrow({
      where: { id: invitation.invitationId },
      select: { acceptedAt: true, acceptedByUserId: true, revokedAt: true },
    });
    expect(invitationState).toEqual({
      acceptedAt: INITIAL_TIME,
      acceptedByUserId: userId,
      revokedAt: null,
    });
    const audit = await fetch(
      `${testApi.baseUrl}${buildPath(ORGANIZATION_AUDIT_EVENTS_PATH_TEMPLATE, {
        organizationId: graph.organizationId,
      })}`,
      { headers: { Cookie: graph.owner.cookie } },
    );
    expect(audit.status).toBe(200);
    expect(
      auditEventsResponseSchema
        .parse(await audit.json())
        .events.filter(
          (event) =>
            event.targetId === userId && event.targetType === "membership",
        ),
    ).toEqual([
      expect.objectContaining({ action: "permission.change" }),
    ]);
  });

  test("rechecks invitation expiry after waiting for the invitation row lock", async () => {
    const graph = await createOrganizationGraph();
    const loginIdentifier = `expiring-invitee-${randomUUID()}@example.test`;
    const userId = await createUser(loginIdentifier);
    const invitationsPath = buildPath(ORGANIZATION_INVITATIONS_PATH_TEMPLATE, {
      organizationId: graph.organizationId,
    });
    const createdResponse = await fetch(`${testApi.baseUrl}${invitationsPath}`, {
      body: JSON.stringify({ expiresInHours: 1, loginIdentifier, role: "member" }),
      headers: mutationHeaders(graph.owner),
      method: "POST",
    });
    expect(createdResponse.status).toBe(201);
    const invitation = createdOrganizationInvitationSchema.parse(
      await createdResponse.json(),
    );
    const invitee = await login(userId, loginIdentifier);
    const heldLock = await holdInvitationRowLock(
      database,
      invitation.invitationId,
    );
    let acceptance: Promise<Response> | undefined;

    try {
      acceptance = fetch(`${testApi.baseUrl}${AUTH_INVITATION_ACCEPT_PATH}`, {
        body: JSON.stringify({ invitationToken: invitation.invitationToken }),
        headers: mutationHeaders(invitee),
        method: "POST",
      });
      await waitForBlockedBackendCount(database, heldLock.lockerPid, 1);
      clock.set(new Date(INITIAL_TIME.getTime() + 2 * 60 * 60 * 1_000));
      heldLock.release();
      await heldLock.completed;

      const rejected = await acceptance;
      expect(rejected.status).toBe(409);
      expect(apiProblemSchema.parse(await rejected.json()).code).toBe("conflict");
    } finally {
      heldLock.release();
      await Promise.allSettled([
        heldLock.completed,
        ...(acceptance === undefined ? [] : [acceptance]),
      ]);
    }

    await expect(
      database.organizationInvitation.findUniqueOrThrow({
        where: { id: invitation.invitationId },
        select: { acceptedAt: true, acceptedByUserId: true, revokedAt: true },
      }),
    ).resolves.toEqual({
      acceptedAt: null,
      acceptedByUserId: null,
      revokedAt: null,
    });
    await expect(
      database.organizationMembership.findUnique({
        where: {
          organizationId_userId: { organizationId: graph.organizationId, userId },
        },
      }),
    ).resolves.toBeNull();
  });

  test("commits exactly one local account when two requests accept the same invitation", async () => {
    const graph = await createOrganizationGraph();
    const loginIdentifier = `concurrent-local-${randomUUID()}@example.test`;
    const invitationsPath = buildPath(ORGANIZATION_INVITATIONS_PATH_TEMPLATE, {
      organizationId: graph.organizationId,
    });
    const createdResponse = await fetch(`${testApi.baseUrl}${invitationsPath}`, {
      body: JSON.stringify({ expiresInHours: 24, loginIdentifier, role: "member" }),
      headers: mutationHeaders(graph.owner),
      method: "POST",
    });
    expect(createdResponse.status).toBe(201);
    const invitation = createdOrganizationInvitationSchema.parse(
      await createdResponse.json(),
    );
    const heldLock = await holdOrganizationRowLock(database, graph.organizationId);
    const accept = (): Promise<Response> =>
      fetch(`${testApi.baseUrl}${AUTH_INVITATION_ACCEPT_LOCAL_PATH}`, {
        body: JSON.stringify({
          invitationToken: invitation.invitationToken,
          password: USER_PASSWORD,
        }),
        headers: {
          "Content-Type": "application/json",
          Origin: TEST_PUBLIC_ORIGIN,
        },
        method: "POST",
      });
    const acceptances = [accept(), accept()];

    try {
      await waitForBlockedBackendCount(database, heldLock.lockerPid, 2);
      heldLock.release();
      await heldLock.completed;

      const responses = await Promise.all(acceptances);
      expect(
        responses.map(({ status }) => status).sort((left, right) => left - right),
      ).toEqual([200, 409]);
      const accepted = responses.find(({ status }) => status === 200);
      const rejected = responses.find(({ status }) => status === 409);
      if (accepted === undefined || rejected === undefined) {
        throw new Error("The concurrent invitation responses were incomplete");
      }
      loginResponseSchema.parse(await accepted.json());
      expect(accepted.headers.get("set-cookie")).not.toBeNull();
      expect(apiProblemSchema.parse(await rejected.json()).code).toBe("conflict");
    } finally {
      heldLock.release();
      await Promise.allSettled([heldLock.completed, ...acceptances]);
    }

    const user = await database.user.findUniqueOrThrow({
      where: { loginIdentifier },
      select: { id: true },
    });
    await expect(
      database.user.count({ where: { loginIdentifier } }),
    ).resolves.toBe(1);
    await expect(
      database.organizationMembership.findMany({
        where: { organizationId: graph.organizationId, userId: user.id },
        select: { role: true, status: true },
      }),
    ).resolves.toEqual([{ role: "member", status: "active" }]);
    await expect(
      database.authSession.count({ where: { userId: user.id } }),
    ).resolves.toBe(1);
    await expect(
      database.organizationInvitation.findUniqueOrThrow({
        where: { id: invitation.invitationId },
        select: { acceptedAt: true, acceptedByUserId: true, revokedAt: true },
      }),
    ).resolves.toEqual({
      acceptedAt: INITIAL_TIME,
      acceptedByUserId: user.id,
      revokedAt: null,
    });
    await expect(
      database.auditEvent.count({
        where: {
          organizationId: graph.organizationId,
          targetId: user.id,
          targetType: "membership",
        },
      }),
    ).resolves.toBe(1);
  });

  test("lets invitation revocation win over a queued local acceptance", async () => {
    const graph = await createOrganizationGraph();
    const loginIdentifier = `revoke-race-${randomUUID()}@example.test`;
    const invitationsPath = buildPath(ORGANIZATION_INVITATIONS_PATH_TEMPLATE, {
      organizationId: graph.organizationId,
    });
    const createdResponse = await fetch(`${testApi.baseUrl}${invitationsPath}`, {
      body: JSON.stringify({ expiresInHours: 24, loginIdentifier, role: "member" }),
      headers: mutationHeaders(graph.owner),
      method: "POST",
    });
    expect(createdResponse.status).toBe(201);
    const invitation = createdOrganizationInvitationSchema.parse(
      await createdResponse.json(),
    );
    const heldLock = await holdOrganizationRowLock(database, graph.organizationId);
    let revocation: Promise<Response> | undefined;
    let acceptance: Promise<Response> | undefined;

    try {
      revocation = fetch(
        `${testApi.baseUrl}${buildPath(ORGANIZATION_INVITATION_PATH_TEMPLATE, {
          invitationId: invitation.invitationId,
          organizationId: graph.organizationId,
        })}`,
        { headers: mutationHeaders(graph.owner), method: "DELETE" },
      );
      void revocation.catch(() => undefined);
      await waitForBlockedBackendCount(database, heldLock.lockerPid, 1);
      acceptance = fetch(`${testApi.baseUrl}${AUTH_INVITATION_ACCEPT_LOCAL_PATH}`, {
        body: JSON.stringify({
          invitationToken: invitation.invitationToken,
          password: USER_PASSWORD,
        }),
        headers: {
          "Content-Type": "application/json",
          Origin: TEST_PUBLIC_ORIGIN,
        },
        method: "POST",
      });
      void acceptance.catch(() => undefined);
      await waitForBlockedBackendCount(database, heldLock.lockerPid, 2);

      heldLock.release();
      await heldLock.completed;
      const revoked = await revocation;
      const rejected = await acceptance;
      expect(revoked.status).toBe(204);
      expect(rejected.status).toBe(409);
      expect(apiProblemSchema.parse(await rejected.json()).code).toBe("conflict");
    } finally {
      heldLock.release();
      await Promise.allSettled([
        heldLock.completed,
        ...(revocation === undefined ? [] : [revocation]),
        ...(acceptance === undefined ? [] : [acceptance]),
      ]);
    }

    await expect(
      database.organizationInvitation.findUniqueOrThrow({
        where: { id: invitation.invitationId },
        select: { acceptedAt: true, acceptedByUserId: true, revokedAt: true },
      }),
    ).resolves.toEqual({
      acceptedAt: null,
      acceptedByUserId: null,
      revokedAt: INITIAL_TIME,
    });
    await expect(
      database.user.findUnique({ where: { loginIdentifier } }),
    ).resolves.toBeNull();
    await expect(
      database.auditEvent.count({
        where: {
          organizationId: graph.organizationId,
          targetId: invitation.invitationId,
          targetType: "invitation",
        },
      }),
    ).resolves.toBe(2);
  });

  test("lets invitation reissue win over a queued local acceptance", async () => {
    const graph = await createOrganizationGraph();
    const loginIdentifier = `reissue-race-${randomUUID()}@example.test`;
    const invitationsPath = buildPath(ORGANIZATION_INVITATIONS_PATH_TEMPLATE, {
      organizationId: graph.organizationId,
    });
    const firstResponse = await fetch(`${testApi.baseUrl}${invitationsPath}`, {
      body: JSON.stringify({ expiresInHours: 24, loginIdentifier, role: "member" }),
      headers: mutationHeaders(graph.owner),
      method: "POST",
    });
    expect(firstResponse.status).toBe(201);
    const firstInvitation = createdOrganizationInvitationSchema.parse(
      await firstResponse.json(),
    );
    const heldLock = await holdOrganizationRowLock(database, graph.organizationId);
    let reissue: Promise<Response> | undefined;
    let acceptance: Promise<Response> | undefined;
    let secondInvitationId: string | undefined;

    try {
      reissue = fetch(`${testApi.baseUrl}${invitationsPath}`, {
        body: JSON.stringify({ expiresInHours: 48, loginIdentifier, role: "member" }),
        headers: mutationHeaders(graph.owner),
        method: "POST",
      });
      void reissue.catch(() => undefined);
      await waitForBlockedBackendCount(database, heldLock.lockerPid, 1);
      acceptance = fetch(`${testApi.baseUrl}${AUTH_INVITATION_ACCEPT_LOCAL_PATH}`, {
        body: JSON.stringify({
          invitationToken: firstInvitation.invitationToken,
          password: USER_PASSWORD,
        }),
        headers: {
          "Content-Type": "application/json",
          Origin: TEST_PUBLIC_ORIGIN,
        },
        method: "POST",
      });
      void acceptance.catch(() => undefined);
      await waitForBlockedBackendCount(database, heldLock.lockerPid, 2);

      heldLock.release();
      await heldLock.completed;
      const reissued = await reissue;
      const rejected = await acceptance;
      expect(reissued.status).toBe(201);
      const secondInvitation = createdOrganizationInvitationSchema.parse(
        await reissued.json(),
      );
      secondInvitationId = secondInvitation.invitationId;
      expect(secondInvitation.invitationId).not.toBe(firstInvitation.invitationId);
      expect(rejected.status).toBe(409);
      expect(apiProblemSchema.parse(await rejected.json()).code).toBe("conflict");
    } finally {
      heldLock.release();
      await Promise.allSettled([
        heldLock.completed,
        ...(reissue === undefined ? [] : [reissue]),
        ...(acceptance === undefined ? [] : [acceptance]),
      ]);
    }

    if (secondInvitationId === undefined) {
      throw new Error("The reissued invitation response was unavailable");
    }
    await expect(
      database.organizationInvitation.findUniqueOrThrow({
        where: { id: firstInvitation.invitationId },
        select: { acceptedAt: true, acceptedByUserId: true, revokedAt: true },
      }),
    ).resolves.toEqual({
      acceptedAt: null,
      acceptedByUserId: null,
      revokedAt: INITIAL_TIME,
    });
    await expect(
      database.organizationInvitation.findUniqueOrThrow({
        where: { id: secondInvitationId },
        select: { acceptedAt: true, revokedAt: true },
      }),
    ).resolves.toEqual({ acceptedAt: null, revokedAt: null });
    await expect(
      database.user.findUnique({ where: { loginIdentifier } }),
    ).resolves.toBeNull();
    await expect(
      database.auditEvent.count({
        where: {
          organizationId: graph.organizationId,
          targetId: firstInvitation.invitationId,
          targetType: "invitation",
        },
      }),
    ).resolves.toBe(2);
    await expect(
      database.auditEvent.count({
        where: {
          organizationId: graph.organizationId,
          targetId: secondInvitationId,
          targetType: "invitation",
        },
      }),
    ).resolves.toBe(1);
  });

  test("publishes one organization-and-user close event when acceptance updates an active membership", async () => {
    const graph = await createOrganizationGraph();
    const loginIdentifier = `active-invitee-${randomUUID()}@example.test`;
    const userId = await createUser(loginIdentifier);
    await database.organizationMembership.create({
      data: {
        organizationId: graph.organizationId,
        role: "member",
        status: "inactive",
        userId,
      },
    });
    const invitationsPath = buildPath(ORGANIZATION_INVITATIONS_PATH_TEMPLATE, {
      organizationId: graph.organizationId,
    });
    const createdResponse = await fetch(`${testApi.baseUrl}${invitationsPath}`, {
      body: JSON.stringify({ expiresInHours: 24, loginIdentifier, role: "admin" }),
      headers: mutationHeaders(graph.owner),
      method: "POST",
    });
    expect(createdResponse.status).toBe(201);
    const invitation = createdOrganizationInvitationSchema.parse(
      await createdResponse.json(),
    );

    await database.organizationMembership.update({
      where: {
        organizationId_userId: { organizationId: graph.organizationId, userId },
      },
      data: { status: "active" },
    });
    const invitee = await login(userId, loginIdentifier);

    const closeEvents: unknown[] = [];
    let resolveClose!: (event: unknown) => void;
    let rejectClose!: (error: unknown) => void;
    const closeEvent = new Promise<unknown>((resolve, reject) => {
      resolveClose = resolve;
      rejectClose = reject;
    });
    const subscription = await testApi.app.get(DatabaseRuntime).listen(
      ACCESS_CHANGE_CHANNEL,
      (payload) => {
        let decoded: unknown;
        try {
          decoded = JSON.parse(payload) as unknown;
        } catch (error) {
          rejectClose(error);
          return;
        }
        if (
          typeof decoded === "object" &&
          decoded !== null &&
          "kind" in decoded &&
          (decoded as { kind?: unknown }).kind === "close"
        ) {
          closeEvents.push(decoded);
          resolveClose(decoded);
        }
      },
      rejectClose,
    );
    let notificationTimeout: ReturnType<typeof setTimeout> | undefined;

    try {
      const accepted = await fetch(`${testApi.baseUrl}${AUTH_INVITATION_ACCEPT_PATH}`, {
        body: JSON.stringify({ invitationToken: invitation.invitationToken }),
        headers: mutationHeaders(invitee),
        method: "POST",
      });
      expect(accepted.status).toBe(204);
      const event = await Promise.race([
        closeEvent,
        new Promise<never>((_, reject) => {
          notificationTimeout = setTimeout(
            () => reject(new Error("active-membership close event was not delivered")),
            NOTIFICATION_TIMEOUT_MS,
          );
        }),
      ]);
      expect(event).toEqual({
        kind: "close",
        reason: "forbidden",
        requestId: expect.any(String),
        selectors: [
          { kind: "organization", value: graph.organizationId },
          { kind: "user", value: userId },
        ],
      });
      expect(closeEvents).toHaveLength(1);
      await expect(
        database.organizationMembership.findUniqueOrThrow({
          where: {
            organizationId_userId: { organizationId: graph.organizationId, userId },
          },
          select: { role: true, status: true },
        }),
      ).resolves.toEqual({ role: "admin", status: "active" });
    } finally {
      if (notificationTimeout !== undefined) {
        clearTimeout(notificationTimeout);
      }
      await subscription.close();
    }
  });

  test("treats an identical owner member patch as a side-effect-free success", async () => {
    const graph = await createOrganizationGraph();
    const memberPath = buildPath(ORGANIZATION_MEMBER_PATH_TEMPLATE, {
      organizationId: graph.organizationId,
      userId: graph.owner.userId,
    });
    const auditCount = await database.auditEvent.count({
      where: { organizationId: graph.organizationId },
    });

    const captured = await captureAccessChanges(databaseRuntime, () =>
      fetch(`${testApi.baseUrl}${memberPath}`, {
        body: JSON.stringify({ status: "active" }),
        headers: mutationHeaders(graph.owner),
        method: "PATCH",
      }),
    );

    expect(captured.result.status).toBe(200);
    expect(
      organizationMemberSummarySchema.parse(await captured.result.json()),
    ).toEqual({
      accountStatus: "active",
      loginIdentifier: graph.owner.loginIdentifier,
      role: "owner",
      status: "active",
      userId: graph.owner.userId,
    });
    expect(captured.events).toEqual([]);
    await expect(
      database.auditEvent.count({
        where: { organizationId: graph.organizationId },
      }),
    ).resolves.toBe(auditCount);
  });

  test.each([
    { label: "role downgrade", update: { role: "admin" } },
    { label: "deactivation", update: { status: "inactive" } },
  ])("rejects an owner $label without changing the membership", async ({ update }) => {
    const graph = await createOrganizationGraph();

    const rejected = await fetch(
      `${testApi.baseUrl}${buildPath(ORGANIZATION_MEMBER_PATH_TEMPLATE, {
        organizationId: graph.organizationId,
        userId: graph.owner.userId,
      })}`,
      {
        body: JSON.stringify(update),
        headers: mutationHeaders(graph.owner),
        method: "PATCH",
      },
    );

    expect(rejected.status).toBe(409);
    expect(apiProblemSchema.parse(await rejected.json()).code).toBe("conflict");
    await expect(
      database.organizationMembership.findUniqueOrThrow({
        where: {
          organizationId_userId: {
            organizationId: graph.organizationId,
            userId: graph.owner.userId,
          },
        },
        select: { role: true, status: true },
      }),
    ).resolves.toEqual({ role: "owner", status: "active" });
  });

  test("updates a member role and status with durable access removal and audit", async () => {
    const graph = await createOrganizationGraph();
    const loginIdentifier = `managed-member-${randomUUID()}@example.test`;
    const userId = await createUser(loginIdentifier);
    await database.organizationMembership.create({
      data: {
        organizationId: graph.organizationId,
        role: "member",
        status: "active",
        userId,
      },
    });
    const space = await database.space.create({
      data: {
        name: "Managed member space",
        organizationId: graph.organizationId,
        status: "active",
      },
    });
    await database.spaceMembership.create({
      data: {
        organizationId: graph.organizationId,
        role: "editor",
        spaceId: space.id,
        status: "active",
        userId,
      },
    });

    const updated = await fetch(
      `${testApi.baseUrl}${buildPath(ORGANIZATION_MEMBER_PATH_TEMPLATE, {
        organizationId: graph.organizationId,
        userId,
      })}`,
      {
        body: JSON.stringify({ role: "admin", status: "inactive" }),
        headers: mutationHeaders(graph.owner),
        method: "PATCH",
      },
    );
    expect(updated.status).toBe(200);
    expect(organizationMemberSummarySchema.parse(await updated.json())).toEqual({
      accountStatus: "active",
      loginIdentifier,
      role: "admin",
      status: "inactive",
      userId,
    });
    await expect(
      database.organizationMembership.findUniqueOrThrow({
        where: {
          organizationId_userId: {
            organizationId: graph.organizationId,
            userId,
          },
        },
        select: { role: true, status: true },
      }),
    ).resolves.toEqual({ role: "admin", status: "inactive" });
    await expect(
      database.spaceMembership.findUniqueOrThrow({
        where: { spaceId_userId: { spaceId: space.id, userId } },
        select: { status: true },
      }),
    ).resolves.toEqual({ status: "inactive" });

    const audit = await fetch(
      `${testApi.baseUrl}${buildPath(ORGANIZATION_AUDIT_EVENTS_PATH_TEMPLATE, {
        organizationId: graph.organizationId,
      })}`,
      { headers: { Cookie: graph.owner.cookie } },
    );
    expect(audit.status).toBe(200);
    expect(
      auditEventsResponseSchema
        .parse(await audit.json())
        .events.filter((event) => event.targetId === userId),
    ).toEqual([
      expect.objectContaining({
        action: "permission.change",
        actorUserId: graph.owner.userId,
        organizationId: graph.organizationId,
        outcome: "succeeded",
        spaceId: null,
        targetType: "membership",
      }),
    ]);
  });

  test("lets an administrator revoke every member session and records the revocation", async () => {
    const graph = await createOrganizationGraph();
    const adminLoginIdentifier = `admin-${randomUUID()}@example.test`;
    const adminUserId = await createUser(adminLoginIdentifier);
    await database.organizationMembership.create({
      data: {
        organizationId: graph.organizationId,
        role: "admin",
        status: "active",
        userId: adminUserId,
      },
    });
    const admin = await login(adminUserId, adminLoginIdentifier);
    const memberLoginIdentifier = `session-member-${randomUUID()}@example.test`;
    const memberUserId = await createUser(memberLoginIdentifier);
    await database.organizationMembership.create({
      data: {
        organizationId: graph.organizationId,
        role: "member",
        status: "active",
        userId: memberUserId,
      },
    });
    const member = await login(memberUserId, memberLoginIdentifier);
    await login(memberUserId, memberLoginIdentifier);

    const revoked = await fetch(
      `${testApi.baseUrl}${buildPath(ORGANIZATION_MEMBER_SESSIONS_PATH_TEMPLATE, {
        organizationId: graph.organizationId,
        userId: memberUserId,
      })}`,
      { headers: mutationHeaders(admin), method: "POST" },
    );
    expect(revoked.status).toBe(204);
    await expect(
      database.authSession.count({
        where: { revokedAt: INITIAL_TIME, userId: memberUserId },
      }),
    ).resolves.toBe(2);
    await expect(
      database.authSession.count({
        where: { revokedAt: null, userId: adminUserId },
      }),
    ).resolves.toBe(1);

    const rejectedSession = await fetch(
      `${testApi.baseUrl}${buildPath(ORGANIZATION_MEMBERS_PATH_TEMPLATE, {
        organizationId: graph.organizationId,
      })}`,
      { headers: { Cookie: member.cookie } },
    );
    expect(rejectedSession.status).toBe(401);
    expect(apiProblemSchema.parse(await rejectedSession.json()).code).toBe(
      "unauthenticated",
    );

    const audit = await fetch(
      `${testApi.baseUrl}${buildPath(ORGANIZATION_AUDIT_EVENTS_PATH_TEMPLATE, {
        organizationId: graph.organizationId,
      })}`,
      { headers: { Cookie: graph.owner.cookie } },
    );
    expect(audit.status).toBe(200);
    expect(
      auditEventsResponseSchema
        .parse(await audit.json())
        .events.filter((event) => event.targetId === memberUserId),
    ).toEqual([
      expect.objectContaining({
        action: "permission.change",
        actorUserId: adminUserId,
        organizationId: graph.organizationId,
        outcome: "succeeded",
        spaceId: null,
        targetType: "session",
      }),
    ]);
  });

  test("keeps every session active when the target belongs to another active organization", async () => {
    const graph = await createOrganizationGraph();
    const loginIdentifier = `multi-organization-${randomUUID()}@example.test`;
    const userId = await createUser(loginIdentifier);
    await database.organizationMembership.create({
      data: {
        organizationId: graph.organizationId,
        role: "member",
        status: "active",
        userId,
      },
    });
    const otherGraph = await createOrganizationGraph();
    await database.organizationMembership.create({
      data: {
        organizationId: otherGraph.organizationId,
        role: "member",
        status: "active",
        userId,
      },
    });
    await login(userId, loginIdentifier);
    await login(userId, loginIdentifier);

    const rejected = await fetch(
      `${testApi.baseUrl}${buildPath(ORGANIZATION_MEMBER_SESSIONS_PATH_TEMPLATE, {
        organizationId: graph.organizationId,
        userId,
      })}`,
      { headers: mutationHeaders(graph.owner), method: "POST" },
    );

    expect(rejected.status).toBe(409);
    expect(apiProblemSchema.parse(await rejected.json()).code).toBe("conflict");
    await expect(
      database.authSession.count({ where: { revokedAt: null, userId } }),
    ).resolves.toBe(2);
    await expect(
      database.authSession.count({ where: { revokedAt: { not: null }, userId } }),
    ).resolves.toBe(0);
    await expect(
      database.auditEvent.count({
        where: {
          organizationId: graph.organizationId,
          targetId: userId,
          targetType: "session",
        },
      }),
    ).resolves.toBe(0);
  });

  test("transfers ownership atomically and applies the new owner-only authorization", async () => {
    const graph = await createOrganizationGraph();
    const loginIdentifier = `new-owner-${randomUUID()}@example.test`;
    const userId = await createUser(loginIdentifier);
    await database.organizationMembership.create({
      data: {
        organizationId: graph.organizationId,
        role: "member",
        status: "active",
        userId,
      },
    });
    const newOwner = await login(userId, loginIdentifier);
    const ownershipPath = buildPath(ORGANIZATION_OWNERSHIP_PATH_TEMPLATE, {
      organizationId: graph.organizationId,
    });

    const transferred = await fetch(`${testApi.baseUrl}${ownershipPath}`, {
      body: JSON.stringify({ newOwnerUserId: userId }),
      headers: mutationHeaders(graph.owner),
      method: "POST",
    });
    expect(transferred.status).toBe(204);
    await expect(
      database.organizationMembership.findMany({
        orderBy: { userId: "asc" },
        select: { role: true, userId: true },
        where: { organizationId: graph.organizationId },
      }),
    ).resolves.toEqual(
      [
        { role: "admin", userId: graph.owner.userId },
        { role: "owner", userId },
      ].sort((left, right) => left.userId.localeCompare(right.userId)),
    );

    const formerOwnerRejected = await fetch(`${testApi.baseUrl}${ownershipPath}`, {
      body: JSON.stringify({ newOwnerUserId: graph.owner.userId }),
      headers: mutationHeaders(graph.owner),
      method: "POST",
    });
    expect(formerOwnerRejected.status).toBe(403);
    expect(apiProblemSchema.parse(await formerOwnerRejected.json()).code).toBe(
      "forbidden",
    );

    const audit = await fetch(
      `${testApi.baseUrl}${buildPath(ORGANIZATION_AUDIT_EVENTS_PATH_TEMPLATE, {
        organizationId: graph.organizationId,
      })}`,
      { headers: { Cookie: newOwner.cookie } },
    );
    expect(audit.status).toBe(200);
    expect(
      auditEventsResponseSchema
        .parse(await audit.json())
        .events.filter((event) => event.targetId === userId),
    ).toEqual([
      expect.objectContaining({
        action: "permission.change",
        actorUserId: graph.owner.userId,
        organizationId: graph.organizationId,
        outcome: "succeeded",
        spaceId: null,
        targetType: "membership",
      }),
    ]);
  });

  test("keeps the current owner when they consume an invitation created before ownership transfer", async () => {
    const graph = await createOrganizationGraph();
    const loginIdentifier = `stale-owner-invitation-${randomUUID()}@example.test`;
    const userId = await createUser(loginIdentifier);
    await database.organizationMembership.create({
      data: {
        organizationId: graph.organizationId,
        role: "member",
        status: "inactive",
        userId,
      },
    });
    const invitationsPath = buildPath(ORGANIZATION_INVITATIONS_PATH_TEMPLATE, {
      organizationId: graph.organizationId,
    });
    const createdResponse = await fetch(`${testApi.baseUrl}${invitationsPath}`, {
      body: JSON.stringify({
        expiresInHours: 24,
        loginIdentifier,
        role: "member",
      }),
      headers: mutationHeaders(graph.owner),
      method: "POST",
    });
    expect(createdResponse.status).toBe(201);
    const invitation = createdOrganizationInvitationSchema.parse(
      await createdResponse.json(),
    );

    const activated = await fetch(
      `${testApi.baseUrl}${buildPath(ORGANIZATION_MEMBER_PATH_TEMPLATE, {
        organizationId: graph.organizationId,
        userId,
      })}`,
      {
        body: JSON.stringify({ status: "active" }),
        headers: mutationHeaders(graph.owner),
        method: "PATCH",
      },
    );
    expect(activated.status).toBe(200);
    const newOwner = await login(userId, loginIdentifier);
    const transferred = await fetch(
      `${testApi.baseUrl}${buildPath(ORGANIZATION_OWNERSHIP_PATH_TEMPLATE, {
        organizationId: graph.organizationId,
      })}`,
      {
        body: JSON.stringify({ newOwnerUserId: userId }),
        headers: mutationHeaders(graph.owner),
        method: "POST",
      },
    );
    expect(transferred.status).toBe(204);

    const rejectedAcceptance = await fetch(
      `${testApi.baseUrl}${AUTH_INVITATION_ACCEPT_PATH}`,
      {
        body: JSON.stringify({ invitationToken: invitation.invitationToken }),
        headers: mutationHeaders(newOwner),
        method: "POST",
      },
    );
    expect(rejectedAcceptance.status).toBe(409);
    expect(apiProblemSchema.parse(await rejectedAcceptance.json()).code).toBe(
      "conflict",
    );
    await expect(
      database.organizationMembership.findMany({
        orderBy: { userId: "asc" },
        select: { role: true, userId: true },
        where: { organizationId: graph.organizationId },
      }),
    ).resolves.toEqual(
      [
        { role: "admin", userId: graph.owner.userId },
        { role: "owner", userId },
      ].sort((left, right) => left.userId.localeCompare(right.userId)),
    );
    await expect(
      database.organizationInvitation.findUniqueOrThrow({
        where: { id: invitation.invitationId },
        select: { acceptedAt: true, acceptedByUserId: true },
      }),
    ).resolves.toEqual({ acceptedAt: null, acceptedByUserId: null });
  });

  test("rejects organization members before they can create a group", async () => {
    const graph = await createOrganizationGraph();
    const loginIdentifier = `member-${randomUUID()}@example.test`;
    const userId = await createUser(loginIdentifier);
    await database.organizationMembership.create({
      data: {
        organizationId: graph.organizationId,
        role: "member",
        status: "active",
        userId,
      },
    });
    const member = await login(userId, loginIdentifier);
    const groupsPath = buildPath(ORGANIZATION_GROUPS_PATH_TEMPLATE, {
      organizationId: graph.organizationId,
    });

    const rejected = await fetch(`${testApi.baseUrl}${groupsPath}`, {
      body: JSON.stringify({ name: "Unauthorized" }),
      headers: mutationHeaders(member),
      method: "POST",
    });
    expect(rejected.status).toBe(403);
    expect(apiProblemSchema.parse(await rejected.json()).code).toBe("forbidden");
    await expect(
      database.userGroup.count({ where: { organizationId: graph.organizationId } }),
    ).resolves.toBe(0);
  });

  test("creates a group, changes its membership, disables it, and records each permission change", async () => {
    const graph = await createOrganizationGraph();
    const loginIdentifier = `group-member-${randomUUID()}@example.test`;
    const userId = await createUser(loginIdentifier);
    await database.organizationMembership.create({
      data: {
        organizationId: graph.organizationId,
        role: "member",
        status: "active",
        userId,
      },
    });
    const groupsPath = buildPath(ORGANIZATION_GROUPS_PATH_TEMPLATE, {
      organizationId: graph.organizationId,
    });
    const createdResponse = await fetch(`${testApi.baseUrl}${groupsPath}`, {
      body: JSON.stringify({ name: "Design" }),
      headers: mutationHeaders(graph.owner),
      method: "POST",
    });
    expect(createdResponse.status).toBe(201);
    const group = userGroupSummarySchema.parse(await createdResponse.json());
    const space = await database.space.create({
      data: {
        name: "Group idempotency space",
        organizationId: graph.organizationId,
        status: "active",
      },
    });
    await database.spaceGroupGrant.create({
      data: {
        groupId: group.groupId,
        organizationId: graph.organizationId,
        role: "viewer",
        spaceId: space.id,
      },
    });

    const memberPath = buildPath(ORGANIZATION_GROUP_MEMBER_PATH_TEMPLATE, {
      groupId: group.groupId,
      organizationId: graph.organizationId,
      userId,
    });
    const added = await fetch(`${testApi.baseUrl}${memberPath}`, {
      headers: mutationHeaders(graph.owner),
      method: "PUT",
    });
    expect(added.status).toBe(204);
    const auditCountAfterAdd = await database.auditEvent.count({
      where: { organizationId: graph.organizationId },
    });
    const repeatedAdd = await captureAccessChanges(databaseRuntime, () =>
      fetch(`${testApi.baseUrl}${memberPath}`, {
        headers: mutationHeaders(graph.owner),
        method: "PUT",
      }),
    );
    expect(repeatedAdd.result.status).toBe(204);
    expect(repeatedAdd.events).toEqual([]);
    await expect(
      database.auditEvent.count({
        where: { organizationId: graph.organizationId },
      }),
    ).resolves.toBe(auditCountAfterAdd);
    const membersPath = buildPath(ORGANIZATION_GROUP_MEMBERS_PATH_TEMPLATE, {
      groupId: group.groupId,
      organizationId: graph.organizationId,
    });
    const listedMembers = await fetch(`${testApi.baseUrl}${membersPath}`, {
      headers: { Cookie: graph.owner.cookie },
    });
    expect(listedMembers.status).toBe(200);
    expect(
      userGroupMembersResponseSchema.parse(await listedMembers.json()),
    ).toEqual({ members: [{ loginIdentifier, userId }] });

    const groupPath = buildPath(ORGANIZATION_GROUP_PATH_TEMPLATE, {
      groupId: group.groupId,
      organizationId: graph.organizationId,
    });
    const repeatedPatch = await captureAccessChanges(databaseRuntime, () =>
      fetch(`${testApi.baseUrl}${groupPath}`, {
        body: JSON.stringify({ name: "Design", status: "active" }),
        headers: mutationHeaders(graph.owner),
        method: "PATCH",
      }),
    );
    expect(repeatedPatch.result.status).toBe(200);
    expect(
      userGroupSummarySchema.parse(await repeatedPatch.result.json()),
    ).toEqual({
      groupId: group.groupId,
      memberCount: 1,
      name: "Design",
      organizationId: graph.organizationId,
      status: "active",
    });
    expect(repeatedPatch.events).toEqual([]);
    await expect(
      database.auditEvent.count({
        where: { organizationId: graph.organizationId },
      }),
    ).resolves.toBe(auditCountAfterAdd);

    const removed = await fetch(`${testApi.baseUrl}${memberPath}`, {
      headers: mutationHeaders(graph.owner),
      method: "DELETE",
    });
    expect(removed.status).toBe(204);
    const auditCountAfterRemove = await database.auditEvent.count({
      where: { organizationId: graph.organizationId },
    });
    const repeatedRemove = await captureAccessChanges(databaseRuntime, () =>
      fetch(`${testApi.baseUrl}${memberPath}`, {
        headers: mutationHeaders(graph.owner),
        method: "DELETE",
      }),
    );
    expect(repeatedRemove.result.status).toBe(204);
    expect(repeatedRemove.events).toEqual([]);
    await expect(
      database.auditEvent.count({
        where: { organizationId: graph.organizationId },
      }),
    ).resolves.toBe(auditCountAfterRemove);
    const disabledResponse = await fetch(`${testApi.baseUrl}${groupPath}`, {
      body: JSON.stringify({ status: "disabled" }),
      headers: mutationHeaders(graph.owner),
      method: "PATCH",
    });
    expect(disabledResponse.status).toBe(200);
    expect(userGroupSummarySchema.parse(await disabledResponse.json())).toEqual({
      groupId: group.groupId,
      memberCount: 0,
      name: "Design",
      organizationId: graph.organizationId,
      status: "disabled",
    });

    const listedGroups = await fetch(`${testApi.baseUrl}${groupsPath}`, {
      headers: { Cookie: graph.owner.cookie },
    });
    expect(listedGroups.status).toBe(200);
    expect(userGroupsResponseSchema.parse(await listedGroups.json())).toEqual({
      groups: [
        {
          groupId: group.groupId,
          memberCount: 0,
          name: "Design",
          organizationId: graph.organizationId,
          status: "disabled",
        },
      ],
    });
    await expect(
      database.userGroupMembership.count({
        where: { groupId: group.groupId, userId },
      }),
    ).resolves.toBe(0);
    await expect(
      database.userGroup.findUniqueOrThrow({
        where: { id: group.groupId },
        select: { status: true },
      }),
    ).resolves.toEqual({ status: "disabled" });

    const audit = await fetch(
      `${testApi.baseUrl}${buildPath(ORGANIZATION_AUDIT_EVENTS_PATH_TEMPLATE, {
        organizationId: graph.organizationId,
      })}`,
      { headers: { Cookie: graph.owner.cookie } },
    );
    expect(audit.status).toBe(200);
    const events = auditEventsResponseSchema.parse(await audit.json()).events;
    expect(
      events.filter((event) => event.targetId === group.groupId),
    ).toEqual([
      expect.objectContaining({
        action: "permission.change",
        targetType: "group",
      }),
      expect.objectContaining({
        action: "permission.change",
        targetType: "group",
      }),
    ]);
    expect(
      events.filter(
        (event) =>
          event.targetId === userId && event.targetType === "membership",
      ),
    ).toEqual([
      expect.objectContaining({ action: "permission.change" }),
      expect.objectContaining({ action: "permission.change" }),
    ]);
  });
});
