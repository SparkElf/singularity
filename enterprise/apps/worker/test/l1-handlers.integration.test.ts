import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DatabaseRuntime,
  type DatabaseClient,
} from "@singularity/database";
import { isolatedDatabaseUrl } from "@singularity/database/testing/postgres";
import {
  createObjectKey,
  FileObjectStore,
  type ObjectKey,
} from "@singularity/object-store";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";

import {
  BackupSpaceHandler,
  RestoreSpaceHandler,
  type BackupKernelPort,
  type RestoreDeploymentPort,
} from "../src/l1-handlers.js";
import {
  WorkerJobError,
  type BackupSpaceJob,
  type RestoreSpaceJob,
} from "../src/worker.js";
import { CapturingWorkerLogger } from "./support/restore-deployment.js";

const MAXIMUM_BACKUP_BYTES = 1024 * 1024;
const ARCHIVE_BODY_SENTINEL = "private-document-body-sentinel";
const FAILURE_DETAIL_SENTINEL = "private-restore-failure-sentinel";
const roots: string[] = [];

interface ManagedSpaceFixture {
  organizationId: string;
  sourceSpaceId: string;
  userId: string;
}

interface RestoreFixture extends ManagedSpaceFixture {
  backupId: string;
  objectKey: ObjectKey;
  restoreId: string;
  targetKernelInstanceId: string;
  targetSpaceId: string;
}

function entries(
  logger: CapturingWorkerLogger,
  event: "backup.job" | "kernel.lifecycle",
): Readonly<Record<string, unknown>>[] {
  return logger.entries.filter((entry) => entry.event === event);
}

async function createManagedSpace(
  database: DatabaseClient,
): Promise<ManagedSpaceFixture> {
  const user = await database.user.create({
    data: {
      loginIdentifier: `worker-${randomUUID()}@example.test`,
      passwordDigest: "test-password-digest",
      status: "active",
    },
  });
  const organization = await database.organization.create({
    data: { name: `Worker ${randomUUID()}`, status: "active" },
  });
  await database.organizationMembership.create({
    data: {
      organizationId: organization.id,
      role: "owner",
      status: "active",
      userId: user.id,
    },
  });
  const sourceSpace = await database.space.create({
    data: {
      name: `Source ${randomUUID()}`,
      organizationId: organization.id,
      status: "active",
    },
  });
  await database.spaceMembership.create({
    data: {
      organizationId: organization.id,
      role: "admin",
      spaceId: sourceSpace.id,
      status: "active",
      userId: user.id,
    },
  });
  return {
    organizationId: organization.id,
    sourceSpaceId: sourceSpace.id,
    userId: user.id,
  };
}

function backupJob(
  fixture: ManagedSpaceFixture,
  backupId: string,
): BackupSpaceJob {
  return {
    attempt: 1,
    backupId,
    id: randomUUID(),
    kind: "backup-space",
    leaseExpiresAt: new Date("2026-07-19T12:00:00.000Z"),
    organizationId: fixture.organizationId,
    requestId: randomUUID(),
    spaceId: fixture.sourceSpaceId,
  };
}

function restoreJob(fixture: RestoreFixture): RestoreSpaceJob {
  return {
    attempt: 1,
    backupId: fixture.backupId,
    id: randomUUID(),
    kind: "restore-space",
    leaseExpiresAt: new Date("2026-07-19T12:00:00.000Z"),
    organizationId: fixture.organizationId,
    requestId: randomUUID(),
    restoreId: fixture.restoreId,
    sourceSpaceId: fixture.sourceSpaceId,
    targetKernelInstanceId: fixture.targetKernelInstanceId,
    targetSpaceId: fixture.targetSpaceId,
  };
}

async function createRestoreFixture(
  database: DatabaseClient,
  objects: FileObjectStore,
): Promise<RestoreFixture> {
  const fixture = await createManagedSpace(database);
  const archive = Buffer.from(ARCHIVE_BODY_SENTINEL, "utf8");
  const sha256 = createHash("sha256").update(archive).digest("hex");
  const objectKey = createObjectKey();
  await objects.putBytes(objectKey, archive, sha256);
  const backup = await database.spaceBackup.create({
    data: {
      completedAt: new Date("2026-07-19T10:00:00.000Z"),
      createdByUserId: fixture.userId,
      formatVersion: 1,
      kernelVersion: "3.7.2",
      objectKey,
      organizationId: fixture.organizationId,
      sha256,
      sizeBytes: BigInt(archive.byteLength),
      sourceSpaceId: fixture.sourceSpaceId,
      status: "succeeded",
    },
  });
  const target = await database.space.create({
    data: {
      kernelInstance: {
        create: {
          deploymentHandle: null,
          status: "starting",
          version: null,
        },
      },
      name: `Restored ${randomUUID()}`,
      organizationId: fixture.organizationId,
      status: "archived",
    },
    select: { id: true, kernelInstance: { select: { id: true } } },
  });
  if (target.kernelInstance === null) {
    throw new Error("Restore fixture Kernel instance is unavailable");
  }
  await database.spaceMembership.create({
    data: {
      organizationId: fixture.organizationId,
      role: "admin",
      spaceId: target.id,
      status: "active",
      userId: fixture.userId,
    },
  });
  const restore = await database.spaceRestoreJob.create({
    data: {
      backupId: backup.id,
      createdByUserId: fixture.userId,
      organizationId: fixture.organizationId,
      sourceSpaceId: fixture.sourceSpaceId,
      status: "queued",
      targetSpaceId: target.id,
    },
  });
  return {
    ...fixture,
    backupId: backup.id,
    objectKey,
    restoreId: restore.id,
    targetKernelInstanceId: target.kernelInstance.id,
    targetSpaceId: target.id,
  };
}

async function consume(source: AsyncIterable<Uint8Array>): Promise<void> {
  for await (const chunk of source) {
    void chunk;
  }
}

describe("L1 backup and restore handler observability with PostgreSQL", () => {
  let database: DatabaseRuntime;
  let logger: CapturingWorkerLogger;
  let objects: FileObjectStore;
  let rootDirectory: string;

  beforeAll(() => {
    database = new DatabaseRuntime(isolatedDatabaseUrl());
  });

  beforeEach(async () => {
    rootDirectory = await mkdtemp(join(tmpdir(), "worker-l1-observability-"));
    roots.push(rootDirectory);
    objects = await FileObjectStore.open({
      maximumObjectBytes: MAXIMUM_BACKUP_BYTES,
      rootDirectory,
    });
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

  it("records one committed backup result and treats its job replay as idempotent", async () => {
    const fixture = await createManagedSpace(database.client);
    const archive = Buffer.from(ARCHIVE_BODY_SENTINEL, "utf8");
    const sha256 = createHash("sha256").update(archive).digest("hex");
    const backup = await database.client.spaceBackup.create({
      data: {
        createdByUserId: fixture.userId,
        organizationId: fixture.organizationId,
        sourceSpaceId: fixture.sourceSpaceId,
        status: "queued",
      },
    });
    const job = backupJob(fixture, backup.id);
    let backupCalls = 0;
    const kernel: BackupKernelPort = {
      async createBackup() {
        backupCalls += 1;
        return {
          body: (async function* () {
            yield archive;
          })(),
          formatVersion: 1,
          kernelVersion: "3.7.2",
          sha256,
        };
      },
    };
    const handler = new BackupSpaceHandler(
      database,
      kernel,
      MAXIMUM_BACKUP_BYTES,
      objects,
      logger,
    );

    await handler.execute(job, new AbortController().signal);
    await handler.execute(job, new AbortController().signal);

    const persisted = await database.client.spaceBackup.findUniqueOrThrow({
      where: { id: backup.id },
    });
    expect(persisted).toMatchObject({ status: "succeeded", sha256 });
    expect(persisted.objectKey).not.toBeNull();
    expect(backupCalls).toBe(1);
    expect(entries(logger, "backup.job")).toEqual([
      expect.objectContaining({
        objectKey: persisted.objectKey,
        reason: job.kind,
        requestId: job.requestId,
        spaceId: fixture.sourceSpaceId,
        status: "running",
        taskId: backup.id,
        taskKind: "backup",
        validationResult: "pending",
      }),
      expect.objectContaining({
        elapsedMs: expect.any(Number),
        objectKey: persisted.objectKey,
        reason: job.kind,
        requestId: job.requestId,
        spaceId: fixture.sourceSpaceId,
        status: "succeeded",
        taskId: backup.id,
        taskKind: "backup",
        validationResult: "passed",
      }),
    ]);
    const output = JSON.stringify(logger.entries);
    expect(output).not.toContain(ARCHIVE_BODY_SENTINEL);
    expect(output).not.toContain(rootDirectory);
  });

  it("records restore validation and the committed Kernel transition once", async () => {
    const fixture = await createRestoreFixture(database.client, objects);
    const job = restoreJob(fixture);
    let restoreCalls = 0;
    const deployment: RestoreDeploymentPort = {
      async destroyTarget() {
        throw new Error("Successful restore must not clean its target");
      },
      async restore(input) {
        restoreCalls += 1;
        await consume(input.archive);
        return {
          endpoint: {
            handle: `restore-${fixture.targetKernelInstanceId}`,
            hostname: "127.0.0.1",
            kernelInstanceId: fixture.targetKernelInstanceId,
            port: 8443,
            serverName: "kernel.restore.test",
            spaceId: fixture.targetSpaceId,
            tlsProfile: "restore-test",
          },
          kernelVersion: "3.7.2",
        };
      },
    };
    const handler = new RestoreSpaceHandler(
      database,
      deployment,
      MAXIMUM_BACKUP_BYTES,
      objects,
      logger,
    );

    await handler.execute(job, new AbortController().signal);
    await expect(
      handler.execute(job, new AbortController().signal),
    ).resolves.toBeUndefined();

    expect(restoreCalls).toBe(1);
    await expect(
      database.client.spaceRestoreJob.findUniqueOrThrow({
        where: { id: fixture.restoreId },
      }),
    ).resolves.toMatchObject({
      status: "ready-for-activation",
      targetSpaceId: fixture.targetSpaceId,
    });
    await expect(
      database.client.kernelInstance.findUniqueOrThrow({
        where: { id: fixture.targetKernelInstanceId },
      }),
    ).resolves.toMatchObject({ status: "ready", version: "3.7.2" });
    expect(entries(logger, "backup.job")).toEqual([
      expect.objectContaining({
        objectKey: fixture.objectKey,
        requestId: job.requestId,
        spaceId: fixture.sourceSpaceId,
        status: "restoring",
        targetSpaceId: fixture.targetSpaceId,
        taskId: fixture.restoreId,
        taskKind: "restore",
        validationResult: "pending",
      }),
      expect.objectContaining({
        elapsedMs: expect.any(Number),
        objectKey: fixture.objectKey,
        reason: job.kind,
        status: "ready-for-activation",
        validationResult: "passed",
      }),
    ]);
    expect(entries(logger, "kernel.lifecycle")).toEqual([
      expect.objectContaining({
        elapsedMs: expect.any(Number),
        fromState: "starting",
        kernelInstanceId: fixture.targetKernelInstanceId,
        reason: job.kind,
        requestId: job.requestId,
        spaceId: fixture.targetSpaceId,
        toState: "ready",
      }),
    ]);
    const output = JSON.stringify(logger.entries);
    expect(output).not.toContain(ARCHIVE_BODY_SENTINEL);
    expect(output).not.toContain(rootDirectory);
  });

  it("records the committed restoring state before revoked authorization cleanup", async () => {
    const fixture = await createRestoreFixture(database.client, objects);
    const job = restoreJob(fixture);
    await database.client.organizationMembership.update({
      where: {
        organizationId_userId: {
          organizationId: fixture.organizationId,
          userId: fixture.userId,
        },
      },
      data: { status: "inactive" },
    });
    let restoreCalls = 0;
    const deployment: RestoreDeploymentPort = {
      async destroyTarget() {},
      async restore() {
        restoreCalls += 1;
        throw new Error("Revoked restore must not start a deployment");
      },
    };
    const handler = new RestoreSpaceHandler(
      database,
      deployment,
      MAXIMUM_BACKUP_BYTES,
      objects,
      logger,
    );

    await expect(
      handler.execute(job, new AbortController().signal),
    ).rejects.toMatchObject<Partial<WorkerJobError>>({
      code: "restore-authorization-revoked",
    });

    expect(restoreCalls).toBe(0);
    await expect(
      database.client.spaceRestoreJob.findUniqueOrThrow({
        where: { id: fixture.restoreId },
      }),
    ).resolves.toMatchObject({
      failureCode: "restore-authorization-revoked",
      status: "failed",
      targetSpaceId: null,
    });
    expect(entries(logger, "backup.job")).toEqual([
      expect.objectContaining({
        objectKey: fixture.objectKey,
        reason: job.kind,
        requestId: job.requestId,
        status: "restoring",
        taskId: fixture.restoreId,
        validationResult: "pending",
      }),
      expect.objectContaining({
        objectKey: fixture.objectKey,
        reason: "restore-authorization-revoked",
        requestId: job.requestId,
        status: "failed",
        taskId: fixture.restoreId,
        validationResult: "not-completed",
      }),
    ]);
  });

  it("resumes a committed restore cleanup marker with its opaque object key", async () => {
    const fixture = await createRestoreFixture(database.client, objects);
    const job = restoreJob(fixture);
    await database.client.spaceRestoreJob.update({
      where: { id: fixture.restoreId },
      data: {
        failureCode: "restore-execution-failed",
        status: "restoring",
        workerAttempt: job.attempt,
        workerJobId: job.id,
      },
    });
    let destroyedTargets = 0;
    const deployment: RestoreDeploymentPort = {
      async destroyTarget() {
        destroyedTargets += 1;
      },
      async restore() {
        throw new Error("Committed cleanup must not restart a deployment");
      },
    };
    const handler = new RestoreSpaceHandler(
      database,
      deployment,
      MAXIMUM_BACKUP_BYTES,
      objects,
      logger,
    );

    await expect(
      handler.execute(job, new AbortController().signal),
    ).rejects.toMatchObject<Partial<WorkerJobError>>({
      code: "restore-execution-failed",
    });

    expect(destroyedTargets).toBe(1);
    await expect(
      database.client.spaceRestoreJob.findUniqueOrThrow({
        where: { id: fixture.restoreId },
      }),
    ).resolves.toMatchObject({
      failureCode: "restore-execution-failed",
      status: "failed",
      targetSpaceId: null,
    });
    expect(entries(logger, "backup.job")).toEqual([
      expect.objectContaining({
        objectKey: fixture.objectKey,
        reason: "restore-execution-failed",
        requestId: job.requestId,
        status: "failed",
        taskId: fixture.restoreId,
        validationResult: "not-completed",
      }),
    ]);
  });

  it("records failed restore cleanup without logging the thrown detail or host path", async () => {
    const fixture = await createRestoreFixture(database.client, objects);
    const job = restoreJob(fixture);
    let destroyedTargets = 0;
    const deployment: RestoreDeploymentPort = {
      async destroyTarget() {
        destroyedTargets += 1;
      },
      async restore(input) {
        await consume(input.archive);
        throw new Error(FAILURE_DETAIL_SENTINEL);
      },
    };
    const handler = new RestoreSpaceHandler(
      database,
      deployment,
      MAXIMUM_BACKUP_BYTES,
      objects,
      logger,
    );

    await expect(
      handler.execute(job, new AbortController().signal),
    ).rejects.toMatchObject<Partial<WorkerJobError>>({
      code: "restore-execution-failed",
    });
    await expect(
      handler.execute(job, new AbortController().signal),
    ).resolves.toBeUndefined();

    expect(destroyedTargets).toBe(1);
    await expect(
      database.client.spaceRestoreJob.findUniqueOrThrow({
        where: { id: fixture.restoreId },
      }),
    ).resolves.toMatchObject({ status: "failed", targetSpaceId: null });
    await expect(
      database.client.kernelInstance.findUnique({
        where: { id: fixture.targetKernelInstanceId },
      }),
    ).resolves.toBeNull();
    await expect(
      database.client.space.findUnique({ where: { id: fixture.targetSpaceId } }),
    ).resolves.toBeNull();
    const jobEntries = entries(logger, "backup.job");
    expect(jobEntries.map((entry) => entry.status)).toEqual([
      "restoring",
      "failed",
    ]);
    const failed = jobEntries.find(
      (entry) => entry.status === "failed",
    );
    expect(failed).toMatchObject({
      elapsedMs: expect.any(Number),
      objectKey: fixture.objectKey,
      reason: "restore-execution-failed",
      requestId: job.requestId,
      spaceId: fixture.sourceSpaceId,
      targetSpaceId: fixture.targetSpaceId,
      taskId: fixture.restoreId,
      taskKind: "restore",
      validationResult: "not-completed",
    });
    expect(entries(logger, "kernel.lifecycle")).toEqual([
      expect.objectContaining({
        fromState: "starting",
        kernelInstanceId: fixture.targetKernelInstanceId,
        reason: "restore-execution-failed",
        requestId: job.requestId,
        spaceId: fixture.targetSpaceId,
        toState: "removed",
      }),
    ]);
    const output = JSON.stringify(logger.entries);
    expect(output).not.toContain(ARCHIVE_BODY_SENTINEL);
    expect(output).not.toContain(FAILURE_DETAIL_SENTINEL);
    expect(output).not.toContain(rootDirectory);
  });
});
