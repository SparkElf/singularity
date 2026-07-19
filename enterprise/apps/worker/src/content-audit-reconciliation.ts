import { performance } from "node:perf_hooks";

import { Inject, Injectable } from "@nestjs/common";
import type { ContentAuditAction } from "@singularity/contracts";
import { AuditWriter, DatabaseRuntime, Prisma } from "@singularity/database";

import type { WorkerConfiguration } from "./configuration.js";
import { HandlesWorkerJob } from "./job-declarations.js";
import { WORKER_CONFIGURATION, WORKER_JOB_LOGGER } from "./tokens.js";
import type {
  ReconcileContentAuditJob,
  WorkerJobHandler,
  WorkerJobLogger,
  WorkerJobRecord,
} from "./worker.js";
import { WorkerJobError } from "./worker.js";

type ContentAuditHandlerConfiguration = Pick<
  WorkerConfiguration,
  "contentAuditBatchSize"
>;

interface ContentAuditIntentRow {
  action: ContentAuditAction;
  actorUserId: string;
  documentId: string;
  observedOutcome: "failed" | "succeeded" | null;
  occurredAt: Date;
  requestId: string;
  spaceId: string;
}

function retryAt(attempt: number): Date {
  return new Date(Date.now() + Math.min(attempt * 5_000, 60_000));
}

@Injectable()
@HandlesWorkerJob({ kind: "reconcile-content-audit" })
export class ContentAuditHandler
  implements WorkerJobHandler<ReconcileContentAuditJob>
{
  readonly kind = "reconcile-content-audit" as const;
  readonly #batchSize: number;

  constructor(
    private readonly auditWriter: AuditWriter,
    private readonly database: DatabaseRuntime,
    @Inject(WORKER_CONFIGURATION)
    configuration: ContentAuditHandlerConfiguration,
    @Inject(WORKER_JOB_LOGGER)
    private readonly logger: WorkerJobLogger,
  ) {
    this.#batchSize = configuration.contentAuditBatchSize;
  }

  decode(record: WorkerJobRecord): ReconcileContentAuditJob {
    return {
      attempt: record.attempt,
      id: record.id,
      kind: this.kind,
      leaseExpiresAt: record.leaseExpiresAt,
      organizationId: record.organizationId,
      requestId: record.requestId,
    };
  }

  async execute(
    job: ReconcileContentAuditJob,
    signal: AbortSignal,
  ): Promise<void> {
    const startedAt = performance.now();
    const availableAt = new Date();
    try {
      const finalized = await this.database.client.$transaction(
        async (transaction) => {
          const intents = await transaction.$queryRaw<
            ContentAuditIntentRow[]
          >(
            Prisma.sql`
              SELECT
                "request_id" AS "requestId",
                "space_id" AS "spaceId",
                "actor_user_id" AS "actorUserId",
                "action",
                "document_id" AS "documentId",
                "occurred_at" AS "occurredAt",
                "observed_outcome" AS "observedOutcome"
              FROM "content_audit_intents"
              WHERE "organization_id" = ${job.organizationId}::uuid
                AND "available_at" <= ${availableAt}
              ORDER BY "occurred_at" ASC, "request_id" ASC
              FOR UPDATE SKIP LOCKED
              LIMIT ${this.#batchSize}
            `,
          );
          for (const intent of intents) {
            signal.throwIfAborted();
            await this.auditWriter.append(transaction, {
              action: intent.action,
              actorUserId: intent.actorUserId,
              occurredAt: intent.occurredAt,
              organizationId: job.organizationId,
              outcome: intent.observedOutcome ?? "indeterminate",
              requestId: intent.requestId,
              spaceId: intent.spaceId,
              targetId: intent.documentId,
              targetType: "document",
            });
          }
          if (intents.length > 0) {
            await transaction.$executeRaw(
              Prisma.sql`
                DELETE FROM "content_audit_intents"
                WHERE "request_id" IN (${Prisma.join(
                  intents.map(
                    (intent) => Prisma.sql`${intent.requestId}::uuid`,
                  ),
                )})
              `,
            );
          }
          return intents.length;
        },
      );
      this.logger.info({
        event: "content.audit-finalization",
        finalized,
        jobId: job.id,
        organizationId: job.organizationId,
        outcome: "succeeded",
        requestId: job.requestId,
        durationMilliseconds: performance.now() - startedAt,
      });
    } catch (error) {
      this.logger.error({
        error,
        event: "content.audit-finalization",
        jobId: job.id,
        organizationId: job.organizationId,
        outcome: "failed",
        requestId: job.requestId,
        durationMilliseconds: performance.now() - startedAt,
      });
      signal.throwIfAborted();
      throw new WorkerJobError(
        "content-audit-finalization-failed",
        retryAt(job.attempt),
      );
    }
  }
}
