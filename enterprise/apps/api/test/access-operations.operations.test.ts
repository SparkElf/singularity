import { randomBytes, randomUUID } from "node:crypto";
import { PassThrough, Readable } from "node:stream";

import {
  type AccessOperation,
  type AccessOperationResult,
  accessOperationResultSchemaByOperation,
} from "@singularity/contracts";
import {
  DatabaseRuntime,
  type DatabaseClient,
} from "@singularity/database";
import { isolatedDatabaseUrl } from "@singularity/database/testing/postgres";
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
import { runAccessOperationsApplication } from "../src/operations/application.js";
import { runAccessOperation } from "../src/operations/runner.js";
import { CapturingLogger } from "./support/capturing-logger.js";
import {
  startTestApiApplication,
  type TestApiApplication,
} from "./support/test-app.js";
import { testAuditConfiguration } from "./support/audit-configuration.js";
import { truncateTestDatabase } from "./support/database.js";

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

async function runProductionOperation(
  databaseUrl: string,
  command: AccessOperation,
): Promise<OperationRun> {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const exitCode = await runAccessOperationsApplication({
    auditConfiguration: testAuditConfiguration(),
    databaseUrl,
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
    await truncateTestDatabase(database);
    logger.clear();
  });

  afterAll(async () => {
    await testApi.dispose();
  });

  test("serializes concurrent initialization into one complete installation", async () => {
    const [first, second] = await Promise.all([
      runOperation(operations, {
        operation: "initialize",
        loginIdentifier: `owner-a-${randomUUID()}@example.test`,
        password,
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
  });

  test("writes one sanitized operation result line and access diagnostic", async () => {
    const secretSentinel = "initial-password-secret-sentinel";
    const run = await runOperation(operations, {
      operation: "initialize",
      loginIdentifier: `sanitized-owner-${randomUUID()}@example.test`,
      password: `${password}-${secretSentinel}`,
      organizationName: "Sanitized Organization",
      spaceName: "Sanitized Space",
    });

    expect(run.exitCode).toBe(0);
    expect(run.result.outcome).toBe("created");
    expect(run.stdout.endsWith("\n")).toBe(true);
    expect(run.stdout.trimEnd().includes("\n")).toBe(false);
    expect(run.stderr).toBe("");
    expect(`${run.stdout}${run.stderr}${logger.output}`).not.toContain(
      secretSentinel,
    );
    expect(logger.output).toContain("access.operation");
  });

  test("runs the production operations composition root with real service lifecycle", async () => {
    const targetSpaceId = randomUUID();
    const run = await runProductionOperation(isolatedDatabaseUrl(), {
      operation: "disable-space",
      spaceId: targetSpaceId,
    });

    expect(run).toMatchObject({
      exitCode: 2,
      result: { outcome: "not-found" },
    });
    expect(run.stdout.endsWith("\n")).toBe(true);
    expect(run.stderr).toContain("access.operation");
    expect(run.stderr).toContain(targetSpaceId);
  });

  test("sanitizes production composition-root database failures", async () => {
    const databaseSentinel = "database-configuration-secret-sentinel";
    const deploymentSentinel = "deployment-secret-sentinel";
    const versionSentinel = "version-secret-sentinel";
    const run = await runProductionOperation(
      `invalid-database-url-${databaseSentinel}`,
      {
        operation: "set-kernel-state",
        spaceId: randomUUID(),
        kernelState: "ready",
        deploymentHandle: deploymentSentinel,
        version: versionSentinel,
      },
    );

    expect(run).toMatchObject({ exitCode: 1, result: { outcome: "failed" } });
    expect(run.stderr).toContain("access.operation");
    for (const sentinel of [
      databaseSentinel,
      deploymentSentinel,
      versionSentinel,
    ]) {
      expect(`${run.stdout}${run.stderr}`).not.toContain(sentinel);
    }
  });

  test.each([
    {
      label: "create-user organization",
      command: {
        operation: "create-user",
        organizationId: randomUUID(),
        loginIdentifier: `missing-organization-${randomUUID()}@example.test`,
        password,
      },
    },
    {
      label: "create-space administrator",
      command: {
        operation: "create-space",
        organizationId: randomUUID(),
        name: "Missing Administrator",
        adminUserId: randomUUID(),
      },
    },
    {
      label: "set-kernel-state space",
      command: {
        operation: "set-kernel-state",
        spaceId: randomUUID(),
        kernelState: "starting",
      },
    },
    {
      label: "set-space-member space",
      command: {
        operation: "set-space-member",
        spaceId: randomUUID(),
        userId: randomUUID(),
        role: "viewer",
      },
    },
    {
      label: "revoke-space-member space",
      command: {
        operation: "revoke-space-member",
        spaceId: randomUUID(),
        userId: randomUUID(),
      },
    },
    {
      label: "disable-organization organization",
      command: {
        operation: "disable-organization",
        organizationId: randomUUID(),
      },
    },
    {
      label: "disable-space space",
      command: {
        operation: "disable-space",
        spaceId: randomUUID(),
      },
    },
    {
      label: "revoke-organization-member user",
      command: {
        operation: "revoke-organization-member",
        organizationId: randomUUID(),
        userId: randomUUID(),
      },
    },
    {
      label: "disable-user user",
      command: { operation: "disable-user", userId: randomUUID() },
    },
    {
      label: "revoke-user-sessions user",
      command: { operation: "revoke-user-sessions", userId: randomUUID() },
    },
  ] satisfies ReadonlyArray<{ label: string; command: AccessOperation }>)(
    "returns not-found for a missing $label",
    async ({ command }) => {
      const run = await runOperation(operations, command);

      expect(run).toMatchObject({
        exitCode: 2,
        result: { outcome: "not-found" },
        stderr: "",
      });
    },
  );

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

    test("keeps repeatable state and revocation operations idempotent", async () => {
      const userId = createdUserId(
        (
          await runOperation(operations, {
            operation: "create-user",
            organizationId: installation.organizationId,
            loginIdentifier: `idempotent-user-${randomUUID()}@example.test`,
            password,
          })
        ).result,
      );
      await runOperation(operations, {
        operation: "set-space-member",
        spaceId: installation.spaceId,
        userId,
        role: "viewer",
      });

      const repeatable = [
        {
          command: {
            operation: "set-kernel-state",
            spaceId: installation.spaceId,
            kernelState: "starting",
          },
          outcome: "updated",
        },
        {
          command: {
            operation: "revoke-space-member",
            spaceId: installation.spaceId,
            userId,
          },
          outcome: "revoked",
        },
        {
          command: { operation: "revoke-user-sessions", userId },
          outcome: "revoked",
        },
        {
          command: {
            operation: "revoke-organization-member",
            organizationId: installation.organizationId,
            userId,
          },
          outcome: "revoked",
        },
        {
          command: { operation: "disable-user", userId },
          outcome: "updated",
        },
        {
          command: {
            operation: "disable-space",
            spaceId: installation.spaceId,
          },
          outcome: "updated",
        },
        {
          command: {
            operation: "disable-organization",
            organizationId: installation.organizationId,
          },
          outcome: "updated",
        },
      ] as const satisfies ReadonlyArray<{
        command: AccessOperation;
        outcome: AccessOperationResult["outcome"];
      }>;

      for (const { command, outcome } of repeatable) {
        const first = await runOperation(operations, command);
        const second = await runOperation(operations, command);
        expect(first.result.outcome).toBe(outcome);
        expect(second.result.outcome).toBe(outcome);
      }
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
