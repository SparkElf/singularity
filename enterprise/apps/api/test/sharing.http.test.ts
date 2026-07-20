import { randomUUID } from "node:crypto";

import {
  AUTH_LOGIN_PATH,
  CSRF_HEADER_NAME,
  ORGANIZATION_AUDIT_EVENTS_PATH_TEMPLATE,
  ORGANIZATION_SPACE_SHARE_PASSWORD_PATH_TEMPLATE,
  ORGANIZATION_SPACE_SHARE_PATH_TEMPLATE,
  ORGANIZATION_SPACE_SHARES_PATH_TEMPLATE,
  PUBLIC_SHARE_ASSET_PATH_TEMPLATE,
  PUBLIC_SHARE_CHALLENGE_PATH_TEMPLATE,
  PUBLIC_SHARE_PATH_TEMPLATE,
  apiProblemSchema,
  auditEventsResponseSchema,
  createdDocumentShareSchema,
  loginResponseSchema,
  managedDocumentSharesResponseSchema,
  sharedDocumentPayloadSchema,
} from "@singularity/contracts";
import {
  DatabaseRuntime,
  Prisma,
  type DatabaseClient,
} from "@singularity/database";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";

import { PasswordHasher } from "../src/identity/password-hasher.js";
import { CapturingLogger } from "./support/capturing-logger.js";
import { truncateTestDatabase } from "./support/database.js";
import {
  startTestKernelGateway,
  type TestKernelGateway,
  type TestKernelRequest,
  type TestKernelResponse,
} from "./support/kernel-gateway.js";
import {
  startTestApiApplication,
  TEST_PUBLIC_ORIGIN,
  type TestApiApplication,
} from "./support/test-app.js";

const USER_PASSWORD = "correct horse battery staple";
const SHARE_PASSWORD = "protected share password";
const ROTATED_SHARE_PASSWORD = "rotated share password";
const NOTEBOOK_ID = "20260718010101-abcdefg";
const DOCUMENT_ID = "20260718010102-hijklmn";
const OTHER_DOCUMENT_ID = "20260718010103-opqrstu";
const ASSET_ID = "a".repeat(64);
const ASSET_BODY = Buffer.from("share asset", "utf8");

type KernelResponseHandler = (
  request: TestKernelRequest,
) => Promise<TestKernelResponse> | TestKernelResponse;

let kernelResponseOverride: KernelResponseHandler | null = null;

interface AuthenticatedGraph {
  cookie: string;
  csrfToken: string;
  organizationId: string;
  spaceId: string;
}

interface AuthenticatedGraphOptions {
  organizationRole?: "admin" | "member" | "owner";
  spaceRole?: "admin" | "editor" | "viewer";
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
    throw new Error("Response cookie is unavailable");
  }
  return pair;
}

function kernelResponse(
  request: TestKernelRequest,
): Promise<TestKernelResponse> | TestKernelResponse {
  if (kernelResponseOverride !== null) {
    return kernelResponseOverride(request);
  }
  return defaultKernelResponse(request);
}

function defaultKernelResponse(request: TestKernelRequest): TestKernelResponse {
  if (request.path === "/internal/enterprise/share/verify") {
    return { headers: { "content-type": "application/json" }, status: 200 };
  }
  if (request.path === "/internal/enterprise/share/document") {
    return {
      body: JSON.stringify({
        assets: [
          {
            assetId: ASSET_ID,
            disposition: "inline",
            fileName: "diagram.png",
            mediaType: "image/png",
          },
        ],
        documentId: DOCUMENT_ID,
        html: `<img src="singularity-share-asset:${ASSET_ID}">`,
        title: "Shared document",
      }),
      headers: { "content-type": "application/json" },
      status: 200,
    };
  }
  if (request.path === `/internal/enterprise/share/asset?assetId=${ASSET_ID}`) {
    return {
      body: ASSET_BODY,
      headers: {
        "content-length": ASSET_BODY.byteLength,
        "content-type": "image/png",
        "x-singularity-asset-disposition": "inline",
        "x-singularity-asset-filename": Buffer.from("diagram.png").toString(
          "base64url",
        ),
      },
      status: 200,
    };
  }
  return { status: 404 };
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

async function waitForBlockedShareMutation(
  database: DatabaseClient,
): Promise<void> {
  const deadline = Date.now() + 3_000;
  for (;;) {
    const rows = await database.$queryRaw<Array<{ pid: number }>>(
      Prisma.sql`
        SELECT activity.pid AS "pid"
        FROM pg_stat_activity AS activity
        WHERE activity.wait_event_type = 'Lock'
          AND cardinality(pg_blocking_pids(activity.pid)) > 0
          AND activity.query ILIKE '%UPDATE "document_shares"%'
      `,
    );
    if (rows.length > 0) {
      return;
    }
    if (Date.now() >= deadline) {
      throw new Error("The share mutation did not wait for the active public response");
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

describe("sharing and audit HTTP contracts with PostgreSQL and mTLS Kernel", () => {
  let database: DatabaseClient;
  let kernel: TestKernelGateway;
  let logger: CapturingLogger;
  let testApi: TestApiApplication;
  let userPasswordDigest: string;

  beforeAll(async () => {
    logger = new CapturingLogger();
    kernel = await startTestKernelGateway({ handler: kernelResponse });
    try {
      testApi = await startTestApiApplication({
        kernelGateway: kernel.configuration,
        logger,
      });
      database = testApi.app.get(DatabaseRuntime).client;
      userPasswordDigest = await testApi.app
        .get(PasswordHasher)
        .hashPassword(USER_PASSWORD);
    } catch (error) {
      await kernel.dispose();
      throw error;
    }
  });

  afterEach(async () => {
    kernelResponseOverride = null;
    await truncateTestDatabase(database);
    logger.clear();
  });

  afterAll(async () => {
    try {
      await testApi.dispose();
    } finally {
      await kernel.dispose();
    }
  });

  async function createAuthenticatedGraph(
    options: AuthenticatedGraphOptions = {},
  ): Promise<AuthenticatedGraph> {
    const userId = randomUUID();
    const organizationId = randomUUID();
    const loginIdentifier = `share-${randomUUID()}@example.test`;
    await database.user.create({
      data: {
        id: userId,
        loginIdentifier,
        passwordDigest: userPasswordDigest,
        status: "active",
      },
    });
    await database.organization.create({
      data: { id: organizationId, name: "Sharing", status: "active" },
    });
    await database.organizationMembership.create({
      data: {
        organizationId,
        role: options.organizationRole ?? "owner",
        status: "active",
        userId,
      },
    });
    await database.space.create({
      data: {
        id: kernel.deployment.spaceId,
        name: "Shared space",
        organizationId,
        status: "active",
      },
    });
    await database.spaceMembership.create({
      data: {
        organizationId,
        role: options.spaceRole ?? "admin",
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
        version: "3.7.2",
      },
    });

    const login = await fetch(`${testApi.baseUrl}${AUTH_LOGIN_PATH}`, {
      body: JSON.stringify({
        loginIdentifier,
        password: USER_PASSWORD,
      }),
      headers: {
        "Content-Type": "application/json",
        Origin: TEST_PUBLIC_ORIGIN,
      },
      method: "POST",
    });
    if (login.status !== 200) {
      throw new Error("Sharing test login failed");
    }
    const { csrfToken } = loginResponseSchema.parse(await login.json());
    return {
      cookie: cookiePair(login),
      csrfToken,
      organizationId,
      spaceId: kernel.deployment.spaceId,
    };
  }

  function mutationHeaders(graph: AuthenticatedGraph): Record<string, string> {
    return {
      [CSRF_HEADER_NAME]: graph.csrfToken,
      "Content-Type": "application/json",
      Cookie: graph.cookie,
      Origin: TEST_PUBLIC_ORIGIN,
    };
  }

  async function createShare(
    graph: AuthenticatedGraph,
    password: string | null,
    documentId = DOCUMENT_ID,
  ) {
    const path = buildPath(ORGANIZATION_SPACE_SHARES_PATH_TEMPLATE, {
      organizationId: graph.organizationId,
      spaceId: graph.spaceId,
    });
    const response = await fetch(`${testApi.baseUrl}${path}`, {
      body: JSON.stringify({
        documentId,
        expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
        notebookId: NOTEBOOK_ID,
        password,
      }),
      headers: mutationHeaders(graph),
      method: "POST",
    });
    expect(response.status).toBe(201);
    return createdDocumentShareSchema.parse(await response.json());
  }

  test("creates, lists, revokes, and audits a managed live share", async () => {
    const graph = await createAuthenticatedGraph();
    const requestOffset = kernel.requests.length;
    const share = await createShare(graph, null);
    const managedPath = buildPath(
      ORGANIZATION_SPACE_SHARES_PATH_TEMPLATE,
      { organizationId: graph.organizationId, spaceId: graph.spaceId },
    );
    const listed = await fetch(`${testApi.baseUrl}${managedPath}`, {
      headers: { Cookie: graph.cookie },
    });
    expect(listed.status).toBe(200);
    const listedText = await listed.text();
    const { shareToken, ...managedShare } = share;
    expect(shareToken).toHaveLength(43);
    expect(
      managedDocumentSharesResponseSchema.parse(JSON.parse(listedText)),
    ).toEqual({ shares: [managedShare] });
    expect(listedText).not.toContain(share.shareToken);

    const sharePath = buildPath(ORGANIZATION_SPACE_SHARE_PATH_TEMPLATE, {
      organizationId: graph.organizationId,
      shareId: share.shareId,
      spaceId: graph.spaceId,
    });
    const revoked = await fetch(`${testApi.baseUrl}${sharePath}`, {
      headers: mutationHeaders(graph),
      method: "DELETE",
    });
    expect(revoked.status).toBe(204);

    const auditPath = buildPath(ORGANIZATION_AUDIT_EVENTS_PATH_TEMPLATE, {
      organizationId: graph.organizationId,
    });
    const audit = await fetch(`${testApi.baseUrl}${auditPath}`, {
      headers: { Cookie: graph.cookie },
    });
    expect(audit.status).toBe(200);
    const events = auditEventsResponseSchema.parse(await audit.json()).events;
    expect(events.map((event) => event.action)).toEqual([
      "share.revoke",
      "share.create",
      "authentication.login",
    ]);
    expect(
      events
        .filter((event) => event.targetType === "share")
        .map((event) => event.targetId),
    ).toEqual([share.shareId, share.shareId]);

    const requests = kernel.requests.slice(requestOffset);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      authorized: true,
      method: "POST",
      path: "/internal/enterprise/share/verify",
    });
    expect(requests[0]?.headers["x-singularity-notebook-id"]).toBe(NOTEBOOK_ID);
    expect(requests[0]?.headers["x-singularity-document-id"]).toBe(DOCUMENT_ID);
    expect(requests[0]?.headers["x-singularity-service-token"]).toEqual(
      expect.any(String),
    );
  });

  test("rejects a space viewer before Kernel verification or persistence", async () => {
    const graph = await createAuthenticatedGraph({
      organizationRole: "member",
      spaceRole: "viewer",
    });
    const path = buildPath(ORGANIZATION_SPACE_SHARES_PATH_TEMPLATE, {
      organizationId: graph.organizationId,
      spaceId: graph.spaceId,
    });
    const requestCount = kernel.requests.length;
    const response = await fetch(`${testApi.baseUrl}${path}`, {
      body: JSON.stringify({
        documentId: DOCUMENT_ID,
        expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
        notebookId: NOTEBOOK_ID,
        password: null,
      }),
      headers: mutationHeaders(graph),
      method: "POST",
    });

    expect(response.status).toBe(403);
    expect(apiProblemSchema.parse(await response.json()).code).toBe("forbidden");
    expect(kernel.requests).toHaveLength(requestCount);
    expect(await database.documentShare.count()).toBe(0);
  });

  test("applies public security headers before share path validation", async () => {
    const response = await fetch(`${testApi.baseUrl}/api/v1/shares/invalid`);

    expect(response.status).toBe(400);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("content-security-policy")).toBe(
      "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'",
    );
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("x-robots-tag")).toBe(
      "noindex, nofollow, noarchive",
    );
  });

  test("rejects a Kernel projection whose document identity differs from the share", async () => {
    const graph = await createAuthenticatedGraph();
    const share = await createShare(graph, null, OTHER_DOCUMENT_ID);
    const response = await fetch(
      `${testApi.baseUrl}${buildPath(PUBLIC_SHARE_PATH_TEMPLATE, {
        shareToken: share.shareToken,
      })}`,
    );

    expect(response.status).toBe(503);
    expect(apiProblemSchema.parse(await response.json()).code).toBe(
      "service-unavailable",
    );
    const request = kernel.requests.at(-1);
    expect(request?.path).toBe("/internal/enterprise/share/document");
    expect(request?.headers["x-singularity-notebook-id"]).toBe(NOTEBOOK_ID);
    expect(request?.headers["x-singularity-document-id"]).toBe(
      OTHER_DOCUMENT_ID,
    );
    expect(logger.output).toContain("share.kernel");
    expect(logger.output).toMatch(
      /Error: Kernel shared document projection failed validation\n\s+at /,
    );
    expect(logger.output).not.toContain(share.shareToken);
    expect(logger.output).not.toContain(NOTEBOOK_ID);
    expect(logger.output).not.toContain(OTHER_DOCUMENT_ID);
  });

  test("logs malformed Kernel JSON without exposing shared content", async () => {
    const graph = await createAuthenticatedGraph();
    const share = await createShare(graph, null);
    const privateContent = "PRIVATE-SHARED-CONTENT-SENTINEL";
    kernelResponseOverride = (request) =>
      request.path === "/internal/enterprise/share/document"
        ? {
            body: `{"html":"${privateContent}`,
            headers: { "content-type": "application/json" },
            status: 200,
          }
        : defaultKernelResponse(request);

    const response = await fetch(
      `${testApi.baseUrl}${buildPath(PUBLIC_SHARE_PATH_TEMPLATE, {
        shareToken: share.shareToken,
      })}`,
    );

    expect(response.status).toBe(503);
    expect(logger.output).toMatch(
      /Error: Kernel shared document JSON parsing failed\n\s+at /,
    );
    expect(logger.output).not.toContain(privateContent);
    expect(logger.output).not.toContain(share.shareToken);
    expect(logger.output).not.toContain(NOTEBOOK_ID);
    expect(logger.output).not.toContain(DOCUMENT_ID);
  });

  test("terminates a shared asset response whose body ends before Content-Length", async () => {
    const graph = await createAuthenticatedGraph();
    const share = await createShare(graph, null);
    kernelResponseOverride = (request) =>
      request.path === `/internal/enterprise/share/asset?assetId=${ASSET_ID}`
        ? {
            body: ASSET_BODY,
            headers: {
              "content-length": ASSET_BODY.byteLength + 1,
              "content-type": "image/png",
              "x-singularity-asset-disposition": "inline",
              "x-singularity-asset-filename": Buffer.from(
                "diagram.png",
              ).toString("base64url"),
            },
            status: 200,
          }
        : defaultKernelResponse(request);
    const assetPath = buildPath(PUBLIC_SHARE_ASSET_PATH_TEMPLATE, {
      assetId: ASSET_ID,
      shareToken: share.shareToken,
    });

    await expect(
      fetch(`${testApi.baseUrl}${assetPath}`).then((response) =>
        response.arrayBuffer()
      ),
    ).rejects.toBeInstanceOf(Error);
    expect(logger.output).toContain("share.kernel");
    expect(logger.output).not.toContain(share.shareToken);
  });

  test("rejects a shared asset declaration above the byte limit", async () => {
    const graph = await createAuthenticatedGraph();
    const share = await createShare(graph, null);
    kernelResponseOverride = (request) =>
      request.path === `/internal/enterprise/share/asset?assetId=${ASSET_ID}`
        ? {
            body: ASSET_BODY,
            headers: {
              "content-length": 100 * 1_024 * 1_024 + 1,
              "content-type": "image/png",
              "x-singularity-asset-disposition": "inline",
              "x-singularity-asset-filename": Buffer.from("diagram.png").toString(
                "base64url",
              ),
            },
            status: 200,
          }
        : defaultKernelResponse(request);
    const assetPath = buildPath(PUBLIC_SHARE_ASSET_PATH_TEMPLATE, {
      assetId: ASSET_ID,
      shareToken: share.shareToken,
    });

    const response = await fetch(`${testApi.baseUrl}${assetPath}`);
    expect(response.status).toBe(503);
    expect(apiProblemSchema.parse(await response.json()).code).toBe(
      "service-unavailable",
    );
  });

  test("rechecks expiry before each public document read", async () => {
    const graph = await createAuthenticatedGraph();
    const share = await createShare(graph, null);
    const publicPath = buildPath(PUBLIC_SHARE_PATH_TEMPLATE, {
      shareToken: share.shareToken,
    });
    const initialRead = await fetch(`${testApi.baseUrl}${publicPath}`);
    expect(initialRead.status).toBe(200);
    await initialRead.arrayBuffer();

    const now = Date.now();
    await database.documentShare.update({
      where: { id: share.shareId },
      data: {
        createdAt: new Date(now - 2 * 60 * 60_000),
        expiresAt: new Date(now - 60 * 60_000),
      },
    });
    const requestCount = kernel.requests.length;
    const expiredRead = await fetch(`${testApi.baseUrl}${publicPath}`);

    expect(expiredRead.status).toBe(404);
    expect(apiProblemSchema.parse(await expiredRead.json()).code).toBe(
      "not-found",
    );
    expect(kernel.requests).toHaveLength(requestCount);
  });

  test.each([
    {
      kernelPath: "/internal/enterprise/share/document",
      publicPath: (shareToken: string) =>
        buildPath(PUBLIC_SHARE_PATH_TEMPLATE, { shareToken }),
      resource: "document",
    },
    {
      kernelPath: `/internal/enterprise/share/asset?assetId=${ASSET_ID}`,
      publicPath: (shareToken: string) =>
        buildPath(PUBLIC_SHARE_ASSET_PATH_TEMPLATE, {
          assetId: ASSET_ID,
          shareToken,
        }),
      resource: "asset",
    },
  ])(
    "holds revocation until the active $resource response finishes",
    async ({ kernelPath, publicPath }) => {
      const graph = await createAuthenticatedGraph();
      const share = await createShare(graph, null);
      const kernelReached = deferred();
      const releaseKernel = deferred();
      kernelResponseOverride = async (request) => {
        if (request.path === kernelPath) {
          kernelReached.resolve();
          await releaseKernel.promise;
        }
        return defaultKernelResponse(request);
      };

      const publicUrl = `${testApi.baseUrl}${publicPath(share.shareToken)}`;
      const read = fetch(publicUrl);
      let revocation: Promise<Response> | undefined;
      try {
        await kernelReached.promise;
        const sharePath = buildPath(ORGANIZATION_SPACE_SHARE_PATH_TEMPLATE, {
          organizationId: graph.organizationId,
          shareId: share.shareId,
          spaceId: graph.spaceId,
        });
        revocation = fetch(`${testApi.baseUrl}${sharePath}`, {
          headers: mutationHeaders(graph),
          method: "DELETE",
        });
        await waitForBlockedShareMutation(database);
        releaseKernel.resolve();

        const response = await read;
        expect(response.status).toBe(200);
        await response.arrayBuffer();
        expect((await revocation).status).toBe(204);

        const afterRevocation = await fetch(publicUrl);
        expect(afterRevocation.status).toBe(404);
        expect(apiProblemSchema.parse(await afterRevocation.json()).code).toBe(
          "not-found",
        );
      } finally {
        releaseKernel.resolve();
        await Promise.allSettled([
          read.then(async (response) => {
            if (!response.bodyUsed) {
              await response.arrayBuffer();
            }
          }),
          ...(revocation === undefined ? [] : [revocation]),
        ]);
      }
    },
  );

  test("holds password rotation until the active response finishes", async () => {
    const graph = await createAuthenticatedGraph();
    const share = await createShare(graph, SHARE_PASSWORD);
    const challengePath = buildPath(PUBLIC_SHARE_CHALLENGE_PATH_TEMPLATE, {
      shareToken: share.shareToken,
    });
    const challenged = await fetch(`${testApi.baseUrl}${challengePath}`, {
      body: JSON.stringify({ password: SHARE_PASSWORD }),
      headers: {
        "Content-Type": "application/json",
        Origin: TEST_PUBLIC_ORIGIN,
      },
      method: "POST",
    });
    expect(challenged.status).toBe(204);
    const challengeCookie = cookiePair(challenged);
    const kernelReached = deferred();
    const releaseKernel = deferred();
    kernelResponseOverride = async (request) => {
      if (request.path === "/internal/enterprise/share/document") {
        kernelReached.resolve();
        await releaseKernel.promise;
      }
      return defaultKernelResponse(request);
    };

    const publicPath = buildPath(PUBLIC_SHARE_PATH_TEMPLATE, {
      shareToken: share.shareToken,
    });
    const read = fetch(`${testApi.baseUrl}${publicPath}`, {
      headers: { Cookie: challengeCookie },
    });
    let rotation: Promise<Response> | undefined;
    try {
      await kernelReached.promise;
      const passwordPath = buildPath(
        ORGANIZATION_SPACE_SHARE_PASSWORD_PATH_TEMPLATE,
        {
          organizationId: graph.organizationId,
          shareId: share.shareId,
          spaceId: graph.spaceId,
        },
      );
      rotation = fetch(`${testApi.baseUrl}${passwordPath}`, {
        body: JSON.stringify({ password: ROTATED_SHARE_PASSWORD }),
        headers: mutationHeaders(graph),
        method: "PATCH",
      });
      await waitForBlockedShareMutation(database);
      releaseKernel.resolve();

      const response = await read;
      expect(response.status).toBe(200);
      await response.arrayBuffer();
      expect((await rotation).status).toBe(204);

      const afterRotation = await fetch(`${testApi.baseUrl}${publicPath}`, {
        headers: { Cookie: challengeCookie },
      });
      expect(afterRotation.status).toBe(401);
      expect(apiProblemSchema.parse(await afterRotation.json()).code).toBe(
        "unauthenticated",
      );
    } finally {
      releaseKernel.resolve();
      await Promise.allSettled([
        read.then(async (response) => {
          if (!response.bodyUsed) {
            await response.arrayBuffer();
          }
        }),
        ...(rotation === undefined ? [] : [rotation]),
      ]);
    }
  });

  test("invalidates password challenges on rotation and revocation", async () => {
    const graph = await createAuthenticatedGraph();
    const share = await createShare(graph, SHARE_PASSWORD);
    const publicPath = buildPath(PUBLIC_SHARE_PATH_TEMPLATE, {
      shareToken: share.shareToken,
    });
    const challengePath = buildPath(PUBLIC_SHARE_CHALLENGE_PATH_TEMPLATE, {
      shareToken: share.shareToken,
    });

    const required = await fetch(`${testApi.baseUrl}${publicPath}`);
    expect(required.status).toBe(401);
    expect(apiProblemSchema.parse(await required.json()).code).toBe(
      "unauthenticated",
    );
    expect(required.headers.get("cache-control")).toBe("no-store");
    expect(required.headers.get("x-robots-tag")).toContain("noindex");

    logger.clear();
    const denied = await fetch(`${testApi.baseUrl}${challengePath}`, {
      body: JSON.stringify({ password: "incorrect share password" }),
      headers: {
        "Content-Type": "application/json",
        Origin: TEST_PUBLIC_ORIGIN,
      },
      method: "POST",
    });
    expect(denied.status).toBe(401);
    expect(apiProblemSchema.parse(await denied.json()).code).toBe(
      "unauthenticated",
    );
    expect(denied.headers.get("set-cookie")).toBeNull();
    expect(logger.output).toContain("share.access");
    expect(logger.output).toContain("sourceDigest");
    expect(logger.output).not.toContain("127.0.0.1");
    expect(logger.output).not.toContain("incorrect share password");
    expect(logger.output).not.toContain(share.shareToken);

    const challenged = await fetch(`${testApi.baseUrl}${challengePath}`, {
      body: JSON.stringify({ password: SHARE_PASSWORD }),
      headers: {
        "Content-Type": "application/json",
        Origin: TEST_PUBLIC_ORIGIN,
      },
      method: "POST",
    });
    expect(challenged.status).toBe(204);
    const firstChallengeCookie = cookiePair(challenged);
    const challengeHeader = challenged.headers.get("set-cookie");
    expect(challengeHeader).toContain("Expires=");
    expect(challengeHeader).toContain("HttpOnly");
    expect(challengeHeader).toContain("Secure");

    const document = await fetch(`${testApi.baseUrl}${publicPath}`, {
      headers: { Cookie: firstChallengeCookie },
    });
    expect(document.status).toBe(200);
    expect(document.headers.get("cache-control")).toBe("no-store");
    expect(document.headers.get("content-security-policy")).toBe(
      "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'",
    );
    expect(document.headers.get("referrer-policy")).toBe("no-referrer");
    expect(document.headers.get("x-content-type-options")).toBe("nosniff");
    expect(document.headers.get("x-robots-tag")).toContain("noindex");
    const payload = sharedDocumentPayloadSchema.parse(await document.json());
    expect(payload).not.toHaveProperty("documentId");
    expect(payload.html).toContain(
      `/api/v1/shares/${share.shareToken}/assets/${ASSET_ID}`,
    );

    const assetPath = buildPath(PUBLIC_SHARE_ASSET_PATH_TEMPLATE, {
      assetId: ASSET_ID,
      shareToken: share.shareToken,
    });
    const asset = await fetch(`${testApi.baseUrl}${assetPath}`, {
      headers: { Cookie: firstChallengeCookie },
    });
    expect(asset.status).toBe(200);
    expect(asset.headers.get("content-type")).toBe("image/png");
    expect(asset.headers.get("content-disposition")).toContain("inline");
    expect(asset.headers.get("content-security-policy")).toBe(
      "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'",
    );
    expect(asset.headers.get("referrer-policy")).toBe("no-referrer");
    expect(asset.headers.get("x-content-type-options")).toBe("nosniff");
    expect(asset.headers.get("x-robots-tag")).toBe(
      "noindex, nofollow, noarchive",
    );
    expect(Buffer.from(await asset.arrayBuffer())).toEqual(ASSET_BODY);

    const passwordPath = buildPath(
      ORGANIZATION_SPACE_SHARE_PASSWORD_PATH_TEMPLATE,
      {
        organizationId: graph.organizationId,
        shareId: share.shareId,
        spaceId: graph.spaceId,
      },
    );
    const rotated = await fetch(`${testApi.baseUrl}${passwordPath}`, {
      body: JSON.stringify({ password: ROTATED_SHARE_PASSWORD }),
      headers: mutationHeaders(graph),
      method: "PATCH",
    });
    expect(rotated.status).toBe(204);
    const auditPath = buildPath(ORGANIZATION_AUDIT_EVENTS_PATH_TEMPLATE, {
      organizationId: graph.organizationId,
    });
    const audit = await fetch(`${testApi.baseUrl}${auditPath}`, {
      headers: { Cookie: graph.cookie },
    });
    expect(audit.status).toBe(200);
    expect(
      auditEventsResponseSchema
        .parse(await audit.json())
        .events.filter((event) => event.action === "share.password-change"),
    ).toEqual([
      expect.objectContaining({
        spaceId: graph.spaceId,
        targetId: share.shareId,
        targetType: "share",
      }),
    ]);
    const oldChallenge = await fetch(`${testApi.baseUrl}${publicPath}`, {
      headers: { Cookie: firstChallengeCookie },
    });
    expect(oldChallenge.status).toBe(401);

    const rechallenged = await fetch(`${testApi.baseUrl}${challengePath}`, {
      body: JSON.stringify({ password: ROTATED_SHARE_PASSWORD }),
      headers: {
        "Content-Type": "application/json",
        Origin: TEST_PUBLIC_ORIGIN,
      },
      method: "POST",
    });
    expect(rechallenged.status).toBe(204);
    const secondChallengeCookie = cookiePair(rechallenged);
    expect(secondChallengeCookie).not.toBe(firstChallengeCookie);

    const sharePath = buildPath(ORGANIZATION_SPACE_SHARE_PATH_TEMPLATE, {
      organizationId: graph.organizationId,
      shareId: share.shareId,
      spaceId: graph.spaceId,
    });
    const revoked = await fetch(`${testApi.baseUrl}${sharePath}`, {
      headers: mutationHeaders(graph),
      method: "DELETE",
    });
    expect(revoked.status).toBe(204);
    const afterRevocation = await fetch(`${testApi.baseUrl}${publicPath}`, {
      headers: { Cookie: secondChallengeCookie },
    });
    expect(afterRevocation.status).toBe(404);
    expect(afterRevocation.headers.get("cache-control")).toBe("no-store");
  });
});
