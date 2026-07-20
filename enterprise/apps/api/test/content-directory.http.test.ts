import { randomUUID } from "node:crypto";

import {
  AUTH_LOGIN_PATH,
  AUTH_SESSION_COOKIE_NAME,
  RUNTIME_ACCESS_LOST_HEADER_NAME,
  RUNTIME_ACCESS_LOST_HEADER_VALUE,
  apiProblemSchema,
  buildContentDirectoryChildDocumentsPath,
  buildContentDirectoryNotebooksPath,
  buildContentDirectoryRootDocumentsPath,
  contentDirectoryDocumentsResponseSchema,
  contentDirectoryNotebooksResponseSchema,
  loginResponseSchema,
} from "@singularity/contracts";
import { DatabaseRuntime, type DatabaseClient } from "@singularity/database";
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

const PASSWORD = "correct horse battery staple";
const NOTEBOOK_ID = "20260718010101-dirbook";
const PARENT_DOCUMENT_ID = "20260718010102-dirpare";
const CHILD_DOCUMENT_ID = "20260718010103-dirchil";
const OTHER_NOTEBOOK_ID = "20260718010104-dirothr";
const NON_JSON_NOTEBOOK_ID = "20260718010105-dirtext";
const INVALID_SCHEMA_NOTEBOOK_ID = "20260718010106-dirbad1";
const NON_FORWARD_NOTEBOOK_ID = "20260718010107-dirnext";
const OVERSIZED_NOTEBOOK_ID = "20260718010108-dirsize";
const UPSTREAM_AUTH_NOTEBOOK_ID = "20260718010109-dirauth";
const MALFORMED_JSON_NOTEBOOK_ID = "20260718010110-dirmalf";
const INTERNAL_NOTEBOOKS_PATH = "/internal/enterprise/directory/notebooks";
const INTERNAL_DOCUMENTS_PATH = "/internal/enterprise/directory/documents";

interface AuthenticatedGraph {
  readonly cookie: string;
  readonly organizationId: string;
  readonly spaceId: string;
}

function jsonResponse(body: unknown, status = 200): TestKernelResponse {
  return {
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
    status,
  };
}

function directoryKernelResponse(request: TestKernelRequest): TestKernelResponse {
  const target = new URL(request.path, "https://kernel.test");
  if (target.pathname === INTERNAL_NOTEBOOKS_PATH) {
    return jsonResponse({
      notebooks: [
        {
          icon: "",
          locked: false,
          name: "Engineering",
          notebookId: NOTEBOOK_ID,
          supportsGraph: true,
        },
        {
          icon: "",
          locked: true,
          name: "Vault",
          notebookId: OTHER_NOTEBOOK_ID,
          supportsGraph: false,
        },
      ],
    });
  }
  if (target.pathname !== INTERNAL_DOCUMENTS_PATH) {
    return { status: 404 };
  }

  const notebookId = target.searchParams.get("notebookId");
  if (notebookId === NON_JSON_NOTEBOOK_ID) {
    return {
      body: "not-json",
      headers: { "content-type": "text/plain" },
      status: 200,
    };
  }
  if (notebookId === MALFORMED_JSON_NOTEBOOK_ID) {
    return {
      body: "directory-secret-sentinel",
      headers: { "content-type": "application/json" },
      status: 200,
    };
  }
  if (notebookId === INVALID_SCHEMA_NOTEBOOK_ID) {
    return jsonResponse({
      documents: [{
        documentId: CHILD_DOCUMENT_ID,
        hasChildren: false,
        icon: "",
        notebookId: OTHER_NOTEBOOK_ID,
        title: "Wrong notebook",
      }],
      locked: false,
      nextOffset: null,
    });
  }
  if (notebookId === NON_FORWARD_NOTEBOOK_ID) {
    return jsonResponse({ documents: [], locked: false, nextOffset: 0 });
  }
  if (notebookId === OVERSIZED_NOTEBOOK_ID) {
    return jsonResponse({
      documents: [],
      locked: false,
      nextOffset: null,
      padding: "x".repeat(1_024 * 1_024),
    });
  }
  if (notebookId === UPSTREAM_AUTH_NOTEBOOK_ID) {
    return { status: 401 };
  }
  if (notebookId !== NOTEBOOK_ID) {
    return { status: 404 };
  }

  const parentDocumentId = target.searchParams.get("parentDocumentId");
  return parentDocumentId === null
    ? jsonResponse({
        documents: [{
          documentId: PARENT_DOCUMENT_ID,
          hasChildren: true,
          icon: "",
          notebookId: NOTEBOOK_ID,
          title: "Parent",
        }],
        locked: false,
        nextOffset: null,
      })
    : jsonResponse({
        documents: [{
          documentId: CHILD_DOCUMENT_ID,
          hasChildren: false,
          icon: "",
          notebookId: NOTEBOOK_ID,
          title: "Child",
        }],
        locked: false,
        nextOffset: null,
      });
}

function cookiePair(response: Response): string {
  const pair = response.headers.get("set-cookie")?.split(";", 1)[0];
  if (!pair?.startsWith(`${AUTH_SESSION_COOKIE_NAME}=`)) {
    throw new Error("Content directory test login did not set a session cookie");
  }
  return pair;
}

describe("Content directory HTTP contract", () => {
  let database: DatabaseClient;
  let kernel: TestKernelGateway;
  let logger: CapturingLogger;
  let passwordDigest: string;
  let testApi: TestApiApplication;

  beforeAll(async () => {
    logger = new CapturingLogger();
    kernel = await startTestKernelGateway({ handler: directoryKernelResponse });
    try {
      testApi = await startTestApiApplication({
        kernelGateway: kernel.configuration,
        logger,
      });
      database = testApi.app.get(DatabaseRuntime).client;
      passwordDigest = await testApi.app
        .get(PasswordHasher)
        .hashPassword(PASSWORD);
    } catch (error) {
      await kernel.dispose();
      throw error;
    }
  });

  afterEach(async () => {
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
    includeSpaceMembership = true,
  ): Promise<AuthenticatedGraph> {
    const userId = randomUUID();
    const organizationId = randomUUID();
    const loginIdentifier = `directory-${randomUUID()}@example.test`;
    await database.user.create({
      data: {
        id: userId,
        loginIdentifier,
        passwordDigest,
        status: "active",
      },
    });
    await database.organization.create({
      data: { id: organizationId, name: "Directory", status: "active" },
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
        name: "Directory Space",
        organizationId,
        status: "active",
      },
    });
    if (includeSpaceMembership) {
      await database.spaceMembership.create({
        data: {
          organizationId,
          role: "viewer",
          spaceId: kernel.deployment.spaceId,
          status: "active",
          userId,
        },
      });
    }
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
    loginResponseSchema.parse(await login.json());
    return {
      cookie: cookiePair(login),
      organizationId,
      spaceId: kernel.deployment.spaceId,
    };
  }

  function requestDirectory(graph: AuthenticatedGraph, path: string): Promise<Response> {
    return fetch(`${testApi.baseUrl}${path}`, {
      headers: {
        Cookie: graph.cookie,
        Origin: TEST_PUBLIC_ORIGIN,
      },
      method: "GET",
    });
  }

  test("routes an authorized viewer through service identity and preserves the real parent chain", async () => {
    const graph = await createAuthenticatedGraph();
    const identity = {
      organizationId: graph.organizationId,
      spaceId: graph.spaceId,
    };
    const firstRequest = kernel.requests.length;

    const notebooksResponse = await requestDirectory(
      graph,
      buildContentDirectoryNotebooksPath(identity),
    );
    expect(notebooksResponse.status).toBe(200);
    expect(contentDirectoryNotebooksResponseSchema.parse(
      await notebooksResponse.json(),
    ).notebooks).toEqual([
      {
        icon: "",
        locked: false,
        name: "Engineering",
        notebookId: NOTEBOOK_ID,
        supportsGraph: true,
      },
      {
        icon: "",
        locked: true,
        name: "Vault",
        notebookId: OTHER_NOTEBOOK_ID,
        supportsGraph: false,
      },
    ]);

    const rootResponse = await requestDirectory(
      graph,
      buildContentDirectoryRootDocumentsPath({
        ...identity,
        notebookId: NOTEBOOK_ID,
        offset: 0,
      }),
    );
    expect(rootResponse.status).toBe(200);
    expect(contentDirectoryDocumentsResponseSchema.parse(
      await rootResponse.json(),
    ).documents).toEqual([
      expect.objectContaining({
        documentId: PARENT_DOCUMENT_ID,
        hasChildren: true,
        notebookId: NOTEBOOK_ID,
      }),
    ]);

    const childResponse = await requestDirectory(
      graph,
      buildContentDirectoryChildDocumentsPath({
        documentId: PARENT_DOCUMENT_ID,
        ...identity,
        notebookId: NOTEBOOK_ID,
        offset: 7,
      }),
    );
    expect(childResponse.status).toBe(200);
    expect(contentDirectoryDocumentsResponseSchema.parse(
      await childResponse.json(),
    ).documents).toEqual([
      expect.objectContaining({
        documentId: CHILD_DOCUMENT_ID,
        notebookId: NOTEBOOK_ID,
      }),
    ]);

    const requests = kernel.requests.slice(firstRequest);
    expect(requests.map(({ path }) => path)).toEqual([
      INTERNAL_NOTEBOOKS_PATH,
      `${INTERNAL_DOCUMENTS_PATH}?notebookId=${NOTEBOOK_ID}&offset=0`,
      `${INTERNAL_DOCUMENTS_PATH}?notebookId=${NOTEBOOK_ID}&offset=7&parentDocumentId=${PARENT_DOCUMENT_ID}`,
    ]);
    for (const request of requests) {
      expect(request.authorized).toBe(true);
      expect(request.headers["x-singularity-service-token"]).toEqual(
        expect.any(String),
      );
      expect(request.headers.authorization).toBeUndefined();
      expect(request.headers["x-singularity-notebook-id"]).toBeUndefined();
      expect(request.headers["x-singularity-document-id"]).toBeUndefined();
    }
  });

  test("revalidates space access before contacting the Kernel directory", async () => {
    const graph = await createAuthenticatedGraph(false);
    const requestCount = kernel.requests.length;

    const response = await requestDirectory(
      graph,
      buildContentDirectoryNotebooksPath(graph),
    );

    expect(response.status).toBe(404);
    expect(response.headers.get(RUNTIME_ACCESS_LOST_HEADER_NAME)).toBe(
      RUNTIME_ACCESS_LOST_HEADER_VALUE,
    );
    expect(apiProblemSchema.parse(await response.json()).code).toBe("not-found");
    expect(kernel.requests).toHaveLength(requestCount);
  });

  test("keeps a trusted Kernel business 404 local to the directory request", async () => {
    const graph = await createAuthenticatedGraph();
    const response = await requestDirectory(
      graph,
      buildContentDirectoryRootDocumentsPath({
        notebookId: OTHER_NOTEBOOK_ID,
        offset: 0,
        organizationId: graph.organizationId,
        spaceId: graph.spaceId,
      }),
    );

    expect(response.status).toBe(404);
    expect(response.headers.get(RUNTIME_ACCESS_LOST_HEADER_NAME)).toBeNull();
    expect(apiProblemSchema.parse(await response.json()).code).toBe("not-found");
  });

  test("records the original directory parsing stack before returning 503", async () => {
    const graph = await createAuthenticatedGraph();
    logger.clear();

    const response = await requestDirectory(
      graph,
      buildContentDirectoryRootDocumentsPath({
        notebookId: MALFORMED_JSON_NOTEBOOK_ID,
        offset: 0,
        organizationId: graph.organizationId,
        spaceId: graph.spaceId,
      }),
    );

    expect(response.status).toBe(503);
    expect(apiProblemSchema.parse(await response.json()).code).toBe(
      "service-unavailable",
    );
    expect(logger.output).toContain("directory-stack-sentinel");
    expect(logger.output).toContain("SyntaxError");
    expect(logger.output).toContain("at JSON.parse");
    expect(logger.output).toContain("at readDirectoryJson");
    expect(logger.output).not.toContain("directory-secret-sentinel");
  });

  test("rejects an out-of-range offset before contacting the Kernel directory", async () => {
    const graph = await createAuthenticatedGraph();
    const requestCount = kernel.requests.length;
    const path = buildContentDirectoryRootDocumentsPath({
      notebookId: NOTEBOOK_ID,
      offset: 1_000_001,
      organizationId: graph.organizationId,
      spaceId: graph.spaceId,
    });

    const response = await requestDirectory(graph, path);

    expect(response.status).toBe(400);
    expect(kernel.requests).toHaveLength(requestCount);
  });

  test.each([
    { name: "non-JSON", notebookId: NON_JSON_NOTEBOOK_ID },
    { name: "cross-notebook", notebookId: INVALID_SCHEMA_NOTEBOOK_ID },
    { name: "non-forward pagination", notebookId: NON_FORWARD_NOTEBOOK_ID },
    { name: "oversized", notebookId: OVERSIZED_NOTEBOOK_ID },
    { name: "upstream authentication", notebookId: UPSTREAM_AUTH_NOTEBOOK_ID },
  ])("maps a $name Kernel directory response to service unavailable", async ({ notebookId }) => {
    const graph = await createAuthenticatedGraph();
    const response = await requestDirectory(
      graph,
      buildContentDirectoryRootDocumentsPath({
        notebookId,
        offset: 0,
        organizationId: graph.organizationId,
        spaceId: graph.spaceId,
      }),
    );

    expect(response.status).toBe(503);
    expect(apiProblemSchema.parse(await response.json()).code).toBe(
      "service-unavailable",
    );
  });
});
