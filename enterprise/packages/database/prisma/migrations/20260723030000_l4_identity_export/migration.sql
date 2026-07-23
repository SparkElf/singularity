CREATE TABLE "mfa_login_challenges" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "user_id" UUID NOT NULL,
  "token_digest" TEXT NOT NULL,
  "expires_at" TIMESTAMPTZ(3) NOT NULL,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "consumed_at" TIMESTAMPTZ(3),
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "mfa_login_challenges_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "mfa_login_challenges_attempts_check" CHECK ("attempts" >= 0)
);
CREATE UNIQUE INDEX "mfa_login_challenges_token_digest_key" ON "mfa_login_challenges"("token_digest");
CREATE INDEX "mfa_login_challenges_user_expires_idx" ON "mfa_login_challenges"("user_id", "expires_at");
ALTER TABLE "mfa_login_challenges"
  ADD CONSTRAINT "mfa_login_challenges_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "export_audits" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "organization_id" UUID NOT NULL,
  "space_id" UUID NOT NULL,
  "notebook_id" TEXT NOT NULL,
  "document_id" TEXT NOT NULL,
  "actor_user_id" UUID NOT NULL,
  "request_id" UUID NOT NULL,
  "format" TEXT NOT NULL,
  "watermark_ref" TEXT,
  "outcome" TEXT NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "export_audits_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "export_audits_identity_check" CHECK (
    "notebook_id" ~ '^[0-9]{14}-[0-9a-z]{7}$' AND "document_id" ~ '^[0-9]{14}-[0-9a-z]{7}$'
  )
);
CREATE INDEX "export_audits_scope_created_idx" ON "export_audits"("organization_id", "space_id", "created_at");
CREATE INDEX "export_audits_request_idx" ON "export_audits"("request_id");
ALTER TABLE "export_audits"
  ADD CONSTRAINT "export_audits_organization_fkey"
  FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "export_audits_space_scope_fkey"
  FOREIGN KEY ("space_id", "organization_id") REFERENCES "spaces"("id", "organization_id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "export_audits_actor_membership_fkey"
  FOREIGN KEY ("organization_id", "actor_user_id") REFERENCES "organization_memberships"("organization_id", "user_id") ON DELETE RESTRICT ON UPDATE CASCADE;
