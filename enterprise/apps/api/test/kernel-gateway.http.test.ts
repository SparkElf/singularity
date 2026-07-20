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
import {
  DatabaseRuntime,
  Prisma,
  type DatabaseClient,
} from "@singularity/database";
import {
  KERNEL_DEPLOYMENT_CHANGED_CHANNEL,
  RuntimeKernelDeploymentRegistry,
  type KernelDeploymentChangedEvent,
} from "@singularity/kernel-client";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
  vi,
} from "vitest";

import { PasswordHasher } from "../src/identity/password-hasher.js";
import { AccessOperationsService } from "../src/operations/access-operations.service.js";
import { CapturingLogger } from "./support/capturing-logger.js";
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
const KERNEL_TRANSACTION_AUTHENTICATION_FAILURE_MARKER =
  "authentication-failure";
const KERNEL_TRANSACTION_BUSINESS_FAILURE_MARKER = "business-failure";
const KERNEL_TRANSACTION_HTTP_FAILURE_MARKER = "http-failure";
const KERNEL_TRANSACTION_MALFORMED_MARKER = "malformed-response";
const KERNEL_TRANSACTION_ENVELOPE_FAILURE_MARKER = "envelope-failure";
const KERNEL_EXPORT_PATH = "/export/code/report.txt?download=true";
const KERNEL_IMAGE_ASSET_PATH = `/assets/inline.png?box=${NOTEBOOK_ID}`;
const KERNEL_IMAGE_DOWNLOAD_PATH =
  `/assets/inline.png?box=${NOTEBOOK_ID}&download=true`;
const KERNEL_HTML_ASSET_PATH = `/assets/active.html?box=${NOTEBOOK_ID}`;
const KERNEL_PDF_ASSET_PATH = `/assets/document.pdf?box=${NOTEBOOK_ID}`;

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
  documentId: string;
  organizationId: string;
  outcome: string | null;
  spaceId: string | null;
}

function cookiePair(response: Response): string {
  const setCookie = response.headers.get("set-cookie");
  const pair = setCookie?.split(";", 1)[0];
  if (!pair?.startsWith(`${AUTH_SESSION_COOKIE_NAME}=`)) {
    throw new Error("Kernel Gateway test login did not set a session cookie");
  }
  return pair;
}

function expectLoggedContentAuditStack(
  output: string,
  event: "content.audit-intent" | "content.audit-resolution",
): void {
  const eventOffset = output.indexOf(`event: '${event}'`);
  expect(eventOffset).toBeGreaterThanOrEqual(0);
  const errorOffset = output.lastIndexOf("error:", eventOffset);
  expect(errorOffset).toBeGreaterThanOrEqual(0);
  const error = output.slice(errorOffset, eventOffset);
  expect(error).toContain("content audit test failure");
  expect(error).toMatch(/\n\s+at /);
}

describe("Kernel Gateway business responses and runtime access loss", () => {
  let database: DatabaseClient;
  let deployments: RuntimeKernelDeploymentRegistry;
  let kernel: TestKernelGateway;
  let logger: CapturingLogger;
  let operations: AccessOperationsService;
  let passwordDigest: string;
  let runtimeKernel: TestKernelGateway;
  let secondKernel: TestKernelGateway;
  let testApi: TestApiApplication;

  beforeAll(async () => {
    logger = new CapturingLogger();
    kernel = await startTestKernelGateway({
      handler: (request) => {
        if (request.path === KERNEL_IMAGE_ASSET_PATH) {
          return {
            body: Buffer.from("png-bytes"),
            headers: { "content-type": "image/png" },
            status: 200,
          };
        }
        if (request.path === KERNEL_IMAGE_DOWNLOAD_PATH) {
          return {
            body: Buffer.from("png-bytes"),
            headers: { "content-type": "image/png" },
            status: 200,
          };
        }
        if (request.path === KERNEL_HTML_ASSET_PATH) {
          return {
            body: "<script>document.body.textContent = 'active'</script>",
            headers: { "content-type": "text/html" },
            status: 200,
          };
        }
        if (request.path === KERNEL_PDF_ASSET_PATH) {
          return {
            body: Buffer.from("pdf-bytes"),
            headers: { "content-type": "application/pdf" },
            status: 200,
          };
        }
        if (request.path === KERNEL_EXPORT_PATH) {
          return {
            body: "exported content",
            headers: { "content-type": "text/plain" },
            status: 200,
          };
        }
        if (request.path === KERNEL_TRANSACTION_PATH) {
          const requestText = request.body.toString("utf8");
          if (
            requestText.includes(
              KERNEL_TRANSACTION_AUTHENTICATION_FAILURE_MARKER,
            )
          ) {
            return {
              body: "upstream authentication failure",
              headers: { "content-type": "application/json" },
              status: 403,
            };
          }
          if (requestText.includes(KERNEL_TRANSACTION_HTTP_FAILURE_MARKER)) {
            return {
              body: "upstream failure",
              headers: { "content-type": "application/json" },
              status: 500,
            };
          }
          if (requestText.includes(KERNEL_TRANSACTION_MALFORMED_MARKER)) {
            return {
              body: "not-json",
              headers: { "content-type": "application/json" },
              status: 200,
            };
          }
          return {
            body: JSON.stringify({
              code: requestText.includes(KERNEL_TRANSACTION_ENVELOPE_FAILURE_MARKER)
                ? 500
                : requestText.includes(KERNEL_TRANSACTION_BUSINESS_FAILURE_MARKER)
                  ? -1
                : 0,
              data: null,
              msg: "",
            }),
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
      secondKernel = await startTestKernelGateway({
        deploymentHandle: "test-kernel-second-space",
        handler: (request) =>
          request.path === KERNEL_IMAGE_ASSET_PATH
            ? {
                body: "second-space-asset",
                headers: { "content-type": "image/png" },
                status: 200,
              }
            : { status: 404 },
      });
      try {
        runtimeKernel = await startTestKernelGateway({
          deploymentHandle: "test-runtime-kernel",
          handler: (request) =>
            request.path === KERNEL_IMAGE_ASSET_PATH
              ? {
                  body: "runtime-space-asset",
                  headers: { "content-type": "image/png" },
                  status: 200,
                }
              : { status: 404 },
        });
        try {
          const configuration = {
            credentials: kernel.configuration.credentials,
            deployments: new RuntimeKernelDeploymentRegistry([
              kernel.configuration.deployments.resolve(kernel.deployment),
              secondKernel.configuration.deployments.resolve(
                secondKernel.deployment,
              ),
            ]),
            runtimeDeployment: kernel.configuration.runtimeDeployment,
          };
          deployments = configuration.deployments;
          testApi = await startTestApiApplication({
            kernelGateway: configuration,
            logger,
          });
          database = testApi.app.get(DatabaseRuntime).client;
          operations = testApi.app.get(AccessOperationsService);
          passwordDigest = await testApi.app
            .get(PasswordHasher)
            .hashPassword(PASSWORD);
        } catch (error) {
          await runtimeKernel.dispose();
          throw error;
        }
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
    logger.clear();
  });

  afterAll(async () => {
    try {
      await testApi.dispose();
    } finally {
      await Promise.all([
        kernel.dispose(),
        runtimeKernel.dispose(),
        secondKernel.dispose(),
      ]);
    }
  });

  async function createAuthenticatedGraph(
    targetKernel: TestKernelGateway = kernel,
  ): Promise<AuthenticatedGraph> {
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
        id: targetKernel.deployment.spaceId,
        name: "Gateway Space",
        organizationId,
        status: "active",
      },
    });
    await database.spaceMembership.create({
      data: {
        organizationId,
        role: "admin",
        spaceId: targetKernel.deployment.spaceId,
        status: "active",
        userId,
      },
    });
    await database.kernelInstance.create({
      data: {
        deploymentHandle: targetKernel.deployment.handle,
        id: targetKernel.deployment.kernelInstanceId,
        spaceId: targetKernel.deployment.spaceId,
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
      spaceId: targetKernel.deployment.spaceId,
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
        "document_id" AS "documentId",
        "organization_id" AS "organizationId",
        "observed_outcome"::text AS "outcome",
        "space_id" AS "spaceId"
      FROM "content_audit_intents"
      WHERE "organization_id" = ${graph.organizationId}::uuid
        AND "document_id" = ${DOCUMENT_ID}
      ORDER BY "occurred_at", "request_id"
    `;
  }

  async function installContentAuditFailureTrigger(
    event: "insert" | "update",
  ): Promise<() => Promise<void>> {
    const functionName = "singularity_test_fail_content_audit_intent";
    const triggerName = `singularity_test_fail_content_audit_intent_${event}`;
    await database.$executeRaw(Prisma.sql`
      CREATE OR REPLACE FUNCTION ${Prisma.raw(functionName)}()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $function$
      BEGIN
        RAISE EXCEPTION 'content audit test failure';
      END;
      $function$
    `);
    await database.$executeRaw(Prisma.sql`
      CREATE TRIGGER ${Prisma.raw(triggerName)}
      BEFORE ${Prisma.raw(event === "insert" ? "INSERT" : "UPDATE")}
      ON "content_audit_intents"
      FOR EACH ROW
      EXECUTE FUNCTION ${Prisma.raw(functionName)}()
    `);
    return async () => {
      await database.$executeRaw(Prisma.sql`
        DROP TRIGGER IF EXISTS ${Prisma.raw(triggerName)}
        ON "content_audit_intents"
      `);
      await database.$executeRaw(Prisma.sql`
        DROP FUNCTION IF EXISTS ${Prisma.raw(functionName)}()
      `);
    };
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

  function requestAsset(
    graph: AuthenticatedGraph,
    assetPath: string,
    download = false,
  ): Promise<Response> {
    const path = `/api/v1/organizations/${graph.organizationId}/spaces/${graph.spaceId}${assetPath}`;
    const parameters = new URLSearchParams({
      documentId: DOCUMENT_ID,
      notebookId: NOTEBOOK_ID,
    });
    if (download) {
      parameters.set("download", "true");
    }
    return fetch(`${testApi.baseUrl}${path}?${parameters.toString()}`, {
      headers: {
        Cookie: graph.cookie,
        Origin: TEST_PUBLIC_ORIGIN,
      },
      method: "GET",
    });
  }

  test.each([
    {
      kernelPath: KERNEL_ENVELOPE_SUCCESS_PATH,
      outcome: "proxied",
      status: 200,
    },
    {
      kernelPath: "/api/block/getBlockInfo",
      outcome: "upstream-rejected",
      status: 404,
    },
  ])(
    "correlates an authorized $outcome route with its request and Kernel instance",
    async ({ kernelPath, outcome, status }) => {
      const graph = await createAuthenticatedGraph();
      const requestOffset = kernel.requests.length;
      logger.clear();

      const response = await requestContent(graph, kernelPath);

      expect(response.status).toBe(status);
      const requestId = response.ok
        ? response.headers.get("x-request-id")
        : apiProblemSchema.parse(await response.clone().json()).requestId;
      expect(requestId).not.toBeNull();
      const upstreamRequests = kernel.requests.slice(requestOffset);
      expect(upstreamRequests).toHaveLength(1);
      expect(upstreamRequests[0]?.headers["x-singularity-request-id"]).toBe(
        requestId,
      );
      expect(logger.output).toContain(`outcome: '${outcome}'`);
      expect(logger.output).toContain(`requestId: '${String(requestId)}'`);
      expect(logger.output).toContain(
        `kernelInstanceId: '${kernel.deployment.kernelInstanceId}'`,
      );
    },
  );

  test("omits a Kernel instance before authentication establishes an authorized deployment", async () => {
    const organizationId = randomUUID();
    const parameters = new URLSearchParams({
      documentId: DOCUMENT_ID,
      notebookId: NOTEBOOK_ID,
    });
    logger.clear();

    const response = await fetch(
      `${testApi.baseUrl}/api/v1/organizations/${organizationId}/spaces/${kernel.deployment.spaceId}/assets/inline.png?${parameters.toString()}`,
      {
        headers: { Origin: TEST_PUBLIC_ORIGIN },
        method: "GET",
      },
    );

    expect(response.status).toBe(401);
    const problem = apiProblemSchema.parse(await response.json());
    expect(logger.output).toContain("outcome: 'admitted'");
    expect(logger.output).toContain(`requestId: '${problem.requestId}'`);
    expect(logger.output).not.toContain("kernelInstanceId");
  });

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

  test("does not call Kernel when intent preparation fails", async () => {
    const graph = await createAuthenticatedGraph();
    const requestCount = kernel.requests.length;
    const disposeTrigger = await installContentAuditFailureTrigger("insert");
    logger.clear();
    try {
      const response = await requestContent(graph, KERNEL_TRANSACTION_PATH);
      expect(response.status).toBe(503);
      const problem = apiProblemSchema.parse(await response.json());
      expect(problem.code).toBe("service-unavailable");
      expect(logger.output).toContain(`requestId: '${problem.requestId}'`);
      expectLoggedContentAuditStack(logger.output, "content.audit-intent");
    } finally {
      await disposeTrigger();
    }
    expect(kernel.requests).toHaveLength(requestCount);
    await expect(contentAuditRows(graph)).resolves.toEqual([]);
  });

  test("keeps a successful Kernel response when intent resolution fails", async () => {
    const graph = await createAuthenticatedGraph();
    const disposeTrigger = await installContentAuditFailureTrigger("update");
    logger.clear();
    try {
      const response = await requestContent(graph, KERNEL_TRANSACTION_PATH);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ code: 0, data: null, msg: "" });
      const requestId = response.headers.get("x-request-id");
      expect(requestId).not.toBeNull();
      expect(logger.output).toContain(
        `requestId: '${String(requestId)}'`,
      );
      expectLoggedContentAuditStack(logger.output, "content.audit-resolution");
    } finally {
      await disposeTrigger();
    }
    await expect(contentAuditRows(graph)).resolves.toEqual([
      {
        action: "content.edit",
        actorUserId: graph.userId,
        documentId: DOCUMENT_ID,
        organizationId: graph.organizationId,
        outcome: null,
        spaceId: graph.spaceId,
      },
    ]);
  });

  test("keeps a Kernel HTTP authentication rejection unknown", async () => {
    const graph = await createAuthenticatedGraph();

    const response = await requestContent(graph, KERNEL_TRANSACTION_PATH, {
      marker: KERNEL_TRANSACTION_AUTHENTICATION_FAILURE_MARKER,
    });

    expect(response.status).toBe(502);
    expect(apiProblemSchema.parse(await response.json()).code).toBe(
      "service-unavailable",
    );
    await expect(contentAuditRows(graph)).resolves.toMatchObject([
      expect.objectContaining({ outcome: null }),
    ]);
  });

  test("keeps an HTTP Kernel 5xx result unknown", async () => {
    const graph = await createAuthenticatedGraph();

    const response = await requestContent(graph, KERNEL_TRANSACTION_PATH, {
      marker: KERNEL_TRANSACTION_HTTP_FAILURE_MARKER,
    });

    expect(response.status).toBe(502);
    expect(apiProblemSchema.parse(await response.json()).code).toBe(
      "service-unavailable",
    );
    await expect(contentAuditRows(graph)).resolves.toMatchObject([
      expect.objectContaining({ outcome: null }),
    ]);
  });

  test("keeps a malformed Kernel result unknown", async () => {
    const graph = await createAuthenticatedGraph();

    const response = await requestContent(graph, KERNEL_TRANSACTION_PATH, {
      marker: KERNEL_TRANSACTION_MALFORMED_MARKER,
    });

    expect(response.status).toBe(502);
    expect(apiProblemSchema.parse(await response.json()).code).toBe(
      "service-unavailable",
    );
    await expect(contentAuditRows(graph)).resolves.toMatchObject([
      expect.objectContaining({ outcome: null }),
    ]);
  });

  test("keeps a Kernel envelope 5xx result unknown", async () => {
    const graph = await createAuthenticatedGraph();

    const response = await requestContent(graph, KERNEL_TRANSACTION_PATH, {
      marker: KERNEL_TRANSACTION_ENVELOPE_FAILURE_MARKER,
    });

    expect(response.status).toBe(502);
    expect(apiProblemSchema.parse(await response.json()).code).toBe(
      "service-unavailable",
    );
    await expect(contentAuditRows(graph)).resolves.toMatchObject([
      expect.objectContaining({ outcome: null }),
    ]);
  });

  test("resolves a trusted Kernel business failure as failed", async () => {
    const graph = await createAuthenticatedGraph();

    const response = await requestContent(graph, KERNEL_TRANSACTION_PATH, {
      marker: KERNEL_TRANSACTION_BUSINESS_FAILURE_MARKER,
    });

    expect(response.status).toBe(422);
    expect(apiProblemSchema.parse(await response.json()).code).toBe(
      "validation-failed",
    );
    await expect(contentAuditRows(graph)).resolves.toMatchObject([
      expect.objectContaining({ outcome: "failed" }),
    ]);
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
          documentId: DOCUMENT_ID,
          organizationId: graph.organizationId,
          outcome: "succeeded",
          spaceId: graph.spaceId,
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
        documentId: DOCUMENT_ID,
        organizationId: graph.organizationId,
        outcome: "succeeded",
        spaceId: graph.spaceId,
      },
    ]);
  });

  test("keeps inert image assets inline while preserving the safety header", async () => {
    const graph = await createAuthenticatedGraph();

    const response = await requestAsset(graph, "/assets/inline.png");

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("content-disposition")).toBeNull();
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  });

  test("honors an explicit image download request", async () => {
    const graph = await createAuthenticatedGraph();

    const response = await requestAsset(graph, "/assets/inline.png", true);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-disposition")).toMatch(/^attachment;/);
    expect(response.headers.get("content-type")).toBe("application/octet-stream");
    expect(response.headers.get("content-security-policy")).toContain("sandbox");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  });

  test("routes identical content identities only to the Kernel owned by their space", async () => {
    const firstGraph = await createAuthenticatedGraph(kernel);
    const secondGraph = await createAuthenticatedGraph(secondKernel);
    const firstRequestCount = kernel.requests.length;
    const secondRequestCount = secondKernel.requests.length;

    const firstResponse = await requestAsset(firstGraph, "/assets/inline.png");

    expect(firstResponse.status).toBe(200);
    expect(await firstResponse.text()).toBe("png-bytes");
    expect(kernel.requests.slice(firstRequestCount).map(({ path }) => path)).toEqual([
      KERNEL_IMAGE_ASSET_PATH,
    ]);
    expect(secondKernel.requests).toHaveLength(secondRequestCount);

    const secondResponse = await requestAsset(secondGraph, "/assets/inline.png");

    expect(secondResponse.status).toBe(200);
    expect(await secondResponse.text()).toBe("second-space-asset");
    expect(kernel.requests).toHaveLength(firstRequestCount + 1);
    expect(secondKernel.requests.slice(secondRequestCount).map(({ path }) => path)).toEqual([
      KERNEL_IMAGE_ASSET_PATH,
    ]);
  });

  test("installs and removes a PostgreSQL runtime endpoint through committed notifications", async () => {
    const graph = await createAuthenticatedGraph(runtimeKernel);
    const endpoint = runtimeKernel.configuration.deployments.resolve(
      runtimeKernel.deployment,
    );
    const event = {
      kernelInstanceId: endpoint.kernelInstanceId,
      kind: "upsert" as const,
      requestId: randomUUID(),
      spaceId: endpoint.spaceId,
    } satisfies KernelDeploymentChangedEvent;
    await database.$transaction(async (transaction) => {
      await transaction.kernelRuntimeEndpoint.create({
        data: {
          hostname: endpoint.hostname,
          kernelInstanceId: endpoint.kernelInstanceId,
          port: endpoint.port,
          runtimeOwner: "kernel-gateway-test",
          serverName: endpoint.serverName,
          spaceId: endpoint.spaceId,
          tlsProfile:
            runtimeKernel.configuration.runtimeDeployment.tlsProfile,
        },
      });
      await transaction.$executeRaw(
        Prisma.sql`SELECT pg_notify(${KERNEL_DEPLOYMENT_CHANGED_CHANNEL}, ${JSON.stringify(event)})`,
      );
    });
    await vi.waitFor(
      () => {
        expect(deployments.resolve(runtimeKernel.deployment)).toMatchObject({
          hostname: endpoint.hostname,
          port: endpoint.port,
          serverName: endpoint.serverName,
        });
      },
      { timeout: 5_000 },
    );

    const response = await requestAsset(graph, "/assets/inline.png");

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("runtime-space-asset");
    const unavailable = await operations.execute({
      deploymentHandle: endpoint.handle,
      kernelState: "unavailable",
      operation: "set-kernel-state",
      spaceId: endpoint.spaceId,
      version: "test",
    });
    expect(unavailable.outcome).toBe("updated");
    await vi.waitFor(
      () => {
        expect(() => deployments.resolve(runtimeKernel.deployment)).toThrow(
          "Kernel deployment is unavailable",
        );
      },
      { timeout: 5_000 },
    );
  });

  test.each([
    { assetPath: "/assets/active.html", contentType: "application/octet-stream" },
    { assetPath: "/assets/document.pdf", contentType: "application/pdf" },
  ])("forces active $assetPath assets into a download response", async ({ assetPath, contentType }) => {
    const graph = await createAuthenticatedGraph();

    const response = await requestAsset(graph, assetPath);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-disposition")).toMatch(/^attachment;/);
    expect(response.headers.get("content-type")).toBe(contentType);
    expect(response.headers.get("content-security-policy")).toContain("sandbox");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
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
