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
  WorkerJobRecord,
} from "./worker.js";
import { WorkerJobError } from "./worker.js";
import {
  KERNEL_WORKER,
  MAXIMUM_AUDIT_ARCHIVE_BYTES,
  MAXIMUM_AUDIT_ARCHIVE_EVENT_COUNT,
  MAXIMUM_BACKUP_BYTES,
  RESTORE_DEPLOYMENT,
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
  }>;
}

function retryAt(attempt: number): Date | null {
  return attempt < 3 ? new Date(Date.now() + attempt * 60_000) : null;
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
    try {
      const key = await this.#begin(job);
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
            "completed_at" = CURRENT_TIMESTAMP
          WHERE "id" = ${job.backupId}::uuid
            AND "organization_id" = ${job.organizationId}::uuid
            AND "source_space_id" = ${job.spaceId}::uuid
            AND "status" = 'running'
        `,
      );
      if (count !== 1) {
        throw new WorkerJobError("backup-state-conflict", null);
      }
    } catch (error) {
      if (signal.aborted) {
        throw error;
      }
      const nextRetryAt =
        error instanceof WorkerJobError && error.retryAt === null
          ? null
          : retryAt(job.attempt);
      await this.database.client.$executeRaw(
        Prisma.sql`
          UPDATE "space_backups"
          SET
            "status" = ${nextRetryAt === null ? "failed" : "queued"}::"space_backup_status",
            "completed_at" = CASE
              WHEN ${nextRetryAt}::timestamptz IS NULL THEN CURRENT_TIMESTAMP
              ELSE NULL
            END
          WHERE "id" = ${job.backupId}::uuid
            AND "organization_id" = ${job.organizationId}::uuid
            AND "source_space_id" = ${job.spaceId}::uuid
            AND "status" IN ('queued', 'running')
        `,
      );
      if (error instanceof WorkerJobError && error.retryAt === null) {
        throw error;
      }
      throw new WorkerJobError("backup-execution-failed", nextRetryAt);
    }
  }

  async #begin(job: BackupSpaceJob) {
    const rows = await this.database.client.$queryRaw<Array<{ objectKey: string | null }>>(
      Prisma.sql`
        UPDATE "space_backups"
        SET "status" = 'running', "object_key" = COALESCE("space_backups"."object_key", ${createObjectKey()})
        FROM "organizations" AS organization, "spaces" AS source_space
        WHERE "space_backups"."id" = ${job.backupId}::uuid
          AND "space_backups"."organization_id" = ${job.organizationId}::uuid
          AND "space_backups"."source_space_id" = ${job.spaceId}::uuid
          AND organization."id" = "space_backups"."organization_id"
          AND source_space."id" = "space_backups"."source_space_id"
          AND source_space."organization_id" = "space_backups"."organization_id"
          AND organization."status" = 'active'
          AND source_space."status" IN ('active', 'archived')
          AND "space_backups"."status" IN ('queued', 'running')
        RETURNING "space_backups"."object_key" AS "objectKey"
      `,
    );
    const objectKey = rows[0]?.objectKey;
    if (objectKey === undefined || objectKey === null) {
      throw new WorkerJobError("backup-state-conflict", null);
    }
    return parseObjectKey(objectKey);
  }
}

interface RestoreCleanupRow {
  failureCode: string;
  status: "queued" | "restoring";
}

interface RestoreSourceRow {
  authorized: boolean;
  objectKey: string;
  sha256: string;
}

interface RestoreStateRow {
  claimActive: boolean;
  targetSpaceId: string | null;
  workerAttempt: number | null;
  workerJobId: string | null;
  status: string;
  targetKernelStatus: string | null;
  targetSpaceStatus: string | null;
}

type RestoreBegin =
  | {
      cleanupRequired: true;
      failureCode: string;
      status: "queued" | "restoring";
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
    let started = false;
    try {
      const begin = await this.#begin(job);
      if ("idempotent" in begin && begin.idempotent) {
        return;
      }
      if (begin.cleanupRequired) {
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
          await this.#cleanupFailed(job);
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
      if (!begin.authorized) {
        throw new WorkerJobError("restore-authorization-revoked", null);
      }
      const archive = await this.objects.openReadStream(
        parseObjectKey(begin.objectKey),
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
          deploymentHandle: result.endpoint.handle,
          kernelInstanceId: result.endpoint.kernelInstanceId,
          kind: "upsert",
          requestId: job.requestId,
          spaceId: result.endpoint.spaceId,
        });
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
        await this.#cleanupFailed(job);
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
        SELECT "failure_code" AS "failureCode", "status"
        FROM "space_restore_jobs"
        WHERE "id" = ${job.restoreId}::uuid
          AND "organization_id" = ${job.organizationId}::uuid
          AND "source_space_id" = ${job.sourceSpaceId}::uuid
          AND "target_space_id" = ${job.targetSpaceId}::uuid
          AND "status" IN ('queued', 'restoring')
          AND "failure_code" IS NOT NULL
        LIMIT 1
      `,
    );
    const cleanup = cleanupRows[0];
    if (cleanup !== undefined) {
      return {
        cleanupRequired: true,
        failureCode: cleanup.failureCode,
        status: cleanup.status,
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
          status: "restoring",
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
          status: "queued",
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

  async #cleanupFailed(job: RestoreSpaceJob): Promise<void> {
    await this.deployment.destroyTarget(job);
    await this.database.client.$transaction(async (transaction) => {
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
        Array<{ deploymentHandle: string }>
      >(
        Prisma.sql`
          SELECT "deployment_handle" AS "deploymentHandle"
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
          deploymentHandle: endpoint.deploymentHandle,
          kernelInstanceId: job.targetKernelInstanceId,
          kind: "remove",
          requestId: job.requestId,
          spaceId: job.targetSpaceId,
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
      await transaction.kernelInstance.deleteMany({
        where: { id: job.targetKernelInstanceId, spaceId: job.targetSpaceId },
      });
      await transaction.space.deleteMany({
        where: { id: job.targetSpaceId, organizationId: job.organizationId },
      });
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
    const sample = await this.observations.read(job, signal);
    signal.throwIfAborted();
    await this.database.client.$transaction(async (transaction) => {
      const active = await transaction.$queryRaw<Array<{ allowed: boolean }>>(
        Prisma.sql`
          SELECT EXISTS (
            SELECT 1
            FROM "kernel_instances" AS kernel
            INNER JOIN "spaces" AS space
              ON space."id" = kernel."space_id"
              AND space."organization_id" = ${job.organizationId}::uuid
            INNER JOIN "organizations" AS organization
              ON organization."id" = space."organization_id"
            WHERE kernel."id" = ${job.kernelInstanceId}::uuid
              AND kernel."space_id" = ${job.spaceId}::uuid
              AND organization."status" = 'active'
              AND space."status" IN ('active', 'archived')
          ) AS "allowed"
        `,
      );
      if (active[0]?.allowed !== true) {
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
  objectKey: string;
  sha256: string;
  sizeBytes: bigint;
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
        SELECT "object_key" AS "objectKey", "sha256", "size_bytes" AS "sizeBytes"
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
