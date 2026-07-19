import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import {
  DatabaseRuntime,
  type DatabaseClient,
} from "@singularity/database";
import { isolatedDatabaseUrl } from "@singularity/database/testing/postgres";
import {
  KERNEL_DEPLOYMENT_CHANGED_CHANNEL,
  parseKernelDeploymentChangedEvent,
  RuntimeKernelDeploymentRegistry,
} from "@singularity/kernel-client";
import { createObjectKey } from "@singularity/object-store";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";

import { ProcessRestoreDeployment } from "../src/restore-deployment.js";
import { RestorePlatformModule } from "../src/restore-platform.module.js";
import { RESTORE_DEPLOYMENT } from "../src/tokens.js";
import { WorkerPlatformModule } from "../src/worker-platform.module.js";
import {
  CapturingWorkerLogger,
  restoreDeploymentConfiguration,
} from "./support/restore-deployment.js";

const roots: string[] = [];

class CountingDatabaseRuntime extends DatabaseRuntime {
  shutdownCalls = 0;

  override async onApplicationShutdown(): Promise<void> {
    this.shutdownCalls += 1;
    await super.onApplicationShutdown();
  }
}

@Module({})
class RestorePlatformIntegrationModule {}

async function createReadyKernel(
  database: DatabaseClient,
  organizationId: string,
  spaceStatus: "active" | "archived",
) {
  const handle = `restore-test-${randomUUID()}`;
  const space = await database.space.create({
    data: {
      kernelInstance: {
        create: {
          deploymentHandle: handle,
          status: "ready",
          version: "3.7.2",
        },
      },
      name: `Reconcile ${randomUUID()}`,
      organizationId,
      status: spaceStatus,
    },
    select: { id: true, kernelInstance: { select: { id: true } } },
  });
  if (space.kernelInstance === null) {
    throw new Error("Ready Kernel fixture is unavailable");
  }
  await database.kernelRuntimeEndpoint.create({
    data: {
      hostname: "127.0.0.1",
      kernelInstanceId: space.kernelInstance.id,
      port: 58_443,
      serverName: "kernel.test",
      spaceId: space.id,
      tlsProfile: "restore-test",
    },
  });
  return {
    handle,
    kernelInstanceId: space.kernelInstance.id,
    spaceId: space.id,
  };
}

async function observeNextDeploymentChange(database: DatabaseRuntime) {
  let resolveNotification!: (payload: string) => void;
  let rejectNotification!: (error: Error) => void;
  const payload = new Promise<string>((resolve, reject) => {
    resolveNotification = resolve;
    rejectNotification = reject;
  });
  const subscription = await database.listen(
    KERNEL_DEPLOYMENT_CHANGED_CHANNEL,
    resolveNotification,
    rejectNotification,
  );
  return {
    close: () => subscription.close(),
    event: payload.then((value) =>
      parseKernelDeploymentChangedEvent(JSON.parse(value) as unknown),
    ),
  };
}

describe("ProcessRestoreDeployment startup reconciliation with PostgreSQL", () => {
  let database: CountingDatabaseRuntime;
  let logger: CapturingWorkerLogger;
  let rootDirectory: string;

  beforeAll(() => {
    database = new CountingDatabaseRuntime(isolatedDatabaseUrl());
  });

  beforeEach(async () => {
    rootDirectory = await mkdtemp(join(tmpdir(), "restore-reconciliation-"));
    roots.push(rootDirectory);
    logger = new CapturingWorkerLogger();
  });

  afterEach(async () => {
    await Promise.all(
      roots.splice(0).map((root) => rm(root, { force: true, recursive: true })),
    );
  });

  afterAll(async () => {
    await database.onApplicationShutdown();
  });

  it("keeps deployment identity when a stale ready Kernel becomes unavailable", async () => {
    const organization = await database.client.organization.create({
      data: { name: `Reconcile ${randomUUID()}`, status: "active" },
    });
    const fixture = await createReadyKernel(
      database.client,
      organization.id,
      "active",
    );
    const deployment = new ProcessRestoreDeployment(
      restoreDeploymentConfiguration(rootDirectory),
      database,
      new RuntimeKernelDeploymentRegistry([]),
      logger,
    );
    const notification = await observeNextDeploymentChange(database);

    const notificationEvent = await (async () => {
      try {
        await deployment.onModuleInit();
        const event = await notification.event;
        await deployment.onModuleInit();
        return event;
      } finally {
        await notification.close();
      }
    })();

    await expect(
      database.client.kernelRuntimeEndpoint.findUnique({
        where: { kernelInstanceId: fixture.kernelInstanceId },
      }),
    ).resolves.toBeNull();
    await expect(
      database.client.kernelInstance.findUniqueOrThrow({
        where: { id: fixture.kernelInstanceId },
      }),
    ).resolves.toMatchObject({
      deploymentHandle: fixture.handle,
      status: "unavailable",
      version: "3.7.2",
    });
    expect(logger.entries).toEqual([
      expect.objectContaining({
        event: "kernel.lifecycle",
        fromState: "ready",
        kernelInstanceId: fixture.kernelInstanceId,
        reason: "restore-runtime-lost",
        spaceId: fixture.spaceId,
        toState: "unavailable",
      }),
    ]);
    const lifecycle = logger.entries[0];
    if (lifecycle === undefined) {
      throw new Error("Kernel lifecycle reconciliation log is missing");
    }
    expect(notificationEvent).toEqual({
      kernelInstanceId: fixture.kernelInstanceId,
      kind: "remove",
      requestId: lifecycle.requestId,
      spaceId: fixture.spaceId,
    });
  });

  it("fails a ready restore and removes its isolated target once", async () => {
    const user = await database.client.user.create({
      data: {
        loginIdentifier: `reconcile-${randomUUID()}@example.test`,
        passwordDigest: "test-password-digest",
        status: "active",
      },
    });
    const organization = await database.client.organization.create({
      data: { name: `Reconcile ${randomUUID()}`, status: "active" },
    });
    await database.client.organizationMembership.create({
      data: {
        organizationId: organization.id,
        role: "owner",
        status: "active",
        userId: user.id,
      },
    });
    const sourceSpace = await database.client.space.create({
      data: {
        name: `Source ${randomUUID()}`,
        organizationId: organization.id,
        status: "active",
      },
    });
    const backup = await database.client.spaceBackup.create({
      data: {
        completedAt: new Date("2026-07-19T10:00:00.000Z"),
        createdByUserId: user.id,
        formatVersion: 1,
        kernelVersion: "3.7.2",
        objectKey: createObjectKey(),
        organizationId: organization.id,
        sha256: "a".repeat(64),
        sizeBytes: 1n,
        sourceSpaceId: sourceSpace.id,
        status: "succeeded",
      },
    });
    const fixture = await createReadyKernel(
      database.client,
      organization.id,
      "archived",
    );
    await database.client.spaceMembership.create({
      data: {
        organizationId: organization.id,
        role: "admin",
        spaceId: fixture.spaceId,
        status: "active",
        userId: user.id,
      },
    });
    const restore = await database.client.spaceRestoreJob.create({
      data: {
        backupId: backup.id,
        completedAt: new Date("2026-07-19T11:00:00.000Z"),
        createdByUserId: user.id,
        organizationId: organization.id,
        sourceSpaceId: sourceSpace.id,
        status: "ready-for-activation",
        targetSpaceId: fixture.spaceId,
      },
    });
    const deployment = new ProcessRestoreDeployment(
      restoreDeploymentConfiguration(rootDirectory),
      database,
      new RuntimeKernelDeploymentRegistry([]),
      logger,
    );
    const notification = await observeNextDeploymentChange(database);

    const notificationEvent = await (async () => {
      try {
        await deployment.onModuleInit();
        const event = await notification.event;
        await deployment.onModuleInit();
        return event;
      } finally {
        await notification.close();
      }
    })();

    await expect(
      database.client.spaceRestoreJob.findUniqueOrThrow({
        where: { id: restore.id },
      }),
    ).resolves.toMatchObject({
      failureCode: "restore-runtime-lost",
      status: "failed",
      targetSpaceId: null,
    });
    await expect(
      database.client.kernelInstance.findUnique({
        where: { id: fixture.kernelInstanceId },
      }),
    ).resolves.toBeNull();
    await expect(
      database.client.space.findUnique({ where: { id: fixture.spaceId } }),
    ).resolves.toBeNull();
    expect(logger.entries).toEqual([
      expect.objectContaining({
        elapsedMs: expect.any(Number),
        event: "backup.job",
        objectKey: null,
        reason: "restore-runtime-lost",
        requestId: expect.any(String),
        spaceId: sourceSpace.id,
        status: "failed",
        targetSpaceId: fixture.spaceId,
        taskId: restore.id,
        taskKind: "restore",
        validationResult: "passed",
      }),
      expect.objectContaining({
        elapsedMs: expect.any(Number),
        event: "kernel.lifecycle",
        fromState: "ready",
        kernelInstanceId: fixture.kernelInstanceId,
        reason: "restore-runtime-lost",
        requestId: expect.any(String),
        spaceId: fixture.spaceId,
        toState: "removed",
      }),
    ]);
    const backupLog = logger.entries.find((entry) => entry.event === "backup.job");
    const lifecycleLog = logger.entries.find(
      (entry) => entry.event === "kernel.lifecycle",
    );
    if (backupLog === undefined || lifecycleLog === undefined) {
      throw new Error("Restore reconciliation logs are missing");
    }
    expect(backupLog?.requestId).toBe(lifecycleLog?.requestId);
    expect(notificationEvent).toEqual({
      kernelInstanceId: fixture.kernelInstanceId,
      kind: "remove",
      requestId: lifecycleLog.requestId,
      spaceId: fixture.spaceId,
    });
  });

  it("shares production platform providers and closes their database once", async () => {
    const deployments = new RuntimeKernelDeploymentRegistry([]);
    const moduleDatabase = new CountingDatabaseRuntime(isolatedDatabaseUrl());
    const platformModule = WorkerPlatformModule.register(moduleDatabase, deployments);
    let application:
      | Awaited<ReturnType<typeof NestFactory.createApplicationContext>>
      | undefined;
    try {
      application = await NestFactory.createApplicationContext(
        {
          module: RestorePlatformIntegrationModule,
          imports: [
            platformModule,
            RestorePlatformModule.register(
              restoreDeploymentConfiguration(rootDirectory),
              platformModule,
            ),
          ],
        },
        { abortOnError: false, logger: false },
      );
      expect(application.get(RESTORE_DEPLOYMENT)).toBe(
        application.get(ProcessRestoreDeployment),
      );
      expect(application.get(RuntimeKernelDeploymentRegistry)).toBe(deployments);
      expect(application.get(DatabaseRuntime)).toBe(moduleDatabase);
      expect(moduleDatabase.shutdownCalls).toBe(0);
      expect(database.shutdownCalls).toBe(0);
    } finally {
      if (application === undefined) {
        await moduleDatabase.onApplicationShutdown();
      } else {
        await application.close();
      }
    }
    expect(moduleDatabase.shutdownCalls).toBe(1);
    expect(database.shutdownCalls).toBe(0);
  });
});
