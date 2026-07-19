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
import { DatabaseRuntime, type DatabaseClient } from "@singularity/database";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";

import { PasswordHasher } from "../src/identity/password-hasher.js";
import { truncateTestDatabase } from "./support/database.js";
import {
  startTestApiApplication,
  TEST_PUBLIC_ORIGIN,
  type TestApiApplication,
} from "./support/test-app.js";
import {
  startTestKernelGateway,
  type TestKernelGateway,
  type TestKernelRequest,
  type TestKernelResponse,
} from "./support/kernel-gateway.js";

const USER_PASSWORD = "correct horse battery staple";
const SHARE_PASSWORD = "protected share password";
const ROTATED_SHARE_PASSWORD = "rotated share password";
const NOTEBOOK_ID = "20260718010101-abcdefg";
const DOCUMENT_ID = "20260718010102-hijklmn";
const OTHER_DOCUMENT_ID = "20260718010103-opqrstu";
const ASSET_ID = "a".repeat(64);
const ASSET_BODY = Buffer.from("share asset", "utf8");

interface AuthenticatedGraph {
  cookie: string;
  csrfToken: string;
  organizationId: string;
  spaceId: string;
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

function kernelResponse(request: TestKernelRequest): TestKernelResponse {
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

describe("sharing and audit HTTP contracts with PostgreSQL and mTLS Kernel", () => {
  let database: DatabaseClient;
  let kernel: TestKernelGateway;
  let testApi: TestApiApplication;
  let userPasswordDigest: string;

  beforeAll(async () => {
    kernel = await startTestKernelGateway({ handler: kernelResponse });
    try {
      testApi = await startTestApiApplication({
        kernelGateway: kernel.configuration,
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
    await truncateTestDatabase(database);
  });

  afterAll(async () => {
    try {
      await testApi.dispose();
    } finally {
      await kernel.dispose();
    }
  });

  async function createAuthenticatedGraph(): Promise<AuthenticatedGraph> {
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
        role: "owner",
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
        role: "admin",
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
