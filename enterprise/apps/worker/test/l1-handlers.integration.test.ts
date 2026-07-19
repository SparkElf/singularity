import {
  createHash,
  createHmac,
  generateKeyPairSync,
  randomUUID,
} from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TLSSocket } from "node:tls";

import { kernelRoutePolicies } from "@singularity/authorization";
import {
  AuditWriter,
  DatabaseRuntime,
  Prisma,
  parseAuditConfiguration,
  type DatabaseClient,
} from "@singularity/database";
import { isolatedDatabaseUrl } from "@singularity/database/testing/postgres";
import {
  KERNEL_DEPLOYMENT_CHANGED_CHANNEL,
  KernelCredentialService,
  KernelPrivateClient,
  KernelRoutePolicyRegistry,
  parseKernelDeploymentChangedEvent,
  RuntimeKernelDeploymentRegistry,
} from "@singularity/kernel-client";
import {
  createObjectKey,
  FileObjectStore,
  parseObjectKey,
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
  ArchiveAuditHandler,
  BackupSpaceHandler,
  RestoreSpaceHandler,
  SampleKernelHandler,
  type BackupKernelPort,
  type RestoreDeploymentPort,
} from "../src/l1-handlers.js";
import { ContentAuditHandler } from "../src/content-audit-reconciliation.js";
import {
  KernelWorkerClient,
  WORKER_OBSERVATION_PATH,
} from "../src/kernel-worker-client.js";
import { PostgresWorkerJobRepository } from "../src/postgres-job-repository.js";
import {
  ArchiveAuditJobProducer,
  ContentAuditJobProducer,
  SampleKernelJobProducer,
} from "../src/scheduled-producers.js";
import { WorkerJobScheduler } from "../src/scheduler.js";
import {
  BoundedJobWorker,
  WorkerJobError,
  type BackupSpaceJob,
  type RestoreSpaceJob,
  type WorkerJobLogger,
} from "../src/worker.js";
import { CapturingWorkerLogger } from "./support/restore-deployment.js";

const MAXIMUM_BACKUP_BYTES = 1024 * 1024;
const ARCHIVE_BODY_SENTINEL = "private-document-body-sentinel";
const FAILURE_DETAIL_SENTINEL = "private-restore-failure-sentinel";
const roots: string[] = [];
const observationCertificate = readFileSync(
  new URL("../../api/test/fixtures/kernel-gateway.crt", import.meta.url),
);
const observationPrivateKey = readFileSync(
  new URL("../../api/test/fixtures/kernel-gateway.key", import.meta.url),
);
const OBSERVATION_SAMPLED_AT = "2026-07-19T10:00:00.000Z";

interface ObservationKernelRequest {
  authorized: boolean;
  method: string;
  path: string;
  requestId: string | undefined;
  serviceToken: string | undefined;
}

interface ObservationKernelFixture {
  client: KernelPrivateClient;
  deploymentHandle: string;
  dispose(): Promise<void>;
  requests: readonly ObservationKernelRequest[];
}

async function startObservationKernel(input: {
  beforeResponse?: () => Promise<void>;
  kernelInstanceId: string;
  spaceId: string;
}): Promise<ObservationKernelFixture> {
  const requests: ObservationKernelRequest[] = [];
  const server = createServer(
    {
      ca: observationCertificate,
      cert: observationCertificate,
      key: observationPrivateKey,
      minVersion: "TLSv1.3",
      rejectUnauthorized: true,
      requestCert: true,
    },
    async (request, response) => {
      requests.push({
        authorized:
          request.socket instanceof TLSSocket && request.socket.authorized,
        method: request.method ?? "",
        path: request.url ?? "",
        requestId:
          typeof request.headers["x-singularity-request-id"] === "string"
            ? request.headers["x-singularity-request-id"]
            : undefined,
        serviceToken:
          typeof request.headers["x-singularity-service-token"] === "string"
            ? request.headers["x-singularity-service-token"]
            : undefined,
      });
      try {
        await input.beforeResponse?.();
        response.statusCode = 200;
        response.setHeader("cache-control", "no-store");
        response.setHeader("content-type", "application/json");
        response.end(
          JSON.stringify({
            capacity: {
              assetBytes: "256",
              dataBytes: "1024",
              fileCount: "8",
              sampleDurationMilliseconds: 14,
              sampledAt: OBSERVATION_SAMPLED_AT,
            },
            health: {
              kernelVersion: "3.7.2",
              sampledAt: OBSERVATION_SAMPLED_AT,
              status: "ready",
            },
          }),
        );
      } catch {
        response.statusCode = 500;
        response.end();
      }
    },
  );
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => reject(error);
    server.once("error", onError);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", onError);
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw new Error("Observation Kernel did not expose a TCP address");
  }
  const deploymentHandle = `sample-${input.kernelInstanceId}`;
  const { privateKey } = generateKeyPairSync("ed25519");
  return {
    client: new KernelPrivateClient({
      credentials: new KernelCredentialService({
        keyId: "worker-observation-test",
        privateKey,
      }),
      deployments: new RuntimeKernelDeploymentRegistry([
        {
          handle: deploymentHandle,
          hostname: "127.0.0.1",
          kernelInstanceId: input.kernelInstanceId,
          port: address.port,
          serverName: "kernel.test",
          spaceId: input.spaceId,
          tls: {
            caCertificate: observationCertificate,
            clientCertificate: observationCertificate,
            clientPrivateKey: observationPrivateKey,
          },
        },
      ]),
      policies: new KernelRoutePolicyRegistry(kernelRoutePolicies),
    }),
    deploymentHandle,
    async dispose(): Promise<void> {
      await new Promise<void>((resolve, reject) => {
        server.close((error) =>
          error === undefined ? resolve() : reject(error),
        );
      });
    },
    requests,
  };
}

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

  it("fences a late backup attempt after the worker lease is taken over", async () => {
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
    const firstJob = backupJob(fixture, backup.id);
    const secondJob = { ...firstJob, attempt: 2 };
    await database.client.workerJob.create({
      data: {
        availableAt: new Date("2026-07-19T09:00:00.000Z"),
        attempt: 1,
        id: firstJob.id,
        kind: "backup_space",
        leaseExpiresAt: new Date(Date.now() + 60_000),
        organizationId: fixture.organizationId,
        payload: {
          backupId: backup.id,
          spaceId: fixture.sourceSpaceId,
        },
        requestId: firstJob.requestId,
        status: "running",
        workerId: "backup-old-worker",
      },
    });
    let releaseFirst!: () => void;
    const firstRelease = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let firstStarted!: () => void;
    const firstStartedPromise = new Promise<void>((resolve) => {
      firstStarted = resolve;
    });
    const kernel: BackupKernelPort = {
      async createBackup(job) {
        if (job.attempt === 1) {
          firstStarted();
          await firstRelease;
        }
        return {
          body: (async function* () {
            yield archive;
          })(),
          formatVersion: 1,
          kernelVersion: job.attempt === 1 ? "old-attempt" : "new-attempt",
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
    const firstExecution = handler.execute(
      firstJob,
      new AbortController().signal,
    );
    void firstExecution.catch(() => undefined);
    await firstStartedPromise;
    await expect(
      handler.execute(firstJob, new AbortController().signal),
    ).rejects.toMatchObject<Partial<WorkerJobError>>({
      code: "backup-claim-active",
    });
    await expect(
      database.client.spaceBackup.findUniqueOrThrow({
        where: { id: backup.id },
      }),
    ).resolves.toMatchObject({
      status: "running",
      workerAttempt: 1,
      workerJobId: firstJob.id,
    });
    await database.client.$executeRaw(
      Prisma.sql`
        UPDATE "worker_jobs"
        SET
          "attempt" = 2,
          "worker_id" = 'backup-new-worker',
          "lease_expires_at" = ${new Date(Date.now() + 60_000)}
        WHERE "id" = ${firstJob.id}::uuid
      `,
    );
    try {
      await handler.execute(secondJob, new AbortController().signal);
    } finally {
      releaseFirst();
    }
    await expect(firstExecution).rejects.toMatchObject<Partial<WorkerJobError>>({
      code: "backup-state-conflict",
    });

    await expect(
      database.client.spaceBackup.findUniqueOrThrow({
        where: { id: backup.id },
      }),
    ).resolves.toMatchObject({
      kernelVersion: "new-attempt",
      status: "succeeded",
    });
    const claim = await database.client.$queryRaw<
      Array<{ workerAttempt: number | null; workerJobId: string | null }>
    >(
      Prisma.sql`
        SELECT
          "worker_attempt" AS "workerAttempt",
          "worker_job_id" AS "workerJobId"
        FROM "space_backups"
        WHERE "id" = ${backup.id}::uuid
      `,
    );
    expect(claim[0]).toEqual({ workerAttempt: null, workerJobId: null });
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
    const deploymentEvents: ReturnType<
      typeof parseKernelDeploymentChangedEvent
    >[] = [];
    const subscription = await database.listen(
      KERNEL_DEPLOYMENT_CHANGED_CHANNEL,
      (payload) => {
        deploymentEvents.push(
          parseKernelDeploymentChangedEvent(JSON.parse(payload) as unknown),
        );
      },
      (error) => {
        throw error;
      },
    );
    try {
      await handler.execute(job, new AbortController().signal);
      await expect(
        handler.execute(job, new AbortController().signal),
      ).resolves.toBeUndefined();
      await expect
        .poll(() => deploymentEvents.length, { timeout: 5_000 })
        .toBe(1);
    } finally {
      await subscription.close();
    }

    expect(restoreCalls).toBe(1);
    expect(deploymentEvents).toEqual([
      {
        kernelInstanceId: fixture.targetKernelInstanceId,
        kind: "upsert",
        requestId: job.requestId,
        spaceId: fixture.targetSpaceId,
      },
    ]);
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

describe("L1 scheduled observation and audit archive chains with PostgreSQL", () => {
  let database: DatabaseRuntime;

  beforeAll(() => {
    database = new DatabaseRuntime(isolatedDatabaseUrl());
  });

  beforeEach(async () => {
    await database.client.organization.updateMany({
      data: { status: "disabled" },
    });
  });

  afterEach(async () => {
    await Promise.all(
      roots.splice(0).map((root) => rm(root, { force: true, recursive: true })),
    );
  });

  afterAll(async () => {
    await database.onApplicationShutdown();
  });

  it("schedules one sample per ready Kernel and persists the authenticated response", async () => {
    const fixture = await createManagedSpace(database.client);
    const kernelInstanceId = randomUUID();
    const kernel = await startObservationKernel({
      kernelInstanceId,
      spaceId: fixture.sourceSpaceId,
    });
    try {
      await database.client.kernelInstance.create({
        data: {
          deploymentHandle: kernel.deploymentHandle,
          id: kernelInstanceId,
          spaceId: fixture.sourceSpaceId,
          status: "ready",
          version: "3.7.2",
        },
      });
      const producer = new SampleKernelJobProducer(database, {
        sampleKernelIntervalMilliseconds: 60_000,
      });
      const schedulerAbort = new AbortController();
      const schedulerEntries: Readonly<Record<string, unknown>>[] = [];
      const schedulerLogger: WorkerJobLogger = {
        debug(context) {
          schedulerEntries.push(context);
        },
        error(context) {
          schedulerEntries.push(context);
        },
        info(context) {
          schedulerEntries.push(context);
          if (
            context.event === "worker.producer" &&
            context.kind === "sample-kernel" &&
            context.outcome === "completed"
          ) {
            schedulerAbort.abort();
          }
        },
        warn(context) {
          schedulerEntries.push(context);
        },
      };
      const producedAt = new Date("2026-07-19T10:01:00.000Z");
      await new WorkerJobScheduler({
        logger: schedulerLogger,
        now: () => producedAt,
        producers: [producer],
      }).run(schedulerAbort.signal);

      expect(schedulerEntries).toContainEqual(
        expect.objectContaining({
          event: "worker.producer",
          kind: "sample-kernel",
          outcome: "completed",
          producedJobs: 1,
        }),
      );
      await expect(producer.produce(producedAt)).resolves.toBe(0);

      const workerAbort = new AbortController();
      const workerEntries: Readonly<Record<string, unknown>>[] = [];
      const workerLogger: WorkerJobLogger = {
        debug(context) {
          workerEntries.push(context);
        },
        error(context) {
          workerEntries.push(context);
        },
        info(context) {
          workerEntries.push(context);
          if (
            context.event === "worker.job" &&
            context.kind === "sample-kernel" &&
            context.outcome === "completed"
          ) {
            workerAbort.abort();
          }
        },
        warn(context) {
          workerEntries.push(context);
        },
      };
      const repository = new PostgresWorkerJobRepository(database);
      const handler = new SampleKernelHandler(
        database,
        new KernelWorkerClient(database, kernel.client),
      );
      await new BoundedJobWorker({
        claimBatchSize: 1,
        handlers: [handler],
        leaseDurationMilliseconds: 30_000,
        leaseRenewalMilliseconds: 10_000,
        logger: workerLogger,
        maximumConcurrentJobs: 1,
        now: () => producedAt,
        pollIntervalMilliseconds: 100,
        repository,
        workerId: "sample-success-worker",
      }).run(workerAbort.signal);

      const jobs = await database.client.workerJob.findMany({
        where: {
          kind: "sample_kernel",
          organizationId: fixture.organizationId,
        },
      });
      expect(jobs).toHaveLength(1);
      expect(jobs[0]).toMatchObject({
        attempt: 1,
        errorCode: null,
        payload: {
          kernelInstanceId,
          spaceId: fixture.sourceSpaceId,
        },
        status: "succeeded",
      });
      await expect(
        database.client.kernelHealthObservation.findMany({
          where: { kernelInstanceId },
        }),
      ).resolves.toEqual([
        expect.objectContaining({
          errorCode: null,
          kernelVersion: "3.7.2",
          sampledAt: new Date(OBSERVATION_SAMPLED_AT),
          status: "ready",
        }),
      ]);
      await expect(
        database.client.spaceCapacityObservation.findMany({
          where: { kernelInstanceId, spaceId: fixture.sourceSpaceId },
        }),
      ).resolves.toEqual([
        expect.objectContaining({
          assetBytes: 256n,
          dataBytes: 1024n,
          errorCode: null,
          fileCount: 8n,
          sampleDurationMilliseconds: 14,
          sampledAt: new Date(OBSERVATION_SAMPLED_AT),
        }),
      ]);
      expect(kernel.requests).toEqual([
        expect.objectContaining({
          authorized: true,
          method: "GET",
          path: WORKER_OBSERVATION_PATH,
          requestId: jobs[0]?.requestId,
          serviceToken: expect.any(String),
        }),
      ]);
      expect(workerEntries).toContainEqual(
        expect.objectContaining({
          event: "worker.job",
          kind: "sample-kernel",
          outcome: "completed",
        }),
      );
    } finally {
      await kernel.dispose();
    }
  });

  it("rejects a late sample after the ready deployment handle changes", async () => {
    const fixture = await createManagedSpace(database.client);
    const kernelInstanceId = randomUUID();
    const replacementHandle = `replacement-${kernelInstanceId}`;
    const kernel = await startObservationKernel({
      async beforeResponse() {
        await database.client.kernelInstance.update({
          data: { deploymentHandle: replacementHandle },
          where: { id: kernelInstanceId },
        });
      },
      kernelInstanceId,
      spaceId: fixture.sourceSpaceId,
    });
    try {
      await database.client.kernelInstance.create({
        data: {
          deploymentHandle: kernel.deploymentHandle,
          id: kernelInstanceId,
          spaceId: fixture.sourceSpaceId,
          status: "ready",
          version: "3.7.2",
        },
      });
      const producedAt = new Date("2026-07-19T10:02:00.000Z");
      const producer = new SampleKernelJobProducer(database, {
        sampleKernelIntervalMilliseconds: 60_000,
      });
      await expect(producer.produce(producedAt)).resolves.toBe(1);

      const workerAbort = new AbortController();
      const workerEntries: Readonly<Record<string, unknown>>[] = [];
      const workerLogger: WorkerJobLogger = {
        debug(context) {
          workerEntries.push(context);
        },
        error(context) {
          workerEntries.push(context);
        },
        info(context) {
          workerEntries.push(context);
        },
        warn(context) {
          workerEntries.push(context);
          if (
            context.event === "worker.job" &&
            context.kind === "sample-kernel" &&
            context.outcome === "failed"
          ) {
            workerAbort.abort();
          }
        },
      };
      await new BoundedJobWorker({
        claimBatchSize: 1,
        handlers: [
          new SampleKernelHandler(
            database,
            new KernelWorkerClient(database, kernel.client),
          ),
        ],
        leaseDurationMilliseconds: 30_000,
        leaseRenewalMilliseconds: 10_000,
        logger: workerLogger,
        maximumConcurrentJobs: 1,
        now: () => producedAt,
        pollIntervalMilliseconds: 100,
        repository: new PostgresWorkerJobRepository(database),
        workerId: "sample-late-worker",
      }).run(workerAbort.signal);

      await expect(
        database.client.workerJob.findFirstOrThrow({
          where: {
            kind: "sample_kernel",
            organizationId: fixture.organizationId,
          },
        }),
      ).resolves.toMatchObject({
        attempt: 1,
        errorCode: "observation-state-conflict",
        status: "failed",
      });
      await expect(
        database.client.kernelHealthObservation.count({
          where: { kernelInstanceId },
        }),
      ).resolves.toBe(0);
      await expect(
        database.client.spaceCapacityObservation.count({
          where: { kernelInstanceId },
        }),
      ).resolves.toBe(0);
      expect(workerEntries).toContainEqual(
        expect.objectContaining({
          errorCode: "observation-state-conflict",
          event: "worker.job",
          kind: "sample-kernel",
          outcome: "failed",
          retryAt: null,
        }),
      );
      expect(kernel.requests).toEqual([
        expect.objectContaining({
          authorized: true,
          method: "GET",
          path: WORKER_OBSERVATION_PATH,
          serviceToken: expect.any(String),
        }),
      ]);
    } finally {
      await kernel.dispose();
    }
  });

  it("accepts only an exact replay of one archived audit range", async () => {
    const fixture = await createManagedSpace(database.client);
    const firstMac = "a".repeat(64);
    const lastMac = "b".repeat(64);
    const firstEventId = randomUUID();
    const lastEventId = randomUUID();
    await database.client.organizationAuditSequence.create({
      data: { organizationId: fixture.organizationId },
    });
    await database.client.$transaction(async (transaction) => {
      await transaction.$executeRaw(
        Prisma.sql`
          INSERT INTO "audit_events" (
            "id", "organization_id", "sequence", "space_id", "actor_user_id",
            "action", "target_type", "target_id", "outcome", "occurred_at",
            "request_id", "previous_mac", "mac", "key_version"
          ) VALUES (
            ${firstEventId}::uuid, ${fixture.organizationId}::uuid, 1,
            ${fixture.sourceSpaceId}::uuid, ${fixture.userId}::uuid,
            'permission.change', 'space', ${fixture.sourceSpaceId}, 'succeeded',
            ${new Date("2026-07-19T09:00:00.000Z")}, ${randomUUID()}::uuid,
            NULL, ${firstMac}, 'audit-v1'
          )
        `,
      );
      await transaction.organizationAuditSequence.update({
        data: { lastMac: firstMac, lastSequence: 1n },
        where: { organizationId: fixture.organizationId },
      });
      await transaction.$executeRaw(
        Prisma.sql`
          INSERT INTO "audit_events" (
            "id", "organization_id", "sequence", "space_id", "actor_user_id",
            "action", "target_type", "target_id", "outcome", "occurred_at",
            "request_id", "previous_mac", "mac", "key_version"
          ) VALUES (
            ${lastEventId}::uuid, ${fixture.organizationId}::uuid, 2,
            ${fixture.sourceSpaceId}::uuid, ${fixture.userId}::uuid,
            'share.create', 'document', '20260719090000-abcdefg', 'succeeded',
            ${new Date("2026-07-19T09:01:00.000Z")}, ${randomUUID()}::uuid,
            ${firstMac}, ${lastMac}, 'audit-v1'
          )
        `,
      );
      await transaction.organizationAuditSequence.update({
        data: { lastMac, lastSequence: 2n },
        where: { organizationId: fixture.organizationId },
      });
    });

    const rootDirectory = await mkdtemp(join(tmpdir(), "worker-audit-archive-"));
    roots.push(rootDirectory);
    const objects = await FileObjectStore.open({
      maximumObjectBytes: MAXIMUM_BACKUP_BYTES,
      rootDirectory,
    });
    const producer = new ArchiveAuditJobProducer(database, {
      archiveAuditIntervalMilliseconds: 300_000,
      maximumAuditArchiveEvents: 2,
    });
    const producedAt = new Date("2026-07-19T10:03:00.000Z");
    await expect(producer.produce(producedAt)).resolves.toBe(1);
    await expect(producer.produce(producedAt)).resolves.toBe(0);

    const repository = new PostgresWorkerJobRepository(database);
    const claimed = await repository.claimBatch({
      kinds: ["archive-audit"],
      leaseExpiresAt: new Date("2026-07-19T10:08:00.000Z"),
      limit: 1,
      now: producedAt,
      workerId: "audit-archive-worker",
    });
    const record = claimed[0];
    if (record === undefined) {
      throw new Error("Scheduled audit archive job was not claimable");
    }
    expect(record.payload).toEqual({
      fromSequence: "1",
      throughSequence: "2",
    });
    const handler = new ArchiveAuditHandler(
      database,
      MAXIMUM_BACKUP_BYTES,
      2,
      objects,
    );
    const job = handler.decode(record);
    await handler.execute(job, new AbortController().signal);
    await expect(
      handler.execute(job, new AbortController().signal),
    ).resolves.toBeUndefined();
    await database.client.$executeRaw(
      Prisma.sql`
        UPDATE "worker_jobs"
        SET
          "payload" = ${JSON.stringify({
            fromSequence: "2",
            throughSequence: "2",
          })}::jsonb,
          "lease_expires_at" = ${new Date("2026-07-19T10:04:00.000Z")}
        WHERE "id" = ${record.id}::uuid
      `,
    );
    const reclaimed = await repository.claimBatch({
      kinds: ["archive-audit"],
      leaseExpiresAt: new Date("2026-07-19T10:10:00.000Z"),
      limit: 1,
      now: new Date("2026-07-19T10:05:00.000Z"),
      workerId: "audit-archive-replay-worker",
    });
    const changedRangeRecord = reclaimed[0];
    if (changedRangeRecord === undefined) {
      throw new Error("Changed audit archive range was not claimable");
    }
    expect(changedRangeRecord).toMatchObject({
      attempt: record.attempt + 1,
      id: record.id,
      payload: { fromSequence: "2", throughSequence: "2" },
    });
    const changedRangeJob = handler.decode(changedRangeRecord);
    await expect(
      handler.execute(changedRangeJob, new AbortController().signal),
    ).rejects.toMatchObject<Partial<WorkerJobError>>({
      code: "audit-archive-range-conflict",
    });

    const archive = await database.client.auditArchive.findUniqueOrThrow({
      where: { id: record.id },
    });
    expect(archive).toMatchObject({
      firstMac,
      fromSequence: 1n,
      lastMac,
      organizationId: fixture.organizationId,
      throughSequence: 2n,
    });
    const objectKey = parseObjectKey(archive.objectKey);
    const stored = await objects.digest(objectKey, MAXIMUM_BACKUP_BYTES);
    expect(stored).toMatchObject({
      sha256: archive.sha256,
      sizeBytes: Number(archive.sizeBytes),
    });
    const archivedEvents = (
      await objects.read(objectKey, MAXIMUM_BACKUP_BYTES)
    )
      .toString("utf8")
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(archivedEvents).toEqual([
      expect.objectContaining({
        auditEventId: firstEventId,
        mac: firstMac,
        organizationId: fixture.organizationId,
        previousMac: null,
        sequence: "1",
      }),
      expect.objectContaining({
        auditEventId: lastEventId,
        mac: lastMac,
        organizationId: fixture.organizationId,
        previousMac: firstMac,
        sequence: "2",
      }),
    ]);
    await expect(
      database.client.auditEvent.count({
        where: { organizationId: fixture.organizationId },
      }),
    ).resolves.toBe(2);
    await expect(
      database.client.auditArchive.count({
        where: { organizationId: fixture.organizationId },
      }),
    ).resolves.toBe(1);
    await expect(producer.produce(producedAt)).resolves.toBe(0);
  });
});

interface ContentAuditIntentFixture {
  action: "content.delete" | "content.edit" | "content.export";
  availableAt: Date;
  documentId: string;
  occurredAt: Date;
  observedOutcome: "failed" | "succeeded" | null;
  requestId: string;
}

async function insertContentAuditIntent(
  database: DatabaseClient,
  fixture: ManagedSpaceFixture,
  intent: ContentAuditIntentFixture,
): Promise<void> {
  await database.$executeRaw(
    Prisma.sql`
      INSERT INTO "content_audit_intents" (
        "request_id", "organization_id", "space_id", "actor_user_id",
        "action", "document_id", "occurred_at", "observed_outcome", "available_at"
      ) VALUES (
        ${intent.requestId}::uuid, ${fixture.organizationId}::uuid,
        ${fixture.sourceSpaceId}::uuid, ${fixture.userId}::uuid,
        ${intent.action}::"audit_action", ${intent.documentId}, ${intent.occurredAt},
        ${intent.observedOutcome}::"audit_outcome", ${intent.availableAt}
      )
    `,
  );
}

describe("L1 cross-Kernel content audit reconciliation with PostgreSQL", () => {
  let database: DatabaseRuntime;

  beforeAll(() => {
    database = new DatabaseRuntime(isolatedDatabaseUrl());
  });

  beforeEach(async () => {
    await database.client.$executeRaw(
      Prisma.sql`DELETE FROM "worker_jobs" WHERE "kind" = 'reconcile-content-audit'`,
    );
    await database.client.$executeRaw(
      Prisma.sql`DELETE FROM "content_audit_intents"`,
    );
  });

  afterAll(async () => {
    await database.onApplicationShutdown();
  });

  it("creates at most one active reconciliation job per organization", async () => {
    const fixture = await createManagedSpace(database.client);
    const now = new Date("2026-07-19T10:00:00.000Z");
    await insertContentAuditIntent(database.client, fixture, {
      action: "content.edit",
      availableAt: new Date("2026-07-19T09:59:00.000Z"),
      documentId: "document-producer",
      occurredAt: new Date("2026-07-19T09:58:00.000Z"),
      observedOutcome: null,
      requestId: randomUUID(),
    });
    const producer = new ContentAuditJobProducer(database, {
      contentAuditReconciliationIntervalMilliseconds: 5_000,
    });

    const results = await Promise.all([
      producer.produce(now),
      producer.produce(now),
    ]);

    expect(results.sort()).toEqual([0, 1]);
    await expect(
      database.client.$queryRaw<Array<{ payload: unknown }>>(
        Prisma.sql`
          SELECT "payload"
          FROM "worker_jobs"
          WHERE "organization_id" = ${fixture.organizationId}::uuid
            AND "kind" = 'reconcile-content-audit'
            AND "status" IN ('queued', 'running')
        `,
      ),
    ).resolves.toEqual([{ payload: {} }]);
  });

  it("finalizes bounded resolved and due batches in order with independently verifiable MACs", async () => {
    const fixture = await createManagedSpace(database.client);
    const occurredAt = [
      new Date("2026-07-19T09:58:00.000Z"),
      new Date("2026-07-19T09:58:01.000Z"),
      new Date("2026-07-19T09:58:02.000Z"),
    ];
    const intents: ContentAuditIntentFixture[] = [
      {
        action: "content.edit",
        availableAt: occurredAt[0]!,
        documentId: "document-succeeded",
        occurredAt: occurredAt[0]!,
        observedOutcome: "succeeded",
        requestId: randomUUID(),
      },
      {
        action: "content.delete",
        availableAt: occurredAt[1]!,
        documentId: "document-failed",
        occurredAt: occurredAt[1]!,
        observedOutcome: "failed",
        requestId: randomUUID(),
      },
      {
        action: "content.export",
        availableAt: occurredAt[2]!,
        documentId: "document-indeterminate",
        occurredAt: occurredAt[2]!,
        observedOutcome: null,
        requestId: randomUUID(),
      },
    ];
    for (const intent of intents) {
      await insertContentAuditIntent(database.client, fixture, intent);
    }
    const key = Buffer.alloc(32, 23);
    const keyVersion = "content-audit-test-v1";
    const writer = new AuditWriter(
      parseAuditConfiguration({
        SINGULARITY_AUDIT_HMAC_KEY: key.toString("base64url"),
        SINGULARITY_AUDIT_KEY_VERSION: keyVersion,
      }),
    );
    const logger = new CapturingWorkerLogger();
    const handler = new ContentAuditHandler(
      writer,
      database,
      { contentAuditBatchSize: 2 },
      logger,
    );
    const producer = new ContentAuditJobProducer(database, {
      contentAuditReconciliationIntervalMilliseconds: 5_000,
    });
    const now = new Date("2026-07-19T10:00:00.000Z");
    await expect(producer.produce(now)).resolves.toBe(1);
    const repository = new PostgresWorkerJobRepository(database);
    const claimed = await repository.claimBatch({
      kinds: ["reconcile-content-audit"],
      leaseExpiresAt: new Date("2026-07-19T10:05:00.000Z"),
      limit: 1,
      now,
      workerId: "content-audit-worker",
    });
    const record = claimed[0];
    if (record === undefined) {
      throw new Error("Content audit reconciliation job was not claimable");
    }

    await handler.execute(handler.decode(record), new AbortController().signal);

    await expect(
      database.client.$queryRaw<Array<{ count: bigint }>>(
        Prisma.sql`
          SELECT COUNT(*)::bigint AS count
          FROM "content_audit_intents"
          WHERE "organization_id" = ${fixture.organizationId}::uuid
        `,
      ),
    ).resolves.toEqual([{ count: 1n }]);
    await expect(
      database.client.auditEvent.count({
        where: { organizationId: fixture.organizationId },
      }),
    ).resolves.toBe(2);
    await expect(
      repository.complete({
        completedAt: new Date("2026-07-19T10:00:00.001Z"),
        jobId: record.id,
        workerId: "content-audit-worker",
      }),
    ).resolves.toBe(true);
    const nextProducedAt = new Date("2026-07-19T10:00:00.002Z");
    await expect(producer.produce(nextProducedAt)).resolves.toBe(1);
    const nextClaimed = await repository.claimBatch({
      kinds: ["reconcile-content-audit"],
      leaseExpiresAt: new Date("2026-07-19T10:05:00.000Z"),
      limit: 1,
      now: nextProducedAt,
      workerId: "content-audit-worker",
    });
    const nextRecord = nextClaimed[0];
    if (nextRecord === undefined) {
      throw new Error("Remaining content audit batch was not claimable");
    }
    await handler.execute(
      handler.decode(nextRecord),
      new AbortController().signal,
    );

    await expect(
      database.client.$queryRaw<Array<{ count: bigint }>>(
        Prisma.sql`
          SELECT COUNT(*)::bigint AS count
          FROM "content_audit_intents"
          WHERE "organization_id" = ${fixture.organizationId}::uuid
        `,
      ),
    ).resolves.toEqual([{ count: 0n }]);
    const events = await database.client.$queryRaw<
      Array<{
        action: string;
        actorUserId: string;
        auditEventId: string;
        occurredAt: Date;
        outcome: string;
        previousMac: string | null;
        requestId: string;
        sequence: bigint;
        spaceId: string;
        targetId: string;
        targetType: string;
        mac: string;
        keyVersion: string;
        organizationId: string;
      }>
    >(Prisma.sql`
      SELECT
        "id" AS "auditEventId", "organization_id" AS "organizationId",
        "sequence", "space_id" AS "spaceId", "actor_user_id" AS "actorUserId",
        "action"::text AS "action", "target_type" AS "targetType",
        "target_id" AS "targetId", "outcome"::text AS "outcome",
        "occurred_at" AS "occurredAt", "request_id" AS "requestId",
        "previous_mac" AS "previousMac", "mac", "key_version" AS "keyVersion"
      FROM "audit_events"
      WHERE "organization_id" = ${fixture.organizationId}::uuid
      ORDER BY "sequence"
    `);
    expect(events.map((event) => event.outcome)).toEqual([
      "succeeded",
      "failed",
      "indeterminate",
    ]);
    let previousMac: string | null = null;
    for (const event of events) {
      const expectedMac = createHmac("sha256", key)
        .update(
          JSON.stringify([
            "singularity.audit-event.v1",
            event.auditEventId,
            event.organizationId,
            event.sequence.toString(),
            previousMac,
            event.spaceId,
            event.actorUserId,
            event.action,
            event.targetType,
            event.targetId,
            event.outcome,
            event.occurredAt.toISOString(),
            event.requestId,
            keyVersion,
          ]),
          "utf8",
        )
        .digest("hex");
      expect(event.mac).toBe(expectedMac);
      previousMac = event.mac;
    }
  });

  it("rolls back failed finalization, retries the intent, and does not duplicate a replay", async () => {
    const fixture = await createManagedSpace(database.client);
    const requestId = randomUUID();
    await insertContentAuditIntent(database.client, fixture, {
      action: "content.edit",
      availableAt: new Date("2026-07-19T09:59:00.000Z"),
      documentId: "document-retry",
      occurredAt: new Date("2026-07-19T09:58:00.000Z"),
      observedOutcome: "succeeded",
      requestId,
    });
    const key = Buffer.alloc(32, 29);
    const writer = new AuditWriter(
      parseAuditConfiguration({
        SINGULARITY_AUDIT_HMAC_KEY: key.toString("base64url"),
        SINGULARITY_AUDIT_KEY_VERSION: "content-audit-retry-v1",
      }),
    );
    const logger = new CapturingWorkerLogger();
    const handler = new ContentAuditHandler(
      writer,
      database,
      { contentAuditBatchSize: 10 },
      logger,
    );
    const producer = new ContentAuditJobProducer(database, {
      contentAuditReconciliationIntervalMilliseconds: 5_000,
    });
    const producedAt = new Date();
    await producer.produce(producedAt);
    const repository = new PostgresWorkerJobRepository(database);
    const workerId = "content-audit-retry-worker";
    const firstClaim = await repository.claimBatch({
      kinds: ["reconcile-content-audit"],
      leaseExpiresAt: new Date(producedAt.getTime() + 5 * 60_000),
      limit: 1,
      now: producedAt,
      workerId,
    });
    const firstRecord = firstClaim[0];
    if (firstRecord === undefined) {
      throw new Error("Initial content audit job was not claimable");
    }
    const triggerName = "singularity_test_fail_content_audit_event_insert";
    const functionName = "singularity_test_fail_content_audit_event";
    await database.client.$executeRaw(Prisma.sql`
      CREATE OR REPLACE FUNCTION ${Prisma.raw(functionName)}()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $function$
      BEGIN
        RAISE EXCEPTION 'content audit event test failure';
      END;
      $function$
    `);
    await database.client.$executeRaw(Prisma.sql`
      CREATE TRIGGER ${Prisma.raw(triggerName)}
      BEFORE INSERT ON "audit_events"
      FOR EACH ROW EXECUTE FUNCTION ${Prisma.raw(functionName)}()
    `);
    let failure: unknown;
    try {
      await handler.execute(
        handler.decode(firstRecord),
        new AbortController().signal,
      );
    } catch (error) {
      failure = error;
    } finally {
      await database.client.$executeRaw(Prisma.sql`
        DROP TRIGGER IF EXISTS ${Prisma.raw(triggerName)} ON "audit_events"
      `);
      await database.client.$executeRaw(Prisma.sql`
        DROP FUNCTION IF EXISTS ${Prisma.raw(functionName)}()
      `);
    }
    expect(failure).toMatchObject<Partial<WorkerJobError>>({
      code: "content-audit-finalization-failed",
    });
    const loggedError = logger.entries.find(
      (entry) =>
        entry.event === "content.audit-finalization" &&
        entry.outcome === "failed",
    )?.error;
    expect(loggedError).toBeInstanceOf(Error);
    expect((loggedError as Error).stack).toContain(
      (loggedError as Error).message,
    );
    const retryAt = (failure as WorkerJobError).retryAt;
    if (retryAt === null) {
      throw new Error("Content audit failure did not schedule a retry");
    }
    await expect(
      database.client.$queryRaw<Array<{ count: bigint }>>(
        Prisma.sql`
          SELECT COUNT(*)::bigint AS count
          FROM "content_audit_intents"
          WHERE "request_id" = ${requestId}::uuid
        `,
      ),
    ).resolves.toEqual([{ count: 1n }]);
    await expect(
      database.client.auditEvent.count({
        where: { organizationId: fixture.organizationId },
      }),
    ).resolves.toBe(0);
    await expect(
      repository.fail({
        errorCode: "content-audit-finalization-failed",
        failedAt: new Date(),
        jobId: firstRecord.id,
        retryAt,
        workerId,
      }),
    ).resolves.toBe(true);
    const retryClaim = await repository.claimBatch({
      kinds: ["reconcile-content-audit"],
      leaseExpiresAt: new Date(retryAt.getTime() + 60_000),
      limit: 1,
      now: new Date(retryAt.getTime() + 1),
      workerId,
    });
    const retryRecord = retryClaim[0];
    if (retryRecord === undefined) {
      throw new Error("Retried content audit job was not claimable");
    }
    await handler.execute(handler.decode(retryRecord), new AbortController().signal);
    await expect(
      database.client.auditEvent.count({
        where: { organizationId: fixture.organizationId },
      }),
    ).resolves.toBe(1);

    await database.client.$executeRaw(
      Prisma.sql`
        UPDATE "worker_jobs"
        SET "lease_expires_at" = ${new Date(0)}
        WHERE "id" = ${retryRecord.id}::uuid
      `,
    );
    const replayClaim = await repository.claimBatch({
      kinds: ["reconcile-content-audit"],
      leaseExpiresAt: new Date(Date.now() + 60_000),
      limit: 1,
      now: new Date(),
      workerId: "content-audit-replay-worker",
    });
    const replayRecord = replayClaim[0];
    if (replayRecord === undefined) {
      throw new Error("Expired content audit job was not reclaimable");
    }
    await handler.execute(handler.decode(replayRecord), new AbortController().signal);
    await expect(
      database.client.auditEvent.count({
        where: { organizationId: fixture.organizationId },
      }),
    ).resolves.toBe(1);
    await expect(
      repository.complete({
        completedAt: new Date(),
        jobId: replayRecord.id,
        workerId: "content-audit-replay-worker",
      }),
    ).resolves.toBe(true);
  });
});
