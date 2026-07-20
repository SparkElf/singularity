import { randomUUID } from "node:crypto";

import {
  AUTH_LOGIN_PATH,
  AUTH_SESSION_COOKIE_NAME,
  CSRF_HEADER_NAME,
  apiProblemSchema,
  buildSpaceDiscoveryGraphPath,
  buildSpaceDiscoverySearchPath,
  loginResponseSchema,
  spaceDiscoveryGraphResponseSchema,
  spaceDiscoverySearchResponseSchema,
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
  testKernelGatewayConfiguration,
  type TestKernelGateway,
  type TestKernelRequest,
  type TestKernelResponse,
} from "./support/kernel-gateway.js";

const PASSWORD = "correct horse battery staple";
const NOTEBOOK_ID = "20260719150000-noteb01";
const DOCUMENT_ID = "20260719150001-docum01";
const BLOCK_ID = "20260719150002-block01";
const SECOND_NOTEBOOK_ID = "20260719160000-noteb02";
const SECOND_DOCUMENT_ID = "20260719160001-docum02";
const SECOND_BLOCK_ID = "20260719160002-block02";
const SEARCH_PATH = "/internal/enterprise/discovery/search";
const GRAPH_PATH = "/internal/enterprise/discovery/graph";
const DOCUMENT_SEARCH_PATH = "/api/search/fullTextSearchBlock";
const DOCUMENT_OUTLINE_PATH = "/api/outline/getDocOutline";
const DOCUMENT_BACKLINKS_PATH = "/api/ref/getBacklink2";
const DOCUMENT_HISTORY_PATH = "/api/history/searchHistory";
const DOCUMENT_GRAPH_PATH = "/api/graph/getLocalGraph";
const INVALID_SCHEMA_QUERY = "invalid-kernel-schema";
const INVALID_CONTENT_TYPE_QUERY = "invalid-kernel-content-type";
const OVERSIZED_RESPONSE_QUERY = "oversized-kernel-response";
const FAILED_STATUS_QUERY = "failed-kernel-status";
const MAX_DISCOVERY_RESPONSE_BYTES = 2 * 1024 * 1024;

const SEARCH_RESPONSE = {
  blocks: [
    {
      content: "Alpha knowledge",
      documentId: DOCUMENT_ID,
      id: BLOCK_ID,
      notebookId: NOTEBOOK_ID,
    },
  ],
  matchedBlockCount: 1,
  pageCount: 1,
};

const SECOND_SEARCH_RESPONSE = {
  blocks: [
    {
      content: "Beta knowledge",
      documentId: SECOND_DOCUMENT_ID,
      id: SECOND_BLOCK_ID,
      notebookId: SECOND_NOTEBOOK_ID,
    },
  ],
  matchedBlockCount: 1,
  pageCount: 1,
};

const GRAPH_RESPONSE = {
  links: [{ from: DOCUMENT_ID, to: BLOCK_ID }],
  nodes: [
    {
      documentId: DOCUMENT_ID,
      id: DOCUMENT_ID,
      label: "Alpha",
      notebookId: NOTEBOOK_ID,
    },
    {
      documentId: DOCUMENT_ID,
      id: BLOCK_ID,
      label: "Knowledge",
      notebookId: NOTEBOOK_ID,
    },
  ],
};

const DOCUMENT_RESPONSES = new Map<string, unknown>([
  [
    DOCUMENT_SEARCH_PATH,
    {
      blocks: SEARCH_RESPONSE.blocks,
      matchedBlockCount: 1,
      pageCount: 1,
    },
  ],
  [
    DOCUMENT_OUTLINE_PATH,
    [{ children: [], id: BLOCK_ID, name: "Alpha outline" }],
  ],
  [
    DOCUMENT_BACKLINKS_PATH,
    {
      backlinks: [
        {
          documentId: DOCUMENT_ID,
          notebookId: NOTEBOOK_ID,
          title: "Alpha",
        },
      ],
      backmentions: [],
    },
  ],
  [
    DOCUMENT_HISTORY_PATH,
    {
      histories: ["2026-07-19 15:00:00"],
      pageCount: 1,
      totalCount: 1,
    },
  ],
  [
    DOCUMENT_GRAPH_PATH,
    {
      links: [{ from: BLOCK_ID, to: "tag:knowledge/tag" }],
      nodes: [
        {
          documentId: DOCUMENT_ID,
          id: BLOCK_ID,
          label: "Knowledge",
          notebookId: NOTEBOOK_ID,
        },
        {
          documentId: null,
          id: "tag:knowledge/tag",
          label: "knowledge/tag",
          notebookId: null,
        },
      ],
    },
  ],
]);

interface AuthenticatedSpace {
  readonly cookie: string;
  readonly csrfToken: string;
  readonly organizationId: string;
  readonly spaceId: string;
  readonly userId: string;
}

function kernelResponse(request: TestKernelRequest): TestKernelResponse {
  if (request.path === SEARCH_PATH) {
    const { query } = JSON.parse(request.body.toString("utf8")) as {
      readonly query: string;
    };
    if (query === INVALID_SCHEMA_QUERY) {
      return {
        body: JSON.stringify({ ...SEARCH_RESPONSE, internalPath: "/data" }),
        headers: { "content-type": "application/json" },
        status: 200,
      };
    }
    if (query === INVALID_CONTENT_TYPE_QUERY) {
      return {
        body: JSON.stringify(SEARCH_RESPONSE),
        headers: { "content-type": "text/plain" },
        status: 200,
      };
    }
    if (query === OVERSIZED_RESPONSE_QUERY) {
      return {
        body: JSON.stringify({
          ...SEARCH_RESPONSE,
          internalPayload: "x".repeat(MAX_DISCOVERY_RESPONSE_BYTES),
        }),
        headers: { "content-type": "application/json" },
        status: 200,
      };
    }
    if (query === FAILED_STATUS_QUERY) {
      return {
        body: JSON.stringify({ error: "unavailable" }),
        headers: { "content-type": "application/json" },
        status: 500,
      };
    }
    return {
      body: JSON.stringify(SEARCH_RESPONSE),
      headers: { "content-type": "application/json" },
      status: 200,
    };
  }
  if (request.path === GRAPH_PATH) {
    return {
      body: JSON.stringify(GRAPH_RESPONSE),
      headers: { "content-type": "application/json" },
      status: 200,
    };
  }
  const documentResponse = DOCUMENT_RESPONSES.get(request.path);
  if (documentResponse !== undefined) {
    return {
      body: JSON.stringify({ code: 0, data: documentResponse, msg: "" }),
      headers: { "content-type": "application/json" },
      status: 200,
    };
  }
  return { status: 404 };
}

function secondKernelResponse(request: TestKernelRequest): TestKernelResponse {
  if (request.path === SEARCH_PATH) {
    return {
      body: JSON.stringify(SECOND_SEARCH_RESPONSE),
      headers: { "content-type": "application/json" },
      status: 200,
    };
  }
  return { status: 404 };
}

function cookiePair(response: Response): string {
  const pair = response.headers.get("set-cookie")?.split(";", 1)[0];
  if (!pair?.startsWith(`${AUTH_SESSION_COOKIE_NAME}=`)) {
    throw new Error("Space discovery login did not set a session cookie");
  }
  return pair;
}

describe("space discovery HTTP and trusted Kernel contracts", () => {
  let database: DatabaseClient;
  let kernel: TestKernelGateway;
  let passwordDigest: string;
  let secondKernel: TestKernelGateway;
  let testApi: TestApiApplication;

  beforeAll(async () => {
    kernel = await startTestKernelGateway({
      deploymentHandle: "test-discovery-first-space",
      handler: kernelResponse,
    });
    try {
      secondKernel = await startTestKernelGateway({
        deploymentHandle: "test-discovery-second-space",
        handler: secondKernelResponse,
      });
      try {
        testApi = await startTestApiApplication({
          kernelGateway: (() => {
            const configuration = testKernelGatewayConfiguration();
            configuration.deployments.register(
              kernel.configuration.deployments.resolve(kernel.deployment),
            );
            configuration.deployments.register(
              secondKernel.configuration.deployments.resolve(
                secondKernel.deployment,
              ),
            );
            return configuration;
          })(),
        });
        database = testApi.app.get(DatabaseRuntime).client;
        passwordDigest = await testApi.app
          .get(PasswordHasher)
          .hashPassword(PASSWORD);
      } catch (error) {
        await secondKernel.dispose();
        throw error;
      }
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
      await Promise.all([kernel.dispose(), secondKernel.dispose()]);
    }
  });

  async function createAuthenticatedSpace(): Promise<AuthenticatedSpace> {
    const userId = randomUUID();
    const organizationId = randomUUID();
    const loginIdentifier = `discovery-${randomUUID()}@example.test`;
    await database.user.create({
      data: {
        id: userId,
        loginIdentifier,
        passwordDigest,
        status: "active",
      },
    });
    await database.organization.create({
      data: { id: organizationId, name: "Discovery", status: "active" },
    });
    await database.organizationMembership.create({
      data: {
        organizationId,
        role: "member",
        status: "active",
        userId,
      },
    });
    await database.space.create({
      data: {
        id: kernel.deployment.spaceId,
        name: "Discovery Space",
        organizationId,
        status: "active",
      },
    });
    await database.spaceMembership.create({
      data: {
        organizationId,
        role: "viewer",
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
      body: JSON.stringify({ loginIdentifier, password: PASSWORD }),
      headers: {
        "Content-Type": "application/json",
        Origin: TEST_PUBLIC_ORIGIN,
      },
      method: "POST",
    });
    expect(login.status).toBe(200);
    const { csrfToken } = loginResponseSchema.parse(await login.json());
    return {
      cookie: cookiePair(login),
      csrfToken,
      organizationId,
      spaceId: kernel.deployment.spaceId,
      userId,
    };
  }

  function discoveryHeaders(
    authenticated: AuthenticatedSpace,
  ): Record<string, string> {
    return {
      [CSRF_HEADER_NAME]: authenticated.csrfToken,
      "Content-Type": "application/json",
      Cookie: authenticated.cookie,
      Origin: TEST_PUBLIC_ORIGIN,
    };
  }

  function expectServiceIdentityRequest(
    request: TestKernelRequest,
    path: string,
  ): void {
    expect(request).toMatchObject({
      authorized: true,
      method: "POST",
      path,
    });
    expect(request.headers["x-singularity-service-token"]).toEqual(
      expect.any(String),
    );
    expect(request.headers["x-singularity-notebook-id"]).toBeUndefined();
    expect(request.headers["x-singularity-document-id"]).toBeUndefined();
  }

  function expectDocumentIdentityRequest(
    request: TestKernelRequest,
    path: string,
  ): void {
    expect(request).toMatchObject({
      authorized: true,
      method: "POST",
      path,
    });
    expect(request.headers["x-singularity-service-token"]).toEqual(
      expect.any(String),
    );
    expect(request.headers["x-singularity-notebook-id"]).toBe(NOTEBOOK_ID);
    expect(request.headers["x-singularity-document-id"]).toBe(DOCUMENT_ID);
  }

  function requestDocumentDiscovery(
    authenticated: AuthenticatedSpace,
    path: string,
    body: unknown,
  ): Promise<Response> {
    const gatewayPath =
      `/api/v1/organizations/${authenticated.organizationId}` +
      `/spaces/${authenticated.spaceId}/kernel/api${path}`;
    return fetch(`${testApi.baseUrl}${gatewayPath}`, {
      body: JSON.stringify(body),
      headers: {
        ...discoveryHeaders(authenticated),
        "X-Singularity-Document-Id": DOCUMENT_ID,
        "X-Singularity-Notebook-Id": NOTEBOOK_ID,
      },
      method: "POST",
    });
  }

  test("searches one authorized space through the service-identity Kernel route", async () => {
    const authenticated = await createAuthenticatedSpace();
    const requestOffset = kernel.requests.length;
    const body = { method: "preferred", query: "Alpha" } as const;
    const response = await fetch(
      `${testApi.baseUrl}${buildSpaceDiscoverySearchPath(authenticated)}`,
      {
        body: JSON.stringify(body),
        headers: discoveryHeaders(authenticated),
        method: "POST",
      },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(spaceDiscoverySearchResponseSchema.parse(await response.json()))
      .toEqual(SEARCH_RESPONSE);
    const requests = kernel.requests.slice(requestOffset);
    expect(requests).toHaveLength(1);
    expectServiceIdentityRequest(requests[0]!, SEARCH_PATH);
    expect(JSON.parse(requests[0]!.body.toString("utf8"))).toEqual(body);
  });

  test("rejects content identity in a public space query before Kernel", async () => {
    const authenticated = await createAuthenticatedSpace();
    const requestOffset = kernel.requests.length;
    const response = await fetch(
      `${testApi.baseUrl}${buildSpaceDiscoverySearchPath(authenticated)}`,
      {
        body: JSON.stringify({
          documentId: DOCUMENT_ID,
          method: "keyword",
          notebookId: NOTEBOOK_ID,
          query: "Alpha",
        }),
        headers: discoveryHeaders(authenticated),
        method: "POST",
      },
    );

    expect(response.status).toBe(400);
    expect(kernel.requests).toHaveLength(requestOffset);
  });

  test.each([
    { query: INVALID_SCHEMA_QUERY, source: "schema" },
    { query: INVALID_CONTENT_TYPE_QUERY, source: "content type" },
    { query: OVERSIZED_RESPONSE_QUERY, source: "size" },
    { query: FAILED_STATUS_QUERY, source: "status" },
  ])(
    "maps an invalid Kernel response $source to service unavailable",
    async ({ query }) => {
      const authenticated = await createAuthenticatedSpace();
      const requestOffset = kernel.requests.length;
      const response = await fetch(
        `${testApi.baseUrl}${buildSpaceDiscoverySearchPath(authenticated)}`,
        {
          body: JSON.stringify({ method: "keyword", query }),
          headers: discoveryHeaders(authenticated),
          method: "POST",
        },
      );

      expect(response.status).toBe(503);
      expect(apiProblemSchema.parse(await response.json()).code).toBe(
        "service-unavailable",
      );
      expect(kernel.requests.slice(requestOffset)).toHaveLength(1);
    },
  );

  test("routes the same discovery query only to the Kernel owned by each space", async () => {
    const first = await createAuthenticatedSpace();
    await database.space.create({
      data: {
        id: secondKernel.deployment.spaceId,
        name: "Second Discovery Space",
        organizationId: first.organizationId,
        status: "active",
      },
    });
    await database.spaceMembership.create({
      data: {
        organizationId: first.organizationId,
        role: "viewer",
        spaceId: secondKernel.deployment.spaceId,
        status: "active",
        userId: first.userId,
      },
    });
    await database.kernelInstance.create({
      data: {
        deploymentHandle: secondKernel.deployment.handle,
        id: secondKernel.deployment.kernelInstanceId,
        spaceId: secondKernel.deployment.spaceId,
        status: "ready",
        version: "3.7.2",
      },
    });
    const second = { ...first, spaceId: secondKernel.deployment.spaceId };
    const firstRequestOffset = kernel.requests.length;
    const secondRequestOffset = secondKernel.requests.length;
    const body = { method: "keyword", query: "same-query" } as const;

    const [firstResponse, secondResponse] = await Promise.all([
      fetch(`${testApi.baseUrl}${buildSpaceDiscoverySearchPath(first)}`, {
        body: JSON.stringify(body),
        headers: discoveryHeaders(first),
        method: "POST",
      }),
      fetch(`${testApi.baseUrl}${buildSpaceDiscoverySearchPath(second)}`, {
        body: JSON.stringify(body),
        headers: discoveryHeaders(second),
        method: "POST",
      }),
    ]);

    expect(firstResponse.status).toBe(200);
    expect(secondResponse.status).toBe(200);
    expect(spaceDiscoverySearchResponseSchema.parse(await firstResponse.json()))
      .toEqual(SEARCH_RESPONSE);
    expect(spaceDiscoverySearchResponseSchema.parse(await secondResponse.json()))
      .toEqual(SECOND_SEARCH_RESPONSE);
    const firstRequests = kernel.requests.slice(firstRequestOffset);
    const secondRequests = secondKernel.requests.slice(secondRequestOffset);
    expect(firstRequests).toHaveLength(1);
    expect(secondRequests).toHaveLength(1);
    expectServiceIdentityRequest(firstRequests[0]!, SEARCH_PATH);
    expectServiceIdentityRequest(secondRequests[0]!, SEARCH_PATH);
    expect(JSON.parse(firstRequests[0]!.body.toString("utf8"))).toEqual(body);
    expect(JSON.parse(secondRequests[0]!.body.toString("utf8"))).toEqual(body);
  });

  test("reads an authorized space graph with explicit navigation identities", async () => {
    const authenticated = await createAuthenticatedSpace();
    const requestOffset = kernel.requests.length;
    const body = { query: "Alpha" };
    const response = await fetch(
      `${testApi.baseUrl}${buildSpaceDiscoveryGraphPath(authenticated)}`,
      {
        body: JSON.stringify(body),
        headers: discoveryHeaders(authenticated),
        method: "POST",
      },
    );

    expect(response.status).toBe(200);
    expect(spaceDiscoveryGraphResponseSchema.parse(await response.json()))
      .toEqual(GRAPH_RESPONSE);
    const requests = kernel.requests.slice(requestOffset);
    expect(requests).toHaveLength(1);
    expectServiceIdentityRequest(requests[0]!, GRAPH_PATH);
    expect(JSON.parse(requests[0]!.body.toString("utf8"))).toEqual(body);
  });

  test.each([
    {
      body: { query: "Alpha" },
      path: DOCUMENT_SEARCH_PATH,
    },
    {
      body: { id: DOCUMENT_ID, preview: false },
      path: DOCUMENT_OUTLINE_PATH,
    },
    {
      body: { id: DOCUMENT_ID, k: "", mSort: "3", mk: "", sort: "3" },
      path: DOCUMENT_BACKLINKS_PATH,
    },
    {
      body: { op: "all", page: 1, query: DOCUMENT_ID, type: 3 },
      path: DOCUMENT_HISTORY_PATH,
    },
    {
      body: {
        conf: {
          d3: {},
          dailyNote: false,
          type: { paragraph: true, tag: true },
        },
        id: DOCUMENT_ID,
        k: "Alpha",
        type: "local",
      },
      path: DOCUMENT_GRAPH_PATH,
    },
  ])(
    "proxies document discovery read route $path with explicit content identity",
    async ({ body, path }) => {
      const authenticated = await createAuthenticatedSpace();
      const requestOffset = kernel.requests.length;
      const response = await requestDocumentDiscovery(
        authenticated,
        path,
        body,
      );

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        code: 0,
        data: DOCUMENT_RESPONSES.get(path),
        msg: "",
      });
      const requests = kernel.requests.slice(requestOffset);
      expect(requests).toHaveLength(1);
      expectDocumentIdentityRequest(requests[0]!, path);
      expect(JSON.parse(requests[0]!.body.toString("utf8"))).toEqual(body);
    },
  );

  test("rejects a document discovery route before Kernel when content identity is incomplete", async () => {
    const authenticated = await createAuthenticatedSpace();
    const requestOffset = kernel.requests.length;
    const gatewayPath =
      `/api/v1/organizations/${authenticated.organizationId}` +
      `/spaces/${authenticated.spaceId}/kernel/api${DOCUMENT_SEARCH_PATH}`;
    const response = await fetch(`${testApi.baseUrl}${gatewayPath}`, {
      body: JSON.stringify({ query: "Alpha" }),
      headers: {
        ...discoveryHeaders(authenticated),
        "X-Singularity-Notebook-Id": NOTEBOOK_ID,
      },
      method: "POST",
    });

    expect(response.status).toBe(400);
    expect(kernel.requests).toHaveLength(requestOffset);
  });

  test("rejects lost space access before any discovery request reaches Kernel", async () => {
    const authenticated = await createAuthenticatedSpace();
    await database.spaceMembership.delete({
      where: {
        spaceId_userId: {
          spaceId: authenticated.spaceId,
          userId: authenticated.userId,
        },
      },
    });
    const requestOffset = kernel.requests.length;
    const response = await fetch(
      `${testApi.baseUrl}${buildSpaceDiscoverySearchPath(authenticated)}`,
      {
        body: JSON.stringify({ method: "keyword", query: "Alpha" }),
        headers: discoveryHeaders(authenticated),
        method: "POST",
      },
    );

    expect(response.status).toBe(404);
    expect(apiProblemSchema.parse(await response.json()).code).toBe(
      "not-found",
    );
    expect(kernel.requests).toHaveLength(requestOffset);
  });
});
