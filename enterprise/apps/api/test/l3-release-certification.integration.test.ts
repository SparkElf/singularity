import { randomUUID } from "node:crypto";
import { request as httpsRequest } from "node:https";

import {
  AUTH_LOGIN_PATH,
  AUTH_SESSION_COOKIE_NAME,
  CSRF_HEADER_NAME,
  collaborationClientMessageSchema,
  collaborationResumeRequestSchema,
  collaborationServerMessageSchema,
  documentIdentitySchema,
  loginResponseSchema,
  buildDocumentCollaborationFeaturePath,
  type CollaborationServerMessage,
  type DocumentIdentity,
} from "@singularity/contracts";
import { DatabaseRuntime, type DatabaseClient } from "@singularity/database";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "vitest";
import WebSocket from "ws";

import { PasswordHasher } from "../src/identity/password-hasher.js";
import { truncateTestDatabase } from "./support/database.js";
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
const NOTEBOOK_ID = "20260723090000-release";
const DOCUMENT_ID = "20260723090001-release";
const CAPACITY_LIMIT = 64;

interface Session {
  readonly cookie: string;
  readonly csrfToken: string;
  readonly userId: string;
}

interface ReleaseEnvironment {
  readonly database: DatabaseClient;
  readonly documentIdentity: DocumentIdentity;
  readonly editor: Session;
  readonly kernel: TestKernelGateway;
  readonly organizationId: string;
  readonly spaceId: string;
  readonly viewer: Session;
}

interface ReleaseKernelMode {
  readonly encryptedUnavailable: { value: boolean };
  readonly failAdmission: { value: boolean };
}

interface HttpsResponse {
  readonly body: string;
  readonly headers: Record<string, string | string[] | undefined>;
  readonly statusCode: number;
}

function buildPath(template: string, parameters: Record<string, string>): string {
  return Object.entries(parameters).reduce(
    (path, [name, value]) => path.replace(`{${name}}`, encodeURIComponent(value)),
    template,
  );
}

function cookiePair(response: HttpsResponse): string {
  const value = response.headers["set-cookie"];
  const setCookie = Array.isArray(value) ? value[0] : value;
  const pair = setCookie?.split(";", 1)[0];
  if (!pair?.startsWith(`${AUTH_SESSION_COOKIE_NAME}=`)) {
    throw new Error("The release certification login did not issue a session cookie");
  }
  return pair;
}

function requestHttps(
  baseUrl: string,
  path: string,
  options: {
    readonly body?: unknown;
    readonly cookie?: string;
    readonly csrfToken?: string;
    readonly method: "DELETE" | "GET" | "PATCH" | "POST";
  },
): Promise<HttpsResponse> {
  const url = new URL(path, baseUrl);
  const body = options.body === undefined ? undefined : JSON.stringify(options.body);
  return new Promise((resolve, reject) => {
    const request = httpsRequest({
      ca: TEST_TLS_CERTIFICATE,
      headers: {
        ...(body === undefined ? {} : {
          "Content-Length": Buffer.byteLength(body),
          "Content-Type": "application/json",
        }),
        ...(options.cookie === undefined ? {} : { Cookie: options.cookie }),
        ...(options.csrfToken === undefined ? {} : { [CSRF_HEADER_NAME]: options.csrfToken }),
        Origin: TEST_PUBLIC_ORIGIN,
      },
      hostname: url.hostname,
      method: options.method,
      path: `${url.pathname}${url.search}`,
      port: url.port,
      rejectUnauthorized: true,
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer | string) => {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      });
      response.on("end", () => resolve({
        body: Buffer.concat(chunks).toString("utf8"),
        headers: response.headers,
        statusCode: response.statusCode ?? 0,
      }));
    });
    request.once("error", reject);
    if (body !== undefined) {
      request.write(body);
    }
    request.end();
  });
}

async function login(api: TestApiApplication, loginIdentifier: string, userId: string): Promise<Session> {
  const response = await requestHttps(api.baseUrl, AUTH_LOGIN_PATH, {
    body: { loginIdentifier, password: PASSWORD },
    method: "POST",
  });
  if (response.statusCode !== 200) {
    throw new Error(`Release certification login failed with ${String(response.statusCode)}`);
  }
  return {
    cookie: cookiePair(response),
    csrfToken: loginResponseSchema.parse(JSON.parse(response.body)).csrfToken,
    userId,
  };
}

function responseBody(code: number, data: unknown): { body: string; headers: Record<string, string>; status: number } {
  return {
    body: JSON.stringify({ code, data }),
    headers: { "content-type": "application/json" },
    status: code === 0 ? 200 : 409,
  };
}

function releaseKernelHandler(input: ReleaseKernelMode) {
  const history: Array<{ readonly operation: Record<string, unknown>; readonly serverSequence: number }> = [];
  return async (request: { readonly body: Buffer; readonly path: string }) => {
    if (request.path === "/api/block/checkBlockExist") {
      return responseBody(0, true);
    }
    if (request.path !== "/internal/enterprise/collaboration") {
      return { status: 404 };
    }
    const body = JSON.parse(request.body.toString("utf8")) as {
      action?: string;
      envelope?: { operationId?: string; identity?: DocumentIdentity };
      featureMode?: string;
      identity?: DocumentIdentity;
    };
    if (body.action === "admit") {
      if (input.failAdmission.value) {
        return {
          body: JSON.stringify({ code: 0 }),
          headers: { "content-type": "application/json" },
          status: 500,
        };
      }
      if (body.featureMode === "restricted-encrypted" && input.encryptedUnavailable.value) {
        return {
          body: JSON.stringify({ code: "encrypted-collaboration-unavailable" }),
          headers: { "content-type": "application/json" },
          status: 409,
        };
      }
      return responseBody(0, { sessionGeneration: 1, version: {} });
    }
    if (body.action === "apply" && body.envelope?.operationId !== undefined && body.envelope.identity !== undefined) {
      history.push({
        operation: body.envelope,
        serverSequence: history.length + 1,
      });
      return responseBody(0, {
        broadcast: {
          identity: body.envelope.identity,
          operation: body.envelope,
          serverSequence: history.length,
        },
        result: { outcome: "accepted", serverSequence: history.length },
      });
    }
    if (body.action === "replay") {
      return responseBody(0, { entries: history });
    }
    return responseBody(0, {});
  };
}

/** 创建认证用真实组织、空间、成员、Kernel deployment 与内容身份，清除数据库路径猜测。 */
async function createEnvironment(
  api: TestApiApplication,
  database: DatabaseClient,
  kernel: TestKernelGateway,
): Promise<ReleaseEnvironment> {
  const organizationId = randomUUID();
  const spaceId = kernel.deployment.spaceId;
  const editorId = randomUUID();
  const viewerId = randomUUID();
  const editorLogin = `release-editor-${randomUUID()}@example.test`;
  const viewerLogin = `release-viewer-${randomUUID()}@example.test`;
  const passwordDigest = await new PasswordHasher().hashPassword(PASSWORD);
  await database.organization.create({ data: { id: organizationId, name: "L3 Release", status: "active" } });
  await database.user.create({ data: { id: editorId, loginIdentifier: editorLogin, passwordDigest, status: "active" } });
  await database.user.create({ data: { id: viewerId, loginIdentifier: viewerLogin, passwordDigest, status: "active" } });
  await database.organizationMembership.createMany({
    data: [
      { organizationId, role: "owner", status: "active", userId: editorId },
      { organizationId, role: "member", status: "active", userId: viewerId },
    ],
  });
  await database.space.create({ data: { id: spaceId, name: "L3 Release Space", organizationId, status: "active" } });
  await database.spaceMembership.createMany({
    data: [
      { organizationId, role: "admin", spaceId, status: "active", userId: editorId },
      { organizationId, role: "viewer", spaceId, status: "active", userId: viewerId },
    ],
  });
  await database.kernelInstance.create({
    data: {
      deploymentHandle: kernel.deployment.handle,
      id: kernel.deployment.kernelInstanceId,
      spaceId,
      status: "ready",
      version: "release-certification",
    },
  });
  const editor = await login(api, editorLogin, editorId);
  const viewer = await login(api, viewerLogin, viewerId);
  return {
    database,
    documentIdentity: documentIdentitySchema.parse({
      documentId: DOCUMENT_ID,
      notebookId: NOTEBOOK_ID,
      organizationId,
      spaceId,
    }),
    editor,
    kernel,
    organizationId,
    spaceId,
    viewer,
  };
}

function openSocket(baseUrl: string, session: Session): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const url = new URL("/api/v1/collaboration/ws", baseUrl);
    const socket = new WebSocket(url, {
      ca: TEST_TLS_CERTIFICATE,
      headers: { Cookie: session.cookie },
      origin: TEST_PUBLIC_ORIGIN,
      rejectUnauthorized: true,
    });
    socket.once("open", () => resolve(socket));
    socket.once("error", reject);
  });
}

function nextMessage(
  socket: WebSocket,
  predicate: (message: CollaborationServerMessage) => boolean,
): Promise<CollaborationServerMessage> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off("message", onMessage);
      reject(new Error("Timed out waiting for collaboration server message"));
    }, 10_000);
    const onMessage = (data: WebSocket.RawData): void => {
      let message: CollaborationServerMessage;
      try {
        message = collaborationServerMessageSchema.parse(JSON.parse(data.toString("utf8")));
      } catch (error) {
        clearTimeout(timer);
        socket.off("message", onMessage);
        reject(error);
        return;
      }
      if (!predicate(message)) {
        return;
      }
      clearTimeout(timer);
      socket.off("message", onMessage);
      resolve(message);
    };
    socket.on("message", onMessage);
  });
}

/** 在同一空间中确认另一个显式文档身份不会收到迟到的协作广播。 */
function noOperationBroadcast(socket: WebSocket, timeoutMilliseconds: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      socket.off("message", onMessage);
      resolve(true);
    }, timeoutMilliseconds);
    const onMessage = (data: WebSocket.RawData): void => {
      let message: CollaborationServerMessage;
      try {
        message = collaborationServerMessageSchema.parse(JSON.parse(data.toString("utf8")));
      } catch {
        return;
      }
      if (message.type === "operation-broadcast") {
        clearTimeout(timer);
        socket.off("message", onMessage);
        resolve(false);
      }
    };
    socket.on("message", onMessage);
  });
}

function closed(socket: WebSocket): Promise<number> {
  return new Promise((resolve) => {
    if (socket.readyState === WebSocket.CLOSED) {
      resolve(WebSocket.CLOSED);
      return;
    }
    socket.once("close", (code) => resolve(code));
  });
}

function sendJoin(
  socket: WebSocket,
  identity: DocumentIdentity,
  clientId: string,
  capability: "editor" | "viewer",
  featureMode: "standard" | "restricted-encrypted",
) {
  socket.send(JSON.stringify(collaborationClientMessageSchema.parse({
    request: {
      capability,
      clientId,
      featureMode,
      identity,
      protocolVersion: 1,
    },
    type: "join",
  })));
}

/** 发送带显式四段身份和会话代次的 history 缺口恢复请求。 */
function sendResume(
  socket: WebSocket,
  identity: DocumentIdentity,
  clientId: string,
  sessionGeneration: number,
): void {
  socket.send(JSON.stringify(collaborationClientMessageSchema.parse({
    request: collaborationResumeRequestSchema.parse({
      causalContext: {},
      clientId,
      identity,
      sessionGeneration,
    }),
    type: "resume",
  })));
}

/** 等待控制面 session 投影收敛，确认 socket 清理没有留下 ready 记录。 */
async function waitForReadySessionCount(
  database: DatabaseClient,
  expected: number,
): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const count = await database.collaborationSession.count({ where: { status: "ready" } });
    if (count === expected) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const count = await database.collaborationSession.count({ where: { status: "ready" } });
  throw new Error(`Expected ${String(expected)} ready collaboration sessions, got ${String(count)}`);
}

/** 为容量认证创建独立成员，证明用户边界而不是重复使用一个浏览器身份。 */
async function createAdditionalViewers(
  api: TestApiApplication,
  database: DatabaseClient,
  environment: ReleaseEnvironment,
  count: number,
): Promise<readonly Session[]> {
  const passwordDigest = await new PasswordHasher().hashPassword(PASSWORD);
  const users = Array.from({ length: count }, () => ({
    id: randomUUID(),
    loginIdentifier: `release-capacity-${randomUUID()}@example.test`,
  }));
  await database.user.createMany({
    data: users.map((user) => ({
      id: user.id,
      loginIdentifier: user.loginIdentifier,
      passwordDigest,
      status: "active",
    })),
  });
  await database.organizationMembership.createMany({
    data: users.map((user) => ({
      organizationId: environment.organizationId,
      role: "member",
      status: "active",
      userId: user.id,
    })),
  });
  await database.spaceMembership.createMany({
    data: users.map((user) => ({
      organizationId: environment.organizationId,
      role: "viewer",
      spaceId: environment.spaceId,
      status: "active",
      userId: user.id,
    })),
  });
  const sessions: Session[] = [];
  // 登录沿用生产 Argon2 admission 的队列合同，避免容量 fixture 自己制造不可达的 KDF 拒绝。
  for (const user of users) {
    sessions.push(await login(api, user.loginIdentifier, user.id));
  }
  return sessions;
}

/** 优雅关闭已加入的 socket，并将资源释放结果交给 session projection 断言。 */
async function closeSockets(sockets: readonly WebSocket[]): Promise<void> {
  await Promise.all(sockets.map(async (socket) => {
    const closedPromise = closed(socket);
    if (socket.readyState < WebSocket.CLOSING) {
      socket.close(1000, "release-certification-teardown");
    }
    await closedPromise;
  }));
}

async function enableFeature(
  api: TestApiApplication,
  environment: ReleaseEnvironment,
  value: { readonly restrictedEncryptedEnabled: boolean; readonly standardEnabled: boolean },
): Promise<void> {
  const response = await requestHttps(
    api.baseUrl,
    buildDocumentCollaborationFeaturePath(environment.documentIdentity),
    {
      body: value,
      cookie: environment.editor.cookie,
      csrfToken: environment.editor.csrfToken,
      method: "PATCH",
    },
  );
  expect(response.statusCode).toBe(200);
}

describe("L3 production release certification", () => {
  let api: TestApiApplication;
  let database: DatabaseClient;
  let environment: ReleaseEnvironment | undefined;
  let kernel: TestKernelGateway | undefined;
  const kernelMode: ReleaseKernelMode = {
    encryptedUnavailable: { value: false },
    failAdmission: { value: false },
  };
  const sockets = new Set<WebSocket>();
  const logger = new CapturingLogger();
  let previousCollaborationFlag: string | undefined;

  beforeAll(() => {
    previousCollaborationFlag = process.env.SINGULARITY_COLLABORATION_ENABLED;
    process.env.SINGULARITY_COLLABORATION_ENABLED = "1";
  });

  beforeEach(async () => {
    kernelMode.encryptedUnavailable.value = false;
    kernelMode.failAdmission.value = false;
    logger.clear();
    kernel = await startTestKernelGateway({
      handler: releaseKernelHandler(kernelMode),
    });
    environment = undefined;
    api = await startTestApiApplication({ https: true, kernelGateway: kernel.configuration, logger });
    database = api.app.get(DatabaseRuntime).client;
    environment = await createEnvironment(api, database, kernel);
  });

  afterEach(async () => {
    for (const socket of sockets) {
      socket.removeAllListeners();
      socket.terminate();
    }
    sockets.clear();
    try {
      await api.dispose();
    } finally {
      try {
        await kernel?.dispose();
      } finally {
        if (environment !== undefined) {
          await truncateTestDatabase(database);
        }
      }
    }
  });

  afterAll(() => {
    if (previousCollaborationFlag === undefined) {
      delete process.env.SINGULARITY_COLLABORATION_ENABLED;
    } else {
      process.env.SINGULARITY_COLLABORATION_ENABLED = previousCollaborationFlag;
    }
  });

  test("two users converge, then ACL revoke and feature closure stop the old session", async () => {
    const current = environment!;
    await enableFeature(api, current, { restrictedEncryptedEnabled: false, standardEnabled: true });
    const editorSocket = await openSocket(api.baseUrl, current.editor);
    const viewerSocket = await openSocket(api.baseUrl, current.viewer);
    sockets.add(editorSocket);
    sockets.add(viewerSocket);
    const editorClientId = randomUUID();
    const viewerClientId = randomUUID();
    const editorJoinedPromise = nextMessage(editorSocket, (message) => message.type === "joined");
    sendJoin(editorSocket, current.documentIdentity, editorClientId, "editor", "standard");
    const editorJoined = await editorJoinedPromise;
    const viewerJoinedPromise = nextMessage(viewerSocket, (message) => message.type === "joined");
    sendJoin(viewerSocket, current.documentIdentity, viewerClientId, "viewer", "standard");
    await viewerJoinedPromise;
    if (editorJoined.type !== "joined") {
      throw new Error("Editor join did not produce joined state");
    }
    const envelope = {
      causalContext: {},
      clientId: editorClientId,
      clientSequence: 1,
      identity: current.documentIdentity,
      operation: { blockId: DOCUMENT_ID, kind: "text.insert" as const, position: 0, text: "release" },
      operationId: randomUUID(),
      sessionGeneration: editorJoined.response.sessionGeneration,
    };
    const resultPromise = nextMessage(editorSocket, (message) => message.type === "operation-result");
    const broadcastPromise = nextMessage(viewerSocket, (message) => message.type === "operation-broadcast");
    editorSocket.send(JSON.stringify(collaborationClientMessageSchema.parse({ envelope, type: "submit" })));
    const result = await resultPromise;
    const broadcast = await broadcastPromise;
    if (result.type !== "operation-result") {
      throw new Error("Editor submit did not produce an operation result");
    }
    expect(result.result.outcome).toBe("accepted");
    if (broadcast.type !== "operation-broadcast") {
      throw new Error("Viewer did not receive an operation broadcast");
    }
    expect(broadcast.broadcast.identity).toEqual(current.documentIdentity);

    const revokedPromise = nextMessage(viewerSocket, (message) => message.type === "revoked");
    const viewerClosedPromise = closed(viewerSocket);
    const revokePath = buildPath("/api/v1/organizations/{organizationId}/spaces/{spaceId}/members/{userId}", {
      organizationId: current.organizationId,
      spaceId: current.spaceId,
      userId: current.viewer.userId,
    });
    const revokedResponse = await requestHttps(api.baseUrl, revokePath, {
      cookie: current.editor.cookie,
      csrfToken: current.editor.csrfToken,
      method: "DELETE",
    });
    expect(revokedResponse.statusCode).toBe(204);
    const revoked = await revokedPromise;
    if (revoked.type !== "revoked") {
      throw new Error("Revoked session did not receive a revocation message");
    }
    expect(await viewerClosedPromise).toBe(1000);

    const closedPromise = closed(editorSocket);
    const disabledPromise = nextMessage(editorSocket, (message) => message.type === "error" && message.code === "collaboration-disabled");
    await enableFeature(api, current, { restrictedEncryptedEnabled: false, standardEnabled: false });
    const disabled = await disabledPromise;
    expect(disabled.type).toBe("error");
    expect(await closedPromise).toBe(1000);
  });

  test("rejects restricted encrypted admission when the Kernel key is unavailable", async () => {
    const current = environment!;
    kernelMode.encryptedUnavailable.value = true;
    await enableFeature(api, current, { restrictedEncryptedEnabled: true, standardEnabled: false });
    const socket = await openSocket(api.baseUrl, current.editor);
    sockets.add(socket);
    const errorPromise = nextMessage(socket, (message) => message.type === "error");
    sendJoin(socket, current.documentIdentity, randomUUID(), "editor", "restricted-encrypted");
    const error = await errorPromise;
    if (error.type !== "error") {
      throw new Error("Encrypted admission did not return an error message");
    }
    expect(error.code).toBe("encrypted-collaboration-unavailable");
  });

  test("keeps broadcasts isolated by the full document identity", async () => {
    const current = environment!;
    const secondIdentity = documentIdentitySchema.parse({
      documentId: `${DOCUMENT_ID.slice(0, 14)}-other01`,
      notebookId: `${NOTEBOOK_ID.slice(0, 14)}-other01`,
      organizationId: current.organizationId,
      spaceId: current.spaceId,
    });
    await enableFeature(api, current, { restrictedEncryptedEnabled: false, standardEnabled: true });
    await enableFeature(api, { ...current, documentIdentity: secondIdentity }, { restrictedEncryptedEnabled: false, standardEnabled: true });
    const firstSocket = await openSocket(api.baseUrl, current.editor);
    const secondSocket = await openSocket(api.baseUrl, current.viewer);
    sockets.add(firstSocket);
    sockets.add(secondSocket);
    const firstClientId = randomUUID();
    const secondClientId = randomUUID();
    const firstJoinedPromise = nextMessage(firstSocket, (message) => message.type === "joined");
    sendJoin(firstSocket, current.documentIdentity, firstClientId, "editor", "standard");
    const firstJoined = await firstJoinedPromise;
    const secondJoinedPromise = nextMessage(secondSocket, (message) => message.type === "joined");
    sendJoin(secondSocket, secondIdentity, secondClientId, "viewer", "standard");
    await secondJoinedPromise;
    const resultPromise = nextMessage(firstSocket, (message) => message.type === "operation-result");
    firstSocket.send(JSON.stringify(collaborationClientMessageSchema.parse({
      envelope: {
        causalContext: {},
        clientId: firstClientId,
        clientSequence: 1,
        identity: current.documentIdentity,
        operation: { blockId: DOCUMENT_ID, kind: "text.insert" as const, position: 0, text: "identity" },
        operationId: randomUUID(),
        sessionGeneration: firstJoined.type === "joined" ? firstJoined.response.sessionGeneration : 1,
      },
      type: "submit",
    })));
    await resultPromise;
    expect(await noOperationBroadcast(secondSocket, 250)).toBe(true);
  });

  test("preserves release failure stack and keeps sensitive credentials out of logs", async () => {
    const current = environment!;
    kernelMode.failAdmission.value = true;
    await enableFeature(api, current, { restrictedEncryptedEnabled: false, standardEnabled: true });
    const socket = await openSocket(api.baseUrl, current.editor);
    sockets.add(socket);
    const errorPromise = nextMessage(socket, (message) => message.type === "error");
    sendJoin(socket, current.documentIdentity, randomUUID(), "editor", "standard");
    const error = await errorPromise;
    if (error.type !== "error") {
      throw new Error("Kernel failure did not return an error message");
    }
    expect(error.code).toBe("service-unavailable");
    expect(logger.output).toContain("collaboration.join");
    expect(logger.output).toContain("Kernel collaboration response is invalid");
    expect(logger.output).toContain("causes");
    expect(logger.output).toContain("at unwrap");
    expect(logger.output).toContain("at CollaborationCoordinator.#admitJoin");
    expect(logger.output).not.toContain(PASSWORD);
    expect(logger.output).not.toContain("operationId");
  });

  test("API restart closes old sessions and resumes canonical Kernel history", async () => {
    const current = environment!;
    await enableFeature(api, current, { restrictedEncryptedEnabled: false, standardEnabled: true });
    const oldSocket = await openSocket(api.baseUrl, current.editor);
    sockets.add(oldSocket);
    const oldClientId = randomUUID();
    const joinedPromise = nextMessage(oldSocket, (message) => message.type === "joined");
    sendJoin(oldSocket, current.documentIdentity, oldClientId, "editor", "standard");
    const joined = await joinedPromise;
    if (joined.type !== "joined") {
      throw new Error("API restart test did not establish the old session");
    }
    const operationId = randomUUID();
    const operationResultPromise = nextMessage(oldSocket, (message) => message.type === "operation-result");
    oldSocket.send(JSON.stringify(collaborationClientMessageSchema.parse({
      envelope: {
        causalContext: {},
        clientId: oldClientId,
        clientSequence: 1,
        identity: current.documentIdentity,
        operation: { blockId: DOCUMENT_ID, kind: "text.insert" as const, position: 0, text: "restart" },
        operationId,
        sessionGeneration: joined.response.sessionGeneration,
      },
      type: "submit",
    })));
    const operationResult = await operationResultPromise;
    if (operationResult.type !== "operation-result") {
      throw new Error("API restart test did not confirm the canonical operation");
    }
    expect(operationResult.result.outcome).toBe("accepted");

    const oldClosed = closed(oldSocket);
    await api.dispose();
    expect(await oldClosed).toBe(1000);
    api = await startTestApiApplication({ https: true, kernelGateway: current.kernel.configuration, logger });
    database = api.app.get(DatabaseRuntime).client;

    const reconnectedSocket = await openSocket(api.baseUrl, current.editor);
    sockets.add(reconnectedSocket);
    const reconnectedClientId = randomUUID();
    const reconnectedJoinedPromise = nextMessage(reconnectedSocket, (message) => message.type === "joined");
    sendJoin(reconnectedSocket, current.documentIdentity, reconnectedClientId, "editor", "standard");
    const reconnectedJoined = await reconnectedJoinedPromise;
    if (reconnectedJoined.type !== "joined") {
      throw new Error("API restart test did not re-establish the collaboration session");
    }
    const resumedPromise = nextMessage(reconnectedSocket, (message) => message.type === "resumed");
    sendResume(
      reconnectedSocket,
      current.documentIdentity,
      reconnectedClientId,
      reconnectedJoined.response.sessionGeneration,
    );
    const resumed = await resumedPromise;
    if (resumed.type !== "resumed") {
      throw new Error("API restart test did not return canonical history");
    }
    expect(resumed.broadcasts.map((entry) => entry.operation.operationId)).toContain(operationId);
    await closeSockets([reconnectedSocket]);
    await waitForReadySessionCount(database, 0);
  });

  test("enforces the single-document active session limit", async () => {
    const current = environment!;
    await enableFeature(api, current, { restrictedEncryptedEnabled: false, standardEnabled: true });
    const viewers = await createAdditionalViewers(api, database, current, 20);
    const userSockets: WebSocket[] = [];
    for (const [index, viewer] of viewers.entries()) {
      const socket = await openSocket(api.baseUrl, viewer);
      sockets.add(socket);
      userSockets.push(socket);
      const joinedPromise = nextMessage(socket, (message) => message.type === "joined");
      sendJoin(socket, current.documentIdentity, randomUUID(), "viewer", "standard");
      const joined = await joinedPromise;
      expect(joined.type).toBe("joined");
      if (index === 9) {
        await waitForReadySessionCount(database, 10);
      }
    }
    await waitForReadySessionCount(database, 20);
    await closeSockets(userSockets);
    await waitForReadySessionCount(database, 0);

    const capacitySockets: WebSocket[] = [];
    for (let index = 0; index < CAPACITY_LIMIT; index += 1) {
      const socket = await openSocket(api.baseUrl, current.editor);
      sockets.add(socket);
      capacitySockets.push(socket);
      const joinedPromise = nextMessage(socket, (message) => message.type === "joined");
      sendJoin(socket, current.documentIdentity, randomUUID(), "editor", "standard");
      const joined = await joinedPromise;
      expect(joined.type).toBe("joined");
    }
    await waitForReadySessionCount(database, CAPACITY_LIMIT);
    const rejectedSocket = await openSocket(api.baseUrl, current.editor);
    sockets.add(rejectedSocket);
    const rejectedPromise = nextMessage(rejectedSocket, (message) => message.type === "error");
    sendJoin(rejectedSocket, current.documentIdentity, randomUUID(), "editor", "standard");
    const rejected = await rejectedPromise;
    if (rejected.type !== "error") {
      throw new Error("Capacity admission did not return an error message");
    }
    expect(rejected.code).toBe("collaboration-capacity-exceeded");
    await closeSockets([...capacitySockets, rejectedSocket]);
    await waitForReadySessionCount(database, 0);
  });
});
