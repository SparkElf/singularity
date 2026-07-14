import { randomBytes, randomUUID } from "node:crypto";
import { PassThrough, Readable } from "node:stream";

import {
  AUTHORIZED_SPACES_PATH,
  AUTH_CSRF_PATH,
  AUTH_LOGIN_PATH,
  AUTH_LOGOUT_PATH,
  DATABASE_READINESS_PATH,
  OPENAPI_DOCUMENT_PATH,
  SPACE_RUNTIME_PATH_TEMPLATE,
  type AccessOperation,
  type AccessOperationResult,
  accessOperationResultSchemaByOperation,
} from "@singularity/contracts";
import { DatabaseRuntime, type DatabaseClient } from "@singularity/database";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "vitest";

import { AccessOperationsService } from "../src/operations/access-operations.service.js";
import { runAccessOperation } from "../src/operations/runner.js";
import { CapturingLogger } from "./support/capturing-logger.js";
import {
  startTestApiApplication,
  type TestApiApplication,
} from "./support/test-app.js";

const password = "correct horse battery staple";

interface OperationRun {
  exitCode: 0 | 1 | 2;
  result: AccessOperationResult;
  stderr: string;
  stdout: string;
}

function streamText(stream: PassThrough): string {
  const chunk: unknown = stream.read();
  if (Buffer.isBuffer(chunk)) {
    return chunk.toString("utf8");
  }
  return typeof chunk === "string" ? chunk : "";
}

async function runOperation(
  service: AccessOperationsService,
  command: AccessOperation,
): Promise<OperationRun> {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const exitCode = await runAccessOperation({
    service,
    stderr,
    stdin: Readable.from([JSON.stringify(command)]),
    stdout,
  });
  const stdoutText = streamText(stdout);
  return {
    exitCode,
    result: accessOperationResultSchemaByOperation[command.operation].parse(
      JSON.parse(stdoutText),
    ),
    stderr: streamText(stderr),
    stdout: stdoutText,
  };
}

async function cleanDatabase(database: DatabaseClient): Promise<void> {
  await database.$transaction(async (transaction) => {
    await transaction.kernelInstance.deleteMany();
    await transaction.authSession.deleteMany();
    await transaction.spaceMembership.deleteMany();
    await transaction.space.deleteMany();
    await transaction.organizationMembership.deleteMany();
    await transaction.organization.deleteMany();
    await transaction.user.deleteMany();
    await transaction.systemInstallation.deleteMany();
  });
}

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

describe("controlled access operations with PostgreSQL", () => {
  let testApi: TestApiApplication;
  let database: DatabaseClient;
  let logger: CapturingLogger;
  let operations: AccessOperationsService;

  beforeAll(async () => {
    logger = new CapturingLogger();
    testApi = await startTestApiApplication({ logger });
    database = testApi.app.get(DatabaseRuntime).client;
    operations = testApi.app.get(AccessOperationsService);
  });

  afterEach(async () => {
    await cleanDatabase(database);
    logger.clear();
  });

  afterAll(async () => {
    await testApi.dispose();
  });

  test("serializes concurrent initialization into one complete installation", async () => {
    const secretSentinel = "initial-password-secret-sentinel";
    const [first, second] = await Promise.all([
      runOperation(operations, {
        operation: "initialize",
        loginIdentifier: `owner-a-${randomUUID()}@example.test`,
        password: `${password}-${secretSentinel}`,
        organizationName: "Singularity Research",
        spaceName: "Primary Knowledge",
      }),
      runOperation(operations, {
        operation: "initialize",
        loginIdentifier: `owner-b-${randomUUID()}@example.test`,
        password: `${password}-second-owner`,
        organizationName: "Competing Organization",
        spaceName: "Competing Space",
      }),
    ]);

    expect([first.result.outcome, second.result.outcome].sort()).toEqual([
      "already-initialized",
      "created",
    ]);
    expect([first.exitCode, second.exitCode].sort()).toEqual([0, 2]);
    const created = createdInstallation(
      first.result.outcome === "created" ? first.result : second.result,
    );
    const installation = await database.systemInstallation.findMany();
    const user = await database.user.findUnique({
      where: { id: created.userId },
    });
    const organizationMembership =
      await database.organizationMembership.findUnique({
        where: {
          organizationId_userId: {
            organizationId: created.organizationId,
            userId: created.userId,
          },
        },
      });
    const spaceMembership = await database.spaceMembership.findUnique({
      where: {
        spaceId_userId: {
          spaceId: created.spaceId,
          userId: created.userId,
        },
      },
    });
    const kernel = await database.kernelInstance.findUnique({
      where: { spaceId: created.spaceId },
    });

    expect(installation).toHaveLength(1);
    expect(installation[0]?.id).toBe(1);
    expect(await database.user.count()).toBe(1);
    expect(await database.organization.count()).toBe(1);
    expect(await database.space.count()).toBe(1);
    expect(user).toMatchObject({ id: created.userId, status: "active" });
    expect(organizationMembership).toMatchObject({
      organizationId: created.organizationId,
      role: "owner",
      status: "active",
      userId: created.userId,
    });
    expect(spaceMembership).toMatchObject({
      organizationId: created.organizationId,
      role: "admin",
      spaceId: created.spaceId,
      status: "active",
      userId: created.userId,
    });
    expect(kernel).toMatchObject({
      deploymentHandle: null,
      spaceId: created.spaceId,
      status: "starting",
      version: null,
    });
    for (const run of [first, second]) {
      expect(run.stdout.endsWith("\n")).toBe(true);
      expect(run.stdout.trimEnd().includes("\n")).toBe(false);
      expect(run.stderr).toBe("");
      expect(`${run.stdout}${run.stderr}`).not.toContain(secretSentinel);
    }
    expect(logger.output).toContain("access.operation");
    expect(logger.output).not.toContain(secretSentinel);

    const openApiResponse = await fetch(
      `${testApi.baseUrl}${OPENAPI_DOCUMENT_PATH}`,
    );
    const openApi = (await openApiResponse.json()) as {
      paths: Record<string, unknown>;
    };
    expect(Object.keys(openApi.paths).sort()).toEqual(
      [
        AUTHORIZED_SPACES_PATH,
        AUTH_CSRF_PATH,
        AUTH_LOGIN_PATH,
        AUTH_LOGOUT_PATH,
        DATABASE_READINESS_PATH,
        SPACE_RUNTIME_PATH_TEMPLATE,
      ].sort(),
    );
  });

  test("rolls back initialization when a later unique write fails", async () => {
    const loginIdentifier = `existing-${randomUUID()}@example.test`;
    await database.user.create({
      data: {
        loginIdentifier,
        passwordDigest: "preexisting-digest-sentinel",
        status: "active",
      },
    });

    const run = await runOperation(operations, {
      operation: "initialize",
      loginIdentifier,
      password,
      organizationName: "Must Roll Back",
      spaceName: "Must Roll Back",
    });

    expect(run.exitCode).toBe(2);
    expect(run.result).toMatchObject({ outcome: "conflict" });
    expect(run.stderr).toBe("");
    expect(await database.systemInstallation.count()).toBe(0);
    expect(await database.user.count()).toBe(1);
    expect(await database.organization.count()).toBe(0);
    expect(await database.organizationMembership.count()).toBe(0);
    expect(await database.space.count()).toBe(0);
    expect(await database.spaceMembership.count()).toBe(0);
    expect(await database.kernelInstance.count()).toBe(0);
  });

  describe("post-initialization operation states", () => {
    let installation: ReturnType<typeof createdInstallation>;

    beforeEach(async () => {
      const initialized = await runOperation(operations, {
        operation: "initialize",
        loginIdentifier: `owner-${randomUUID()}@example.test`,
        password,
        organizationName: "Singularity",
        spaceName: "Home",
      });
      expect(initialized.exitCode).toBe(0);
      installation = createdInstallation(initialized.result);
    });

    test("create-user persists an active organization member and rejects a duplicate identifier", async () => {
      const loginIdentifier = `member-${randomUUID()}@example.test`;
      const created = await runOperation(operations, {
        operation: "create-user",
        organizationId: installation.organizationId,
        loginIdentifier,
        password,
      });
      const userId = createdUserId(created.result);
      const duplicate = await runOperation(operations, {
        operation: "create-user",
        organizationId: installation.organizationId,
        loginIdentifier,
        password,
      });

      expect(created.exitCode).toBe(0);
      expect(duplicate).toMatchObject({
        exitCode: 2,
        result: { outcome: "conflict" },
      });
      await expect(
        database.user.findUnique({ where: { id: userId } }),
      ).resolves.toMatchObject({ status: "active" });
      await expect(
        database.organizationMembership.findUnique({
          where: {
            organizationId_userId: {
              organizationId: installation.organizationId,
              userId,
            },
          },
        }),
      ).resolves.toMatchObject({ role: "member", status: "active" });
    });

    test("create-space persists an admin membership and a starting Kernel instance", async () => {
      const createdUser = await runOperation(operations, {
        operation: "create-user",
        organizationId: installation.organizationId,
        loginIdentifier: `space-admin-${randomUUID()}@example.test`,
        password,
      });
      const adminUserId = createdUserId(createdUser.result);
      const created = await runOperation(operations, {
        operation: "create-space",
        organizationId: installation.organizationId,
        name: "Operations Space",
        adminUserId,
      });
      const spaceId = createdSpaceId(created.result);

      expect(created.exitCode).toBe(0);
      await expect(
        database.space.findUnique({ where: { id: spaceId } }),
      ).resolves.toMatchObject({
        organizationId: installation.organizationId,
        status: "active",
      });
      await expect(
        database.spaceMembership.findUnique({
          where: { spaceId_userId: { spaceId, userId: adminUserId } },
        }),
      ).resolves.toMatchObject({ role: "admin", status: "active" });
      await expect(
        database.kernelInstance.findUnique({ where: { spaceId } }),
      ).resolves.toMatchObject({
        deploymentHandle: null,
        status: "starting",
        version: null,
      });
    });

    test("space membership can be created, updated, revoked, and reactivated", async () => {
      const createdUser = await runOperation(operations, {
        operation: "create-user",
        organizationId: installation.organizationId,
        loginIdentifier: `space-member-${randomUUID()}@example.test`,
        password,
      });
      const userId = createdUserId(createdUser.result);
      const created = await runOperation(operations, {
        operation: "set-space-member",
        spaceId: installation.spaceId,
        userId,
        role: "viewer",
      });
      const updated = await runOperation(operations, {
        operation: "set-space-member",
        spaceId: installation.spaceId,
        userId,
        role: "editor",
      });
      await expect(
        database.spaceMembership.findUnique({
          where: {
            spaceId_userId: { spaceId: installation.spaceId, userId },
          },
        }),
      ).resolves.toMatchObject({ role: "editor", status: "active" });

      const revoked = await runOperation(operations, {
        operation: "revoke-space-member",
        spaceId: installation.spaceId,
        userId,
      });
      await expect(
        database.spaceMembership.findUnique({
          where: {
            spaceId_userId: { spaceId: installation.spaceId, userId },
          },
        }),
      ).resolves.toMatchObject({ status: "inactive" });

      const reactivated = await runOperation(operations, {
        operation: "set-space-member",
        spaceId: installation.spaceId,
        userId,
        role: "admin",
      });

      expect(created.result.outcome).toBe("created");
      expect(updated.result.outcome).toBe("updated");
      expect(revoked.result.outcome).toBe("revoked");
      expect(reactivated.result.outcome).toBe("updated");
      await expect(
        database.spaceMembership.findUnique({
          where: {
            spaceId_userId: { spaceId: installation.spaceId, userId },
          },
        }),
      ).resolves.toMatchObject({ role: "admin", status: "active" });
    });

    test("set-kernel-state persists all three authoritative states and clears starting deployment fields", async () => {
      const ready = await runOperation(operations, {
        operation: "set-kernel-state",
        spaceId: installation.spaceId,
        kernelState: "ready",
        deploymentHandle: "kernel.operations-01",
        version: "3.2.1",
      });
      expect(ready.result.outcome).toBe("updated");
      await expect(
        database.kernelInstance.findUnique({
          where: { spaceId: installation.spaceId },
        }),
      ).resolves.toMatchObject({
        deploymentHandle: "kernel.operations-01",
        status: "ready",
        version: "3.2.1",
      });

      const unavailable = await runOperation(operations, {
        operation: "set-kernel-state",
        spaceId: installation.spaceId,
        kernelState: "unavailable",
        deploymentHandle: "kernel.operations-02",
        version: "3.2.2-rc.1",
      });
      expect(unavailable.result.outcome).toBe("updated");
      await expect(
        database.kernelInstance.findUnique({
          where: { spaceId: installation.spaceId },
        }),
      ).resolves.toMatchObject({
        deploymentHandle: "kernel.operations-02",
        status: "unavailable",
        version: "3.2.2-rc.1",
      });

      const starting = await runOperation(operations, {
        operation: "set-kernel-state",
        spaceId: installation.spaceId,
        kernelState: "starting",
      });
      expect(starting.result.outcome).toBe("updated");
      await expect(
        database.kernelInstance.findUnique({
          where: { spaceId: installation.spaceId },
        }),
      ).resolves.toMatchObject({
        deploymentHandle: null,
        status: "starting",
        version: null,
      });
    });

    test("revoke-user-sessions revokes every active session for the user", async () => {
      const createdUser = await runOperation(operations, {
        operation: "create-user",
        organizationId: installation.organizationId,
        loginIdentifier: `session-user-${randomUUID()}@example.test`,
        password,
      });
      const userId = createdUserId(createdUser.result);
      const expiresAt = new Date(Date.now() + 60 * 60 * 1_000);
      await database.authSession.createMany({
        data: Array.from({ length: 2 }, () => ({
          absoluteExpiresAt: expiresAt,
          csrfDigest: randomBytes(32).toString("hex"),
          idleExpiresAt: expiresAt,
          tokenDigest: randomBytes(32).toString("hex"),
          userId,
        })),
      });

      const revoked = await runOperation(operations, {
        operation: "revoke-user-sessions",
        userId,
      });

      expect(revoked.result.outcome).toBe("revoked");
      expect(
        await database.authSession.count({
          where: { userId, revokedAt: { not: null } },
        }),
      ).toBe(2);
    });

    test("revoke-organization-member rejects an active owner", async () => {
      const rejected = await runOperation(operations, {
        operation: "revoke-organization-member",
        organizationId: installation.organizationId,
        userId: installation.userId,
      });

      expect(rejected).toMatchObject({
        exitCode: 2,
        result: { outcome: "conflict" },
      });
      await expect(
        database.organizationMembership.findUnique({
          where: {
            organizationId_userId: {
              organizationId: installation.organizationId,
              userId: installation.userId,
            },
          },
        }),
      ).resolves.toMatchObject({ role: "owner", status: "active" });
    });

    test("disable-user rejects an active owner", async () => {
      const rejected = await runOperation(operations, {
        operation: "disable-user",
        userId: installation.userId,
      });

      expect(rejected).toMatchObject({
        exitCode: 2,
        result: { outcome: "conflict" },
      });
      await expect(
        database.user.findUnique({ where: { id: installation.userId } }),
      ).resolves.toMatchObject({ status: "active" });
    });

    test("revoke-organization-member deactivates the organization and space memberships", async () => {
      const createdUser = await runOperation(operations, {
        operation: "create-user",
        organizationId: installation.organizationId,
        loginIdentifier: `revoked-member-${randomUUID()}@example.test`,
        password,
      });
      const userId = createdUserId(createdUser.result);
      await runOperation(operations, {
        operation: "set-space-member",
        spaceId: installation.spaceId,
        userId,
        role: "editor",
      });

      const revoked = await runOperation(operations, {
        operation: "revoke-organization-member",
        organizationId: installation.organizationId,
        userId,
      });

      expect(revoked.result.outcome).toBe("revoked");
      await expect(
        database.organizationMembership.findUnique({
          where: {
            organizationId_userId: {
              organizationId: installation.organizationId,
              userId,
            },
          },
        }),
      ).resolves.toMatchObject({ status: "inactive" });
      await expect(
        database.spaceMembership.findUnique({
          where: {
            spaceId_userId: { spaceId: installation.spaceId, userId },
          },
        }),
      ).resolves.toMatchObject({ status: "inactive" });
    });

    test("disable-user disables a non-owner and revokes active sessions", async () => {
      const createdUser = await runOperation(operations, {
        operation: "create-user",
        organizationId: installation.organizationId,
        loginIdentifier: `disabled-user-${randomUUID()}@example.test`,
        password,
      });
      const userId = createdUserId(createdUser.result);
      const expiresAt = new Date(Date.now() + 60 * 60 * 1_000);
      const session = await database.authSession.create({
        data: {
          absoluteExpiresAt: expiresAt,
          csrfDigest: randomBytes(32).toString("hex"),
          idleExpiresAt: expiresAt,
          tokenDigest: randomBytes(32).toString("hex"),
          userId,
        },
      });

      const disabled = await runOperation(operations, {
        operation: "disable-user",
        userId,
      });

      expect(disabled.result.outcome).toBe("updated");
      await expect(
        database.user.findUnique({ where: { id: userId } }),
      ).resolves.toMatchObject({ status: "disabled" });
      const revokedSession = await database.authSession.findUnique({
        where: { id: session.id },
      });
      expect(revokedSession?.revokedAt).toBeInstanceOf(Date);
    });

    test("disable-space persists the disabled state", async () => {
      const disabled = await runOperation(operations, {
        operation: "disable-space",
        spaceId: installation.spaceId,
      });

      expect(disabled.result.outcome).toBe("updated");
      await expect(
        database.space.findUnique({ where: { id: installation.spaceId } }),
      ).resolves.toMatchObject({ status: "disabled" });
    });

    test("disable-organization persists the disabled state", async () => {
      const disabled = await runOperation(operations, {
        operation: "disable-organization",
        organizationId: installation.organizationId,
      });

      expect(disabled.result.outcome).toBe("updated");
      await expect(
        database.organization.findUnique({
          where: { id: installation.organizationId },
        }),
      ).resolves.toMatchObject({ status: "disabled" });
    });
  });
});
