ALTER TABLE "space_backups"
    ADD COLUMN "worker_job_id" UUID,
    ADD COLUMN "worker_attempt" INTEGER;

-- 运行中的旧备份没有持久化 claim，必须回到可重新 claim 的队列状态。
UPDATE "space_backups"
SET "status" = 'queued'::"space_backup_status",
    "worker_job_id" = NULL,
    "worker_attempt" = NULL
WHERE "status" = 'running'::"space_backup_status";

ALTER TABLE "space_backups"
    DROP CONSTRAINT "space_backups_lifecycle_check",
    ADD CONSTRAINT "space_backups_worker_claim_check" CHECK (
        ("worker_job_id" IS NULL AND "worker_attempt" IS NULL)
        OR ("worker_job_id" IS NOT NULL AND "worker_attempt" IS NOT NULL AND "worker_attempt" > 0)
    ),
    ADD CONSTRAINT "space_backups_lifecycle_check" CHECK (
        ("status" = 'queued' AND "worker_job_id" IS NULL AND "worker_attempt" IS NULL
            AND "completed_at" IS NULL AND "format_version" IS NULL)
        OR ("status" = 'running' AND "worker_job_id" IS NOT NULL AND "worker_attempt" IS NOT NULL
            AND "completed_at" IS NULL AND "format_version" IS NULL)
        OR ("status" = 'succeeded' AND "worker_job_id" IS NULL AND "worker_attempt" IS NULL
            AND "completed_at" IS NOT NULL AND "object_key" IS NOT NULL AND "format_version" IS NOT NULL)
        OR ("status" = 'failed' AND "worker_job_id" IS NULL AND "worker_attempt" IS NULL
            AND "completed_at" IS NOT NULL AND "format_version" IS NULL)
    );

CREATE INDEX "space_backups_worker_claim_idx"
    ON "space_backups"("worker_job_id", "worker_attempt");
