import { createHash, generateKeyPairSync, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TLSSocket } from "node:tls";

import { kernelRoutePolicies } from "@singularity/authorization";
import {
  DatabaseRuntime,
  Prisma,
  type DatabaseClient,
} from "@singularity/database";
import { isolatedDatabaseUrl } from "@singularity/database/testing/postgres";
import {
  KernelCredentialService,
  KernelPrivateClient,
  KernelRoutePolicyRegistry,
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
import {
  KernelWorkerClient,
  WORKER_OBSERVATION_PATH,
} from "../src/kernel-worker-client.js";
import { PostgresWorkerJobRepository } from "../src/postgres-job-repository.js";
import {
  ArchiveAuditJobProducer,
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

  it("archives one sealed audit range without deleting its online events", async () => {
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
      repository.complete({
        completedAt: new Date("2026-07-19T10:04:00.000Z"),
        jobId: record.id,
        workerId: "audit-archive-worker",
      }),
    ).resolves.toBe(true);
    await expect(
      handler.execute(job, new AbortController().signal),
    ).resolves.toBeUndefined();

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
