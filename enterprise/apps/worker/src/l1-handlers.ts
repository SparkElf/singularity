import { performance } from "node:perf_hooks";

import { Inject, Injectable } from "@nestjs/common";
import { DatabaseRuntime, Prisma } from "@singularity/database";
import {
  KERNEL_DEPLOYMENT_CHANGED_CHANNEL,
  type KernelDeploymentChangedEvent,
  type KernelRuntimeEndpoint,
} from "@singularity/kernel-client";
import {
  createObjectKey,
  FileObjectStore,
  ObjectStoreError,
  parseObjectKey,
  type StoredObject,
} from "@singularity/object-store";
import { z } from "zod";

import { HandlesWorkerJob } from "./job-declarations.js";
import type {
  ArchiveAuditJob,
  BackupSpaceJob,
  RestoreSpaceJob,
  SampleKernelJob,
  WorkerJobBase,
  WorkerJobHandler,
  WorkerJobLogger,
  WorkerJobRecord,
} from "./worker.js";
import { WorkerJobError } from "./worker.js";
import {
  KERNEL_WORKER,
  MAXIMUM_AUDIT_ARCHIVE_BYTES,
  MAXIMUM_AUDIT_ARCHIVE_EVENT_COUNT,
  MAXIMUM_BACKUP_BYTES,
  RESTORE_DEPLOYMENT,
  WORKER_JOB_LOGGER,
} from "./tokens.js";

export interface BackupKernelPort {
  createBackup(
    job: BackupSpaceJob,
    signal: AbortSignal,
  ): Promise<{
    body: AsyncIterable<Uint8Array>;
    formatVersion: number;
    kernelVersion: string;
    sha256: string;
  }>;
}

export interface RestoreDeploymentPort {
  destroyTarget(job: RestoreSpaceJob): Promise<void>;
  restore(
    input: {
      archive: AsyncIterable<Uint8Array>;
      expectedSha256: string;
      job: RestoreSpaceJob;
    },
    signal: AbortSignal,
  ): Promise<{ endpoint: KernelRuntimeEndpoint; kernelVersion: string }>;
}

async function publishKernelDeploymentChange(
  transaction: Prisma.TransactionClient,
  event: KernelDeploymentChangedEvent,
): Promise<void> {
  await transaction.$executeRaw(
    Prisma.sql`SELECT pg_notify(${KERNEL_DEPLOYMENT_CHANGED_CHANNEL}, ${JSON.stringify(event)})`,
  );
}

export interface KernelObservationPort {
  read(
    job: SampleKernelJob,
    signal: AbortSignal,
  ): Promise<{
    deploymentHandle: string;
    sample: {
      capacity: {
        assetBytes: string;
        dataBytes: string;
        errorCode?: string | undefined;
        fileCount: string;
        sampleDurationMilliseconds: number;
        sampledAt: string;
      };
      health: {
        errorCode?: string | undefined;
        kernelVersion: string;
        sampledAt: string;
        status: "ready" | "unavailable";
      };
    };
  }>;
}

function retryAt(attempt: number): Date | null {
  return attempt < 3 ? new Date(Date.now() + attempt * 60_000) : null;
}

function backupClaimRetryAt(): Date {
  return new Date(Date.now() + 15_000);
}

function baseJob(record: WorkerJobRecord): WorkerJobBase {
  return {
    attempt: record.attempt,
    id: record.id,
    leaseExpiresAt: record.leaseExpiresAt,
    organizationId: record.organizationId,
    requestId: record.requestId,
  };
}

function stringProperty(
  payload: Readonly<Record<string, unknown>>,
  name: string,
): string {
  const value = payload[name];
  if (typeof value !== "string" || value.length === 0) {
    throw new WorkerJobError("worker-job-payload-invalid", null);
  }
  return value;
}

const uuidValueSchema = z.string().uuid();
const MAXIMUM_POSTGRES_BIGINT = 9_223_372_036_854_775_807n;

function uuidProperty(
  payload: Readonly<Record<string, unknown>>,
  name: string,
): string {
  const parsed = uuidValueSchema.safeParse(payload[name]);
  if (!parsed.success) {
    throw new WorkerJobError("worker-job-payload-invalid", null);
  }
  return parsed.data;
}

function sequenceProperty(
  payload: Readonly<Record<string, unknown>>,
  name: string,
): bigint {
  const value = stringProperty(payload, name);
  if (!/^[1-9][0-9]*$/.test(value)) {
    throw new WorkerJobError("worker-job-payload-invalid", null);
  }
  let sequence: bigint;
  try {
    sequence = BigInt(value);
  } catch {
    throw new WorkerJobError("worker-job-payload-invalid", null);
  }
  if (sequence > MAXIMUM_POSTGRES_BIGINT) {
    throw new WorkerJobError("worker-job-payload-invalid", null);
  }
  return sequence;
}

type BackupBegin =
  | { outcome: "succeeded-idempotent" }
  | {
      objectKey: ReturnType<typeof parseObjectKey>;
      outcome: "execute";
      transitioned: boolean;
    };

@Injectable()
@HandlesWorkerJob({ kind: "backup-space" })
export class BackupSpaceHandler implements WorkerJobHandler<BackupSpaceJob> {
  readonly kind: BackupSpaceJob["kind"] = "backup-space";

  constructor(
    private readonly database: DatabaseRuntime,
    @Inject(KERNEL_WORKER)
    private readonly kernel: BackupKernelPort,
    @Inject(MAXIMUM_BACKUP_BYTES)
    private readonly maximumBackupBytes: number,
    private readonly objects: FileObjectStore,
    @Inject(WORKER_JOB_LOGGER)
    private readonly logger: WorkerJobLogger,
  ) {}

  decode(record: WorkerJobRecord): BackupSpaceJob {
    const payload = record.payload;
    return {
      ...baseJob(record),
      backupId: uuidProperty(payload, "backupId"),
      kind: this.kind,
      spaceId: uuidProperty(payload, "spaceId"),
    };
  }

  async execute(job: BackupSpaceJob, signal: AbortSignal): Promise<void> {
    const startedAt = performance.now();
    let runningCommitted = false;
    let objectKey: string | null = null;
    try {
      const begin = await this.#begin(job);
      if (begin.outcome === "succeeded-idempotent") {
        return;
      }
      const key = begin.objectKey;
      runningCommitted = true;
      objectKey = key;
      if (begin.transitioned) {
        this.logger.info({
          elapsedMs: performance.now() - startedAt,
          event: "backup.job",
          objectKey,
          reason: job.kind,
          requestId: job.requestId,
          spaceId: job.spaceId,
          status: "running",
          taskId: job.backupId,
          taskKind: "backup",
          validationResult: "pending",
        });
      }
      signal.throwIfAborted();
      const archive = await this.kernel.createBackup(job, signal);
      let stored: StoredObject;
      try {
        stored = await this.objects.put({
          expectedSha256: archive.sha256,
          key,
          maximumBytes: this.maximumBackupBytes,
          source: archive.body,
        });
      } catch (error) {
        if (!(error instanceof ObjectStoreError) || error.code !== "already-exists") {
          throw error;
        }
        stored = await this.objects.digest(key, this.maximumBackupBytes);
        if (stored.sha256 !== archive.sha256) {
          throw new WorkerJobError("backup-object-conflict", null);
        }
      }
      signal.throwIfAborted();
      const count = await this.database.client.$executeRaw(
        Prisma.sql`
          UPDATE "space_backups"
          SET
            "status" = 'succeeded',
            "format_version" = ${archive.formatVersion},
            "kernel_version" = ${archive.kernelVersion},
            "sha256" = ${stored.sha256},
            "size_bytes" = ${stored.sizeBytes},
            "worker_job_id" = NULL,
            "worker_attempt" = NULL,
            "completed_at" = CURRENT_TIMESTAMP
          WHERE "id" = ${job.backupId}::uuid
            AND "organization_id" = ${job.organizationId}::uuid
            AND "source_space_id" = ${job.spaceId}::uuid
            AND "status" = 'running'
            AND "worker_job_id" = ${job.id}::uuid
            AND "worker_attempt" = ${job.attempt}
        `,
      );
      if (count !== 1) {
        throw new WorkerJobError("backup-state-conflict", null);
      }
      this.logger.info({
        elapsedMs: performance.now() - startedAt,
        event: "backup.job",
        objectKey,
        reason: job.kind,
        requestId: job.requestId,
        spaceId: job.spaceId,
        status: "succeeded",
        taskId: job.backupId,
        taskKind: "backup",
        validationResult: "passed",
      });
    } catch (error) {
      if (signal.aborted) {
        throw error;
      }
      const nextRetryAt =
        error instanceof WorkerJobError
          ? error.retryAt
          : retryAt(job.attempt);
      if (!runningCommitted) {
        if (error instanceof WorkerJobError) {
          throw error;
        }
        throw new WorkerJobError("backup-execution-failed", nextRetryAt);
      }
      const transitioned = await this.database.client.$executeRaw(
        Prisma.sql`
          UPDATE "space_backups"
          SET
            "status" = ${nextRetryAt === null ? "failed" : "queued"}::"space_backup_status",
            "worker_job_id" = NULL,
            "worker_attempt" = NULL,
            "completed_at" = CASE
              WHEN ${nextRetryAt}::timestamptz IS NULL THEN CURRENT_TIMESTAMP
              ELSE NULL
            END
          WHERE "id" = ${job.backupId}::uuid
            AND "organization_id" = ${job.organizationId}::uuid
            AND "source_space_id" = ${job.spaceId}::uuid
            AND "status" = 'running'
            AND "worker_job_id" = ${job.id}::uuid
            AND "worker_attempt" = ${job.attempt}
        `,
      );
      if (transitioned === 1) {
        this.logger.warn({
          elapsedMs: performance.now() - startedAt,
          event: "backup.job",
          objectKey,
          reason:
            error instanceof WorkerJobError
              ? error.code
              : "backup-execution-failed",
          requestId: job.requestId,
          spaceId: job.spaceId,
          status: nextRetryAt === null ? "failed" : "queued",
          taskId: job.backupId,
          taskKind: "backup",
          validationResult:
            (error instanceof WorkerJobError &&
              error.code === "backup-object-conflict") ||
            (error instanceof ObjectStoreError && error.code === "corrupt-object")
              ? "failed"
              : "not-completed",
        });
      }
      if (error instanceof WorkerJobError) {
        throw error;
      }
      throw new WorkerJobError("backup-execution-failed", nextRetryAt);
    }
  }

  async #begin(job: BackupSpaceJob): Promise<BackupBegin> {
    return this.database.client.$transaction(async (transaction) => {
      const rows = await transaction.$queryRaw<
        Array<{
          claimActive: boolean;
          objectKey: string | null;
          status: "queued" | "running" | "succeeded";
          workerAttempt: number | null;
          workerJobId: string | null;
        }>
      >(
        Prisma.sql`
          SELECT
            EXISTS (
              SELECT 1
              FROM "worker_jobs" AS claim
              WHERE claim."id" = backup."worker_job_id"
                AND claim."status" = 'running'
                AND claim."attempt" = backup."worker_attempt"
                AND claim."lease_expires_at" > CURRENT_TIMESTAMP
            ) AS "claimActive",
            backup."object_key" AS "objectKey",
            backup."status",
            backup."worker_attempt" AS "workerAttempt",
            backup."worker_job_id" AS "workerJobId"
          FROM "space_backups" AS backup
          INNER JOIN "organizations" AS organization
            ON organization."id" = backup."organization_id"
          INNER JOIN "spaces" AS source_space
            ON source_space."id" = backup."source_space_id"
            AND source_space."organization_id" = backup."organization_id"
          WHERE backup."id" = ${job.backupId}::uuid
            AND backup."organization_id" = ${job.organizationId}::uuid
            AND backup."source_space_id" = ${job.spaceId}::uuid
            AND backup."status" IN ('queued', 'running', 'succeeded')
            AND (
              backup."status" = 'succeeded'
              OR (
                organization."status" = 'active'
                AND source_space."status" IN ('active', 'archived')
              )
            )
          FOR UPDATE OF backup
        `,
      );
      const current = rows[0];
      if (current === undefined) {
        throw new WorkerJobError("backup-state-conflict", null);
      }
      if (current.status === "succeeded") {
        return { outcome: "succeeded-idempotent" };
      }
      if (
        current.status === "running" &&
        (current.claimActive ||
          (current.workerJobId === job.id &&
            current.workerAttempt === job.attempt))
      ) {
        throw new WorkerJobError("backup-claim-active", backupClaimRetryAt());
      }
      const objectKey =
        current.objectKey === null
          ? createObjectKey()
          : parseObjectKey(current.objectKey);
      const updated = await transaction.$executeRaw(
        Prisma.sql`
          UPDATE "space_backups"
          SET
            "status" = 'running',
            "object_key" = ${objectKey},
            "worker_job_id" = ${job.id}::uuid,
            "worker_attempt" = ${job.attempt}
          WHERE "id" = ${job.backupId}::uuid
            AND "organization_id" = ${job.organizationId}::uuid
            AND "source_space_id" = ${job.spaceId}::uuid
            AND "status" = ${current.status}::"space_backup_status"
        `,
      );
      if (updated !== 1) {
        throw new WorkerJobError("backup-state-conflict", null);
      }
      return {
        objectKey,
        outcome: "execute",
        transitioned: current.status === "queued",
      };
    });
  }
}

type KernelInstanceState = "ready" | "starting" | "unavailable";

interface RestoreCleanupRow {
  failureCode: string;
  objectKey: string;
  status: "queued" | "restoring";
  targetKernelStatus: KernelInstanceState | null;
}

interface RestoreSourceRow {
  authorized: boolean;
  objectKey: string;
  sha256: string;
  targetKernelStatus: KernelInstanceState;
}

interface RestoreStateRow {
  claimActive: boolean;
  objectKey: string;
  targetSpaceId: string | null;
  workerAttempt: number | null;
  workerJobId: string | null;
  status: string;
  targetKernelStatus: KernelInstanceState | null;
  targetSpaceStatus: string | null;
}

type RestoreBegin =
  | {
      cleanupRequired: true;
      failureCode: string;
      objectKey: string;
      status: "queued" | "restoring";
      targetKernelStatus: KernelInstanceState | null;
    }
  | { idempotent: true }
  | (RestoreSourceRow & { cleanupRequired: false; idempotent: false });

function restoreCleanupRetryAt(): Date {
  return new Date(Date.now() + 60_000);
}

function restoreClaimRetryAt(): Date {
  return new Date(Date.now() + 15_000);
}

@Injectable()
@HandlesWorkerJob({ kind: "restore-space" })
export class RestoreSpaceHandler implements WorkerJobHandler<RestoreSpaceJob> {
  readonly kind: RestoreSpaceJob["kind"] = "restore-space";

  constructor(
    private readonly database: DatabaseRuntime,
    @Inject(RESTORE_DEPLOYMENT)
    private readonly deployment: RestoreDeploymentPort,
    @Inject(MAXIMUM_BACKUP_BYTES)
    private readonly maximumBackupBytes: number,
    private readonly objects: FileObjectStore,
    @Inject(WORKER_JOB_LOGGER)
    private readonly logger: WorkerJobLogger,
  ) {}

  decode(record: WorkerJobRecord): RestoreSpaceJob {
    const payload = record.payload;
    return {
      ...baseJob(record),
      backupId: uuidProperty(payload, "backupId"),
      kind: this.kind,
      restoreId: uuidProperty(payload, "restoreId"),
      sourceSpaceId: uuidProperty(payload, "sourceSpaceId"),
      targetKernelInstanceId: uuidProperty(
        payload,
        "targetKernelInstanceId",
      ),
      targetSpaceId: uuidProperty(payload, "targetSpaceId"),
    };
  }

  async execute(job: RestoreSpaceJob, signal: AbortSignal): Promise<void> {
    const startedAt = performance.now();
    let started = false;
    let objectKey: string | null = null;
    let targetKernelStatus: KernelInstanceState | null = null;
    try {
      const begin = await this.#begin(job);
      if ("idempotent" in begin && begin.idempotent) {
        return;
      }
      if (begin.cleanupRequired) {
        objectKey = begin.objectKey;
        try {
          if (
            !(await this.#markCleanupRequired(
              job,
              begin.failureCode,
              begin.status,
            ))
          ) {
            throw new WorkerJobError(
              "restore-claim-active",
              restoreClaimRetryAt(),
            );
          }
          const removedKernel = await this.#cleanupFailed(job);
          this.logger.warn({
            elapsedMs: performance.now() - startedAt,
            event: "backup.job",
            objectKey,
            reason: begin.failureCode,
            requestId: job.requestId,
            spaceId: job.sourceSpaceId,
            status: "failed",
            targetSpaceId: job.targetSpaceId,
            taskId: job.restoreId,
            taskKind: "restore",
            validationResult: "not-completed",
          });
          if (removedKernel && begin.targetKernelStatus !== null) {
            this.logger.warn({
              elapsedMs: performance.now() - startedAt,
              event: "kernel.lifecycle",
              fromState: begin.targetKernelStatus,
              kernelInstanceId: job.targetKernelInstanceId,
              reason: begin.failureCode,
              requestId: job.requestId,
              spaceId: job.targetSpaceId,
              toState: "removed",
            });
          }
        } catch (error) {
          if (
            error instanceof WorkerJobError &&
            error.code === "restore-claim-active"
          ) {
            throw error;
          }
          throw new WorkerJobError(
            "restore-target-cleanup-failed",
            restoreCleanupRetryAt(),
          );
        }
        throw new WorkerJobError(begin.failureCode, null);
      }
      started = true;
      targetKernelStatus = begin.targetKernelStatus;
      const parsedObjectKey = parseObjectKey(begin.objectKey);
      objectKey = parsedObjectKey;
      this.logger.info({
        elapsedMs: performance.now() - startedAt,
        event: "backup.job",
        objectKey,
        reason: job.kind,
        requestId: job.requestId,
        spaceId: job.sourceSpaceId,
        status: "restoring",
        targetSpaceId: job.targetSpaceId,
        taskId: job.restoreId,
        taskKind: "restore",
        validationResult: "pending",
      });
      if (!begin.authorized) {
        throw new WorkerJobError("restore-authorization-revoked", null);
      }
      const archive = await this.objects.openReadStream(
        parsedObjectKey,
        this.maximumBackupBytes,
      );
      const result = await this.deployment.restore(
        { archive, expectedSha256: begin.sha256, job },
        signal,
      );
      signal.throwIfAborted();
      await this.database.client.$transaction(async (transaction) => {
        const updated = await transaction.$executeRaw(
          Prisma.sql`
            UPDATE "space_restore_jobs"
            SET
              "status" = 'ready-for-activation',
              "worker_job_id" = NULL,
              "worker_attempt" = NULL,
              "completed_at" = CURRENT_TIMESTAMP
            WHERE "id" = ${job.restoreId}::uuid
              AND "organization_id" = ${job.organizationId}::uuid
              AND "source_space_id" = ${job.sourceSpaceId}::uuid
              AND "target_space_id" = ${job.targetSpaceId}::uuid
              AND "status" = 'restoring'
              AND "worker_job_id" = ${job.id}::uuid
              AND "worker_attempt" = ${job.attempt}
          `,
        );
        if (updated !== 1) {
          throw new WorkerJobError("restore-state-conflict", null);
        }
        await transaction.$executeRaw(
          Prisma.sql`
            INSERT INTO "kernel_runtime_endpoints" (
              "kernel_instance_id", "space_id", "hostname", "port",
              "server_name", "tls_profile"
            ) VALUES (
              ${result.endpoint.kernelInstanceId}::uuid,
              ${result.endpoint.spaceId}::uuid,
              ${result.endpoint.hostname},
              ${result.endpoint.port},
              ${result.endpoint.serverName},
              ${result.endpoint.tlsProfile}
            )
            ON CONFLICT ("kernel_instance_id") DO UPDATE SET
              "space_id" = EXCLUDED."space_id",
              "hostname" = EXCLUDED."hostname",
              "port" = EXCLUDED."port",
              "server_name" = EXCLUDED."server_name",
              "tls_profile" = EXCLUDED."tls_profile"
          `,
        );
        await transaction.kernelInstance.update({
          where: { id: job.targetKernelInstanceId },
          data: {
            deploymentHandle: result.endpoint.handle,
            status: "ready",
            version: result.kernelVersion,
          },
        });
        await publishKernelDeploymentChange(transaction, {
          kernelInstanceId: result.endpoint.kernelInstanceId,
          kind: "upsert",
          requestId: job.requestId,
          spaceId: result.endpoint.spaceId,
        });
      });
      this.logger.info({
        elapsedMs: performance.now() - startedAt,
        event: "backup.job",
        objectKey,
        reason: job.kind,
        requestId: job.requestId,
        spaceId: job.sourceSpaceId,
        status: "ready-for-activation",
        targetSpaceId: job.targetSpaceId,
        taskId: job.restoreId,
        taskKind: "restore",
        validationResult: "passed",
      });
      this.logger.info({
        elapsedMs: performance.now() - startedAt,
        event: "kernel.lifecycle",
        fromState: begin.targetKernelStatus,
        kernelInstanceId: job.targetKernelInstanceId,
        reason: job.kind,
        requestId: job.requestId,
        spaceId: job.targetSpaceId,
        toState: "ready",
      });
    } catch (error) {
      if (signal.aborted) {
        throw error;
      }
      if (!started) {
        throw error;
      }
      const failureCode =
        error instanceof WorkerJobError
          ? error.code
          : "restore-execution-failed";
      try {
        if (!(await this.#markCleanupRequired(job, failureCode, "restoring"))) {
          throw new WorkerJobError(
            "restore-claim-active",
            restoreClaimRetryAt(),
          );
        }
        const removedKernel = await this.#cleanupFailed(job);
        this.logger.warn({
          elapsedMs: performance.now() - startedAt,
          event: "backup.job",
          objectKey,
          reason: failureCode,
          requestId: job.requestId,
          spaceId: job.sourceSpaceId,
          status: "failed",
          targetSpaceId: job.targetSpaceId,
          taskId: job.restoreId,
          taskKind: "restore",
          validationResult: "not-completed",
        });
        if (removedKernel && targetKernelStatus !== null) {
          this.logger.warn({
            elapsedMs: performance.now() - startedAt,
            event: "kernel.lifecycle",
            fromState: targetKernelStatus,
            kernelInstanceId: job.targetKernelInstanceId,
            reason: failureCode,
            requestId: job.requestId,
            spaceId: job.targetSpaceId,
            toState: "removed",
          });
        }
      } catch (cleanupError) {
        if (
          cleanupError instanceof WorkerJobError &&
          cleanupError.code === "restore-claim-active"
        ) {
          throw cleanupError;
        }
        throw new WorkerJobError(
          "restore-target-cleanup-failed",
          restoreCleanupRetryAt(),
        );
      }
      throw new WorkerJobError(failureCode, null);
    }
  }

  async #begin(job: RestoreSpaceJob): Promise<RestoreBegin> {
    const cleanupRows = await this.database.client.$queryRaw<RestoreCleanupRow[]>(
      Prisma.sql`
        SELECT
          restore."failure_code" AS "failureCode",
          backup."object_key" AS "objectKey",
          restore."status",
          target_kernel."status" AS "targetKernelStatus"
        FROM "space_restore_jobs" AS restore
        INNER JOIN "space_backups" AS backup
          ON backup."id" = restore."backup_id"
          AND backup."organization_id" = restore."organization_id"
          AND backup."source_space_id" = restore."source_space_id"
          AND backup."object_key" IS NOT NULL
        LEFT JOIN "kernel_instances" AS target_kernel
          ON target_kernel."id" = ${job.targetKernelInstanceId}::uuid
          AND target_kernel."space_id" = restore."target_space_id"
        WHERE restore."id" = ${job.restoreId}::uuid
          AND restore."organization_id" = ${job.organizationId}::uuid
          AND restore."source_space_id" = ${job.sourceSpaceId}::uuid
          AND restore."target_space_id" = ${job.targetSpaceId}::uuid
          AND restore."status" IN ('queued', 'restoring')
          AND restore."failure_code" IS NOT NULL
        LIMIT 1
      `,
    );
    const cleanup = cleanupRows[0];
    if (cleanup !== undefined) {
      return {
        cleanupRequired: true,
        failureCode: cleanup.failureCode,
        objectKey: cleanup.objectKey,
        status: cleanup.status,
        targetKernelStatus: cleanup.targetKernelStatus,
      };
    }

    const rows = await this.database.client.$queryRaw<RestoreSourceRow[]>(
      Prisma.sql`
        UPDATE "space_restore_jobs" AS restore
        SET
          "status" = 'restoring',
          "worker_job_id" = ${job.id}::uuid,
          "worker_attempt" = ${job.attempt}
        FROM "space_backups" AS backup,
             "organizations" AS organization,
             "spaces" AS source_space,
             "spaces" AS target_space,
             "kernel_instances" AS target_kernel
        WHERE restore."id" = ${job.restoreId}::uuid
          AND restore."organization_id" = ${job.organizationId}::uuid
          AND restore."source_space_id" = ${job.sourceSpaceId}::uuid
          AND restore."target_space_id" = ${job.targetSpaceId}::uuid
          AND restore."backup_id" = backup."id"
          AND organization."id" = restore."organization_id"
          AND source_space."id" = restore."source_space_id"
          AND source_space."organization_id" = restore."organization_id"
          AND target_space."id" = restore."target_space_id"
          AND target_space."organization_id" = restore."organization_id"
          AND target_kernel."id" = ${job.targetKernelInstanceId}::uuid
          AND target_kernel."space_id" = target_space."id"
          AND restore."status" = 'queued'
          AND restore."failure_code" IS NULL
          AND backup."organization_id" = restore."organization_id"
          AND backup."source_space_id" = restore."source_space_id"
          AND backup."status" = 'succeeded'
          AND backup."object_key" IS NOT NULL
          AND backup."sha256" IS NOT NULL
        RETURNING
          backup."object_key" AS "objectKey",
          backup."sha256",
          target_kernel."status" AS "targetKernelStatus",
          (
            organization."status" = 'active'
            AND source_space."status" IN ('active', 'archived')
            AND target_space."status" = 'archived'
            AND target_kernel."status" IN ('starting', 'unavailable')
            AND EXISTS (
              SELECT 1
              FROM "users" AS actor
              INNER JOIN "organization_memberships" AS organization_membership
                ON organization_membership."user_id" = actor."id"
                AND organization_membership."organization_id" = restore."organization_id"
                AND organization_membership."status" = 'active'
              WHERE actor."id" = restore."created_by_user_id"
                AND actor."status" = 'active'
                AND (
                  organization_membership."role" IN ('owner', 'admin')
                  OR EXISTS (
                    SELECT 1 FROM "space_memberships" AS space_membership
                    WHERE space_membership."space_id" = restore."source_space_id"
                      AND space_membership."organization_id" = restore."organization_id"
                      AND space_membership."user_id" = actor."id"
                      AND space_membership."status" = 'active'
                      AND space_membership."role" = 'admin'
                  )
                  OR EXISTS (
                    SELECT 1
                    FROM "space_group_grants" AS grant
                    INNER JOIN "user_groups" AS user_group
                      ON user_group."id" = grant."group_id"
                      AND user_group."organization_id" = grant."organization_id"
                      AND user_group."status" = 'active'
                    INNER JOIN "user_group_memberships" AS group_membership
                      ON group_membership."group_id" = user_group."id"
                      AND group_membership."organization_id" = user_group."organization_id"
                      AND group_membership."user_id" = actor."id"
                    INNER JOIN "organization_memberships" AS group_organization_membership
                      ON group_organization_membership."organization_id" = user_group."organization_id"
                      AND group_organization_membership."user_id" = group_membership."user_id"
                      AND group_organization_membership."status" = 'active'
                    WHERE grant."space_id" = restore."source_space_id"
                      AND grant."organization_id" = restore."organization_id"
                      AND grant."role" = 'admin'
                  )
                )
            )
          ) AS "authorized"
      `,
    );
    const source = rows[0];
    if (source === undefined) {
      const stateRows = await this.database.client.$queryRaw<RestoreStateRow[]>(
        Prisma.sql`
          SELECT
            backup."object_key" AS "objectKey",
            restore."status",
            restore."target_space_id" AS "targetSpaceId",
            restore."worker_job_id" AS "workerJobId",
            restore."worker_attempt" AS "workerAttempt",
            target_kernel."status" AS "targetKernelStatus",
            target_space."status" AS "targetSpaceStatus",
            EXISTS (
              SELECT 1
              FROM "worker_jobs" AS claim
              WHERE claim."id" = restore."worker_job_id"
                AND claim."status" = 'running'
                AND claim."attempt" = restore."worker_attempt"
                AND claim."lease_expires_at" > CURRENT_TIMESTAMP
            ) AS "claimActive"
          FROM "space_restore_jobs" AS restore
          INNER JOIN "space_backups" AS backup
            ON backup."id" = restore."backup_id"
            AND backup."organization_id" = restore."organization_id"
            AND backup."source_space_id" = restore."source_space_id"
            AND backup."object_key" IS NOT NULL
          LEFT JOIN "spaces" AS target_space
            ON target_space."id" = restore."target_space_id"
            AND target_space."organization_id" = restore."organization_id"
          LEFT JOIN "kernel_instances" AS target_kernel
            ON target_kernel."id" = ${job.targetKernelInstanceId}::uuid
            AND target_kernel."space_id" = target_space."id"
          WHERE restore."id" = ${job.restoreId}::uuid
            AND restore."organization_id" = ${job.organizationId}::uuid
            AND restore."source_space_id" = ${job.sourceSpaceId}::uuid
          LIMIT 1
        `,
      );
      const state = stateRows[0];
      if (state === undefined) {
        throw new WorkerJobError("restore-state-conflict", null);
      }
      if (
        state.status === "ready-for-activation" ||
        state.status === "activated" ||
        state.status === "failed"
      ) {
        if (
          state.status !== "failed" &&
          state.targetSpaceId !== job.targetSpaceId
        ) {
          throw new WorkerJobError("restore-state-conflict", null);
        }
        return { idempotent: true };
      }
      if (state.status === "restoring") {
        if (
          state.workerJobId === job.id &&
          state.workerAttempt === job.attempt
        ) {
          throw new WorkerJobError(
            "restore-claim-active",
            restoreClaimRetryAt(),
          );
        }
        if (state.claimActive) {
          throw new WorkerJobError(
            "restore-claim-active",
            restoreClaimRetryAt(),
          );
        }
        return {
          cleanupRequired: true,
          failureCode: "restore-claim-expired",
          objectKey: state.objectKey,
          status: "restoring",
          targetKernelStatus: state.targetKernelStatus,
        };
      }
      if (
        state.status === "queued" &&
        state.targetSpaceId === job.targetSpaceId &&
        state.targetSpaceStatus === "archived" &&
        (state.targetKernelStatus === "starting" ||
          state.targetKernelStatus === "unavailable")
      ) {
        return {
          cleanupRequired: true,
          failureCode: "restore-state-conflict",
          objectKey: state.objectKey,
          status: "queued",
          targetKernelStatus: state.targetKernelStatus,
        };
      }
      throw new WorkerJobError("restore-state-conflict", null);
    }
    return { ...source, cleanupRequired: false, idempotent: false };
  }

  async #markCleanupRequired(
    job: RestoreSpaceJob,
    failureCode: string,
    status: "queued" | "restoring",
  ): Promise<boolean> {
    const updated = await this.database.client.$executeRaw(
      Prisma.sql`
        UPDATE "space_restore_jobs"
        SET
          "status" = CASE
            WHEN "status" = 'queued' THEN 'restoring'::"space_restore_status"
            ELSE "status"
          END,
          "failure_code" = COALESCE("failure_code", ${failureCode}),
          "worker_job_id" = ${job.id}::uuid,
          "worker_attempt" = ${job.attempt}
        WHERE "id" = ${job.restoreId}::uuid
          AND "organization_id" = ${job.organizationId}::uuid
          AND "source_space_id" = ${job.sourceSpaceId}::uuid
          AND "target_space_id" = ${job.targetSpaceId}::uuid
          AND "status" = ${status}::"space_restore_status"
          AND (
            "worker_job_id" IS NULL
            OR ("worker_job_id" = ${job.id}::uuid AND "worker_attempt" = ${job.attempt})
            OR NOT EXISTS (
              SELECT 1
              FROM "worker_jobs" AS claim
              WHERE claim."id" = "space_restore_jobs"."worker_job_id"
                AND claim."status" = 'running'
                AND claim."attempt" = "space_restore_jobs"."worker_attempt"
                AND claim."lease_expires_at" > CURRENT_TIMESTAMP
            )
          )
      `,
    );
    return updated === 1;
  }

  async #cleanupFailed(job: RestoreSpaceJob): Promise<boolean> {
    await this.deployment.destroyTarget(job);
    return this.database.client.$transaction(async (transaction) => {
      await transaction.$executeRaw(
        Prisma.sql`
          DELETE FROM "space_capacity_observations"
          WHERE "space_id" = ${job.targetSpaceId}::uuid
        `,
      );
      await transaction.$executeRaw(
        Prisma.sql`
          DELETE FROM "kernel_health_observations"
          WHERE "kernel_instance_id" = ${job.targetKernelInstanceId}::uuid
        `,
      );
      const updated = await transaction.$executeRaw(
        Prisma.sql`
          UPDATE "space_restore_jobs"
          SET "status" = 'failed',
              "target_space_id" = NULL,
              "worker_job_id" = NULL,
              "worker_attempt" = NULL,
              "completed_at" = CURRENT_TIMESTAMP
          WHERE "id" = ${job.restoreId}::uuid
            AND "organization_id" = ${job.organizationId}::uuid
            AND "source_space_id" = ${job.sourceSpaceId}::uuid
            AND "target_space_id" = ${job.targetSpaceId}::uuid
            AND "status" IN ('queued', 'restoring')
            AND "failure_code" IS NOT NULL
            AND "worker_job_id" = ${job.id}::uuid
            AND "worker_attempt" = ${job.attempt}
        `,
      );
      if (updated !== 1) {
        throw new WorkerJobError("restore-state-conflict", null);
      }
      const endpointRows = await transaction.$queryRaw<
        Array<{ kernelInstanceId: string; spaceId: string }>
      >(
        Prisma.sql`
          SELECT
            endpoint."kernel_instance_id" AS "kernelInstanceId",
            endpoint."space_id" AS "spaceId"
          FROM "kernel_runtime_endpoints" AS endpoint
          INNER JOIN "kernel_instances" AS kernel
            ON kernel."id" = endpoint."kernel_instance_id"
            AND kernel."space_id" = endpoint."space_id"
          WHERE endpoint."kernel_instance_id" = ${job.targetKernelInstanceId}::uuid
            AND endpoint."space_id" = ${job.targetSpaceId}::uuid
            AND kernel."deployment_handle" IS NOT NULL
          LIMIT 1
        `,
      );
      await transaction.$executeRaw(
        Prisma.sql`
          DELETE FROM "kernel_runtime_endpoints"
          WHERE "kernel_instance_id" = ${job.targetKernelInstanceId}::uuid
            AND "space_id" = ${job.targetSpaceId}::uuid
        `,
      );
      const endpoint = endpointRows[0];
      if (endpoint !== undefined) {
        await publishKernelDeploymentChange(transaction, {
          kernelInstanceId: endpoint.kernelInstanceId,
          kind: "remove",
          requestId: job.requestId,
          spaceId: endpoint.spaceId,
        });
      }
      await transaction.spaceMembership.deleteMany({
        where: { spaceId: job.targetSpaceId },
      });
      await transaction.spaceGroupGrant.deleteMany({
        where: { organizationId: job.organizationId, spaceId: job.targetSpaceId },
      });
      await transaction.documentShare.deleteMany({
        where: { organizationId: job.organizationId, spaceId: job.targetSpaceId },
      });
      const removedKernel = await transaction.kernelInstance.deleteMany({
        where: { id: job.targetKernelInstanceId, spaceId: job.targetSpaceId },
      });
      await transaction.space.deleteMany({
        where: { id: job.targetSpaceId, organizationId: job.organizationId },
      });
      return removedKernel.count === 1;
    });
  }
}

@Injectable()
@HandlesWorkerJob({ kind: "sample-kernel" })
export class SampleKernelHandler implements WorkerJobHandler<SampleKernelJob> {
  readonly kind: SampleKernelJob["kind"] = "sample-kernel";

  constructor(
    private readonly database: DatabaseRuntime,
    @Inject(KERNEL_WORKER)
    private readonly observations: KernelObservationPort,
  ) {}

  decode(record: WorkerJobRecord): SampleKernelJob {
    const payload = record.payload;
    return {
      ...baseJob(record),
      kernelInstanceId: uuidProperty(payload, "kernelInstanceId"),
      kind: this.kind,
      spaceId: uuidProperty(payload, "spaceId"),
    };
  }

  async execute(job: SampleKernelJob, signal: AbortSignal): Promise<void> {
    const observation = await this.observations.read(job, signal);
    const sample = observation.sample;
    signal.throwIfAborted();
    await this.database.client.$transaction(async (transaction) => {
      const organizations = await transaction.$queryRaw<Array<{ id: string }>>(
        Prisma.sql`
          SELECT "id"
          FROM "organizations"
          WHERE "id" = ${job.organizationId}::uuid
            AND "status" = 'active'
          FOR UPDATE
        `,
      );
      if (organizations.length !== 1) {
        throw new WorkerJobError("observation-state-conflict", null);
      }
      const spaces = await transaction.$queryRaw<Array<{ id: string }>>(
        Prisma.sql`
          SELECT "id"
          FROM "spaces"
          WHERE "id" = ${job.spaceId}::uuid
            AND "organization_id" = ${job.organizationId}::uuid
            AND "status" IN ('active', 'archived')
          FOR UPDATE
        `,
      );
      if (spaces.length !== 1) {
        throw new WorkerJobError("observation-state-conflict", null);
      }
      const kernels = await transaction.$queryRaw<Array<{ id: string }>>(
        Prisma.sql`
          SELECT "id"
          FROM "kernel_instances"
          WHERE "id" = ${job.kernelInstanceId}::uuid
            AND "space_id" = ${job.spaceId}::uuid
            AND "status" = 'ready'
            AND "deployment_handle" = ${observation.deploymentHandle}
          FOR UPDATE
        `,
      );
      if (kernels.length !== 1) {
        throw new WorkerJobError("observation-state-conflict", null);
      }
      await transaction.$executeRaw(
        Prisma.sql`
          INSERT INTO "kernel_health_observations" (
            "id", "kernel_instance_id", "status", "kernel_version",
            "sampled_at", "error_code"
          ) VALUES (
            gen_random_uuid(), ${job.kernelInstanceId}::uuid,
            ${sample.health.status}::"kernel_observation_status",
            ${sample.health.kernelVersion},
            ${new Date(sample.health.sampledAt)}, ${sample.health.errorCode ?? null}
          )
        `,
      );
      await transaction.$executeRaw(
        Prisma.sql`
          INSERT INTO "space_capacity_observations" (
            "id", "kernel_instance_id", "space_id", "data_bytes", "asset_bytes",
            "file_count", "sample_duration_milliseconds", "sampled_at", "error_code"
          ) VALUES (
            gen_random_uuid(), ${job.kernelInstanceId}::uuid, ${job.spaceId}::uuid,
            ${BigInt(sample.capacity.dataBytes)}, ${BigInt(sample.capacity.assetBytes)},
            ${BigInt(sample.capacity.fileCount)}, ${sample.capacity.sampleDurationMilliseconds},
            ${new Date(sample.capacity.sampledAt)}, ${sample.capacity.errorCode ?? null}
          )
        `,
      );
    });
  }
}

interface AuditArchiveRow {
  action: string;
  actorUserId: string | null;
  auditEventId: string;
  keyVersion: string;
  mac: string;
  occurredAt: Date;
  organizationId: string;
  outcome: string;
  previousMac: string | null;
  requestId: string;
  sequence: bigint;
  spaceId: string | null;
  targetId: string;
  targetType: string;
}

interface ExistingAuditArchiveRow {
  fromSequence: bigint;
  objectKey: string;
  sha256: string;
  sizeBytes: bigint;
  throughSequence: bigint;
}

@Injectable()
@HandlesWorkerJob({ kind: "archive-audit" })
export class ArchiveAuditHandler implements WorkerJobHandler<ArchiveAuditJob> {
  readonly kind: ArchiveAuditJob["kind"] = "archive-audit";

  constructor(
    private readonly database: DatabaseRuntime,
    @Inject(MAXIMUM_AUDIT_ARCHIVE_BYTES)
    private readonly maximumArchiveBytes: number,
    @Inject(MAXIMUM_AUDIT_ARCHIVE_EVENT_COUNT)
    private readonly maximumArchiveEvents: number,
    private readonly objects: FileObjectStore,
  ) {}

  decode(record: WorkerJobRecord): ArchiveAuditJob {
    const payload = record.payload;
    const fromSequence = sequenceProperty(payload, "fromSequence");
    const throughSequence = sequenceProperty(payload, "throughSequence");
    if (
      fromSequence > throughSequence ||
      throughSequence - fromSequence + 1n > BigInt(this.maximumArchiveEvents)
    ) {
      throw new WorkerJobError("worker-job-payload-invalid", null);
    }
    return {
      ...baseJob(record),
      fromSequence: fromSequence.toString(),
      kind: this.kind,
      throughSequence: throughSequence.toString(),
    };
  }

  async execute(job: ArchiveAuditJob, signal: AbortSignal): Promise<void> {
    const existing = await this.#existing(job);
    if (existing !== null) {
      return;
    }
    const fromSequence = BigInt(job.fromSequence);
    const throughSequence = BigInt(job.throughSequence);
    const rows = await this.database.client.$queryRaw<AuditArchiveRow[]>(
      Prisma.sql`
        SELECT
          "id" AS "auditEventId", "organization_id" AS "organizationId",
          "sequence", "space_id" AS "spaceId", "actor_user_id" AS "actorUserId",
          "action", "target_type" AS "targetType", "target_id" AS "targetId",
          "outcome", "occurred_at" AS "occurredAt", "request_id" AS "requestId",
          "previous_mac" AS "previousMac", "mac", "key_version" AS "keyVersion"
        FROM "audit_events"
        WHERE "organization_id" = ${job.organizationId}::uuid
          AND "sequence" BETWEEN ${fromSequence} AND ${throughSequence}
        ORDER BY "sequence" ASC
        LIMIT ${this.maximumArchiveEvents + 1}
      `,
    );
    const first = rows[0];
    const last = rows.at(-1);
    if (
      rows.length === 0 ||
      rows.length > this.maximumArchiveEvents ||
      first === undefined ||
      last === undefined ||
      first.sequence !== fromSequence ||
      last.sequence !== throughSequence
    ) {
      throw new WorkerJobError("audit-archive-range-invalid", null);
    }
    for (let index = 1; index < rows.length; index += 1) {
      const previous = rows[index - 1];
      const current = rows[index];
      if (
        previous === undefined ||
        current === undefined ||
        current.sequence !== previous.sequence + 1n ||
        current.previousMac !== previous.mac
      ) {
        throw new WorkerJobError("audit-archive-chain-invalid", null);
      }
    }
    const key = createObjectKey();
    async function* jsonLines(): AsyncGenerator<Uint8Array> {
      for (const row of rows) {
        signal.throwIfAborted();
        yield Buffer.from(
          `${JSON.stringify({
            ...row,
            occurredAt: row.occurredAt.toISOString(),
            sequence: row.sequence.toString(),
          })}\n`,
          "utf8",
        );
      }
    }
    let stored: StoredObject | undefined;
    try {
      stored = await this.objects.put({
        key,
        maximumBytes: this.maximumArchiveBytes,
        source: jsonLines(),
      });
      signal.throwIfAborted();
      await this.database.client.$executeRaw(
        Prisma.sql`
          INSERT INTO "audit_archives" (
            "id", "organization_id", "from_sequence", "through_sequence",
            "first_mac", "last_mac", "object_key", "sha256", "size_bytes", "created_at"
          ) VALUES (
            ${job.id}::uuid, ${job.organizationId}::uuid, ${fromSequence},
            ${throughSequence}, ${first.mac}, ${last.mac},
            ${stored.key}, ${stored.sha256}, ${stored.sizeBytes}, CURRENT_TIMESTAMP
          )
        `,
      );
    } catch (error) {
      if (stored !== undefined) {
        try {
          await this.objects.delete(stored.key);
        } catch (cleanupError) {
          if (
            !(
              cleanupError instanceof ObjectStoreError &&
              cleanupError.code === "not-found"
            )
          ) {
            throw new WorkerJobError("audit-archive-object-cleanup-failed", null);
          }
        }
      }
      throw error;
    }
  }

  async #existing(job: ArchiveAuditJob): Promise<ExistingAuditArchiveRow | null> {
    const rows = await this.database.client.$queryRaw<ExistingAuditArchiveRow[]>(
      Prisma.sql`
        SELECT
          "from_sequence" AS "fromSequence",
          "object_key" AS "objectKey",
          "sha256",
          "size_bytes" AS "sizeBytes",
          "through_sequence" AS "throughSequence"
        FROM "audit_archives"
        WHERE "id" = ${job.id}::uuid
          AND "organization_id" = ${job.organizationId}::uuid
        LIMIT 1
      `,
    );
    const existing = rows[0];
    if (existing === undefined) {
      return null;
    }
    if (
      existing.fromSequence !== BigInt(job.fromSequence) ||
      existing.throughSequence !== BigInt(job.throughSequence)
    ) {
      throw new WorkerJobError("audit-archive-range-conflict", null);
    }
    const object = await this.objects.digest(
      parseObjectKey(existing.objectKey),
      this.maximumArchiveBytes,
    );
    if (
      object.sha256 !== existing.sha256 ||
      BigInt(object.sizeBytes) !== existing.sizeBytes
    ) {
      throw new WorkerJobError("audit-archive-object-conflict", null);
    }
    return existing;
  }
}
