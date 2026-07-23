CREATE TYPE "governance_lifecycle_status" AS ENUM ('draft', 'in_review', 'approved', 'published', 'archived', 'rejected');
CREATE TYPE "governance_verification_status" AS ENUM ('verified', 'needs_review', 'expired');
CREATE TYPE "governance_classification" AS ENUM ('public', 'internal', 'confidential', 'restricted');
CREATE TYPE "governance_approval_status" AS ENUM ('pending', 'approved', 'rejected');
CREATE TYPE "governance_task_kind" AS ENUM ('verify', 'archive', 'retain', 'export_watermark');
CREATE TYPE "governance_task_status" AS ENUM ('queued', 'running', 'succeeded', 'failed', 'cancelled');
CREATE TYPE "governance_template_status" AS ENUM ('draft', 'published', 'archived');
CREATE TYPE "enterprise_identity_provider_status" AS ENUM ('active', 'disabled');
CREATE TYPE "scim_external_identity_kind" AS ENUM ('user', 'group');
CREATE TYPE "embedded_object_kind" AS ENUM ('drawio', 'excalidraw');
CREATE TYPE "embedded_object_status" AS ENUM ('active', 'unavailable', 'deleted');

CREATE TABLE "governance_policies" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "organization_id" UUID NOT NULL,
  "space_id" UUID NOT NULL,
  "verification_interval_days" INTEGER NOT NULL DEFAULT 180,
  "verification_grace_days" INTEGER NOT NULL DEFAULT 30,
  "archive_after_days" INTEGER NOT NULL DEFAULT 365,
  "retention_days" INTEGER NOT NULL DEFAULT 2555,
  "default_classification" "governance_classification" NOT NULL DEFAULT 'internal',
  "watermark_enabled" BOOLEAN NOT NULL DEFAULT true,
  "governance_enabled" BOOLEAN NOT NULL DEFAULT false,
  "created_by_user_id" UUID NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "governance_policies_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "governance_policies_days_check" CHECK (
    "verification_interval_days" > 0 AND "verification_grace_days" >= 0
    AND "archive_after_days" > 0 AND "retention_days" > 0
  )
);

CREATE TABLE "document_governance" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "organization_id" UUID NOT NULL,
  "space_id" UUID NOT NULL,
  "notebook_id" TEXT NOT NULL,
  "document_id" TEXT NOT NULL,
  "lifecycle" "governance_lifecycle_status" NOT NULL DEFAULT 'draft',
  "verification" "governance_verification_status" NOT NULL DEFAULT 'needs_review',
  "classification" "governance_classification" NOT NULL DEFAULT 'internal',
  "owner_user_id" UUID,
  "current_version" TEXT,
  "next_verification_at" TIMESTAMPTZ(3),
  "archived_at" TIMESTAMPTZ(3),
  "retention_until" TIMESTAMPTZ(3),
  "legal_hold" BOOLEAN NOT NULL DEFAULT false,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "document_governance_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "document_governance_identity_check" CHECK (
    "notebook_id" ~ '^[0-9]{14}-[0-9a-z]{7}$' AND "document_id" ~ '^[0-9]{14}-[0-9a-z]{7}$'
  )
);

CREATE TABLE "governance_approval_requests" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "organization_id" UUID NOT NULL,
  "space_id" UUID NOT NULL,
  "notebook_id" TEXT NOT NULL,
  "document_id" TEXT NOT NULL,
  "version_token" TEXT NOT NULL,
  "status" "governance_approval_status" NOT NULL DEFAULT 'pending',
  "submitted_by_user_id" UUID NOT NULL,
  "decided_by_user_id" UUID,
  "decision_comment" TEXT,
  "submitted_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "decided_at" TIMESTAMPTZ(3),
  CONSTRAINT "governance_approval_requests_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "governance_approval_identity_check" CHECK (
    "notebook_id" ~ '^[0-9]{14}-[0-9a-z]{7}$' AND "document_id" ~ '^[0-9]{14}-[0-9a-z]{7}$'
  )
);

CREATE TABLE "governance_templates" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "organization_id" UUID NOT NULL,
  "space_id" UUID NOT NULL,
  "name" TEXT NOT NULL,
  "description" TEXT,
  "initial_content" JSONB NOT NULL,
  "default_classification" "governance_classification" NOT NULL DEFAULT 'internal',
  "verification_interval_days" INTEGER NOT NULL DEFAULT 180,
  "status" "governance_template_status" NOT NULL DEFAULT 'draft',
  "created_by_user_id" UUID NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "governance_templates_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "governance_templates_name_check" CHECK (length(btrim("name")) BETWEEN 1 AND 120),
  CONSTRAINT "governance_templates_interval_check" CHECK ("verification_interval_days" > 0)
);

CREATE TABLE "governance_tasks" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "organization_id" UUID NOT NULL,
  "space_id" UUID NOT NULL,
  "notebook_id" TEXT NOT NULL,
  "document_id" TEXT NOT NULL,
  "kind" "governance_task_kind" NOT NULL,
  "status" "governance_task_status" NOT NULL DEFAULT 'queued',
  "idempotency_key" TEXT NOT NULL,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "available_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "last_error_name" TEXT,
  "last_error_message" TEXT,
  "last_error_stack" TEXT,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "governance_tasks_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "governance_tasks_identity_check" CHECK (
    "notebook_id" ~ '^[0-9]{14}-[0-9a-z]{7}$' AND "document_id" ~ '^[0-9]{14}-[0-9a-z]{7}$'
  )
);

CREATE TABLE "enterprise_api_keys" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "organization_id" UUID NOT NULL,
  "user_id" UUID NOT NULL,
  "name" TEXT NOT NULL,
  "key_prefix" TEXT NOT NULL,
  "secret_digest" TEXT NOT NULL,
  "scopes" JSONB NOT NULL,
  "expires_at" TIMESTAMPTZ(3),
  "revoked_at" TIMESTAMPTZ(3),
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "last_used_at" TIMESTAMPTZ(3),
  CONSTRAINT "enterprise_api_keys_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "mfa_factors" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "user_id" UUID NOT NULL,
  "label" TEXT NOT NULL,
  "encrypted_secret" TEXT NOT NULL,
  "enabled_at" TIMESTAMPTZ(3),
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "last_used_at" TIMESTAMPTZ(3),
  CONSTRAINT "mfa_factors_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "saml_providers" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "organization_id" UUID NOT NULL,
  "name" TEXT NOT NULL,
  "entity_id" TEXT NOT NULL,
  "sso_url" TEXT NOT NULL,
  "certificate_pem" TEXT NOT NULL,
  "status" "enterprise_identity_provider_status" NOT NULL DEFAULT 'disabled',
  "created_by_user_id" UUID NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "saml_providers_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "scim_tokens" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "organization_id" UUID NOT NULL,
  "token_prefix" TEXT NOT NULL,
  "token_digest" TEXT NOT NULL,
  "expires_at" TIMESTAMPTZ(3),
  "revoked_at" TIMESTAMPTZ(3),
  "created_by_user_id" UUID NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "last_used_at" TIMESTAMPTZ(3),
  CONSTRAINT "scim_tokens_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "scim_external_identities" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "organization_id" UUID NOT NULL,
  "external_id" TEXT NOT NULL,
  "kind" "scim_external_identity_kind" NOT NULL,
  "user_id" UUID,
  "group_id" UUID,
  "last_synced_at" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "scim_external_identities_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "scim_external_identity_subject_check" CHECK (
    ("kind" = 'user' AND "user_id" IS NOT NULL AND "group_id" IS NULL)
    OR ("kind" = 'group' AND "user_id" IS NULL AND "group_id" IS NOT NULL)
  )
);

CREATE TABLE "personal_spaces" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "organization_id" UUID NOT NULL,
  "user_id" UUID NOT NULL,
  "space_id" UUID NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "personal_spaces_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "search_document_index" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "organization_id" UUID NOT NULL,
  "space_id" UUID NOT NULL,
  "notebook_id" TEXT NOT NULL,
  "document_id" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "excerpt" TEXT NOT NULL,
  "classification" "governance_classification" NOT NULL,
  "updated_at" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "search_document_index_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "search_document_index_identity_check" CHECK (
    "notebook_id" ~ '^[0-9]{14}-[0-9a-z]{7}$' AND "document_id" ~ '^[0-9]{14}-[0-9a-z]{7}$'
  )
);

CREATE TABLE "embedded_objects" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "organization_id" UUID NOT NULL,
  "space_id" UUID NOT NULL,
  "notebook_id" TEXT NOT NULL,
  "document_id" TEXT NOT NULL,
  "kind" "embedded_object_kind" NOT NULL,
  "version" INTEGER NOT NULL DEFAULT 1,
  "payload" JSONB NOT NULL,
  "status" "embedded_object_status" NOT NULL DEFAULT 'active',
  "created_by_user_id" UUID NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "embedded_objects_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "embedded_objects_identity_check" CHECK (
    "notebook_id" ~ '^[0-9]{14}-[0-9a-z]{7}$' AND "document_id" ~ '^[0-9]{14}-[0-9a-z]{7}$'
  )
);

CREATE TABLE "ai_conversations" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "organization_id" UUID NOT NULL,
  "user_id" UUID NOT NULL,
  "title" TEXT,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ai_conversations_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ai_messages" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "conversation_id" UUID NOT NULL,
  "role" TEXT NOT NULL,
  "content" TEXT NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ai_messages_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ai_citations" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "message_id" UUID NOT NULL,
  "organization_id" UUID NOT NULL,
  "space_id" UUID NOT NULL,
  "notebook_id" TEXT NOT NULL,
  "document_id" TEXT NOT NULL,
  "excerpt" TEXT NOT NULL,
  "verified_at" TIMESTAMPTZ(3),
  CONSTRAINT "ai_citations_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ai_citations_identity_check" CHECK (
    "notebook_id" ~ '^[0-9]{14}-[0-9a-z]{7}$' AND "document_id" ~ '^[0-9]{14}-[0-9a-z]{7}$'
  )
);

CREATE UNIQUE INDEX "governance_policies_organization_space_key" ON "governance_policies"("organization_id", "space_id");
CREATE INDEX "governance_policies_organization_updated_idx" ON "governance_policies"("organization_id", "updated_at");
CREATE UNIQUE INDEX "document_governance_identity_key" ON "document_governance"("organization_id", "space_id", "notebook_id", "document_id");
CREATE UNIQUE INDEX "governance_approval_identity_version_key" ON "governance_approval_requests"("organization_id", "space_id", "notebook_id", "document_id", "version_token");
CREATE UNIQUE INDEX "governance_templates_scope_name_key" ON "governance_templates"("organization_id", "space_id", "name");
CREATE INDEX "governance_templates_scope_status_idx" ON "governance_templates"("organization_id", "space_id", "status");
CREATE UNIQUE INDEX "governance_tasks_idempotency_key_key" ON "governance_tasks"("idempotency_key");
CREATE UNIQUE INDEX "enterprise_api_keys_secret_digest_key" ON "enterprise_api_keys"("secret_digest");
CREATE UNIQUE INDEX "mfa_factors_user_label_key" ON "mfa_factors"("user_id", "label");
CREATE UNIQUE INDEX "saml_providers_organization_name_key" ON "saml_providers"("organization_id", "name");
CREATE UNIQUE INDEX "scim_tokens_token_digest_key" ON "scim_tokens"("token_digest");
CREATE UNIQUE INDEX "scim_external_identities_scope_external_key" ON "scim_external_identities"("organization_id", "external_id");
CREATE UNIQUE INDEX "personal_spaces_space_id_key" ON "personal_spaces"("space_id");
CREATE UNIQUE INDEX "personal_spaces_organization_user_key" ON "personal_spaces"("organization_id", "user_id");
CREATE UNIQUE INDEX "search_document_index_identity_key" ON "search_document_index"("organization_id", "space_id", "notebook_id", "document_id");
CREATE INDEX "search_document_index_scope_updated_idx" ON "search_document_index"("organization_id", "space_id", "updated_at");
CREATE INDEX "document_governance_verification_idx" ON "document_governance"("organization_id", "space_id", "verification", "next_verification_at");
CREATE INDEX "document_governance_lifecycle_idx" ON "document_governance"("organization_id", "space_id", "lifecycle", "updated_at");
CREATE INDEX "governance_approval_queue_idx" ON "governance_approval_requests"("organization_id", "space_id", "status", "submitted_at");
CREATE INDEX "governance_tasks_queue_idx" ON "governance_tasks"("organization_id", "space_id", "status", "available_at");
CREATE INDEX "governance_tasks_document_idx" ON "governance_tasks"("organization_id", "space_id", "notebook_id", "document_id");
CREATE INDEX "enterprise_api_keys_owner_idx" ON "enterprise_api_keys"("organization_id", "user_id", "revoked_at");
CREATE INDEX "mfa_factors_user_enabled_idx" ON "mfa_factors"("user_id", "enabled_at");
CREATE INDEX "saml_providers_organization_status_idx" ON "saml_providers"("organization_id", "status");
CREATE INDEX "scim_tokens_organization_revoked_idx" ON "scim_tokens"("organization_id", "revoked_at");
CREATE INDEX "scim_external_identities_sync_idx" ON "scim_external_identities"("organization_id", "kind", "last_synced_at");
CREATE INDEX "embedded_objects_document_status_idx" ON "embedded_objects"("organization_id", "space_id", "document_id", "status");
CREATE UNIQUE INDEX "embedded_objects_identity_key" ON "embedded_objects"("organization_id", "space_id", "notebook_id", "document_id", "id");
CREATE INDEX "ai_conversations_owner_updated_idx" ON "ai_conversations"("organization_id", "user_id", "updated_at");
CREATE INDEX "ai_messages_conversation_created_idx" ON "ai_messages"("conversation_id", "created_at");
CREATE INDEX "ai_citations_document_idx" ON "ai_citations"("organization_id", "space_id", "notebook_id", "document_id");

ALTER TABLE "governance_policies" ADD CONSTRAINT "governance_policies_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "governance_policies" ADD CONSTRAINT "governance_policies_space_scope_fkey" FOREIGN KEY ("space_id", "organization_id") REFERENCES "spaces"("id", "organization_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "governance_policies" ADD CONSTRAINT "governance_policies_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "document_governance" ADD CONSTRAINT "document_governance_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "document_governance" ADD CONSTRAINT "document_governance_space_scope_fkey" FOREIGN KEY ("space_id", "organization_id") REFERENCES "spaces"("id", "organization_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "document_governance" ADD CONSTRAINT "document_governance_owner_user_id_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "governance_approval_requests" ADD CONSTRAINT "governance_approval_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "governance_approval_requests" ADD CONSTRAINT "governance_approval_space_scope_fkey" FOREIGN KEY ("space_id", "organization_id") REFERENCES "spaces"("id", "organization_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "governance_approval_requests" ADD CONSTRAINT "governance_approval_submitted_by_fkey" FOREIGN KEY ("submitted_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "governance_approval_requests" ADD CONSTRAINT "governance_approval_decided_by_fkey" FOREIGN KEY ("decided_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "governance_templates" ADD CONSTRAINT "governance_templates_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "governance_templates" ADD CONSTRAINT "governance_templates_space_scope_fkey" FOREIGN KEY ("space_id", "organization_id") REFERENCES "spaces"("id", "organization_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "governance_templates" ADD CONSTRAINT "governance_templates_created_by_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "governance_tasks" ADD CONSTRAINT "governance_tasks_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "governance_tasks" ADD CONSTRAINT "governance_tasks_space_scope_fkey" FOREIGN KEY ("space_id", "organization_id") REFERENCES "spaces"("id", "organization_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "enterprise_api_keys" ADD CONSTRAINT "enterprise_api_keys_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "enterprise_api_keys" ADD CONSTRAINT "enterprise_api_keys_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "mfa_factors" ADD CONSTRAINT "mfa_factors_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "saml_providers" ADD CONSTRAINT "saml_providers_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "saml_providers" ADD CONSTRAINT "saml_providers_created_by_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "scim_tokens" ADD CONSTRAINT "scim_tokens_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "scim_tokens" ADD CONSTRAINT "scim_tokens_created_by_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "scim_external_identities" ADD CONSTRAINT "scim_external_identities_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "scim_external_identities" ADD CONSTRAINT "scim_external_identities_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "scim_external_identities" ADD CONSTRAINT "scim_external_identities_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "user_groups"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "personal_spaces" ADD CONSTRAINT "personal_spaces_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "personal_spaces" ADD CONSTRAINT "personal_spaces_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "personal_spaces" ADD CONSTRAINT "personal_spaces_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "spaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "search_document_index" ADD CONSTRAINT "search_document_index_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "search_document_index" ADD CONSTRAINT "search_document_index_space_scope_fkey" FOREIGN KEY ("space_id", "organization_id") REFERENCES "spaces"("id", "organization_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "embedded_objects" ADD CONSTRAINT "embedded_objects_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "embedded_objects" ADD CONSTRAINT "embedded_objects_space_scope_fkey" FOREIGN KEY ("space_id", "organization_id") REFERENCES "spaces"("id", "organization_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "embedded_objects" ADD CONSTRAINT "embedded_objects_created_by_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ai_conversations" ADD CONSTRAINT "ai_conversations_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ai_conversations" ADD CONSTRAINT "ai_conversations_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ai_messages" ADD CONSTRAINT "ai_messages_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "ai_conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ai_citations" ADD CONSTRAINT "ai_citations_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "ai_messages"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ai_citations" ADD CONSTRAINT "ai_citations_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ai_citations" ADD CONSTRAINT "ai_citations_space_scope_fkey" FOREIGN KEY ("space_id", "organization_id") REFERENCES "spaces"("id", "organization_id") ON DELETE RESTRICT ON UPDATE CASCADE;
