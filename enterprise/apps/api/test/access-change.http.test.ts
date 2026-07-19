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
  type DatabaseClient,
} from "@singularity/database";
import { isolatedDatabaseUrl } from "@singularity/database/testing/postgres";
import {
  afterAll,
  afterEach,
  beforeAll,
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
  expect(exitCode).not.toBe(1);
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

async function holdSpaceRow(
  database: DatabaseClient,
  spaceId: string,
): Promise<{ release(): void; completed: Promise<void> }> {
  let resolveLocked!: () => void;
  const locked = new Promise<void>((resolve) => {
    resolveLocked = resolve;
  });
  let releaseLock!: () => void;
  const released = new Promise<void>((resolve) => {
    releaseLock = resolve;
  });
  const completed = database.$transaction(async (transaction) => {
    await transaction.$queryRaw`
      SELECT "id" FROM "spaces" WHERE "id" = ${spaceId}::uuid FOR UPDATE
    `;
    resolveLocked();
    await released;
  });
  await locked;
  return { completed, release: releaseLock };
}

describe("ADR-018 PostgreSQL access-change integration", () => {
  let database: DatabaseClient;
  let passwordDigest: string;
  let testApi: TestApiApplication;
  let kernel: TestKernelGateway;

  beforeAll(async () => {
    passwordDigest = await new PasswordHasher().hashPassword(PASSWORD);
    kernel = await startTestKernelGateway();
    try {
      testApi = await startTestApiApplication({
        https: true,
        kernelGateway: kernel.configuration,
      });
      database = testApi.app.get(DatabaseRuntime).client;
    } catch (error) {
      await kernel.dispose();
      throw error;
    }
  });

  afterEach(async () => {
    await truncateTestDatabase(database);
  });

  afterAll(async () => {
    try {
      await testApi.dispose();
    } finally {
      await kernel.dispose();
    }
  });

  test("publishes committed notifications and suppresses rolled-back notifications", async () => {
    const received: string[] = [];
    const committed = signal<void>();
    let committedSessionId: string | undefined;
    const subscription = await testApi.app.get(DatabaseRuntime).listen(
      ACCESS_CHANGE_CHANNEL,
      (payload) => {
        received.push(payload);
        if (committedSessionId !== undefined && payload.includes(committedSessionId)) {
          committed.resolve();
        }
      },
      (error) => {
        throw error;
      },
    );
    const publisher = testApi.app.get(AccessChangedPublisher);
    try {
      await expect(
        database.$transaction(async (transaction) => {
          await publisher.refreshSessionExpiry(transaction, {
            authSessionId: randomUUID(),
            expiresAt: new Date("2030-01-01T00:00:00.000Z"),
            requestId: randomUUID(),
          });
          throw new Error("rollback-notification");
        }),
      ).rejects.toThrow("rollback-notification");
      committedSessionId = randomUUID();
      await database.$transaction(async (transaction) => {
        await publisher.refreshSessionExpiry(transaction, {
          authSessionId: committedSessionId,
          expiresAt: new Date("2030-01-01T00:00:00.000Z"),
          requestId: randomUUID(),
        });
      });
      await Promise.race([
        committed.promise,
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error("committed notification was not delivered")),
            NOTIFICATION_TIMEOUT_MS,
          ),
        ),
      ]);
      expect(received).toHaveLength(1);
      expect(received[0]).toContain(committedSessionId);
    } finally {
      await subscription.close();
    }
  });

  test("closes a pending or active connection on an independent committed revocation and drops late pushes", async () => {
    const graph = await createGraph(database, passwordDigest, testApi, kernel);
    const socket = await openBrowserSocket(testApi.baseUrl, graph);
    socket.on("error", () => undefined);
    const closePromise = closed(socket);
    const marker = Buffer.from(`before-close-${randomUUID()}`);
    kernel.websocket.broadcast(marker);
    const revokePromise = runOperation(isolatedDatabaseUrl(), {
      operation: "revoke-user-sessions",
      userId: graph.userId,
    });
    const revoked = await revokePromise;
    expect(revoked.outcome).toBe("revoked");
    const result = await Promise.race([
      closePromise,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("revoked connection stayed open")), NOTIFICATION_TIMEOUT_MS),
      ),
    ]);
    expect(result.code).toBe(4401);
    kernel.websocket.broadcast(Buffer.from(`after-close-${randomUUID()}`));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(socket.readyState).toBe(WebSocket.CLOSED);
  });

  test("does not activate a pending connection after a committed revocation wins the revalidation lock", async () => {
    const graph = await createGraph(database, passwordDigest, testApi, kernel);
    const lock = await holdSpaceRow(database, graph.spaceId);
    const socketPromise = openBrowserSocket(testApi.baseUrl, graph);
    const kernelConnection = kernel.websocket.nextConnection();
    const revokePromise = runOperation(isolatedDatabaseUrl(), {
      operation: "revoke-space-member",
      spaceId: graph.spaceId,
      userId: graph.userId,
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    lock.release();
    await lock.completed;
    expect((await revokePromise).outcome).toBe("revoked");
    await expect(socketPromise).rejects.toMatchObject(
      new WebSocketUpgradeError(503),
    );
    await expect(
      Promise.race([
        kernelConnection.then(() => "connected" as const),
        new Promise<"none">((resolve) =>
          setTimeout(() => resolve("none"), 250),
        ),
      ]),
    ).resolves.toBe("none");
  });

  test.each([
    { operation: "disable-user", reason: "user", expectedCode: 4401 },
    { operation: "disable-organization", reason: "organization", expectedCode: 4403 },
    { operation: "disable-space", reason: "space", expectedCode: 4403 },
  ] as const)(
    "closes active connections by $reason selector after the operation transaction commits",
    async ({ operation, expectedCode }) => {
      const graph = await createGraph(database, passwordDigest, testApi, kernel);
      const socket = await openBrowserSocket(testApi.baseUrl, graph);
      socket.on("error", () => undefined);
      const closePromise = closed(socket);
      const command =
        operation === "disable-user"
          ? { operation, userId: graph.userId }
          : operation === "disable-organization"
            ? { operation, organizationId: graph.organizationId }
            : { operation, spaceId: graph.spaceId };
      const result = await runOperation(isolatedDatabaseUrl(), command);
      expect(result.outcome).toBe("updated");
      await expect(closePromise).resolves.toMatchObject({ code: expectedCode });
    },
  );

  test("closes a session-selected connection through the real HTTPS logout transaction", async () => {
    const graph = await createGraph(database, passwordDigest, testApi, kernel);
    const socket = await openBrowserSocket(testApi.baseUrl, graph);
    socket.on("error", () => undefined);
    const closePromise = closed(socket);
    const logout = await requestHttps(testApi.baseUrl, AUTH_LOGOUT_PATH, {
      cookie: graph.cookie,
      csrfToken: graph.csrfToken,
      method: "POST",
    });
    expect(logout.statusCode).toBe(204);
    await expect(closePromise).resolves.toMatchObject({ code: 4401 });
  });

  test("rejects client data frames with 4408 and never forwards them to Kernel", async () => {
    const graph = await createGraph(database, passwordDigest, testApi, kernel);
    const socket = await openBrowserSocket(testApi.baseUrl, graph);
    socket.on("error", () => undefined);
    const closePromise = closed(socket);
    socket.send(Buffer.from("client-data-is-forbidden"));
    await expect(closePromise).resolves.toMatchObject({ code: 4408 });
  });

  test("fails closed on LISTEN connection error and rejects a new upgrade", async () => {
    const graph = await createGraph(database, passwordDigest, testApi, kernel);
    const socket = await openBrowserSocket(testApi.baseUrl, graph);
    socket.on("error", () => undefined);
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
    await expect(openBrowserSocket(testApi.baseUrl, graph)).rejects.toMatchObject(
      new WebSocketUpgradeError(503),
    );
  });
});
