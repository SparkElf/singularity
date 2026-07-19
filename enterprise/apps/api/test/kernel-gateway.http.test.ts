import { randomUUID } from "node:crypto";

import {
  AUTH_LOGIN_PATH,
  AUTH_SESSION_COOKIE_NAME,
  CSRF_HEADER_NAME,
  RUNTIME_ACCESS_LOST_HEADER_NAME,
  RUNTIME_ACCESS_LOST_HEADER_VALUE,
  apiProblemSchema,
  loginResponseSchema,
} from "@singularity/contracts";
import { DatabaseRuntime, type DatabaseClient } from "@singularity/database";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";

import { PasswordHasher } from "../src/identity/password-hasher.js";
import { AccessOperationsService } from "../src/operations/access-operations.service.js";
import { truncateTestDatabase } from "./support/database.js";
import {
  startTestApiApplication,
  TEST_PUBLIC_ORIGIN,
  type TestApiApplication,
} from "./support/test-app.js";
import {
  startTestKernelGateway,
  type TestKernelGateway,
} from "./support/kernel-gateway.js";

const PASSWORD = "correct horse battery staple";
const NOTEBOOK_ID = "20260718010101-abcdefg";
const DOCUMENT_ID = "20260718010102-hijklmn";
const KERNEL_ENVELOPE_NOT_FOUND_PATH = "/api/block/getBlockDOM";
const KERNEL_ENVELOPE_VALIDATION_PATH = "/api/block/checkBlockExist";
const KERNEL_ENVELOPE_UNAVAILABLE_PATH = "/api/block/getBlockIndex";
const KERNEL_ENVELOPE_SUCCESS_PATH = "/api/block/getRefText";
const KERNEL_TRANSACTION_PATH = "/api/transactions";
const KERNEL_EXPORT_PATH = "/export/code/report.txt?download=true";

interface AuthenticatedGraph {
  readonly cookie: string;
  readonly csrfToken: string;
  readonly organizationId: string;
  readonly spaceId: string;
  readonly userId: string;
}

interface ContentAuditRow {
  action: string;
  actorUserId: string | null;
  organizationId: string;
  outcome: string;
  spaceId: string | null;
  targetId: string;
  targetType: string;
}

function cookiePair(response: Response): string {
  const setCookie = response.headers.get("set-cookie");
  const pair = setCookie?.split(";", 1)[0];
  if (!pair?.startsWith(`${AUTH_SESSION_COOKIE_NAME}=`)) {
    throw new Error("Kernel Gateway test login did not set a session cookie");
  }
  return pair;
}

describe("Kernel Gateway business responses and runtime access loss", () => {
  let database: DatabaseClient;
  let kernel: TestKernelGateway;
  let operations: AccessOperationsService;
  let passwordDigest: string;
  let testApi: TestApiApplication;

  beforeAll(async () => {
    kernel = await startTestKernelGateway({
      handler: (request) => {
        if (request.path === KERNEL_EXPORT_PATH) {
          return {
            body: "exported content",
            headers: { "content-type": "text/plain" },
            status: 200,
          };
        }
        if (request.path === KERNEL_TRANSACTION_PATH) {
          return {
            body: JSON.stringify({ code: 0, data: null, msg: "" }),
            headers: { "content-type": "application/json" },
            status: 200,
          };
        }
        const envelopeCodes = new Map<string, number>([
          [KERNEL_ENVELOPE_NOT_FOUND_PATH, 404],
          [KERNEL_ENVELOPE_VALIDATION_PATH, -1],
          [KERNEL_ENVELOPE_UNAVAILABLE_PATH, 500],
          [KERNEL_ENVELOPE_SUCCESS_PATH, 0],
        ]);
        const code = envelopeCodes.get(request.path);
        if (code !== undefined) {
          return {
            body: JSON.stringify({
              code,
              data: code === 0 ? "Block title" : null,
              msg: code === 0 ? "" : "Kernel operation failed",
            }),
            headers: { "content-type": "application/json" },
            status: 200,
          };
        }
        return {
          body: JSON.stringify({
            code: "not-found",
            requestId: randomUUID(),
            status: 404,
          }),
          headers: { "content-type": "application/json" },
          status: 404,
        };
      },
    });
    try {
      testApi = await startTestApiApplication({
        kernelGateway: kernel.configuration,
      });
      database = testApi.app.get(DatabaseRuntime).client;
      operations = testApi.app.get(AccessOperationsService);
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
    const loginIdentifier = `gateway-${randomUUID()}@example.test`;
    await database.user.create({
      data: {
        id: userId,
        loginIdentifier,
        passwordDigest,
        status: "active",
      },
    });
    await database.organization.create({
      data: { id: organizationId, name: "Gateway", status: "active" },
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
        name: "Gateway Space",
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

  function requestContent(
    graph: AuthenticatedGraph,
    kernelPath = "/api/block/getBlockInfo",
    body: unknown = { id: DOCUMENT_ID },
  ): Promise<Response> {
    const path = `/api/v1/organizations/${graph.organizationId}/spaces/${graph.spaceId}/kernel/api${kernelPath}`;
    return fetch(`${testApi.baseUrl}${path}`, {
      body: JSON.stringify(body),
      headers: {
        [CSRF_HEADER_NAME]: graph.csrfToken,
        "Content-Type": "application/json",
        Cookie: graph.cookie,
        Origin: TEST_PUBLIC_ORIGIN,
        "X-Singularity-Document-Id": DOCUMENT_ID,
        "X-Singularity-Notebook-Id": NOTEBOOK_ID,
      },
      method: "POST",
    });
  }

  function contentAuditRows(
    graph: AuthenticatedGraph,
  ): Promise<ContentAuditRow[]> {
    return database.$queryRaw<ContentAuditRow[]>`
      SELECT
        "action"::text AS "action",
        "actor_user_id" AS "actorUserId",
        "organization_id" AS "organizationId",
        "outcome"::text AS "outcome",
        "space_id" AS "spaceId",
        "target_id" AS "targetId",
        "target_type" AS "targetType"
      FROM "audit_events"
      WHERE "organization_id" = ${graph.organizationId}::uuid
        AND "target_type" = 'document'
        AND "target_id" = ${DOCUMENT_ID}
      ORDER BY "sequence"
    `;
  }

  function requestExport(
    graph: AuthenticatedGraph,
    downloadValues: readonly string[],
  ): Promise<Response> {
    const parameters = new URLSearchParams({
      documentId: DOCUMENT_ID,
      notebookId: NOTEBOOK_ID,
    });
    downloadValues.forEach((value) => parameters.append("download", value));
    const path = `/api/v1/organizations/${graph.organizationId}/spaces/${graph.spaceId}/exports/code/report.txt?${parameters.toString()}`;
    return fetch(`${testApi.baseUrl}${path}`, {
      headers: {
        Cookie: graph.cookie,
        Origin: TEST_PUBLIC_ORIGIN,
      },
      method: "GET",
    });
  }

  test("marks a hidden authorization 404 as terminal runtime access loss", async () => {
    const graph = await createAuthenticatedGraph();
    const revoked = await operations.execute({
      operation: "revoke-space-member",
      spaceId: graph.spaceId,
      userId: graph.userId,
    });
    expect(revoked.outcome).toBe("revoked");

    const response = await requestContent(graph);
    expect(response.status).toBe(404);
    expect(apiProblemSchema.parse(await response.json()).code).toBe(
      "not-found",
    );
    expect(response.headers.get(RUNTIME_ACCESS_LOST_HEADER_NAME)).toBe(
      RUNTIME_ACCESS_LOST_HEADER_VALUE,
    );
  });

  test("does not mark a trusted Kernel business 404 as access loss", async () => {
    const graph = await createAuthenticatedGraph();

    const response = await requestContent(graph);
    expect(response.status).toBe(404);
    expect(apiProblemSchema.parse(await response.json()).code).toBe(
      "not-found",
    );
    expect(response.headers.get(RUNTIME_ACCESS_LOST_HEADER_NAME)).toBeNull();
  });

  test("maps a Kernel envelope 404 without marking runtime access loss", async () => {
    const graph = await createAuthenticatedGraph();

    const response = await requestContent(
      graph,
      KERNEL_ENVELOPE_NOT_FOUND_PATH,
    );
    expect(response.status).toBe(404);
    expect(apiProblemSchema.parse(await response.json()).code).toBe(
      "not-found",
    );
    expect(response.headers.get(RUNTIME_ACCESS_LOST_HEADER_NAME)).toBeNull();
  });

  test("maps a legacy Kernel envelope failure to validation failed", async () => {
    const graph = await createAuthenticatedGraph();

    const response = await requestContent(
      graph,
      KERNEL_ENVELOPE_VALIDATION_PATH,
    );
    expect(response.status).toBe(422);
    expect(apiProblemSchema.parse(await response.json()).code).toBe(
      "validation-failed",
    );
  });

  test("maps a Kernel envelope service failure to upstream unavailable", async () => {
    const graph = await createAuthenticatedGraph();

    const response = await requestContent(
      graph,
      KERNEL_ENVELOPE_UNAVAILABLE_PATH,
    );
    expect(response.status).toBe(502);
    expect(apiProblemSchema.parse(await response.json()).code).toBe(
      "service-unavailable",
    );
  });

  test("preserves a successful Kernel envelope", async () => {
    const graph = await createAuthenticatedGraph();

    const response = await requestContent(
      graph,
      KERNEL_ENVELOPE_SUCCESS_PATH,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      code: 0,
      data: "Block title",
      msg: "",
    });
  });

  test.each([
    { expectedAction: "content.edit", operationAction: "update" },
    { expectedAction: "content.delete", operationAction: "delete" },
  ])(
    "records $expectedAction only after a successful Kernel transaction",
    async ({ expectedAction, operationAction }) => {
      const graph = await createAuthenticatedGraph();

      const response = await requestContent(graph, KERNEL_TRANSACTION_PATH, {
        reqId: Date.now(),
        transactions: [
          {
            doOperations: [{ action: operationAction, id: DOCUMENT_ID }],
            notebook: NOTEBOOK_ID,
            undoOperations: [],
          },
        ],
      });

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ code: 0, data: null, msg: "" });
      await expect(contentAuditRows(graph)).resolves.toEqual([
        {
          action: expectedAction,
          actorUserId: graph.userId,
          organizationId: graph.organizationId,
          outcome: "succeeded",
          spaceId: graph.spaceId,
          targetId: DOCUMENT_ID,
          targetType: "document",
        },
      ]);
    },
  );

  test("proxies an explicitly identified export and records its document audit", async () => {
    const graph = await createAuthenticatedGraph();
    const requestCount = kernel.requests.length;

    const response = await requestExport(graph, ["true"]);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-disposition")).toBe(
      'attachment; filename="report.txt"',
    );
    expect(response.headers.get("content-type")).toBe("application/octet-stream");
    expect(await response.text()).toBe("exported content");
    expect(kernel.requests).toHaveLength(requestCount + 1);
    expect(kernel.requests.at(-1)?.path).toBe(KERNEL_EXPORT_PATH);
    await expect(contentAuditRows(graph)).resolves.toEqual([
      {
        action: "content.export",
        actorUserId: graph.userId,
        organizationId: graph.organizationId,
        outcome: "succeeded",
        spaceId: graph.spaceId,
        targetId: DOCUMENT_ID,
        targetType: "document",
      },
    ]);
  });

  test.each([
    { downloadValues: [], name: "missing" },
    { downloadValues: ["false"], name: "not true" },
    { downloadValues: ["true", "true"], name: "repeated" },
  ])("rejects a $name export download parameter", async ({ downloadValues }) => {
    const graph = await createAuthenticatedGraph();
    const requestCount = kernel.requests.length;

    const response = await requestExport(graph, downloadValues);

    expect(response.status).toBe(400);
    expect(kernel.requests).toHaveLength(requestCount);
  });
});
