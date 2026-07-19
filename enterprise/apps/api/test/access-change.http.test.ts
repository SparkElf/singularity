import { randomUUID } from "node:crypto";
import { PassThrough, Readable } from "node:stream";
import { request as httpsRequest } from "node:https";

import {
  AUTH_LOGIN_PATH,
  AUTH_LOGOUT_PATH,
  AUTH_SESSION_COOKIE_NAME,
  CSRF_HEADER_NAME,
  type AccessOperation,
  type AccessOperationResult,
  accessOperationResultSchemaByOperation,
  loginResponseSchema,
} from "@singularity/contracts";
import {
  DatabaseRuntime,
  Prisma,
  type DatabaseClient,
} from "@singularity/database";
import { isolatedDatabaseUrl } from "@singularity/database/testing/postgres";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "vitest";
import WebSocket from "ws";

import { AccessChangedPublisher, ACCESS_CHANGE_CHANNEL } from "../src/kernel/access-changed.js";
import { runAccessOperationsApplication } from "../src/operations/application.js";
import { PasswordHasher } from "../src/identity/password-hasher.js";
import { truncateTestDatabase } from "./support/database.js";
import { testAuditConfiguration } from "./support/audit-configuration.js";
import { CapturingLogger } from "./support/capturing-logger.js";
import {
  startTestApiApplication,
  TEST_PUBLIC_ORIGIN,
  type TestApiApplication,
} from "./support/test-app.js";
import {
  startTestKernelGateway,
  TEST_TLS_CERTIFICATE,
  type TestKernelGateway,
} from "./support/kernel-gateway.js";

const PASSWORD = "correct horse battery staple";
const NOTEBOOK_ID = "20260718010101-abcdefg";
const DOCUMENT_ID = "20260718010102-hijklmn";
const NOTIFICATION_TIMEOUT_MS = 5_000;
const LOCK_OBSERVATION_TIMEOUT_MS = 5_000;
const PENDING_LOCK_TRANSACTION_TIMEOUT_MS = 12_000;

interface Graph {
  readonly cookie: string;
  readonly csrfToken: string;
  readonly organizationId: string;
  readonly spaceId: string;
  readonly userId: string;
}

interface HttpsResponse {
  readonly body: string;
  readonly headers: Record<string, string | string[] | undefined>;
  readonly statusCode: number;
}

class WebSocketUpgradeError extends Error {
  constructor(readonly statusCode: number) {
    super(`WebSocket upgrade failed with status ${String(statusCode)}`);
    this.name = "WebSocketUpgradeError";
  }
}

function cookiePair(response: HttpsResponse): string {
  const value = response.headers["set-cookie"];
  const setCookie = Array.isArray(value) ? value[0] : value;
  const pair = setCookie?.split(";", 1)[0];
  if (!pair?.startsWith(`${AUTH_SESSION_COOKIE_NAME}=`)) {
    throw new Error("The HTTPS login response did not set a session cookie");
  }
  return pair;
}

function requestHttps(
  baseUrl: string,
  path: string,
  options: {
    body?: unknown;
    cookie?: string;
    csrfToken?: string;
    method: "GET" | "POST";
  },
): Promise<HttpsResponse> {
  const url = new URL(path, baseUrl);
  const body = options.body === undefined ? undefined : JSON.stringify(options.body);
  return new Promise((resolve, reject) => {
    const request = httpsRequest(
      {
        ca: TEST_TLS_CERTIFICATE,
        headers: {
          ...(body === undefined ? {} : { "Content-Length": Buffer.byteLength(body), "Content-Type": "application/json" }),
          ...(options.cookie === undefined ? {} : { Cookie: options.cookie }),
          ...(options.csrfToken === undefined ? {} : { [CSRF_HEADER_NAME]: options.csrfToken }),
          Origin: TEST_PUBLIC_ORIGIN,
        },
        hostname: url.hostname,
        method: options.method,
        path: `${url.pathname}${url.search}`,
        port: url.port,
        rejectUnauthorized: true,
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer | string) => {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        });
        response.on("end", () => {
          resolve({
            body: Buffer.concat(chunks).toString("utf8"),
            headers: response.headers,
            statusCode: response.statusCode ?? 0,
          });
        });
      },
    );
    request.once("error", reject);
    if (body !== undefined) {
      request.write(body);
    }
    request.end();
  });
}

async function openBrowserSocket(
  baseUrl: string,
  graph: Graph,
): Promise<WebSocket> {
  const url = new URL(
    `/api/v1/organizations/${graph.organizationId}/spaces/${graph.spaceId}/kernel/ws`,
    baseUrl,
  );
  url.search = new URLSearchParams({
    documentId: DOCUMENT_ID,
    notebookId: NOTEBOOK_ID,
    type: "protyle",
  }).toString();
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, {
      ca: TEST_TLS_CERTIFICATE,
      headers: { Cookie: graph.cookie },
      origin: TEST_PUBLIC_ORIGIN,
      rejectUnauthorized: true,
    });
    socket.once("open", () => resolve(socket));
    socket.once("unexpected-response", (_request, response) => {
      response.resume();
      reject(new WebSocketUpgradeError(response.statusCode ?? 0));
    });
    socket.once("error", reject);
  });
}

function closed(socket: WebSocket): Promise<{ code: number; reason: string }> {
  return new Promise((resolve) => {
    socket.once("close", (code, reason) => {
      resolve({ code, reason: reason.toString("utf8") });
    });
  });
}

async function runOperation(
  databaseUrl: string,
  command: AccessOperation,
): Promise<AccessOperationResult> {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const exitCode = await runAccessOperationsApplication({
    auditConfiguration: testAuditConfiguration(),
    databaseUrl,
    stderr,
    stdin: Readable.from([JSON.stringify(command)]),
    stdout,
  });
  const output = stdout.read()?.toString("utf8") ?? "";
  const result = accessOperationResultSchemaByOperation[command.operation].parse(
    JSON.parse(output),
  );
  expect(exitCode).toBe(0);
  return result;
}

function signal<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolveSignal!: (value: T) => void;
  const promise = new Promise<T>((resolve) => {
    resolveSignal = resolve;
  });
  return { promise, resolve: (value) => resolveSignal(value) };
}

async function withTimeout<T>(
  promise: Promise<T>,
  message: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), NOTIFICATION_TIMEOUT_MS);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

async function createGraph(
  database: DatabaseClient,
  passwordDigest: string,
  testApi: TestApiApplication,
  kernel: TestKernelGateway,
): Promise<Graph> {
  const userId = randomUUID();
  const organizationId = randomUUID();
  const loginIdentifier = `access-change-${randomUUID()}@example.test`;
  await database.user.create({
    data: { id: userId, loginIdentifier, passwordDigest, status: "active" },
  });
  await database.organization.create({
    data: { id: organizationId, name: "Access Change", status: "active" },
  });
  await database.organizationMembership.create({
    data: { organizationId, role: "member", status: "active", userId },
  });
  await database.space.create({
    data: {
      id: kernel.deployment.spaceId,
      name: "Access Change Space",
      organizationId,
      status: "active",
    },
  });
  await database.spaceMembership.create({
    data: {
      organizationId,
      role: "editor",
      spaceId: kernel.deployment.spaceId,
      status: "active",
      userId,
    },
  });
  await database.kernelInstance.create({
    data: {
      deploymentHandle: kernel.deployment.handle,
      id: kernel.deployment.kernelInstanceId,
      spaceId: kernel.deployment.spaceId,
      status: "ready",
      version: "test",
    },
  });
  const login = await requestHttps(testApi.baseUrl, AUTH_LOGIN_PATH, {
    body: { loginIdentifier, password: PASSWORD },
    method: "POST",
  });
  expect(login.statusCode).toBe(200);
  const { csrfToken } = loginResponseSchema.parse(JSON.parse(login.body));
  return {
    cookie: cookiePair(login),
    csrfToken,
    organizationId,
    spaceId: kernel.deployment.spaceId,
    userId,
  };
}

async function holdSpaceGroupGrantTable(
  database: DatabaseClient,
): Promise<{ lockerPid: number; release(): void; completed: Promise<void> }> {
  let resolveLocked!: (pid: number) => void;
  let rejectLocked!: (reason?: unknown) => void;
  const locked = new Promise<number>((resolve, reject) => {
    resolveLocked = resolve;
    rejectLocked = reject;
  });
  let releaseLock!: () => void;
  const released = new Promise<void>((resolve) => {
    releaseLock = resolve;
  });
  const completed = database.$transaction(
    async (transaction) => {
      await transaction.$executeRaw(
        Prisma.sql`LOCK TABLE "space_group_grants" IN ACCESS EXCLUSIVE MODE`,
      );
      const rows = await transaction.$queryRaw<Array<{ pid: number }>>(
        Prisma.sql`SELECT pg_backend_pid() AS pid`,
      );
      const pid = rows[0]?.pid;
      if (pid === undefined) {
        throw new Error("The table-lock transaction did not expose a backend");
      }
      resolveLocked(pid);
      await released;
    },
    { maxWait: 2_000, timeout: PENDING_LOCK_TRANSACTION_TIMEOUT_MS },
  );
  void completed.catch(rejectLocked);
  try {
    return { completed, release: releaseLock, lockerPid: await locked };
  } catch (error) {
    releaseLock();
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
        SELECT activity.pid AS pid
        FROM pg_stat_activity AS activity
        WHERE ${lockerPid} = ANY(pg_blocking_pids(activity.pid))
          AND activity.wait_event_type = 'Lock'
      `,
    );
    if (rows.length > 0) {
      return;
    }
    if (Date.now() >= deadline) {
      throw new Error("The connection revalidation did not wait on the table lock");
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

describe("ADR-018 PostgreSQL access-change integration", () => {
  let database: DatabaseClient;
  let logger: CapturingLogger;
  let passwordDigest: string;
  let testApi: TestApiApplication;
  let kernel: TestKernelGateway;

  beforeAll(async () => {
    passwordDigest = await new PasswordHasher().hashPassword(PASSWORD);
  });

  beforeEach(async () => {
    logger = new CapturingLogger();
    kernel = await startTestKernelGateway();
    try {
      testApi = await startTestApiApplication({
        https: true,
        kernelGateway: kernel.configuration,
        logger,
      });
      database = testApi.app.get(DatabaseRuntime).client;
    } catch (error) {
      await kernel.dispose();
      throw error;
    }
  });

  afterEach(async () => {
    try {
      await truncateTestDatabase(database);
    } finally {
      try {
        await testApi.dispose();
      } finally {
        await kernel.dispose();
      }
    }
  });

  test("publishes committed notifications and suppresses rolled-back notifications", async () => {
    const received: string[] = [];
    const committed = signal<void>();
    let committedSessionId: string | undefined;
    const committedExpiresAt = new Date("2030-01-01T00:00:00.000Z");
    const committedRequestId = randomUUID();
    const rolledBackSessionId = randomUUID();
    const subscription = await testApi.app.get(DatabaseRuntime).listen(
      ACCESS_CHANGE_CHANNEL,
      (payload) => {
        received.push(payload);
        const decoded = JSON.parse(payload) as { authSessionId?: string };
        if (decoded.authSessionId === committedSessionId) {
          committed.resolve();
        }
      },
      (error) => {
        throw error;
      },
    );
    const publisher = testApi.app.get(AccessChangedPublisher);
    logger.clear();
    try {
      await expect(
        database.$transaction(async (transaction) => {
          await publisher.refreshSessionExpiry(transaction, {
            authSessionId: rolledBackSessionId,
            expiresAt: committedExpiresAt,
            requestId: randomUUID(),
          });
          throw new Error("rollback-notification");
        }),
      ).rejects.toThrow("rollback-notification");
      committedSessionId = randomUUID();
      await database.$transaction(async (transaction) => {
        await publisher.refreshSessionExpiry(transaction, {
          authSessionId: committedSessionId,
          expiresAt: committedExpiresAt,
          requestId: committedRequestId,
        });
      });
      await withTimeout(
        committed.promise,
        "committed notification was not delivered",
      );
      expect(received).toHaveLength(1);
      expect(JSON.parse(received[0] ?? "")).toMatchObject({
        authSessionId: committedSessionId,
        kind: "session-expiry",
      });
      await expect
        .poll(() => logger.output, { timeout: NOTIFICATION_TIMEOUT_MS })
        .toContain("authorization.change");
      expect(logger.output).toContain("kind: 'session-expiry'");
      expect(logger.output).toContain(`authSessionId: '${committedSessionId}'`);
      expect(logger.output).toContain(`requestId: '${committedRequestId}'`);
      expect(logger.output).not.toContain(committedExpiresAt.toISOString());
      expect(logger.output).not.toContain(rolledBackSessionId);
    } finally {
      await subscription.close();
    }
  });

  test("closes an active connection by user selector and drops late pushes", async () => {
    const graph = await createGraph(database, passwordDigest, testApi, kernel);
    const socket = await openBrowserSocket(testApi.baseUrl, graph);
    socket.on("error", () => undefined);
    const upstream = await kernel.websocket.nextConnection();
    const upstreamClosePromise = closed(upstream);
    const closePromise = closed(socket);
    const received: string[] = [];
    const delivered = signal<void>();
    const beforeClose = `before-close-${randomUUID()}`;
    socket.on("message", (data) => {
      const payload = data.toString();
      received.push(payload);
      if (payload === beforeClose) {
        delivered.resolve();
      }
    });
    kernel.websocket.broadcast(Buffer.from(beforeClose));
    await withTimeout(delivered.promise, "active Kernel push was not delivered");
    logger.clear();
    const revokePromise = runOperation(isolatedDatabaseUrl(), {
      operation: "revoke-user-sessions",
      userId: graph.userId,
    });
    const revoked = await revokePromise;
    expect(revoked.outcome).toBe("revoked");
    const result = await withTimeout(
      closePromise,
      "revoked connection stayed open",
    );
    expect(result).toEqual({ code: 4401, reason: "unauthenticated" });
    await upstreamClosePromise;
    kernel.websocket.broadcast(Buffer.from(`after-close-${randomUUID()}`));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(received).toEqual([beforeClose]);
    expect(socket.readyState).toBe(WebSocket.CLOSED);
    expect(logger.output).toContain("authorization.change");
    expect(logger.output).toContain("selectorKinds: [ 'user' ]");
    expect(logger.output).toContain(`user: [ '${graph.userId}' ]`);
  });

  test("does not activate a pending connection after a committed revocation wins the revalidation lock", async () => {
    const graph = await createGraph(database, passwordDigest, testApi, kernel);
    const group = await database.userGroup.create({
      data: {
        name: `Pending revalidation ${randomUUID()}`,
        organizationId: graph.organizationId,
        status: "active",
      },
    });
    await database.userGroupMembership.create({
      data: {
        groupId: group.id,
        organizationId: graph.organizationId,
        userId: graph.userId,
      },
    });
    await database.spaceGroupGrant.create({
      data: {
        groupId: group.id,
        organizationId: graph.organizationId,
        role: "viewer",
        spaceId: graph.spaceId,
      },
    });
    const lock = await holdSpaceGroupGrantTable(database);
    let socket: WebSocket | undefined;
    try {
      socket = await openBrowserSocket(testApi.baseUrl, graph);
      socket.on("error", () => undefined);
      await waitForBlockedBackend(database, lock.lockerPid);
      const closePromise = closed(socket);
      const revoked = await runOperation(isolatedDatabaseUrl(), {
        operation: "revoke-space-member",
        spaceId: graph.spaceId,
        userId: graph.userId,
      });
      expect(revoked.outcome).toBe("revoked");
      await expect(closePromise).resolves.toMatchObject({
        code: 4403,
        reason: "forbidden",
      });
      const connectionCount = kernel.websocket.connectionCount;
      expect(connectionCount).toBe(0);
      lock.release();
      await lock.completed;
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(kernel.websocket.connectionCount).toBe(connectionCount);
    } finally {
      lock.release();
      await Promise.allSettled([lock.completed]);
      socket?.terminate();
    }
  });

  test.each([
    {
      operation: "disable-organization",
      reason: "organization",
      expectedCode: 4403,
      expectedReason: "forbidden",
    },
    {
      operation: "disable-space",
      reason: "space",
      expectedCode: 4403,
      expectedReason: "forbidden",
    },
  ] as const)(
    "closes active connections by $reason selector after the operation transaction commits",
    async ({ operation, expectedCode, expectedReason }) => {
      const graph = await createGraph(database, passwordDigest, testApi, kernel);
      const socket = await openBrowserSocket(testApi.baseUrl, graph);
      socket.on("error", () => undefined);
      await kernel.websocket.nextConnection();
      const closePromise = closed(socket);
      const command =
        operation === "disable-organization"
          ? { operation, organizationId: graph.organizationId }
          : { operation, spaceId: graph.spaceId };
      const result = await runOperation(isolatedDatabaseUrl(), command);
      expect(result.outcome).toBe("updated");
      await expect(closePromise).resolves.toEqual({
        code: expectedCode,
        reason: expectedReason,
      });
    },
  );

  test("ignores nonmatching selectors and closes by auth-session through HTTPS logout", async () => {
    const graph = await createGraph(database, passwordDigest, testApi, kernel);
    const socket = await openBrowserSocket(testApi.baseUrl, graph);
    socket.on("error", () => undefined);
    await kernel.websocket.nextConnection();
    const closePromise = closed(socket);
    const publisher = testApi.app.get(AccessChangedPublisher);
    const selectors = [
      { kind: "auth-session", value: randomUUID() },
      { kind: "user", value: randomUUID() },
      { kind: "organization", value: randomUUID() },
      { kind: "space", value: randomUUID() },
    ] as const;
    await database.$transaction(async (transaction) => {
      for (const selector of selectors) {
        await publisher.publish(transaction, {
          kind: "close",
          reason: "forbidden",
          requestId: randomUUID(),
          selectors: [selector],
        });
      }
    });
    const logout = await requestHttps(testApi.baseUrl, AUTH_LOGOUT_PATH, {
      cookie: graph.cookie,
      csrfToken: graph.csrfToken,
      method: "POST",
    });
    expect(logout.statusCode).toBe(204);
    await expect(closePromise).resolves.toEqual({
      code: 4401,
      reason: "unauthenticated",
    });
  });

  test("rejects client data frames with 4408 and never forwards them to Kernel", async () => {
    const graph = await createGraph(database, passwordDigest, testApi, kernel);
    const socket = await openBrowserSocket(testApi.baseUrl, graph);
    socket.on("error", () => undefined);
    const upstream = await kernel.websocket.nextConnection();
    const upstreamClosePromise = closed(upstream);
    const closePromise = closed(socket);
    socket.send(Buffer.from("client-data-is-forbidden"));
    await expect(closePromise).resolves.toEqual({
      code: 4408,
      reason: "client-messages-forbidden",
    });
    await upstreamClosePromise;
    expect(kernel.websocket.messages).toEqual([]);
  });

  test("fails closed on LISTEN connection error and rejects a new upgrade", async () => {
    const graph = await createGraph(database, passwordDigest, testApi, kernel);
    const socket = await openBrowserSocket(testApi.baseUrl, graph);
    socket.on("error", () => undefined);
    const upstream = await kernel.websocket.nextConnection();
    const upstreamClosePromise = closed(upstream);
    const closePromise = closed(socket);
    await database.$executeRaw`
      SELECT pg_terminate_backend("pid")
      FROM pg_stat_activity
      WHERE "datname" = current_database()
        AND "pid" <> pg_backend_pid()
        AND "query" ILIKE '%LISTEN%singularity_access_changed%'
    `;
    await expect(closePromise).resolves.toMatchObject({
      code: 1011,
      reason: "service-unavailable",
    });
    await upstreamClosePromise;
    await expect(openBrowserSocket(testApi.baseUrl, graph)).rejects.toMatchObject(
      new WebSocketUpgradeError(503),
    );
  });

  test("fails closed on an invalid notification without logging its payload", async () => {
    const graph = await createGraph(database, passwordDigest, testApi, kernel);
    const socket = await openBrowserSocket(testApi.baseUrl, graph);
    socket.on("error", () => undefined);
    const upstream = await kernel.websocket.nextConnection();
    const upstreamClosePromise = closed(upstream);
    const closePromise = closed(socket);
    const sensitiveSentinel = `invalid-notification-${randomUUID()}`;
    const invalidPayload = JSON.stringify({
      kind: "close",
      reason: "forbidden",
      requestId: randomUUID(),
      selectors: [{ kind: "user", value: graph.userId }],
      unexpected: sensitiveSentinel,
    });
    logger.clear();

    await database.$queryRaw(
      Prisma.sql`SELECT pg_notify(${ACCESS_CHANGE_CHANNEL}, ${invalidPayload})`,
    );

    await expect(closePromise).resolves.toEqual({
      code: 1011,
      reason: "service-unavailable",
    });
    await upstreamClosePromise;
    expect(logger.output).toContain("invalid-event");
    expect(logger.output).not.toContain(sensitiveSentinel);
  });
});
