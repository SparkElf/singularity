import { randomUUID } from "node:crypto";

import {
  AUTH_CSRF_PATH,
  AUTH_LOGIN_PATH,
  AUTH_LOGOUT_PATH,
  AUTH_SESSION_COOKIE_NAME,
  CSRF_HEADER_NAME,
  type AccessOperationResult,
  loginResponseSchema,
} from "@singularity/contracts";
import {
  type DatabaseClient,
  DatabaseRuntime,
  Prisma,
} from "@singularity/database";
import { describe, expect, test } from "vitest";

import { PasswordHasher } from "../src/identity/password-hasher.js";
import { AccessOperationsService } from "../src/operations/access-operations.service.js";
import {
  startTestApiApplication,
  TEST_PUBLIC_ORIGIN,
} from "./support/test-app.js";
import { truncateTestDatabase } from "./support/database.js";

const password = "correct horse battery staple";
const caseTimeoutMilliseconds = 15_000;
const lockObservationWindowMilliseconds = 3_000;

interface ConcurrencyTestContext {
  baseUrl: string;
  database: DatabaseClient;
  operations: AccessOperationsService;
  passwordHasher: PasswordHasher;
}

interface HeldRowLock {
  completed: Promise<void>;
  lockerPid: number;
  release(): void;
}

async function withTestApplication(
  run: (context: ConcurrencyTestContext) => Promise<void>,
): Promise<void> {
  const testApi = await startTestApiApplication();
  const database = testApi.app.get(DatabaseRuntime).client;
  try {
    await run({
      baseUrl: testApi.baseUrl,
      database,
      operations: testApi.app.get(AccessOperationsService),
      passwordHasher: testApi.app.get(PasswordHasher),
    });
  } finally {
    try {
      await truncateTestDatabase(database);
    } finally {
      await testApi.dispose();
    }
  }
}

function loginRequest(
  baseUrl: string,
  loginIdentifier: string,
): Promise<Response> {
  return fetch(`${baseUrl}${AUTH_LOGIN_PATH}`, {
    body: JSON.stringify({ loginIdentifier, password }),
    headers: {
      "Content-Type": "application/json",
      Origin: TEST_PUBLIC_ORIGIN,
    },
    method: "POST",
  });
}

function sessionCookie(response: Response): string {
  const setCookie = response.headers.get("set-cookie");
  if (setCookie === null) {
    throw new Error("The login response did not set a session cookie");
  }
  const separator = setCookie.indexOf(";");
  const cookie = separator === -1 ? setCookie : setCookie.slice(0, separator);
  if (!cookie.startsWith(`${AUTH_SESSION_COOKIE_NAME}=`)) {
    throw new Error("The login response set an unexpected cookie");
  }
  return cookie;
}

async function createLoginUser(
  context: ConcurrencyTestContext,
): Promise<{ loginIdentifier: string; userId: string }> {
  const loginIdentifier = `concurrency-${randomUUID()}@example.test`;
  const passwordDigest = await context.passwordHasher.hashPassword(password);
  const user = await context.database.user.create({
    data: { loginIdentifier, passwordDigest, status: "active" },
    select: { id: true },
  });
  return { loginIdentifier, userId: user.id };
}

async function createAuthenticatedUser(
  context: ConcurrencyTestContext,
): Promise<{
  cookie: string;
  csrfToken: string;
  userId: string;
}> {
  const user = await createLoginUser(context);
  const response = await loginRequest(context.baseUrl, user.loginIdentifier);
  if (response.status !== 200) {
    await response.arrayBuffer();
    throw new Error(`The session setup login returned ${String(response.status)}`);
  }
  const cookie = sessionCookie(response);
  const body = loginResponseSchema.parse(await response.json());
  return { cookie, csrfToken: body.csrfToken, userId: user.userId };
}

async function createMemberGraph(
  database: DatabaseClient,
): Promise<{ organizationId: string; spaceId: string; userId: string }> {
  const user = await database.user.create({
    data: {
      loginIdentifier: `member-${randomUUID()}@example.test`,
      passwordDigest: "unused-in-concurrency-membership-test",
      status: "active",
    },
    select: { id: true },
  });
  const organization = await database.organization.create({
    data: { name: `Organization ${randomUUID()}`, status: "active" },
    select: { id: true },
  });
  await database.organizationMembership.create({
    data: {
      organizationId: organization.id,
      role: "member",
      status: "active",
      userId: user.id,
    },
  });
  const space = await database.space.create({
    data: {
      name: `Space ${randomUUID()}`,
      organizationId: organization.id,
      status: "active",
    },
    select: { id: true },
  });
  return {
    organizationId: organization.id,
    spaceId: space.id,
    userId: user.id,
  };
}

async function createOrganizationRevocationLockGraph(
  database: DatabaseClient,
): Promise<{
  organizationId: string;
  relatedSpaceId: string;
  unrelatedSpaceId: string;
  userId: string;
}> {
  const graph = await createMemberGraph(database);
  const unrelatedSpace = await database.space.create({
    data: {
      name: `Unrelated Space ${randomUUID()}`,
      organizationId: graph.organizationId,
      status: "active",
    },
    select: { id: true },
  });
  await database.spaceMembership.create({
    data: {
      organizationId: graph.organizationId,
      role: "editor",
      spaceId: graph.spaceId,
      status: "active",
      userId: graph.userId,
    },
  });
  return {
    organizationId: graph.organizationId,
    relatedSpaceId: graph.spaceId,
    unrelatedSpaceId: unrelatedSpace.id,
    userId: graph.userId,
  };
}

async function holdRow(
  database: DatabaseClient,
  query: Prisma.Sql,
  missingTargetMessage: string,
): Promise<HeldRowLock> {
  let resolveReady!: (pid: number) => void;
  let rejectReady!: (reason?: unknown) => void;
  const ready = new Promise<number>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
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
      const rows = await transaction.$queryRaw<Array<{ pid: number }>>(
        query,
      );
      const backend = rows[0];
      if (backend === undefined) {
        throw new Error(missingTargetMessage);
      }
      resolveReady(backend.pid);
      await released;
    },
    { maxWait: 2_000, timeout: 10_000 },
  );
  void completed.catch((error: unknown) => {
    rejectReady(error);
  });

  try {
    return { completed, lockerPid: await ready, release };
  } catch (error) {
    release();
    await Promise.allSettled([completed]);
    throw error;
  }
}

function holdUserRow(
  database: DatabaseClient,
  userId: string,
): Promise<HeldRowLock> {
  return holdRow(
    database,
    Prisma.sql`
      SELECT pg_backend_pid() AS "pid"
      FROM "users"
      WHERE "id" = ${userId}
      FOR UPDATE
    `,
    "The user row lock target does not exist",
  );
}

function holdSpaceRow(
  database: DatabaseClient,
  spaceId: string,
): Promise<HeldRowLock> {
  return holdRow(
    database,
    Prisma.sql`
      SELECT pg_backend_pid() AS "pid"
      FROM "spaces"
      WHERE "id" = ${spaceId}
      FOR UPDATE
    `,
    "The space row lock target does not exist",
  );
}

async function blockedBackendPids(
  database: DatabaseClient,
  lockerPid: number,
): Promise<number[]> {
  const rows = await database.$queryRaw<Array<{ pid: number }>>(
    Prisma.sql`
      WITH RECURSIVE blocked_backend(pid) AS (
        SELECT activity.pid
        FROM pg_stat_activity AS activity
        WHERE ${lockerPid} = ANY(pg_blocking_pids(activity.pid))

        UNION

        SELECT activity.pid
        FROM pg_stat_activity AS activity
        INNER JOIN blocked_backend AS blocker
          ON blocker.pid = ANY(pg_blocking_pids(activity.pid))
      )
      SELECT DISTINCT activity.pid AS "pid"
      FROM blocked_backend AS blocked
      INNER JOIN pg_stat_activity AS activity
        ON activity.pid = blocked.pid
      INNER JOIN pg_locks AS pending_lock
        ON pending_lock.pid = activity.pid
      WHERE activity.wait_event_type = 'Lock'
        AND pending_lock.granted = FALSE
      ORDER BY "pid"
    `,
  );
  return rows.map((row) => row.pid);
}

async function waitForBlockedBackendCount(
  database: DatabaseClient,
  lockerPid: number,
  expectedCount: number,
  deadline: number,
): Promise<void> {
  for (;;) {
    const pids = await blockedBackendPids(database, lockerPid);
    if (pids.length === expectedCount) {
      return;
    }
    if (pids.length > expectedCount) {
      throw new Error(
        `Observed ${String(pids.length)} blocked backends; expected ${String(expectedCount)}`,
      );
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `Did not observe ${String(expectedCount)} PostgreSQL lock waiters`,
      );
    }
  }
}

async function observeCompletionOrBlock(
  database: DatabaseClient,
  lockerPid: number,
  action: Promise<unknown>,
  deadline: number,
): Promise<"blocked" | "completed"> {
  let completed = false;
  void action.then(
    () => {
      completed = true;
    },
    () => {
      completed = true;
    },
  );

  for (;;) {
    if (completed) {
      return "completed";
    }
    if ((await blockedBackendPids(database, lockerPid)).length > 0) {
      return "blocked";
    }
    if (Date.now() >= deadline) {
      throw new Error("The operation neither completed nor waited for the row lock");
    }
  }
}

async function queueUnderUserLock<TFirst, TSecond>(
  database: DatabaseClient,
  userId: string,
  firstAction: () => Promise<TFirst>,
  secondAction: () => Promise<TSecond>,
): Promise<[TFirst, TSecond]> {
  const heldLock = await holdUserRow(database, userId);
  const observationDeadline =
    Date.now() + lockObservationWindowMilliseconds;
  let firstPromise: Promise<TFirst> | undefined;
  let secondPromise: Promise<TSecond> | undefined;
  try {
    firstPromise = firstAction();
    void firstPromise.catch(() => undefined);
    await waitForBlockedBackendCount(
      database,
      heldLock.lockerPid,
      1,
      observationDeadline,
    );

    secondPromise = secondAction();
    void secondPromise.catch(() => undefined);
    await waitForBlockedBackendCount(
      database,
      heldLock.lockerPid,
      2,
      observationDeadline,
    );

    heldLock.release();
    await heldLock.completed;
    const firstResult = await firstPromise;
    const secondResult = await secondPromise;
    return [firstResult, secondResult];
  } finally {
    heldLock.release();
    const pending: Promise<unknown>[] = [heldLock.completed];
    if (firstPromise !== undefined) {
      pending.push(firstPromise);
    }
    if (secondPromise !== undefined) {
      pending.push(secondPromise);
    }
    await Promise.allSettled(pending);
  }
}

describe("access concurrency invariants with PostgreSQL", () => {
  test.each([
    {
      expectedLoginStatus: 200,
      label: "keeps a login queued before disable from leaving an active session",
      order: "login-first",
    },
    {
      expectedLoginStatus: 401,
      label: "rejects a login queued after disable without leaving an active session",
      order: "disable-first",
    },
  ] as const)(
    "$label",
    async ({ expectedLoginStatus, order }) => {
      await withTestApplication(async (context) => {
        const user = await createLoginUser(context);
        const disable = () =>
          context.operations.execute({
            operation: "disable-user",
            userId: user.userId,
          });
        const login = () => loginRequest(context.baseUrl, user.loginIdentifier);
        let disableResult: AccessOperationResult;
        let loginResponse: Response;

        if (order === "login-first") {
          [loginResponse, disableResult] = await queueUnderUserLock(
            context.database,
            user.userId,
            login,
            disable,
          );
        } else {
          [disableResult, loginResponse] = await queueUnderUserLock(
            context.database,
            user.userId,
            disable,
            login,
          );
        }

        await loginResponse.arrayBuffer();
        expect(loginResponse.status).toBe(expectedLoginStatus);
        expect(disableResult.outcome).toBe("updated");
        await expect(
          context.database.user.findUnique({ where: { id: user.userId } }),
        ).resolves.toMatchObject({ status: "disabled" });
        expect(
          await context.database.authSession.count({
            where: { revokedAt: null, userId: user.userId },
          }),
        ).toBe(0);
      });
    },
    caseTimeoutMilliseconds,
  );

  test.each([
    {
      expectedSetOutcome: "created",
      label:
        "inactivates a space membership when set-space-member is queued before organization revocation",
      order: "set-first",
    },
    {
      expectedSetOutcome: "conflict",
      label:
        "does not activate a space membership when set-space-member is queued after organization revocation",
      order: "revoke-first",
    },
  ] as const)(
    "$label",
    async ({ expectedSetOutcome, order }) => {
      await withTestApplication(async (context) => {
        const graph = await createMemberGraph(context.database);
        const setMember = () =>
          context.operations.execute({
            operation: "set-space-member",
            role: "editor",
            spaceId: graph.spaceId,
            userId: graph.userId,
          });
        const revokeOrganizationMember = () =>
          context.operations.execute({
            operation: "revoke-organization-member",
            organizationId: graph.organizationId,
            userId: graph.userId,
          });
        let revokeResult: AccessOperationResult;
        let setResult: AccessOperationResult;

        if (order === "set-first") {
          [setResult, revokeResult] = await queueUnderUserLock(
            context.database,
            graph.userId,
            setMember,
            revokeOrganizationMember,
          );
        } else {
          [revokeResult, setResult] = await queueUnderUserLock(
            context.database,
            graph.userId,
            revokeOrganizationMember,
            setMember,
          );
        }

        expect(setResult.outcome).toBe(expectedSetOutcome);
        expect(revokeResult.outcome).toBe("revoked");
        await expect(
          context.database.organizationMembership.findUnique({
            where: {
              organizationId_userId: {
                organizationId: graph.organizationId,
                userId: graph.userId,
              },
            },
          }),
        ).resolves.toMatchObject({ status: "inactive" });
        expect(
          await context.database.spaceMembership.count({
            where: {
              spaceId: graph.spaceId,
              status: "active",
              userId: graph.userId,
            },
          }),
        ).toBe(0);
      });
    },
    caseTimeoutMilliseconds,
  );

  test.each([
    {
      label:
        "does not renew a session queued after revoke-user-sessions commits",
      mutation: "revoke-user-sessions",
      order: "mutation-first",
    },
    {
      label: "does not renew a session queued after disable-user commits",
      mutation: "disable-user",
      order: "mutation-first",
    },
    {
      label:
        "leaves no active session when renewal is queued before HTTP logout",
      mutation: "logout",
      order: "renewal-first",
    },
  ] as const)(
    "$label",
    async ({ mutation, order }) => {
      await withTestApplication(async (context) => {
        const session = await createAuthenticatedUser(context);
        const mutate = (): Promise<Response | AccessOperationResult> => {
          if (mutation === "logout") {
            return fetch(`${context.baseUrl}${AUTH_LOGOUT_PATH}`, {
              headers: {
                Cookie: session.cookie,
                Origin: TEST_PUBLIC_ORIGIN,
                [CSRF_HEADER_NAME]: session.csrfToken,
              },
              method: "POST",
            });
          }
          return mutation === "disable-user"
            ? context.operations.execute({
                operation: "disable-user",
                userId: session.userId,
              })
            : context.operations.execute({
                operation: "revoke-user-sessions",
                userId: session.userId,
              });
        };
        const renew = () =>
          fetch(`${context.baseUrl}${AUTH_CSRF_PATH}`, {
            headers: { Cookie: session.cookie },
          });

        let mutationResult: AccessOperationResult | Response;
        let renewalResponse: Response;
        if (order === "renewal-first") {
          [renewalResponse, mutationResult] = await queueUnderUserLock(
            context.database,
            session.userId,
            renew,
            mutate,
          );
        } else {
          [mutationResult, renewalResponse] = await queueUnderUserLock(
            context.database,
            session.userId,
            mutate,
            renew,
          );
        }

        await renewalResponse.arrayBuffer();
        expect(renewalResponse.status).toBe(mutation === "logout" ? 200 : 401);
        if (mutationResult instanceof Response) {
          await mutationResult.arrayBuffer();
          expect(mutation).toBe("logout");
          expect(mutationResult.status).toBe(204);
        } else {
          expect(mutationResult.outcome).toBe(
            mutation === "disable-user" ? "updated" : "revoked",
          );
        }

        const persistedSessions = await context.database.authSession.findMany({
          where: { userId: session.userId },
        });
        expect(persistedSessions).toHaveLength(1);
        expect(persistedSessions[0]?.revokedAt).toBeInstanceOf(Date);
        expect(
          await context.database.authSession.count({
            where: { revokedAt: null, userId: session.userId },
          }),
        ).toBe(0);
        await expect(
          context.database.user.findUnique({ where: { id: session.userId } }),
        ).resolves.toMatchObject({
          status: mutation === "disable-user" ? "disabled" : "active",
        });
      });
    },
    caseTimeoutMilliseconds,
  );

  test(
    "revokes an organization member without waiting for an unrelated space lock",
    async () => {
      await withTestApplication(async (context) => {
        const graph = await createOrganizationRevocationLockGraph(
          context.database,
        );
        const heldLock = await holdSpaceRow(
          context.database,
          graph.unrelatedSpaceId,
        );
        const revocation = context.operations.execute({
          operation: "revoke-organization-member",
          organizationId: graph.organizationId,
          userId: graph.userId,
        });

        try {
          expect(
            await observeCompletionOrBlock(
              context.database,
              heldLock.lockerPid,
              revocation,
              Date.now() + lockObservationWindowMilliseconds,
            ),
          ).toBe("completed");
          await expect(revocation).resolves.toMatchObject({ outcome: "revoked" });
        } finally {
          heldLock.release();
          await Promise.allSettled([heldLock.completed, revocation]);
        }

        await expect(
          context.database.spaceMembership.findUnique({
            where: {
              spaceId_userId: {
                spaceId: graph.relatedSpaceId,
                userId: graph.userId,
              },
            },
          }),
        ).resolves.toMatchObject({ status: "inactive" });
      });
    },
    caseTimeoutMilliseconds,
  );

  test(
    "waits for a related space lock before revoking an organization member",
    async () => {
      await withTestApplication(async (context) => {
        const graph = await createOrganizationRevocationLockGraph(
          context.database,
        );
        const heldLock = await holdSpaceRow(
          context.database,
          graph.relatedSpaceId,
        );
        const revocation = context.operations.execute({
          operation: "revoke-organization-member",
          organizationId: graph.organizationId,
          userId: graph.userId,
        });

        try {
          expect(
            await observeCompletionOrBlock(
              context.database,
              heldLock.lockerPid,
              revocation,
              Date.now() + lockObservationWindowMilliseconds,
            ),
          ).toBe("blocked");
          await expect(
            context.database.organizationMembership.findUnique({
              where: {
                organizationId_userId: {
                  organizationId: graph.organizationId,
                  userId: graph.userId,
                },
              },
            }),
          ).resolves.toMatchObject({ status: "active" });

          heldLock.release();
          await heldLock.completed;
          await expect(revocation).resolves.toMatchObject({ outcome: "revoked" });
        } finally {
          heldLock.release();
          await Promise.allSettled([heldLock.completed, revocation]);
        }

        await expect(
          context.database.organizationMembership.findUnique({
            where: {
              organizationId_userId: {
                organizationId: graph.organizationId,
                userId: graph.userId,
              },
            },
          }),
        ).resolves.toMatchObject({ status: "inactive" });
        await expect(
          context.database.spaceMembership.findUnique({
            where: {
              spaceId_userId: {
                spaceId: graph.relatedSpaceId,
                userId: graph.userId,
              },
            },
          }),
        ).resolves.toMatchObject({ status: "inactive" });
      });
    },
    caseTimeoutMilliseconds,
  );
});
