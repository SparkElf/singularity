import { Injectable, Inject } from "@nestjs/common";
import { AuditWriter, DatabaseRuntime, Prisma } from "@singularity/database";
import { z } from "zod";

import { HandlesWorkerJob } from "./job-declarations.js";
import { WORKER_JOB_LOGGER } from "./tokens.js";
import type { GovernanceTaskJob, WorkerJobHandler, WorkerJobLogger, WorkerJobRecord } from "./worker.js";
import { WorkerJobError } from "./worker.js";

const uuidSchema = z.string().uuid();
const taskKindSchema = z.enum(["verify", "archive", "retain", "export_watermark"]);

// 从已持久化的任务载荷读取 UUID；这是数据库任务边界的唯一格式校验点。
function uuidValue(payload: Readonly<Record<string, unknown>>, name: string): string {
  const parsed = uuidSchema.safeParse(payload[name]);
  if (!parsed.success) {
    throw new WorkerJobError("governance-task-payload-invalid", null);
  }
  return parsed.data;
}

// 从任务载荷读取文档/笔记本标识；空值在进入治理任务执行器前直接拒绝。
function textValue(payload: Readonly<Record<string, unknown>>, name: string): string {
  const value = payload[name];
  if (typeof value !== "string" || value.length === 0) {
    throw new WorkerJobError("governance-task-payload-invalid", null);
  }
  return value;
}

@Injectable()
@HandlesWorkerJob({ kind: "governance-task" })
export class GovernanceTaskHandler implements WorkerJobHandler<GovernanceTaskJob> {
  readonly kind = "governance-task" as const;

  constructor(
    private readonly database: DatabaseRuntime,
    private readonly audit: AuditWriter,
    @Inject(WORKER_JOB_LOGGER) private readonly logger: WorkerJobLogger,
  ) {}

  // 将通用 Worker 记录收敛为治理任务合同，执行阶段只消费显式四段身份和任务类型。
  decode(record: WorkerJobRecord): GovernanceTaskJob {
    const taskKind = taskKindSchema.safeParse(record.payload.taskKind);
    if (!taskKind.success) {
      throw new WorkerJobError("governance-task-payload-invalid", null);
    }
    return {
      attempt: record.attempt,
      documentId: textValue(record.payload, "documentId"),
      id: record.id,
      kind: this.kind,
      leaseExpiresAt: record.leaseExpiresAt,
      notebookId: textValue(record.payload, "notebookId"),
      organizationId: record.organizationId,
      requestId: record.requestId,
      spaceId: uuidValue(record.payload, "spaceId"),
      taskId: uuidValue(record.payload, "taskId"),
      taskKind: taskKind.data,
    };
  }

  /** 在同一事务内消费治理任务并更新文档治理事实，确保重试不会重复副作用。 */
  async execute(job: GovernanceTaskJob, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    const now = new Date();
    try {
      await this.database.client.$transaction(async (transaction) => {
        await transaction.$queryRaw(Prisma.sql`SELECT "id" FROM "governance_tasks" WHERE "id" = ${job.taskId}::uuid FOR UPDATE`);
        const task = await transaction.governanceTask.findUnique({ where: { id: job.taskId } });
        if (task === null || task.organizationId !== job.organizationId || task.spaceId !== job.spaceId || task.notebookId !== job.notebookId || task.documentId !== job.documentId || task.kind !== job.taskKind) {
          throw new WorkerJobError("governance-task-not-found", null);
        }
        if (task.status === "succeeded") {
          return;
        }
        await transaction.governanceTask.update({ where: { id: task.id }, data: { status: "running", attempts: { increment: 1 } } });
        const document = await transaction.documentGovernance.findUnique({ where: { organizationId_spaceId_notebookId_documentId: { organizationId: job.organizationId, spaceId: job.spaceId, notebookId: job.notebookId, documentId: job.documentId } } });
        if (document === null) {
          throw new WorkerJobError("governance-document-not-found", null);
        }
        if (job.taskKind === "verify") {
          await transaction.documentGovernance.update({ where: { id: document.id }, data: { verification: "verified", nextVerificationAt: new Date(now.getTime() + 180 * 86_400_000) } });
        } else if (job.taskKind === "archive") {
          if (!document.legalHold) {
            await transaction.documentGovernance.update({ where: { id: document.id }, data: { archivedAt: now, lifecycle: "archived" } });
          }
        } else if (job.taskKind === "retain") {
          const retentionUntil = document.retentionUntil !== null && document.retentionUntil > now ? document.retentionUntil : new Date(now.getTime() + 2_555 * 86_400_000);
          await transaction.documentGovernance.update({ where: { id: document.id }, data: { retentionUntil } });
        } else {
          // 水印只在导出响应边界生成；未知/未实现任务必须失败，不能把无副作用当作成功。
          throw new WorkerJobError("governance-task-kind-unsupported", null);
        }
        await transaction.governanceTask.update({ where: { id: task.id }, data: { status: "succeeded", lastErrorName: null, lastErrorMessage: null, lastErrorStack: null } });
        await this.audit.append(transaction, {
          action: job.taskKind === "archive" ? "content.delete" : "content.edit",
          actorUserId: null,
          occurredAt: now,
          organizationId: job.organizationId,
          outcome: "succeeded",
          requestId: job.requestId,
          spaceId: job.spaceId,
          targetId: job.documentId,
          targetType: "document",
        });
      });
      this.logger.info({ event: "governance.task", jobId: job.id, organizationId: job.organizationId, outcome: "succeeded", requestId: job.requestId, taskId: job.taskId, taskKind: job.taskKind });
    } catch (error) {
      this.logger.error({ error, event: "governance.task", jobId: job.id, organizationId: job.organizationId, outcome: "failed", requestId: job.requestId, taskId: job.taskId, taskKind: job.taskKind });
      signal.throwIfAborted();
      const failure = error instanceof Error ? error : new Error("Governance task failed", { cause: error });
      const retryAt = job.attempt < 3 ? new Date(now.getTime() + job.attempt * 15_000) : null;
      await this.database.client.governanceTask.updateMany({ where: { id: job.taskId, status: { in: ["queued", "running"] } }, data: { status: retryAt === null ? "failed" : "queued", availableAt: retryAt ?? now, lastErrorName: failure.name, lastErrorMessage: failure.message, lastErrorStack: failure.stack ?? failure.message } });
      await this.database.client.$transaction(async (transaction) => {
        await this.audit.append(transaction, {
          action: job.taskKind === "archive" ? "content.delete" : "content.edit",
          actorUserId: null,
          occurredAt: now,
          organizationId: job.organizationId,
          outcome: "failed",
          requestId: job.requestId,
          spaceId: job.spaceId,
          targetId: job.documentId,
          targetType: "document",
        });
      });
      if (error instanceof WorkerJobError) {
        throw new WorkerJobError(error.code, retryAt, { cause: error });
      }
      throw new WorkerJobError("governance-task-failed", retryAt, { cause: error });
    }
  }
}
