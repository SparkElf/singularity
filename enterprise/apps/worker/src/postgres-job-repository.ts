import { Injectable } from "@nestjs/common";
import { DatabaseRuntime, Prisma } from "@singularity/database";

import type {
  WorkerJobRecord,
  WorkerJobKind,
  WorkerJobRepository,
} from "./worker.js";

@Injectable()
export class PostgresWorkerJobRepository implements WorkerJobRepository {
  constructor(private readonly database: DatabaseRuntime) {}

  async claimBatch(input: {
    kinds: readonly WorkerJobKind[];
    leaseExpiresAt: Date;
    limit: number;
    now: Date;
    workerId: string;
  }): Promise<readonly WorkerJobRecord[]> {
    const rows = await this.database.client.$queryRaw<WorkerJobRecord[]>(
      Prisma.sql`
        WITH candidates AS (
          SELECT "id"
          FROM "worker_jobs"
          WHERE "kind" IN (${Prisma.join(
              input.kinds.map(
                (kind) => Prisma.sql`${kind}::"worker_job_kind"`,
              ),
            )})
            AND (
              ("status" = 'queued' AND "available_at" <= ${input.now})
              OR ("status" = 'running' AND "lease_expires_at" <= ${input.now})
            )
          ORDER BY "available_at" ASC, "created_at" ASC, "id" ASC
          FOR UPDATE SKIP LOCKED
          LIMIT ${input.limit}
        )
        UPDATE "worker_jobs" AS job
        SET
          "status" = 'running',
          "worker_id" = ${input.workerId},
          "lease_expires_at" = ${input.leaseExpiresAt},
          "attempt" = job."attempt" + 1,
          "updated_at" = ${input.now}
        FROM candidates
        WHERE job."id" = candidates."id"
        RETURNING
          job."id",
          job."organization_id" AS "organizationId",
          job."kind",
          job."payload",
          job."request_id" AS "requestId",
          job."attempt",
          job."lease_expires_at" AS "leaseExpiresAt"
      `,
    );
    return rows;
  }

  async complete(input: {
    completedAt: Date;
    jobId: string;
    workerId: string;
  }): Promise<boolean> {
    const count = await this.database.client.$executeRaw(
      Prisma.sql`
        UPDATE "worker_jobs"
        SET
          "status" = 'succeeded',
          "worker_id" = NULL,
          "lease_expires_at" = NULL,
          "error_code" = NULL,
          "completed_at" = ${input.completedAt},
          "updated_at" = ${input.completedAt}
        WHERE "id" = ${input.jobId}::uuid
          AND "status" = 'running'
          AND "worker_id" = ${input.workerId}
          AND "lease_expires_at" > ${input.completedAt}
      `,
    );
    return count === 1;
  }

  async fail(input: {
    errorCode: string;
    failedAt: Date;
    jobId: string;
    retryAt: Date | null;
    workerId: string;
  }): Promise<boolean> {
    // 原子结束或重排队任务；CASE 分支显式使用 timestamptz，避免 Prisma pg 适配器按文本写入时间列。
    const count = await this.database.client.$executeRaw(
      Prisma.sql`
        UPDATE "worker_jobs"
        SET
          "status" = ${input.retryAt === null ? "failed" : "queued"}::"worker_job_status",
          "worker_id" = NULL,
          "lease_expires_at" = NULL,
          "error_code" = ${input.errorCode},
          "available_at" = COALESCE(${input.retryAt}, "available_at"),
          "completed_at" = CASE WHEN ${input.retryAt}::timestamptz IS NULL THEN ${input.failedAt}::timestamptz ELSE NULL END,
          "updated_at" = ${input.failedAt}
        WHERE "id" = ${input.jobId}::uuid
          AND "status" = 'running'
          AND "worker_id" = ${input.workerId}
          AND "lease_expires_at" > ${input.failedAt}
      `,
    );
    return count === 1;
  }

  async renewLease(input: {
    jobId: string;
    leaseExpiresAt: Date;
    workerId: string;
  }): Promise<boolean> {
    const count = await this.database.client.$executeRaw(
      Prisma.sql`
        UPDATE "worker_jobs"
        SET "lease_expires_at" = ${input.leaseExpiresAt}, "updated_at" = CURRENT_TIMESTAMP
        WHERE "id" = ${input.jobId}::uuid
          AND "status" = 'running'
          AND "worker_id" = ${input.workerId}
          AND "lease_expires_at" > CURRENT_TIMESTAMP
      `,
    );
    return count === 1;
  }
}
