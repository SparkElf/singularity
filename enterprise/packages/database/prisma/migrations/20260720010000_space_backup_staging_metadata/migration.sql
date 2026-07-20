ALTER TABLE "space_backups"
    ADD COLUMN "staged_format_version" INTEGER,
    ADD COLUMN "staged_kernel_version" TEXT,
    ADD COLUMN "staged_sha256" TEXT,
    ADD CONSTRAINT "space_backups_staging_metadata_check" CHECK (
        ("staged_format_version" IS NULL AND "staged_kernel_version" IS NULL
            AND "staged_sha256" IS NULL)
        OR ("status" IN ('queued', 'running')
            AND "staged_format_version" IS NOT NULL AND "staged_format_version" > 0
            AND "staged_kernel_version" IS NOT NULL
            AND "staged_kernel_version" ~ '[^[:space:]]'
            AND "staged_sha256" IS NOT NULL
            AND "staged_sha256" ~ '^[a-f0-9]{64}$')
    );
