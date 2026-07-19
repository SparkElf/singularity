ALTER TYPE "audit_outcome" ADD VALUE 'indeterminate';
ALTER TYPE "worker_job_kind" ADD VALUE 'reconcile-content-audit';

CREATE TABLE "content_audit_intents" (
    "request_id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "space_id" UUID NOT NULL,
    "actor_user_id" UUID NOT NULL,
    "action" "audit_action" NOT NULL,
    "document_id" TEXT NOT NULL,
    "occurred_at" TIMESTAMPTZ(3) NOT NULL,
    "observed_outcome" "audit_outcome",
    "available_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "content_audit_intents_pkey" PRIMARY KEY ("request_id"),
    CONSTRAINT "content_audit_intents_action_check" CHECK (
        "action" IN ('content.edit', 'content.delete', 'content.export')
    ),
    CONSTRAINT "content_audit_intents_document_id_check" CHECK (
        "document_id" ~ '[^[:space:]]'
    ),
    CONSTRAINT "content_audit_intents_observed_outcome_check" CHECK (
        "observed_outcome" IS NULL
        OR "observed_outcome" IN ('failed', 'succeeded')
    ),
    CONSTRAINT "content_audit_intents_available_at_check" CHECK (
        "available_at" >= "occurred_at"
    )
);

CREATE INDEX "content_audit_intents_delivery_idx"
    ON "content_audit_intents"(
        "available_at", "organization_id", "occurred_at", "request_id"
    );

ALTER TABLE "content_audit_intents"
    ADD CONSTRAINT "content_audit_intents_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "content_audit_intents"
    ADD CONSTRAINT "content_audit_intents_space_id_organization_id_fkey"
    FOREIGN KEY ("space_id", "organization_id")
    REFERENCES "spaces"("id", "organization_id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "content_audit_intents"
    ADD CONSTRAINT "content_audit_intents_actor_user_id_fkey"
    FOREIGN KEY ("actor_user_id") REFERENCES "users"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "content_audit_intents"
    ADD CONSTRAINT "content_audit_intents_organization_id_actor_user_id_fkey"
    FOREIGN KEY ("organization_id", "actor_user_id")
    REFERENCES "organization_memberships"("organization_id", "user_id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
