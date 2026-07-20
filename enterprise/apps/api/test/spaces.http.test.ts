import { randomUUID } from "node:crypto";

import {
  AUTHORIZED_SPACES_PATH,
  AUTH_LOGIN_PATH,
  AUTH_SESSION_COOKIE_NAME,
  CSRF_HEADER_NAME,
  ORGANIZATION_SPACES_PATH_TEMPLATE,
  ORGANIZATION_SPACE_GROUP_CANDIDATES_PATH_TEMPLATE,
  ORGANIZATION_SPACE_GROUP_PATH_TEMPLATE,
  ORGANIZATION_SPACE_MEMBER_CANDIDATES_PATH_TEMPLATE,
  ORGANIZATION_SPACE_MEMBER_PATH_TEMPLATE,
  ORGANIZATION_SPACE_PATH_TEMPLATE,
  type AccessOperationResult,
  type ApiProblemCode,
  apiProblemSchema,
  authorizedSpacesResponseSchema,
  buildSpaceRuntimePath,
  loginResponseSchema,
  managedSpaceSummarySchema,
  managedSpacesResponseSchema,
  spaceGroupCandidatesResponseSchema,
  spaceMemberCandidatesResponseSchema,
  spaceRuntimeBootstrapSchema,
} from "@singularity/contracts";
import { DatabaseRuntime, type DatabaseClient } from "@singularity/database";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";

import { AccessOperationsService } from "../src/operations/access-operations.service.js";
import { captureAccessChanges } from "./support/access-change-barrier.js";
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

interface AuthenticatedUser {
  cookie: string;
  csrfToken: string;
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

function mutationHeaders(user: AuthenticatedUser): Record<string, string> {
  return {
    [CSRF_HEADER_NAME]: user.csrfToken,
    "Content-Type": "application/json",
    Cookie: user.cookie,
    Origin: TEST_PUBLIC_ORIGIN,
  };
}

describe("space HTTP contracts with PostgreSQL", () => {
  let database: DatabaseClient;
  let databaseRuntime: DatabaseRuntime;
  let logger: CapturingLogger;
  let operations: AccessOperationsService;
  let testApi: TestApiApplication;

  beforeAll(async () => {
    logger = new CapturingLogger();
    testApi = await startTestApiApplication({ logger });
    databaseRuntime = testApi.app.get(DatabaseRuntime);
    database = databaseRuntime.client;
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

  async function login(loginIdentifier: string): Promise<AuthenticatedUser> {
    const response = await fetch(`${testApi.baseUrl}${AUTH_LOGIN_PATH}`, {
      body: JSON.stringify({ loginIdentifier, password }),
      headers: {
        "Content-Type": "application/json",
        Origin: TEST_PUBLIC_ORIGIN,
      },
      method: "POST",
    });
    expect(response.status).toBe(200);
    const { csrfToken } = loginResponseSchema.parse(await response.json());
    return { cookie: requireCookiePair(response), csrfToken };
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
    const { cookie } = await login(installation.loginIdentifier);

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

  test("creates a managed space and grants its creator direct admin access", async () => {
    const installation = await initialize();
    const owner = await login(installation.loginIdentifier);
    const spacesPath = buildPath(ORGANIZATION_SPACES_PATH_TEMPLATE, {
      organizationId: installation.organizationId,
    });

    const response = await fetch(`${testApi.baseUrl}${spacesPath}`, {
      body: JSON.stringify({ name: "Engineering" }),
      headers: mutationHeaders(owner),
      method: "POST",
    });
    expect(response.status).toBe(201);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const created = managedSpaceSummarySchema.parse(await response.json());
    expect(created).toMatchObject({
      organizationId: installation.organizationId,
      spaceName: "Engineering",
      status: "active",
    });

    const authorizedResponse = await listSpaces(owner.cookie);
    expect(authorizedResponse.status).toBe(200);
    expect(
      authorizedSpacesResponseSchema.parse(await authorizedResponse.json())
        .spaces,
    ).toContainEqual({
      organizationId: installation.organizationId,
      organizationName: "Singularity",
      role: "admin",
      spaceId: created.spaceId,
      spaceName: "Engineering",
    });
  });

  test("archives a space and removes it from authorized runtime access", async () => {
    const installation = await initialize();
    const owner = await login(installation.loginIdentifier);
    const spacePath = buildPath(ORGANIZATION_SPACE_PATH_TEMPLATE, {
      organizationId: installation.organizationId,
      spaceId: installation.spaceId,
    });

    const response = await fetch(`${testApi.baseUrl}${spacePath}`, {
      body: JSON.stringify({ status: "archived" }),
      headers: mutationHeaders(owner),
      method: "PATCH",
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const archived = managedSpaceSummarySchema.parse(await response.json());
    expect(archived).toEqual({
      organizationId: installation.organizationId,
      spaceId: installation.spaceId,
      spaceName: "Primary Space",
      status: "archived",
    });

    const authorizedResponse = await listSpaces(owner.cookie);
    expect(authorizedResponse.status).toBe(200);
    expect(
      authorizedSpacesResponseSchema
        .parse(await authorizedResponse.json())
        .spaces.some((space) => space.spaceId === installation.spaceId),
    ).toBe(false);
  });

  test("treats an identical space patch as a side-effect-free success", async () => {
    const installation = await initialize();
    const owner = await login(installation.loginIdentifier);
    const spacePath = buildPath(ORGANIZATION_SPACE_PATH_TEMPLATE, {
      organizationId: installation.organizationId,
      spaceId: installation.spaceId,
    });
    const auditCount = await database.auditEvent.count({
      where: {
        organizationId: installation.organizationId,
        spaceId: installation.spaceId,
        targetId: installation.spaceId,
        targetType: "space",
      },
    });

    const captured = await captureAccessChanges(databaseRuntime, () =>
      fetch(`${testApi.baseUrl}${spacePath}`, {
        body: JSON.stringify({ name: "Primary Space", status: "active" }),
        headers: mutationHeaders(owner),
        method: "PATCH",
      }),
    );

    expect(captured.result.status).toBe(200);
    expect(
      managedSpaceSummarySchema.parse(await captured.result.json()),
    ).toEqual({
      organizationId: installation.organizationId,
      spaceId: installation.spaceId,
      spaceName: "Primary Space",
      status: "active",
    });
    expect(captured.events).toEqual([]);
    await expect(
      database.auditEvent.count({
        where: {
          organizationId: installation.organizationId,
          spaceId: installation.spaceId,
          targetId: installation.spaceId,
          targetType: "space",
        },
      }),
    ).resolves.toBe(auditCount);
  });

  test("hides an unactivated restore target from the managed space list", async () => {
    const installation = await initialize();
    const owner = await login(installation.loginIdentifier);
    const target = await database.space.create({
      data: {
        name: "Restore target",
        organizationId: installation.organizationId,
        status: "archived",
      },
      select: { id: true },
    });
    const backup = await database.spaceBackup.create({
      data: {
        createdByUserId: installation.userId,
        organizationId: installation.organizationId,
        sourceSpaceId: installation.spaceId,
        status: "succeeded",
      },
      select: { id: true },
    });
    await database.spaceRestoreJob.create({
      data: {
        backupId: backup.id,
        createdByUserId: installation.userId,
        organizationId: installation.organizationId,
        sourceSpaceId: installation.spaceId,
        status: "ready_for_activation",
        targetSpaceId: target.id,
      },
    });
    const spacesPath = buildPath(ORGANIZATION_SPACES_PATH_TEMPLATE, {
      organizationId: installation.organizationId,
    });

    const response = await fetch(`${testApi.baseUrl}${spacesPath}`, {
      headers: { Cookie: owner.cookie },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const spaces = managedSpacesResponseSchema.parse(await response.json());
    expect(spaces.spaces.map((space) => space.spaceId)).toEqual([
      installation.spaceId,
    ]);
  });

  test("grants an organization member direct space access through HTTP", async () => {
    const installation = await initialize();
    const owner = await login(installation.loginIdentifier);
    const loginIdentifier = `direct-member-${randomUUID()}@example.test`;
    const userId = createdUserId(
      await operations.execute({
        operation: "create-user",
        organizationId: installation.organizationId,
        loginIdentifier,
        password,
      }),
    );
    const memberPath = buildPath(ORGANIZATION_SPACE_MEMBER_PATH_TEMPLATE, {
      organizationId: installation.organizationId,
      spaceId: installation.spaceId,
      userId,
    });

    const response = await fetch(`${testApi.baseUrl}${memberPath}`, {
      body: JSON.stringify({ role: "editor" }),
      headers: mutationHeaders(owner),
      method: "PUT",
    });
    expect(response.status).toBe(204);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const repeatedResponse = await fetch(`${testApi.baseUrl}${memberPath}`, {
      body: JSON.stringify({ role: "editor" }),
      headers: mutationHeaders(owner),
      method: "PUT",
    });
    expect(repeatedResponse.status).toBe(204);
    await expect(
      database.auditEvent.count({
        where: {
          organizationId: installation.organizationId,
          spaceId: installation.spaceId,
          targetId: userId,
          targetType: "membership",
        },
      }),
    ).resolves.toBe(1);

    const member = await login(loginIdentifier);
    const authorizedResponse = await listSpaces(member.cookie);
    expect(authorizedResponse.status).toBe(200);
    expect(
      authorizedSpacesResponseSchema.parse(await authorizedResponse.json()),
    ).toEqual({
      spaces: [
        {
          organizationId: installation.organizationId,
          organizationName: "Singularity",
          role: "editor",
          spaceId: installation.spaceId,
          spaceName: "Primary Space",
        },
      ],
    });
  });

  test("grants space access to active members of an organization group through HTTP", async () => {
    const installation = await initialize();
    const owner = await login(installation.loginIdentifier);
    const loginIdentifier = `group-member-${randomUUID()}@example.test`;
    const userId = createdUserId(
      await operations.execute({
        operation: "create-user",
        organizationId: installation.organizationId,
        loginIdentifier,
        password,
      }),
    );
    const group = await database.userGroup.create({
      data: {
        name: "Readers",
        organizationId: installation.organizationId,
        status: "active",
      },
      select: { id: true },
    });
    await database.userGroupMembership.create({
      data: {
        groupId: group.id,
        organizationId: installation.organizationId,
        userId,
      },
    });
    const groupPath = buildPath(ORGANIZATION_SPACE_GROUP_PATH_TEMPLATE, {
      groupId: group.id,
      organizationId: installation.organizationId,
      spaceId: installation.spaceId,
    });

    const response = await fetch(`${testApi.baseUrl}${groupPath}`, {
      body: JSON.stringify({ role: "viewer" }),
      headers: mutationHeaders(owner),
      method: "PUT",
    });
    expect(response.status).toBe(204);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const repeatedResponse = await fetch(`${testApi.baseUrl}${groupPath}`, {
      body: JSON.stringify({ role: "viewer" }),
      headers: mutationHeaders(owner),
      method: "PUT",
    });
    expect(repeatedResponse.status).toBe(204);
    await expect(
      database.auditEvent.count({
        where: {
          organizationId: installation.organizationId,
          spaceId: installation.spaceId,
          targetId: group.id,
          targetType: "group",
        },
      }),
    ).resolves.toBe(1);

    const member = await login(loginIdentifier);
    const authorizedResponse = await listSpaces(member.cookie);
    expect(authorizedResponse.status).toBe(200);
    expect(
      authorizedSpacesResponseSchema.parse(await authorizedResponse.json()),
    ).toEqual({
      spaces: [
        {
          organizationId: installation.organizationId,
          organizationName: "Singularity",
          role: "viewer",
          spaceId: installation.spaceId,
          spaceName: "Primary Space",
        },
      ],
    });
  });

  test.each(["direct member", "user group"] as const)(
    "publishes only real %s grant transitions",
    async (kind) => {
      const installation = await initialize();
      const owner = await login(installation.loginIdentifier);
      const loginIdentifier = `notification-target-${randomUUID()}@example.test`;
      const userId = createdUserId(
        await operations.execute({
          operation: "create-user",
          organizationId: installation.organizationId,
          loginIdentifier,
          password,
        }),
      );
      let targetId = userId;
      let targetType: "group" | "membership" = "membership";
      let path = buildPath(ORGANIZATION_SPACE_MEMBER_PATH_TEMPLATE, {
        organizationId: installation.organizationId,
        spaceId: installation.spaceId,
        userId,
      });
      if (kind === "user group") {
        const group = await database.userGroup.create({
          data: {
            name: `Notification group ${randomUUID()}`,
            organizationId: installation.organizationId,
            status: "active",
          },
          select: { id: true },
        });
        await database.userGroupMembership.create({
          data: {
            groupId: group.id,
            organizationId: installation.organizationId,
            userId,
          },
        });
        targetId = group.id;
        targetType = "group";
        path = buildPath(ORGANIZATION_SPACE_GROUP_PATH_TEMPLATE, {
          groupId: group.id,
          organizationId: installation.organizationId,
          spaceId: installation.spaceId,
        });
      }

      const firstGrant = await captureAccessChanges(databaseRuntime, () =>
        fetch(`${testApi.baseUrl}${path}`, {
          body: JSON.stringify({ role: "editor" }),
          headers: mutationHeaders(owner),
          method: "PUT",
        }),
      );
      expect(firstGrant.result.status).toBe(204);
      expect(firstGrant.events).toEqual([
        expect.objectContaining({
          kind: "close",
          reason: "forbidden",
          selectors: [
            { kind: "space", value: installation.spaceId },
            { kind: "user", value: userId },
          ],
        }),
      ]);

      const repeatedGrant = await captureAccessChanges(databaseRuntime, () =>
        fetch(`${testApi.baseUrl}${path}`, {
          body: JSON.stringify({ role: "editor" }),
          headers: mutationHeaders(owner),
          method: "PUT",
        }),
      );
      expect(repeatedGrant.result.status).toBe(204);
      expect(repeatedGrant.events).toEqual([]);

      const firstRevocation = await captureAccessChanges(databaseRuntime, () =>
        fetch(`${testApi.baseUrl}${path}`, {
          headers: mutationHeaders(owner),
          method: "DELETE",
        }),
      );
      expect(firstRevocation.result.status).toBe(204);
      expect(firstRevocation.events).toEqual([
        expect.objectContaining({
          kind: "close",
          reason: "forbidden",
          selectors: [
            { kind: "space", value: installation.spaceId },
            { kind: "user", value: userId },
          ],
        }),
      ]);

      const repeatedRevocation = await captureAccessChanges(
        databaseRuntime,
        () =>
          fetch(`${testApi.baseUrl}${path}`, {
            headers: mutationHeaders(owner),
            method: "DELETE",
          }),
      );
      expect(repeatedRevocation.result.status).toBe(204);
      expect(repeatedRevocation.events).toEqual([]);
      await expect(
        database.auditEvent.count({
          where: {
            organizationId: installation.organizationId,
            spaceId: installation.spaceId,
            targetId,
            targetType,
          },
        }),
      ).resolves.toBe(2);
    },
  );

  test.each([
    {
      expectedCode: "not-found",
      expectedStatus: 404,
      label: "no delegated",
      role: null,
    },
    {
      expectedCode: "forbidden",
      expectedStatus: 403,
      label: "viewer",
      role: "viewer",
    },
    {
      expectedCode: "forbidden",
      expectedStatus: 403,
      label: "editor",
      role: "editor",
    },
  ] as const)(
    "returns $expectedStatus for $label space management access",
    async ({ expectedCode, expectedStatus, role }) => {
      const installation = await initialize();
      const loginIdentifier = `management-role-${randomUUID()}@example.test`;
      const userId = createdUserId(
        await operations.execute({
          operation: "create-user",
          organizationId: installation.organizationId,
          loginIdentifier,
          password,
        }),
      );
      if (role !== null) {
        const assigned = await operations.execute({
          operation: "set-space-member",
          role,
          spaceId: installation.spaceId,
          userId,
        });
        expect(assigned.outcome).toBe("created");
      }
      const delegated = await login(loginIdentifier);
      const spacePath = buildPath(ORGANIZATION_SPACE_PATH_TEMPLATE, {
        organizationId: installation.organizationId,
        spaceId: installation.spaceId,
      });

      await expectProblem(
        await fetch(`${testApi.baseUrl}${spacePath}`, {
          headers: { Cookie: delegated.cookie },
        }),
        expectedStatus,
        expectedCode,
      );
    },
  );

  test("uses the highest direct and group role for delegated administration", async () => {
    const installation = await initialize();
    const delegatedLogin = `group-admin-${randomUUID()}@example.test`;
    const delegatedUserId = createdUserId(
      await operations.execute({
        operation: "create-user",
        organizationId: installation.organizationId,
        loginIdentifier: delegatedLogin,
        password,
      }),
    );
    const directRole = await operations.execute({
      operation: "set-space-member",
      role: "viewer",
      spaceId: installation.spaceId,
      userId: delegatedUserId,
    });
    expect(directRole.outcome).toBe("created");
    const group = await database.userGroup.create({
      data: {
        name: "Delegated administrators",
        organizationId: installation.organizationId,
        status: "active",
      },
      select: { id: true },
    });
    await database.userGroupMembership.create({
      data: {
        groupId: group.id,
        organizationId: installation.organizationId,
        userId: delegatedUserId,
      },
    });
    await database.spaceGroupGrant.create({
      data: {
        groupId: group.id,
        organizationId: installation.organizationId,
        role: "admin",
        spaceId: installation.spaceId,
      },
    });
    const candidateUserId = createdUserId(
      await operations.execute({
        operation: "create-user",
        organizationId: installation.organizationId,
        loginIdentifier: `delegation-target-${randomUUID()}@example.test`,
        password,
      }),
    );
    const delegated = await login(delegatedLogin);
    const spacePath = buildPath(ORGANIZATION_SPACE_PATH_TEMPLATE, {
      organizationId: installation.organizationId,
      spaceId: installation.spaceId,
    });

    const managedSpace = await fetch(`${testApi.baseUrl}${spacePath}`, {
      headers: { Cookie: delegated.cookie },
    });
    expect(managedSpace.status).toBe(200);
    expect(
      managedSpaceSummarySchema.parse(await managedSpace.json()),
    ).toMatchObject({ spaceId: installation.spaceId, status: "active" });
    const authorized = await listSpaces(delegated.cookie);
    expect(authorized.status).toBe(200);
    expect(
      authorizedSpacesResponseSchema.parse(await authorized.json()).spaces,
    ).toContainEqual(
      expect.objectContaining({
        role: "admin",
        spaceId: installation.spaceId,
      }),
    );

    const candidatePath = buildPath(ORGANIZATION_SPACE_MEMBER_PATH_TEMPLATE, {
      organizationId: installation.organizationId,
      spaceId: installation.spaceId,
      userId: candidateUserId,
    });
    const granted = await fetch(`${testApi.baseUrl}${candidatePath}`, {
      body: JSON.stringify({ role: "viewer" }),
      headers: mutationHeaders(delegated),
      method: "PUT",
    });
    expect(granted.status).toBe(204);
    await expect(
      database.spaceMembership.findUniqueOrThrow({
        where: {
          spaceId_userId: {
            spaceId: installation.spaceId,
            userId: candidateUserId,
          },
        },
        select: { role: true, status: true },
      }),
    ).resolves.toEqual({ role: "viewer", status: "active" });
  });

  test("limits a delegated space administrator to access management for its exact space", async () => {
    const installation = await initialize();
    const delegatedLogin = `delegated-admin-${randomUUID()}@example.test`;
    const delegatedUserId = createdUserId(
      await operations.execute({
        operation: "create-user",
        organizationId: installation.organizationId,
        loginIdentifier: delegatedLogin,
        password,
      }),
    );
    const delegatedSpaceId = createdSpaceId(
      await operations.execute({
        operation: "create-space",
        adminUserId: delegatedUserId,
        name: "Delegated Space",
        organizationId: installation.organizationId,
      }),
    );
    const candidateLogin = `candidate-${randomUUID()}@example.test`;
    const candidateUserId = createdUserId(
      await operations.execute({
        operation: "create-user",
        organizationId: installation.organizationId,
        loginIdentifier: candidateLogin,
        password,
      }),
    );
    const inactiveLogin = `inactive-${randomUUID()}@example.test`;
    const inactiveUserId = createdUserId(
      await operations.execute({
        operation: "create-user",
        organizationId: installation.organizationId,
        loginIdentifier: inactiveLogin,
        password,
      }),
    );
    await database.organizationMembership.update({
      where: {
        organizationId_userId: {
          organizationId: installation.organizationId,
          userId: inactiveUserId,
        },
      },
      data: { status: "inactive" },
    });
    const activeGroup = await database.userGroup.create({
      data: {
        name: "Candidate group",
        organizationId: installation.organizationId,
        status: "active",
      },
    });
    await database.userGroup.create({
      data: {
        name: "Disabled group",
        organizationId: installation.organizationId,
        status: "disabled",
      },
    });
    const delegated = await login(delegatedLogin);
    const memberCandidatesPath = buildPath(
      ORGANIZATION_SPACE_MEMBER_CANDIDATES_PATH_TEMPLATE,
      {
        organizationId: installation.organizationId,
        spaceId: delegatedSpaceId,
      },
    );
    const groupCandidatesPath = buildPath(
      ORGANIZATION_SPACE_GROUP_CANDIDATES_PATH_TEMPLATE,
      {
        organizationId: installation.organizationId,
        spaceId: delegatedSpaceId,
      },
    );

    const memberCandidatesResponse = await fetch(
      `${testApi.baseUrl}${memberCandidatesPath}`,
      { headers: { Cookie: delegated.cookie } },
    );
    expect(memberCandidatesResponse.status).toBe(200);
    expect(memberCandidatesResponse.headers.get("cache-control")).toBe(
      "no-store",
    );
    const memberCandidates = spaceMemberCandidatesResponseSchema.parse(
      await memberCandidatesResponse.json(),
    );
    expect(memberCandidates.members).toContainEqual({
      loginIdentifier: candidateLogin,
      userId: candidateUserId,
    });
    expect(memberCandidates.members).not.toContainEqual(
      expect.objectContaining({ userId: inactiveUserId }),
    );

    const groupCandidatesResponse = await fetch(
      `${testApi.baseUrl}${groupCandidatesPath}`,
      { headers: { Cookie: delegated.cookie } },
    );
    expect(groupCandidatesResponse.status).toBe(200);
    expect(groupCandidatesResponse.headers.get("cache-control")).toBe(
      "no-store",
    );
    const groupCandidates = spaceGroupCandidatesResponseSchema.parse(
      await groupCandidatesResponse.json(),
    );
    expect(groupCandidates).toEqual({
      groups: [
        {
          groupId: activeGroup.id,
          groupName: activeGroup.name,
          groupStatus: "active",
        },
      ],
    });

    const candidateMemberPath = buildPath(
      ORGANIZATION_SPACE_MEMBER_PATH_TEMPLATE,
      {
        organizationId: installation.organizationId,
        spaceId: delegatedSpaceId,
        userId: candidateUserId,
      },
    );
    const granted = await fetch(`${testApi.baseUrl}${candidateMemberPath}`, {
      body: JSON.stringify({ role: "viewer" }),
      headers: mutationHeaders(delegated),
      method: "PUT",
    });
    expect(granted.status).toBe(204);
    await expect(
      database.spaceMembership.findUniqueOrThrow({
        where: {
          spaceId_userId: {
            spaceId: delegatedSpaceId,
            userId: candidateUserId,
          },
        },
        select: { role: true, status: true },
      }),
    ).resolves.toEqual({ role: "viewer", status: "active" });

    const managedSpacePath = buildPath(ORGANIZATION_SPACE_PATH_TEMPLATE, {
      organizationId: installation.organizationId,
      spaceId: delegatedSpaceId,
    });
    await expectProblem(
      await fetch(`${testApi.baseUrl}${managedSpacePath}`, {
        body: JSON.stringify({
          name: "Renamed by delegated administrator",
          status: "archived",
        }),
        headers: mutationHeaders(delegated),
        method: "PATCH",
      }),
      403,
      "forbidden",
    );
    const managedSpacesPath = buildPath(ORGANIZATION_SPACES_PATH_TEMPLATE, {
      organizationId: installation.organizationId,
    });
    await expectProblem(
      await fetch(`${testApi.baseUrl}${managedSpacesPath}`, {
        body: JSON.stringify({ name: "Unauthorized space" }),
        headers: mutationHeaders(delegated),
        method: "POST",
      }),
      403,
      "forbidden",
    );
    await expect(
      database.space.findUniqueOrThrow({
        where: { id: delegatedSpaceId },
        select: { name: true, status: true },
      }),
    ).resolves.toEqual({ name: "Delegated Space", status: "active" });
  });

  test("rejects a foreign space identifier under a managed organization path without mutating the foreign space", async () => {
    const installation = await initialize();
    const owner = await login(installation.loginIdentifier);
    const foreignOrganizationId = randomUUID();
    await database.organization.create({
      data: {
        id: foreignOrganizationId,
        name: "Foreign Organization",
        status: "active",
      },
    });
    const foreignLoginIdentifier = `foreign-admin-${randomUUID()}@example.test`;
    const foreignUserId = createdUserId(
      await operations.execute({
        operation: "create-user",
        organizationId: foreignOrganizationId,
        loginIdentifier: foreignLoginIdentifier,
        password,
      }),
    );
    const foreignSpaceId = createdSpaceId(
      await operations.execute({
        operation: "create-space",
        adminUserId: foreignUserId,
        name: "Foreign Space",
        organizationId: foreignOrganizationId,
      }),
    );
    const mismatchedPath = buildPath(ORGANIZATION_SPACE_PATH_TEMPLATE, {
      organizationId: installation.organizationId,
      spaceId: foreignSpaceId,
    });

    const rejected = await fetch(`${testApi.baseUrl}${mismatchedPath}`, {
      body: JSON.stringify({ status: "archived" }),
      headers: mutationHeaders(owner),
      method: "PATCH",
    });
    await expectProblem(rejected, 404, "not-found");

    const foreignAdmin = await login(foreignLoginIdentifier);
    const foreignSpacePath = buildPath(ORGANIZATION_SPACE_PATH_TEMPLATE, {
      organizationId: foreignOrganizationId,
      spaceId: foreignSpaceId,
    });
    const targetResponse = await fetch(
      `${testApi.baseUrl}${foreignSpacePath}`,
      { headers: { Cookie: foreignAdmin.cookie } },
    );
    expect(targetResponse.status).toBe(200);
    expect(
      managedSpaceSummarySchema.parse(await targetResponse.json()),
    ).toEqual({
      organizationId: foreignOrganizationId,
      spaceId: foreignSpaceId,
      spaceName: "Foreign Space",
      status: "active",
    });
  });

  test.each<InvalidatedAccessLayer>([
    "user",
    "organization",
    "organization-membership",
    "space",
    "space-membership",
  ])("requires an active %s layer for the authorized space list", async (layer) => {
    const graph = await createMemberGraph();
    const { cookie } = await login(graph.loginIdentifier);
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
    const { cookie } = await login(installation.loginIdentifier);

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
    const { cookie } = await login(installation.loginIdentifier);
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
    const { cookie } = await login(installation.loginIdentifier);

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
    const { cookie } = await login(graph.loginIdentifier);
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
