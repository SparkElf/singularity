import { randomUUID } from "node:crypto";

import { Inject, Injectable } from "@nestjs/common";
import { DatabaseRuntime, Prisma } from "@singularity/database";

import { AuditWriter } from "../audit/audit-writer.service.js";
import type { Clock } from "../identity/clock.js";
import { AccessChangedPublisher } from "../kernel/access-changed.js";
import { conflict, notFound } from "../problem.js";
import { SpaceManagementService } from "../spaces/space-management.service.js";
import { CLOCK } from "../tokens.js";
import type {
  SpaceBackupStatus,
  SpaceBackupView,
  SpaceRestoreStatus,
  SpaceRestoreView,
} from "./backup.types.js";

interface BackupRow {
  backupId: string;
  completedAt: Date | null;
  createdAt: Date;
  formatVersion: number | null;
  kernelVersion: string | null;
  organizationId: string;
  sha256: string | null;
  sizeBytes: bigint | null;
  sourceSpaceId: string;
  status: SpaceBackupStatus;
}

interface RestoreRow {
  activatedAt: Date | null;
  backupId: string;
  createdAt: Date;
  organizationId: string;
  restoreId: string;
  sourceSpaceId: string;
  status: SpaceRestoreStatus;
  targetSpaceId: string | null;
}

function backupView(row: BackupRow): SpaceBackupView {
  return {
    backupId: row.backupId,
    completedAt: row.completedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    formatVersion: row.formatVersion,
    kernelVersion: row.kernelVersion,
    organizationId: row.organizationId,
    sha256: row.sha256,
    sizeBytes: row.sizeBytes?.toString() ?? null,
    sourceSpaceId: row.sourceSpaceId,
    status: row.status,
  };
}

function restoreView(row: RestoreRow): SpaceRestoreView {
  return {
    activatedAt: row.activatedAt?.toISOString() ?? null,
    backupId: row.backupId,
    createdAt: row.createdAt.toISOString(),
    organizationId: row.organizationId,
    restoreId: row.restoreId,
    sourceSpaceId: row.sourceSpaceId,
    status: row.status,
    targetSpaceId: row.targetSpaceId,
  };
}

@Injectable()
export class BackupService {
  constructor(
    private readonly audit: AuditWriter,
    private readonly accessChanges: AccessChangedPublisher,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly database: DatabaseRuntime,
    private readonly spaces: SpaceManagementService,
  ) {}

  async listBackups(input: {
    actorUserId: string;
    organizationId: string;
    sourceSpaceId: string;
  }): Promise<SpaceBackupView[]> {
    await this.spaces.requireSpaceManager(
      input.actorUserId,
      input.organizationId,
      input.sourceSpaceId,
    );
    const rows = await this.database.client.$queryRaw<BackupRow[]>(
      Prisma.sql`
        SELECT
          "id" AS "backupId",
          "organization_id" AS "organizationId",
          "source_space_id" AS "sourceSpaceId",
          "status",
          "format_version" AS "formatVersion",
          "kernel_version" AS "kernelVersion",
          "sha256",
          "size_bytes" AS "sizeBytes",
          "created_at" AS "createdAt",
          "completed_at" AS "completedAt"
        FROM "space_backups"
        WHERE "organization_id" = ${input.organizationId}::uuid
          AND "source_space_id" = ${input.sourceSpaceId}::uuid
        ORDER BY "created_at" DESC, "id" ASC
      `,
    );
    return rows.map(backupView);
  }

  async createBackup(input: {
    actorUserId: string;
    organizationId: string;
    requestId: string;
    sourceSpaceId: string;
  }): Promise<SpaceBackupView> {
    const now = this.clock.now();
    const backupId = randomUUID();
    const workerJobId = randomUUID();
    const row = await this.database.client.$transaction(async (transaction) => {
      await this.spaces.requireSpaceManagerInTransaction(
        transaction,
        input.actorUserId,
        input.organizationId,
        input.sourceSpaceId,
      );
      const rows = await transaction.$queryRaw<BackupRow[]>(
        Prisma.sql`
          INSERT INTO "space_backups" (
            "id", "organization_id", "source_space_id", "status",
            "created_by_user_id", "created_at"
          ) VALUES (
            ${backupId}::uuid, ${input.organizationId}::uuid,
            ${input.sourceSpaceId}::uuid, 'queued',
            ${input.actorUserId}::uuid, ${now}
          )
          RETURNING
            "id" AS "backupId",
            "organization_id" AS "organizationId",
            "source_space_id" AS "sourceSpaceId",
            "status",
            "format_version" AS "formatVersion",
            "kernel_version" AS "kernelVersion",
            "sha256",
            "size_bytes" AS "sizeBytes",
            "created_at" AS "createdAt",
            "completed_at" AS "completedAt"
        `,
      );
      await this.#enqueue(transaction, {
        jobId: workerJobId,
        kind: "backup-space",
        organizationId: input.organizationId,
        payload: { backupId, spaceId: input.sourceSpaceId },
        requestId: input.requestId,
        now,
      });
      await this.audit.append(transaction, {
        action: "backup.create",
        actorUserId: input.actorUserId,
        occurredAt: now,
        organizationId: input.organizationId,
        outcome: "succeeded",
        requestId: input.requestId,
        spaceId: input.sourceSpaceId,
        targetId: backupId,
        targetType: "backup",
      });
      const created = rows[0];
      if (created === undefined) {
        throw new Error("Space backup creation failed");
      }
      return created;
    });
    return backupView(row);
  }

  async createRestore(input: {
    actorUserId: string;
    backupId: string;
    organizationId: string;
    requestId: string;
    sourceSpaceId: string;
    targetSpaceName: string;
  }): Promise<SpaceRestoreView> {
    const now = this.clock.now();
    const restoreId = randomUUID();
    const workerJobId = randomUUID();
    const row = await this.database.client.$transaction(async (transaction) => {
      await this.spaces.requireSpaceManagerInTransaction(
        transaction,
        input.actorUserId,
        input.organizationId,
        input.sourceSpaceId,
      );
      const backups = await transaction.$queryRaw<Array<{ backupId: string }>>(
        Prisma.sql`
          SELECT "id" AS "backupId"
          FROM "space_backups"
          WHERE "id" = ${input.backupId}::uuid
            AND "organization_id" = ${input.organizationId}::uuid
            AND "source_space_id" = ${input.sourceSpaceId}::uuid
            AND "status" = 'succeeded'
            AND "object_key" IS NOT NULL
            AND "sha256" IS NOT NULL
          FOR UPDATE
        `,
      );
      if (backups[0] === undefined) {
        throw conflict();
      }
      const target = await transaction.space.create({
        data: {
          name: input.targetSpaceName,
          organizationId: input.organizationId,
          status: "archived",
          kernelInstance: {
            create: {
              deploymentHandle: null,
              status: "starting",
              version: null,
            },
          },
        },
        select: { id: true, kernelInstance: { select: { id: true } } },
      });
      if (target.kernelInstance === null) {
        throw new Error("Restore Kernel instance creation failed");
      }
      await transaction.spaceMembership.create({
        data: {
          organizationId: input.organizationId,
          role: "admin",
          spaceId: target.id,
          status: "active",
          userId: input.actorUserId,
        },
      });
      const rows = await transaction.$queryRaw<RestoreRow[]>(
        Prisma.sql`
          INSERT INTO "space_restore_jobs" (
            "id", "organization_id", "backup_id", "source_space_id",
            "target_space_id", "status", "created_by_user_id", "created_at"
          ) VALUES (
            ${restoreId}::uuid, ${input.organizationId}::uuid,
            ${input.backupId}::uuid, ${input.sourceSpaceId}::uuid,
            ${target.id}::uuid, 'queued', ${input.actorUserId}::uuid, ${now}
          )
          RETURNING
            "id" AS "restoreId",
            "organization_id" AS "organizationId",
            "backup_id" AS "backupId",
            "source_space_id" AS "sourceSpaceId",
            "target_space_id" AS "targetSpaceId",
            "status",
            "created_at" AS "createdAt",
            "activated_at" AS "activatedAt"
        `,
      );
      await this.#enqueue(transaction, {
        jobId: workerJobId,
        kind: "restore-space",
        organizationId: input.organizationId,
        payload: {
          backupId: input.backupId,
          targetKernelInstanceId: target.kernelInstance.id,
          targetSpaceId: target.id,
          restoreId,
          sourceSpaceId: input.sourceSpaceId,
        },
        requestId: input.requestId,
        now,
      });
      await this.audit.append(transaction, {
        action: "restore.create",
        actorUserId: input.actorUserId,
        occurredAt: now,
        organizationId: input.organizationId,
        outcome: "succeeded",
        requestId: input.requestId,
        spaceId: input.sourceSpaceId,
        targetId: restoreId,
        targetType: "restore",
      });
      const created = rows[0];
      if (created === undefined) {
        throw new Error("Space restore creation failed");
      }
      return created;
    });
    return restoreView(row);
  }

  async getRestore(input: {
    actorUserId: string;
    organizationId: string;
    restoreId: string;
    sourceSpaceId: string;
  }): Promise<SpaceRestoreView> {
    await this.spaces.requireSpaceManager(
      input.actorUserId,
      input.organizationId,
      input.sourceSpaceId,
    );
    const rows = await this.database.client.$queryRaw<RestoreRow[]>(
      Prisma.sql`
        SELECT
          "id" AS "restoreId",
          "organization_id" AS "organizationId",
          "backup_id" AS "backupId",
          "source_space_id" AS "sourceSpaceId",
          "target_space_id" AS "targetSpaceId",
          "status",
          "created_at" AS "createdAt",
          "activated_at" AS "activatedAt"
        FROM "space_restore_jobs"
        WHERE "id" = ${input.restoreId}::uuid
          AND "organization_id" = ${input.organizationId}::uuid
          AND "source_space_id" = ${input.sourceSpaceId}::uuid
      `,
    );
    const row = rows[0];
    if (row === undefined) {
      throw notFound();
    }
    return restoreView(row);
  }

  async activateRestore(input: {
    actorUserId: string;
    organizationId: string;
    requestId: string;
    restoreId: string;
    targetSpaceId: string;
  }): Promise<SpaceRestoreView> {
    const now = this.clock.now();
    const row = await this.database.client.$transaction(async (transaction) => {
      await this.spaces.requireSpaceManagerInTransaction(
        transaction,
        input.actorUserId,
        input.organizationId,
        input.targetSpaceId,
        [],
        { allowRestoreTarget: true },
      );
      const rows = await transaction.$queryRaw<RestoreRow[]>(
        Prisma.sql`
          SELECT
            restore."id" AS "restoreId",
            restore."organization_id" AS "organizationId",
            restore."backup_id" AS "backupId",
            restore."source_space_id" AS "sourceSpaceId",
            restore."target_space_id" AS "targetSpaceId",
            restore."status",
            restore."created_at" AS "createdAt",
            restore."activated_at" AS "activatedAt"
          FROM "space_restore_jobs" AS restore
          INNER JOIN "kernel_instances" AS kernel
            ON kernel."space_id" = restore."target_space_id"
          WHERE restore."id" = ${input.restoreId}::uuid
            AND restore."organization_id" = ${input.organizationId}::uuid
            AND restore."target_space_id" = ${input.targetSpaceId}::uuid
            AND restore."status" = 'ready-for-activation'
            AND kernel."status" = 'ready'::"kernel_instance_status"
            AND kernel."deployment_handle" IS NOT NULL
            AND kernel."version" IS NOT NULL
            AND kernel."version" ~ '[^[:space:]]'
          FOR UPDATE OF restore
        `,
      );
      const ready = rows[0];
      if (ready === undefined) {
        throw conflict();
      }
      await transaction.space.update({
        where: { id: input.targetSpaceId },
        data: { status: "active" },
      });
      await this.accessChanges.publish(transaction, {
        kind: "close",
        reason: "forbidden",
        requestId: input.requestId,
        selectors: [{ kind: "space", value: input.targetSpaceId }],
      });
      await transaction.$executeRaw(
        Prisma.sql`
          UPDATE "space_restore_jobs"
          SET "status" = 'activated', "activated_at" = ${now}
          WHERE "id" = ${input.restoreId}::uuid
        `,
      );
      await this.audit.append(transaction, {
        action: "restore.activate",
        actorUserId: input.actorUserId,
        occurredAt: now,
        organizationId: input.organizationId,
        outcome: "succeeded",
        requestId: input.requestId,
        spaceId: input.targetSpaceId,
        targetId: input.restoreId,
        targetType: "restore",
      });
      return { ...ready, activatedAt: now, status: "activated" as const };
    });
    return restoreView(row);
  }

  async #enqueue(
    transaction: Prisma.TransactionClient,
    input: {
      jobId: string;
      kind: "backup-space" | "restore-space";
      now: Date;
      organizationId: string;
      payload: Readonly<Record<string, string>>;
      requestId: string;
    },
  ): Promise<void> {
    await transaction.$executeRaw(
      Prisma.sql`
        INSERT INTO "worker_jobs" (
          "id", "organization_id", "kind", "status", "payload",
          "request_id", "attempt", "available_at", "created_at", "updated_at"
        ) VALUES (
          ${input.jobId}::uuid, ${input.organizationId}::uuid,
          ${input.kind}::"worker_job_kind",
          'queued', ${JSON.stringify(input.payload)}::jsonb,
          ${input.requestId}::uuid, 0, ${input.now}, ${input.now}, ${input.now}
        )
      `,
    );
  }
}
