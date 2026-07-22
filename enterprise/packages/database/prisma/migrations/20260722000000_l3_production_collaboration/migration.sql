CREATE TYPE "collaboration_feature_mode" AS ENUM ('standard', 'restricted-encrypted');
CREATE TYPE "collaboration_session_status" AS ENUM ('connecting', 'ready', 'reconnecting', 'conflict', 'revoked', 'closed');

ALTER TYPE "audit_action" ADD VALUE IF NOT EXISTS 'collaboration.join';
ALTER TYPE "audit_action" ADD VALUE IF NOT EXISTS 'collaboration.operation';
ALTER TYPE "audit_action" ADD VALUE IF NOT EXISTS 'collaboration.conflict';
ALTER TYPE "audit_action" ADD VALUE IF NOT EXISTS 'collaboration.resume';
ALTER TYPE "audit_action" ADD VALUE IF NOT EXISTS 'collaboration.revoke';

CREATE TABLE "collaboration_features" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "space_id" UUID NOT NULL,
    "notebook_id" TEXT NOT NULL,
    "document_id" TEXT NOT NULL,
    "standard_enabled" BOOLEAN NOT NULL DEFAULT FALSE,
    "restricted_encrypted_enabled" BOOLEAN NOT NULL DEFAULT FALSE,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "collaboration_features_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "collaboration_features_identity_check" CHECK (
      "notebook_id" ~ '^[0-9]{14}-[0-9a-z]{7}$'
      AND "document_id" ~ '^[0-9]{14}-[0-9a-z]{7}$'
    )
);

CREATE TABLE "collaboration_sessions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "space_id" UUID NOT NULL,
    "notebook_id" TEXT NOT NULL,
    "document_id" TEXT NOT NULL,
    "auth_session_id" UUID NOT NULL,
    "actor_user_id" UUID NOT NULL,
    "client_id" UUID NOT NULL,
    "connection_id" UUID NOT NULL,
    "feature_mode" "collaboration_feature_mode" NOT NULL,
    "protocol_version" INTEGER NOT NULL,
    "session_generation" BIGINT NOT NULL,
    "status" "collaboration_session_status" NOT NULL,
    "opened_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closed_at" TIMESTAMPTZ(3),
    CONSTRAINT "collaboration_sessions_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "collaboration_sessions_identity_check" CHECK (
      "notebook_id" ~ '^[0-9]{14}-[0-9a-z]{7}$'
      AND "document_id" ~ '^[0-9]{14}-[0-9a-z]{7}$'
      AND "protocol_version" > 0
      AND "session_generation" > 0
    )
);

CREATE TABLE "collaboration_audit_events" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "space_id" UUID NOT NULL,
    "notebook_id" TEXT NOT NULL,
    "document_id" TEXT NOT NULL,
    "auth_session_id" UUID,
    "actor_user_id" UUID,
    "client_id" UUID,
    "feature_mode" "collaboration_feature_mode",
    "session_generation" BIGINT,
    "operation_id" UUID,
    "event" TEXT NOT NULL,
    "outcome" TEXT NOT NULL,
    "result_code" TEXT,
    "request_id" UUID NOT NULL,
    "duration_ms" INTEGER,
    "occurred_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "collaboration_audit_events_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "collaboration_audit_events_identity_check" CHECK (
      "notebook_id" ~ '^[0-9]{14}-[0-9a-z]{7}$'
      AND "document_id" ~ '^[0-9]{14}-[0-9a-z]{7}$'
      AND "event" ~ '[^[:space:]]'
      AND "outcome" ~ '[^[:space:]]'
    )
);

CREATE UNIQUE INDEX "collaboration_features_identity_key"
  ON "collaboration_features"("organization_id", "space_id", "notebook_id", "document_id");
CREATE INDEX "collaboration_features_space_updated_idx"
  ON "collaboration_features"("organization_id", "space_id", "updated_at");
CREATE UNIQUE INDEX "collaboration_sessions_connection_id_key"
  ON "collaboration_sessions"("connection_id");
CREATE INDEX "collaboration_sessions_client_generation_status_idx"
  ON "collaboration_sessions"("client_id", "session_generation", "status");
CREATE INDEX "collaboration_sessions_identity_status_idx"
  ON "collaboration_sessions"("organization_id", "space_id", "notebook_id", "document_id", "status");
CREATE INDEX "collaboration_sessions_auth_session_status_idx"
  ON "collaboration_sessions"("auth_session_id", "status");
CREATE INDEX "collaboration_audit_events_scope_occurred_idx"
  ON "collaboration_audit_events"("organization_id", "space_id", "occurred_at", "id");
CREATE INDEX "collaboration_audit_events_client_occurred_idx"
  ON "collaboration_audit_events"("client_id", "occurred_at");

ALTER TABLE "collaboration_features"
  ADD CONSTRAINT "collaboration_features_organization_id_fkey"
  FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "collaboration_features_space_id_organization_id_fkey"
  FOREIGN KEY ("space_id", "organization_id") REFERENCES "spaces"("id", "organization_id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "collaboration_sessions"
  ADD CONSTRAINT "collaboration_sessions_organization_id_fkey"
  FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "collaboration_sessions_space_id_organization_id_fkey"
  FOREIGN KEY ("space_id", "organization_id") REFERENCES "spaces"("id", "organization_id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "collaboration_sessions_auth_session_id_fkey"
  FOREIGN KEY ("auth_session_id") REFERENCES "auth_sessions"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "collaboration_sessions_actor_user_id_fkey"
  FOREIGN KEY ("actor_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "collaboration_audit_events"
  ADD CONSTRAINT "collaboration_audit_events_organization_id_fkey"
  FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "collaboration_audit_events_space_id_organization_id_fkey"
  FOREIGN KEY ("space_id", "organization_id") REFERENCES "spaces"("id", "organization_id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "collaboration_audit_events_auth_session_id_fkey"
  FOREIGN KEY ("auth_session_id") REFERENCES "auth_sessions"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "collaboration_audit_events_actor_user_id_fkey"
  FOREIGN KEY ("actor_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
