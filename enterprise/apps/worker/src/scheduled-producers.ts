import { Inject, Injectable } from "@nestjs/common";
import { DatabaseRuntime, Prisma } from "@singularity/database";

import type { WorkerConfiguration } from "./configuration.js";
import {
  ProducesWorkerJob,
  type WorkerJobProducer,
} from "./job-declarations.js";
import { WORKER_CONFIGURATION } from "./tokens.js";
import type {
  ArchiveAuditJob,
  ReconcileContentAuditJob,
  SampleKernelJob,
} from "./worker.js";

type SampleKernelProducerConfiguration = Pick<
  WorkerConfiguration,
  "sampleKernelIntervalMilliseconds"
>;
type ArchiveAuditProducerConfiguration = Pick<
  WorkerConfiguration,
  "archiveAuditIntervalMilliseconds" | "maximumAuditArchiveEvents"
>;
type ContentAuditProducerConfiguration = Pick<
  WorkerConfiguration,
  "contentAuditReconciliationIntervalMilliseconds"
>;

async function acquireProducerLock(
  transaction: Prisma.TransactionClient,
  producer: string,
): Promise<void> {
  await transaction.$queryRaw(
    Prisma.sql`
      SELECT pg_advisory_xact_lock(
        hashtext(current_schema()),
        hashtext(${producer})
      )
    `,
  );
}

@Injectable()
@ProducesWorkerJob({ kind: "sample-kernel" })
export class SampleKernelJobProducer
  implements WorkerJobProducer<SampleKernelJob>
{
  readonly intervalMilliseconds: number;
  readonly kind = "sample-kernel" as const;

  constructor(
    private readonly database: DatabaseRuntime,
    @Inject(WORKER_CONFIGURATION)
    configuration: SampleKernelProducerConfiguration,
  ) {
    this.intervalMilliseconds =
      configuration.sampleKernelIntervalMilliseconds;
  }

  produce(now: Date): Promise<number> {
    return this.database.client.$transaction(async (transaction) => {
      await acquireProducerLock(
        transaction,
        "singularity.worker.sample-kernel",
      );
      return transaction.$executeRaw(
        Prisma.sql`
          INSERT INTO "worker_jobs" (
            "id", "organization_id", "kind", "status", "payload",
            "request_id", "attempt", "available_at", "created_at", "updated_at"
          )
          SELECT
            gen_random_uuid(), space."organization_id", 'sample-kernel', 'queued',
            jsonb_build_object(
              'kernelInstanceId', kernel."id"::text,
              'spaceId', space."id"::text
            ),
            gen_random_uuid(), 0, ${now}, ${now}, ${now}
          FROM "kernel_instances" AS kernel
          INNER JOIN "spaces" AS space ON space."id" = kernel."space_id"
          INNER JOIN "organizations" AS organization
            ON organization."id" = space."organization_id"
          WHERE kernel."status" = 'ready'
            AND kernel."deployment_handle" IS NOT NULL
            AND organization."status" = 'active'
            AND space."status" IN ('active', 'archived')
            AND NOT EXISTS (
              SELECT 1
              FROM "worker_jobs" AS pending
              WHERE pending."organization_id" = space."organization_id"
                AND pending."kind" = 'sample-kernel'
                AND pending."status" IN ('queued', 'running')
                AND pending."payload" ->> 'kernelInstanceId' = kernel."id"::text
            )
        `,
      );
    });
  }
}

@Injectable()
@ProducesWorkerJob({ kind: "archive-audit" })
export class ArchiveAuditJobProducer
  implements WorkerJobProducer<ArchiveAuditJob>
{
  readonly intervalMilliseconds: number;
  readonly kind = "archive-audit" as const;
  readonly #maximumEvents: number;

  constructor(
    private readonly database: DatabaseRuntime,
    @Inject(WORKER_CONFIGURATION)
    configuration: ArchiveAuditProducerConfiguration,
  ) {
    this.intervalMilliseconds =
      configuration.archiveAuditIntervalMilliseconds;
    this.#maximumEvents = configuration.maximumAuditArchiveEvents;
  }

  produce(now: Date): Promise<number> {
    return this.database.client.$transaction(async (transaction) => {
      await acquireProducerLock(
        transaction,
        "singularity.worker.archive-audit",
      );
      return transaction.$executeRaw(
        Prisma.sql`
          WITH archive_progress AS (
            SELECT
              audit_sequence."organization_id",
              COALESCE(MAX(archive."through_sequence"), 0)::bigint + 1 AS "from_sequence",
              audit_sequence."last_sequence"
            FROM "organization_audit_sequences" AS audit_sequence
            INNER JOIN "organizations" AS organization
              ON organization."id" = audit_sequence."organization_id"
              AND organization."status" = 'active'
            LEFT JOIN "audit_archives" AS archive
              ON archive."organization_id" = audit_sequence."organization_id"
            GROUP BY
              audit_sequence."organization_id",
              audit_sequence."last_sequence"
          ), archive_ranges AS (
            SELECT
              progress."organization_id",
              progress."from_sequence",
              LEAST(
                progress."last_sequence",
                progress."from_sequence" + ${this.#maximumEvents}::bigint - 1
              ) AS "through_sequence"
            FROM archive_progress AS progress
            WHERE progress."from_sequence" <= progress."last_sequence"
              AND NOT EXISTS (
                SELECT 1
                FROM "worker_jobs" AS pending
                WHERE pending."organization_id" = progress."organization_id"
                  AND pending."kind" = 'archive-audit'
                  AND pending."status" IN ('queued', 'running')
              )
          )
          INSERT INTO "worker_jobs" (
            "id", "organization_id", "kind", "status", "payload",
            "request_id", "attempt", "available_at", "created_at", "updated_at"
          )
          SELECT
            gen_random_uuid(), range."organization_id", 'archive-audit', 'queued',
            jsonb_build_object(
              'fromSequence', range."from_sequence"::text,
              'throughSequence', range."through_sequence"::text
            ),
            gen_random_uuid(), 0, ${now}, ${now}, ${now}
          FROM archive_ranges AS range
        `,
      );
    });
  }
}

@Injectable()
@ProducesWorkerJob({ kind: "reconcile-content-audit" })
export class ContentAuditJobProducer
  implements WorkerJobProducer<ReconcileContentAuditJob>
{
  readonly intervalMilliseconds: number;
  readonly kind = "reconcile-content-audit" as const;

  constructor(
    private readonly database: DatabaseRuntime,
    @Inject(WORKER_CONFIGURATION)
    configuration: ContentAuditProducerConfiguration,
  ) {
    this.intervalMilliseconds =
      configuration.contentAuditReconciliationIntervalMilliseconds;
  }

  produce(now: Date): Promise<number> {
    return this.database.client.$transaction(async (transaction) => {
      await acquireProducerLock(
        transaction,
        "singularity.worker.reconcile-content-audit",
      );
      return transaction.$executeRaw(
        Prisma.sql`
          WITH ready_organizations AS (
            SELECT DISTINCT intent."organization_id"
            FROM "content_audit_intents" AS intent
            WHERE intent."available_at" <= ${now}
              AND NOT EXISTS (
                SELECT 1
                FROM "worker_jobs" AS pending
                WHERE pending."organization_id" = intent."organization_id"
                  AND pending."kind" = 'reconcile-content-audit'
                  AND pending."status" IN ('queued', 'running')
              )
          )
          INSERT INTO "worker_jobs" (
            "id", "organization_id", "kind", "status", "payload",
            "request_id", "attempt", "available_at", "created_at", "updated_at"
          )
          SELECT
            gen_random_uuid(), ready."organization_id",
            'reconcile-content-audit', 'queued', '{}'::jsonb,
            gen_random_uuid(), 0, ${now}, ${now}, ${now}
          FROM ready_organizations AS ready
        `,
      );
    });
  }
}
