import { randomUUID } from "node:crypto";

import {
  AUTHORIZED_SPACES_PATH,
  AUTH_LOGIN_PATH,
  AUTH_SESSION_COOKIE_NAME,
  type AccessOperationResult,
  type ApiProblemCode,
  apiProblemSchema,
  buildSpaceRuntimePath,
  spaceRuntimeBootstrapSchema,
} from "@singularity/contracts";
import { DatabaseRuntime, type DatabaseClient } from "@singularity/database";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";

import { AccessOperationsService } from "../src/operations/access-operations.service.js";
import { CapturingLogger } from "./support/capturing-logger.js";
import { truncateTestDatabase } from "./support/database.js";
import {
  startTestApiApplication,
  TEST_PUBLIC_ORIGIN,
  type TestApiApplication,
} from "./support/test-app.js";

const password = "correct horse battery staple";

interface InstallationGraph {
  loginIdentifier: string;
  organizationId: string;
  spaceId: string;
  userId: string;
}

interface MemberGraph {
  installation: InstallationGraph;
  loginIdentifier: string;
  userId: string;
}

type InvalidatedAccessLayer =
  | "organization"
  | "organization-membership"
  | "space"
  | "space-membership"
  | "user";

function createdInstallation(result: AccessOperationResult): {
  organizationId: string;
  spaceId: string;
  userId: string;
} {
  if (
    result.outcome !== "created" ||
    !("organizationId" in result) ||
    !("spaceId" in result) ||
    !("userId" in result)
  ) {
    throw new Error("The initialize operation did not create an installation");
  }
  return result;
}

function createdUserId(result: AccessOperationResult): string {
  if (result.outcome !== "created" || !("userId" in result)) {
    throw new Error("The create-user operation did not create a user");
  }
  return result.userId;
}

function createdSpaceId(result: AccessOperationResult): string {
  if (result.outcome !== "created" || !("spaceId" in result)) {
    throw new Error("The create-space operation did not create a space");
  }
  return result.spaceId;
}

async function expectProblem(
  response: Response,
  status: number,
  code: ApiProblemCode,
): Promise<void> {
  expect(response.status).toBe(status);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(apiProblemSchema.parse(await response.json())).toMatchObject({
    code,
    status,
  });
}

function requireCookiePair(response: Response): string {
  const setCookie = response.headers.get("set-cookie");
  if (setCookie === null) {
    throw new Error("The login response did not set a session cookie");
  }
  const pair = setCookie.split(";", 1)[0];
  if (
    pair === undefined ||
    !pair.startsWith(`${AUTH_SESSION_COOKIE_NAME}=`)
  ) {
    throw new Error("The login response set an invalid session cookie");
  }
  return pair;
}

describe("authorized space HTTP contract with PostgreSQL", () => {
  let database: DatabaseClient;
  let logger: CapturingLogger;
  let operations: AccessOperationsService;
  let testApi: TestApiApplication;

  beforeAll(async () => {
    logger = new CapturingLogger();
    testApi = await startTestApiApplication({ logger });
    database = testApi.app.get(DatabaseRuntime).client;
    operations = testApi.app.get(AccessOperationsService);
  });

  afterEach(async () => {
    await truncateTestDatabase(database);
    logger.clear();
  });

  afterAll(async () => {
    await testApi.dispose();
  });

  async function initialize(
    organizationName = "Singularity",
    spaceName = "Primary Space",
  ): Promise<InstallationGraph> {
    const loginIdentifier = `owner-${randomUUID()}@example.test`;
    const result = await operations.execute({
      operation: "initialize",
      loginIdentifier,
      password,
      organizationName,
      spaceName,
    });
    return { ...createdInstallation(result), loginIdentifier };
  }

  async function createMemberGraph(): Promise<MemberGraph> {
    const installation = await initialize();
    const loginIdentifier = `member-${randomUUID()}@example.test`;
    const userId = createdUserId(
      await operations.execute({
        operation: "create-user",
        organizationId: installation.organizationId,
        loginIdentifier,
        password,
      }),
    );
    const membership = await operations.execute({
      operation: "set-space-member",
      spaceId: installation.spaceId,
      userId,
      role: "viewer",
    });
    if (membership.outcome !== "created") {
      throw new Error("The test member did not receive space access");
    }
    return { installation, loginIdentifier, userId };
  }

  async function login(loginIdentifier: string): Promise<string> {
    const response = await fetch(`${testApi.baseUrl}${AUTH_LOGIN_PATH}`, {
      body: JSON.stringify({ loginIdentifier, password }),
      headers: {
        "Content-Type": "application/json",
        Origin: TEST_PUBLIC_ORIGIN,
      },
      method: "POST",
    });
    expect(response.status).toBe(200);
    return requireCookiePair(response);
  }

  function listSpaces(cookie: string): Promise<Response> {
    return fetch(`${testApi.baseUrl}${AUTHORIZED_SPACES_PATH}`, {
      headers: { Cookie: cookie },
    });
  }

  function runtime(
    cookie: string,
    organizationId: string,
    spaceId: string,
  ): Promise<Response> {
    return fetch(
      `${testApi.baseUrl}${buildSpaceRuntimePath({ organizationId, spaceId })}`,
      { headers: { Cookie: cookie } },
    );
  }

  async function invalidateLayer(
    graph: MemberGraph,
    layer: InvalidatedAccessLayer,
  ): Promise<AccessOperationResult> {
    switch (layer) {
      case "user":
        return operations.execute({
          operation: "disable-user",
          userId: graph.userId,
        });
      case "organization":
        return operations.execute({
          operation: "disable-organization",
          organizationId: graph.installation.organizationId,
        });
      case "organization-membership":
        return operations.execute({
          operation: "revoke-organization-member",
          organizationId: graph.installation.organizationId,
          userId: graph.userId,
        });
      case "space":
        return operations.execute({
          operation: "disable-space",
          spaceId: graph.installation.spaceId,
        });
      case "space-membership":
        return operations.execute({
          operation: "revoke-space-member",
          spaceId: graph.installation.spaceId,
          userId: graph.userId,
        });
    }
  }

  test("lists only the current user's authorized spaces in stable name order", async () => {
    const installation = await initialize("Zeta Organization", "Zulu Space");
    const alphaSpaceId = createdSpaceId(
      await operations.execute({
        operation: "create-space",
        organizationId: installation.organizationId,
        name: "alpha Space",
        adminUserId: installation.userId,
      }),
    );
    const otherUserId = createdUserId(
      await operations.execute({
        operation: "create-user",
        organizationId: installation.organizationId,
        loginIdentifier: `other-${randomUUID()}@example.test`,
        password,
      }),
    );
    const hiddenSpaceId = createdSpaceId(
      await operations.execute({
        operation: "create-space",
        organizationId: installation.organizationId,
        name: "Secret Space Name",
        adminUserId: otherUserId,
      }),
    );
    const cookie = await login(installation.loginIdentifier);

    const response = await listSpaces(cookie);
    const responseText = await response.text();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(JSON.parse(responseText)).toEqual({
      spaces: [
        {
          organizationId: installation.organizationId,
          organizationName: "Zeta Organization",
          role: "admin",
          spaceId: alphaSpaceId,
          spaceName: "alpha Space",
        },
        {
          organizationId: installation.organizationId,
          organizationName: "Zeta Organization",
          role: "admin",
          spaceId: installation.spaceId,
          spaceName: "Zulu Space",
        },
      ],
    });
    expect(responseText).not.toContain("Secret Space Name");
    expect(responseText).not.toContain(hiddenSpaceId);
    expect(responseText).not.toContain(otherUserId);
  });

  test.each<InvalidatedAccessLayer>([
    "user",
    "organization",
    "organization-membership",
    "space",
    "space-membership",
  ])("requires an active %s layer for the authorized space list", async (layer) => {
    const graph = await createMemberGraph();
    const cookie = await login(graph.loginIdentifier);
    expect((await listSpaces(cookie)).status).toBe(200);
    const invalidated = await invalidateLayer(graph, layer);
    expect(["revoked", "updated"]).toContain(invalidated.outcome);

    const response = await listSpaces(cookie);
    if (layer === "user") {
      await expectProblem(response, 401, "unauthenticated");
      return;
    }
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({ spaces: [] });
  });

  test("returns only the latest role and operator-produced starting, ready, and unavailable states", async () => {
    const installation = await initialize();
    const cookie = await login(installation.loginIdentifier);

    const starting = await runtime(
      cookie,
      installation.organizationId,
      installation.spaceId,
    );
    expect(starting.status).toBe(200);
    expect(
      spaceRuntimeBootstrapSchema.parse(await starting.json()),
    ).toEqual({
      kernelState: "starting",
      organizationId: installation.organizationId,
      role: "admin",
      spaceId: installation.spaceId,
    });

    const readyOperation = await operations.execute({
      operation: "set-kernel-state",
      spaceId: installation.spaceId,
      kernelState: "ready",
      deploymentHandle: "protected-deployment-sentinel",
      version: "3.2.1-private",
    });
    expect(readyOperation.outcome).toBe("updated");
    const ready = await runtime(
      cookie,
      installation.organizationId,
      installation.spaceId,
    );
    const readyText = await ready.text();
    expect(ready.status).toBe(200);
    expect(ready.headers.get("cache-control")).toBe("no-store");
    expect(spaceRuntimeBootstrapSchema.parse(JSON.parse(readyText))).toEqual({
      kernelState: "ready",
      organizationId: installation.organizationId,
      role: "admin",
      spaceId: installation.spaceId,
    });
    expect(readyText).not.toContain("protected-deployment-sentinel");
    expect(readyText).not.toContain("3.2.1-private");
    expect(readyText).not.toContain("kernelInstance");
    expect(readyText).not.toContain("workspaceId");

    const roleUpdated = await operations.execute({
      operation: "set-space-member",
      spaceId: installation.spaceId,
      userId: installation.userId,
      role: "viewer",
    });
    expect(roleUpdated.outcome).toBe("updated");
    const unavailableOperation = await operations.execute({
      operation: "set-kernel-state",
      spaceId: installation.spaceId,
      kernelState: "unavailable",
      deploymentHandle: "protected-deployment-sentinel-2",
      version: "3.2.2",
    });
    expect(unavailableOperation.outcome).toBe("updated");
    const unavailable = await runtime(
      cookie,
      installation.organizationId,
      installation.spaceId,
    );
    expect(unavailable.status).toBe(200);
    expect(
      spaceRuntimeBootstrapSchema.parse(await unavailable.json()),
    ).toEqual({
      kernelState: "unavailable",
      organizationId: installation.organizationId,
      role: "viewer",
      spaceId: installation.spaceId,
    });

    const restartingOperation = await operations.execute({
      operation: "set-kernel-state",
      spaceId: installation.spaceId,
      kernelState: "starting",
    });
    expect(restartingOperation.outcome).toBe("updated");
    const restarting = await runtime(
      cookie,
      installation.organizationId,
      installation.spaceId,
    );
    expect(restarting.status).toBe(200);
    expect(spaceRuntimeBootstrapSchema.parse(await restarting.json())).toEqual({
      kernelState: "starting",
      organizationId: installation.organizationId,
      role: "viewer",
      spaceId: installation.spaceId,
    });
    expect(logger.output).toContain("space.runtime");
    expect(logger.output).toContain("authorization.decision");
    expect(logger.output).not.toContain("protected-deployment-sentinel");
    expect(logger.output).not.toContain("3.2.1-private");
  });

  test("returns the same hidden 404 for unknown organization and space identifiers", async () => {
    const installation = await initialize();
    const cookie = await login(installation.loginIdentifier);
    const responses = await Promise.all([
      runtime(cookie, randomUUID(), installation.spaceId),
      runtime(cookie, installation.organizationId, randomUUID()),
      runtime(cookie, randomUUID(), randomUUID()),
    ]);
    for (const response of responses) {
      await expectProblem(response, 404, "not-found");
    }
    expect(logger.output).toContain("denied");
  });

  test("does not reveal an existing space without a space membership", async () => {
    const installation = await initialize();
    const otherUserId = createdUserId(
      await operations.execute({
        operation: "create-user",
        organizationId: installation.organizationId,
        loginIdentifier: `space-admin-${randomUUID()}@example.test`,
        password,
      }),
    );
    const hiddenSpaceId = createdSpaceId(
      await operations.execute({
        operation: "create-space",
        organizationId: installation.organizationId,
        name: "Invisible Existing Space",
        adminUserId: otherUserId,
      }),
    );
    const cookie = await login(installation.loginIdentifier);

    await expectProblem(
      await runtime(cookie, installation.organizationId, hiddenSpaceId),
      404,
      "not-found",
    );
  });

  test.each<Exclude<InvalidatedAccessLayer, "user">>([
    "organization",
    "organization-membership",
    "space",
    "space-membership",
  ])("turns an invalidated %s layer into the same hidden 404", async (layer) => {
    const graph = await createMemberGraph();
    const cookie = await login(graph.loginIdentifier);
    expect(
      (
        await runtime(
          cookie,
          graph.installation.organizationId,
          graph.installation.spaceId,
        )
      ).status,
    ).toBe(200);
    const invalidated = await invalidateLayer(graph, layer);
    expect(["revoked", "updated"]).toContain(invalidated.outcome);

    await expectProblem(
      await runtime(
        cookie,
        graph.installation.organizationId,
        graph.installation.spaceId,
      ),
      404,
      "not-found",
    );
  });
});
