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

interface AuthenticatedGraph {
  readonly cookie: string;
  readonly csrfToken: string;
  readonly organizationId: string;
  readonly spaceId: string;
  readonly userId: string;
}

function cookiePair(response: Response): string {
  const setCookie = response.headers.get("set-cookie");
  const pair = setCookie?.split(";", 1)[0];
  if (!pair?.startsWith(`${AUTH_SESSION_COOKIE_NAME}=`)) {
    throw new Error("Kernel Gateway test login did not set a session cookie");
  }
  return pair;
}

describe("Kernel Gateway hidden runtime access loss", () => {
  let database: DatabaseClient;
  let kernel: TestKernelGateway;
  let operations: AccessOperationsService;
  let passwordDigest: string;
  let testApi: TestApiApplication;

  beforeAll(async () => {
    kernel = await startTestKernelGateway({
      handler: () => ({
        body: JSON.stringify({
          code: "not-found",
          requestId: randomUUID(),
          status: 404,
        }),
        headers: { "content-type": "application/json" },
        status: 404,
      }),
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

  function requestContent(graph: AuthenticatedGraph): Promise<Response> {
    const path = `/api/v1/organizations/${graph.organizationId}/spaces/${graph.spaceId}/kernel/api/api/block/getBlockInfo`;
    return fetch(`${testApi.baseUrl}${path}`, {
      body: JSON.stringify({ id: DOCUMENT_ID }),
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
});
