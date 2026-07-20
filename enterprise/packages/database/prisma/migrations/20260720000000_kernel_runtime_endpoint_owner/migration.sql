ALTER TABLE "kernel_runtime_endpoints"
    ADD COLUMN "runtime_owner" TEXT NOT NULL,
    ADD CONSTRAINT "kernel_runtime_endpoints_runtime_owner_check" CHECK (
        "runtime_owner" ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$'
    );

CREATE INDEX "kernel_runtime_endpoints_runtime_owner_idx"
    ON "kernel_runtime_endpoints"("runtime_owner");
