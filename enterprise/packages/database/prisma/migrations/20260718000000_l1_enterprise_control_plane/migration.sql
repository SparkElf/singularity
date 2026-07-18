CREATE TYPE "user_group_status" AS ENUM ('active', 'disabled');
CREATE TYPE "oidc_provider_status" AS ENUM ('active', 'disabled');
CREATE TYPE "worker_job_kind" AS ENUM ('archive-audit', 'backup-space', 'restore-space', 'sample-kernel');
CREATE TYPE "worker_job_status" AS ENUM ('queued', 'running', 'succeeded', 'failed');
CREATE TYPE "space_backup_status" AS ENUM ('queued', 'running', 'succeeded', 'failed');
CREATE TYPE "space_restore_status" AS ENUM ('queued', 'restoring', 'ready-for-activation', 'activated', 'failed');
CREATE TYPE "audit_action" AS ENUM (
    'authentication.login',
    'content.delete',
    'content.edit',
    'content.export',
    'permission.change',
    'share.create',
    'share.password-change',
    'share.revoke',
    'backup.create',
    'restore.create',
    'restore.activate'
);
CREATE TYPE "audit_outcome" AS ENUM ('denied', 'failed', 'succeeded');
CREATE TYPE "kernel_observation_status" AS ENUM ('ready', 'unavailable');

ALTER TYPE "space_status" ADD VALUE 'archived' BEFORE 'disabled';

ALTER TABLE "users"
    ALTER COLUMN "password_digest" DROP NOT NULL;

CREATE TABLE "organization_invitations" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "login_identifier" TEXT NOT NULL,
    "role" "organization_role" NOT NULL,
    "token_digest" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "accepted_at" TIMESTAMPTZ(3),
    "revoked_at" TIMESTAMPTZ(3),
    "invited_by_user_id" UUID NOT NULL,
    "accepted_by_user_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "organization_invitations_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "organization_invitations_terminal_state_check" CHECK (
        NOT ("accepted_at" IS NOT NULL AND "revoked_at" IS NOT NULL)
        AND (("accepted_at" IS NULL) = ("accepted_by_user_id" IS NULL))
    )
);

CREATE TABLE "user_groups" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "status" "user_group_status" NOT NULL,

    CONSTRAINT "user_groups_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "user_group_memberships" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "group_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,

    CONSTRAINT "user_group_memberships_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "space_group_grants" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "space_id" UUID NOT NULL,
    "group_id" UUID NOT NULL,
    "role" "space_role" NOT NULL,

    CONSTRAINT "space_group_grants_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "oidc_providers" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "issuer" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "client_secret_reference" TEXT,
    "status" "oidc_provider_status" NOT NULL,

    CONSTRAINT "oidc_providers_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "oidc_identities" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "provider_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "subject" TEXT NOT NULL,

    CONSTRAINT "oidc_identities_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "oidc_authorization_attempts" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "provider_id" UUID NOT NULL,
    "invitation_id" UUID,
    "browser_binding_digest" TEXT NOT NULL,
    "state_digest" TEXT NOT NULL,
    "nonce_digest" TEXT NOT NULL,
    "code_verifier" TEXT NOT NULL,
    "return_to" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "consumed_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "oidc_authorization_attempts_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "document_shares" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "space_id" UUID NOT NULL,
    "notebook_id" TEXT NOT NULL,
    "document_id" TEXT NOT NULL,
    "token_digest" TEXT NOT NULL,
    "password_digest" TEXT,
    "password_version" INTEGER NOT NULL DEFAULT 1,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "revoked_at" TIMESTAMPTZ(3),
    "created_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "document_shares_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "document_shares_content_identity_check" CHECK (
        "notebook_id" ~ '^[0-9]{14}-[0-9a-z]{7}$'
        AND "document_id" ~ '^[0-9]{14}-[0-9a-z]{7}$'
    ),
    CONSTRAINT "document_shares_token_digest_check" CHECK ("token_digest" ~ '^[a-f0-9]{64}$'),
    CONSTRAINT "document_shares_password_digest_check" CHECK (
        "password_digest" IS NULL OR "password_digest" ~ '[^[:space:]]'
    ),
    CONSTRAINT "document_shares_password_version_check" CHECK ("password_version" > 0),
    CONSTRAINT "document_shares_expiry_check" CHECK ("expires_at" > "created_at"),
    CONSTRAINT "document_shares_revocation_check" CHECK (
        "revoked_at" IS NULL OR "revoked_at" >= "created_at"
    )
);

CREATE TABLE "share_challenges" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "share_id" UUID NOT NULL,
    "token_digest" TEXT NOT NULL,
    "password_version" INTEGER NOT NULL,
    "absolute_expires_at" TIMESTAMPTZ(3) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "share_challenges_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "share_challenges_token_digest_check" CHECK ("token_digest" ~ '^[a-f0-9]{64}$'),
    CONSTRAINT "share_challenges_password_version_check" CHECK ("password_version" > 0),
    CONSTRAINT "share_challenges_expiry_check" CHECK ("absolute_expires_at" > "created_at")
);

CREATE TABLE "organization_audit_sequences" (
    "organization_id" UUID NOT NULL,
    "last_sequence" BIGINT NOT NULL DEFAULT 0,
    "last_mac" TEXT,

    CONSTRAINT "organization_audit_sequences_pkey" PRIMARY KEY ("organization_id"),
    CONSTRAINT "organization_audit_sequences_state_check" CHECK (
        "last_sequence" >= 0
        AND (("last_sequence" = 0 AND "last_mac" IS NULL)
            OR ("last_sequence" > 0 AND "last_mac" IS NOT NULL
                AND "last_mac" ~ '^[a-f0-9]{64}$'))
    )
);

CREATE TABLE "audit_events" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "sequence" BIGINT NOT NULL,
    "space_id" UUID,
    "actor_user_id" UUID,
    "action" "audit_action" NOT NULL,
    "target_type" TEXT NOT NULL,
    "target_id" TEXT NOT NULL,
    "outcome" "audit_outcome" NOT NULL,
    "occurred_at" TIMESTAMPTZ(3) NOT NULL,
    "request_id" UUID NOT NULL,
    "previous_mac" TEXT,
    "mac" TEXT NOT NULL,
    "key_version" TEXT NOT NULL,

    CONSTRAINT "audit_events_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "audit_events_sequence_check" CHECK ("sequence" > 0),
    CONSTRAINT "audit_events_chain_shape_check" CHECK (
        (("sequence" = 1 AND "previous_mac" IS NULL)
            OR ("sequence" > 1 AND "previous_mac" IS NOT NULL
                AND "previous_mac" ~ '^[a-f0-9]{64}$'))
        AND "mac" ~ '^[a-f0-9]{64}$'
    ),
    CONSTRAINT "audit_events_target_check" CHECK (
        "target_type" ~ '[^[:space:]]' AND "target_id" ~ '[^[:space:]]'
    ),
    CONSTRAINT "audit_events_key_version_check" CHECK ("key_version" ~ '[^[:space:]]')
);

CREATE TABLE "audit_archives" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "from_sequence" BIGINT NOT NULL,
    "through_sequence" BIGINT NOT NULL,
    "first_mac" TEXT NOT NULL,
    "last_mac" TEXT NOT NULL,
    "object_key" TEXT NOT NULL,
    "sha256" TEXT NOT NULL,
    "size_bytes" BIGINT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_archives_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "audit_archives_sequence_range_check" CHECK (
        "from_sequence" > 0 AND "through_sequence" >= "from_sequence"
    ),
    CONSTRAINT "audit_archives_chain_mac_check" CHECK (
        "first_mac" ~ '^[a-f0-9]{64}$' AND "last_mac" ~ '^[a-f0-9]{64}$'
    ),
    CONSTRAINT "audit_archives_object_key_check" CHECK ("object_key" ~ '^[A-Za-z0-9_-]{43}$'),
    CONSTRAINT "audit_archives_sha256_check" CHECK ("sha256" ~ '^[a-f0-9]{64}$'),
    CONSTRAINT "audit_archives_size_bytes_check" CHECK ("size_bytes" >= 0)
);

CREATE TABLE "worker_jobs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "kind" "worker_job_kind" NOT NULL,
    "status" "worker_job_status" NOT NULL,
    "payload" JSONB NOT NULL,
    "request_id" UUID NOT NULL,
    "attempt" INTEGER NOT NULL DEFAULT 0,
    "available_at" TIMESTAMPTZ(3) NOT NULL,
    "worker_id" TEXT,
    "lease_expires_at" TIMESTAMPTZ(3),
    "error_code" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMPTZ(3),

    CONSTRAINT "worker_jobs_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "worker_jobs_payload_check" CHECK (jsonb_typeof("payload") = 'object'),
    CONSTRAINT "worker_jobs_attempt_check" CHECK ("attempt" >= 0),
    CONSTRAINT "worker_jobs_worker_id_check" CHECK (
        "worker_id" IS NULL OR "worker_id" ~ '[^[:space:]]'
    ),
    CONSTRAINT "worker_jobs_error_code_check" CHECK (
        "error_code" IS NULL OR "error_code" ~ '[^[:space:]]'
    ),
    CONSTRAINT "worker_jobs_lifecycle_check" CHECK (
        ("status" = 'queued' AND "worker_id" IS NULL
            AND "lease_expires_at" IS NULL AND "completed_at" IS NULL)
        OR ("status" = 'running' AND "worker_id" IS NOT NULL
            AND "lease_expires_at" IS NOT NULL AND "completed_at" IS NULL)
        OR ("status" IN ('succeeded', 'failed') AND "worker_id" IS NULL
            AND "lease_expires_at" IS NULL AND "completed_at" IS NOT NULL)
    )
);

CREATE TABLE "space_backups" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "source_space_id" UUID NOT NULL,
    "status" "space_backup_status" NOT NULL,
    "object_key" TEXT,
    "format_version" INTEGER,
    "kernel_version" TEXT,
    "sha256" TEXT,
    "size_bytes" BIGINT,
    "created_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMPTZ(3),

    CONSTRAINT "space_backups_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "space_backups_object_key_check" CHECK (
        "object_key" IS NULL OR "object_key" ~ '^[A-Za-z0-9_-]{43}$'
    ),
    CONSTRAINT "space_backups_metadata_check" CHECK (
        ("format_version" IS NULL AND "kernel_version" IS NULL
            AND "sha256" IS NULL AND "size_bytes" IS NULL)
        OR ("format_version" IS NOT NULL AND "format_version" > 0
            AND "kernel_version" IS NOT NULL
            AND "kernel_version" ~ '[^[:space:]]'
            AND "sha256" IS NOT NULL AND "sha256" ~ '^[a-f0-9]{64}$'
            AND "size_bytes" IS NOT NULL AND "size_bytes" >= 0)
    ),
    CONSTRAINT "space_backups_lifecycle_check" CHECK (
        ("status" IN ('queued', 'running') AND "completed_at" IS NULL
            AND "format_version" IS NULL)
        OR ("status" = 'succeeded' AND "completed_at" IS NOT NULL
            AND "object_key" IS NOT NULL AND "format_version" IS NOT NULL)
        OR ("status" = 'failed' AND "completed_at" IS NOT NULL
            AND "format_version" IS NULL)
    )
);

CREATE TABLE "space_restore_jobs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "backup_id" UUID NOT NULL,
    "source_space_id" UUID NOT NULL,
    "target_space_id" UUID,
    "status" "space_restore_status" NOT NULL,
    "worker_job_id" UUID,
    "worker_attempt" INTEGER,
    "created_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMPTZ(3),
    "activated_at" TIMESTAMPTZ(3),
    "failure_code" TEXT,

    CONSTRAINT "space_restore_jobs_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "space_restore_jobs_failure_code_check" CHECK (
        "failure_code" IS NULL OR "failure_code" ~ '[^[:space:]]'
    ),
    CONSTRAINT "space_restore_jobs_worker_claim_check" CHECK (
        ("worker_job_id" IS NULL AND "worker_attempt" IS NULL)
        OR ("worker_job_id" IS NOT NULL AND "worker_attempt" IS NOT NULL AND "worker_attempt" > 0)
    ),
    CONSTRAINT "space_restore_jobs_lifecycle_check" CHECK (
        ("status" = 'queued' AND "target_space_id" IS NOT NULL
            AND "worker_job_id" IS NULL AND "worker_attempt" IS NULL
            AND "completed_at" IS NULL AND "activated_at" IS NULL)
        OR ("status" = 'restoring' AND "target_space_id" IS NOT NULL
            AND "worker_job_id" IS NOT NULL AND "worker_attempt" IS NOT NULL
            AND "completed_at" IS NULL AND "activated_at" IS NULL)
        OR ("status" = 'ready-for-activation' AND "target_space_id" IS NOT NULL
            AND "worker_job_id" IS NULL AND "worker_attempt" IS NULL
            AND "completed_at" IS NOT NULL AND "activated_at" IS NULL)
        OR ("status" = 'activated' AND "target_space_id" IS NOT NULL
            AND "worker_job_id" IS NULL AND "worker_attempt" IS NULL
            AND "completed_at" IS NOT NULL AND "activated_at" IS NOT NULL)
        OR ("status" = 'failed' AND "target_space_id" IS NULL
            AND "worker_job_id" IS NULL AND "worker_attempt" IS NULL
            AND "completed_at" IS NOT NULL AND "activated_at" IS NULL)
    )
);

CREATE TABLE "kernel_runtime_endpoints" (
    "kernel_instance_id" UUID NOT NULL,
    "space_id" UUID NOT NULL,
    "hostname" TEXT NOT NULL,
    "port" INTEGER NOT NULL,
    "server_name" TEXT NOT NULL,
    "tls_profile" TEXT NOT NULL,

    CONSTRAINT "kernel_runtime_endpoints_pkey" PRIMARY KEY ("kernel_instance_id"),
    CONSTRAINT "kernel_runtime_endpoints_hostname_check" CHECK (
        "hostname" ~ '[^[:space:]]'
    ),
    CONSTRAINT "kernel_runtime_endpoints_port_check" CHECK (
        "port" BETWEEN 1 AND 65535
    ),
    CONSTRAINT "kernel_runtime_endpoints_server_name_check" CHECK (
        "server_name" ~ '[^[:space:]]'
    ),
    CONSTRAINT "kernel_runtime_endpoints_tls_profile_check" CHECK (
        "tls_profile" ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'
    )
);

CREATE TABLE "kernel_health_observations" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "kernel_instance_id" UUID NOT NULL,
    "status" "kernel_observation_status" NOT NULL,
    "kernel_version" TEXT NOT NULL,
    "sampled_at" TIMESTAMPTZ(3) NOT NULL,
    "error_code" TEXT,

    CONSTRAINT "kernel_health_observations_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "kernel_health_observations_kernel_version_check" CHECK (
        "kernel_version" ~ '[^[:space:]]'
    ),
    CONSTRAINT "kernel_health_observations_error_code_check" CHECK (
        "error_code" IS NULL OR "error_code" ~ '[^[:space:]]'
    )
);

CREATE TABLE "space_capacity_observations" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "kernel_instance_id" UUID NOT NULL,
    "space_id" UUID NOT NULL,
    "data_bytes" BIGINT NOT NULL,
    "asset_bytes" BIGINT NOT NULL,
    "file_count" BIGINT NOT NULL,
    "sample_duration_milliseconds" INTEGER NOT NULL,
    "sampled_at" TIMESTAMPTZ(3) NOT NULL,
    "error_code" TEXT,

    CONSTRAINT "space_capacity_observations_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "space_capacity_observations_values_check" CHECK (
        "data_bytes" >= 0 AND "asset_bytes" >= 0 AND "file_count" >= 0
        AND "sample_duration_milliseconds" >= 0
    ),
    CONSTRAINT "space_capacity_observations_error_code_check" CHECK (
        "error_code" IS NULL OR "error_code" ~ '[^[:space:]]'
    )
);

CREATE UNIQUE INDEX "organization_invitations_token_digest_key" ON "organization_invitations"("token_digest");
CREATE UNIQUE INDEX "organization_invitations_id_organization_id_key" ON "organization_invitations"("id", "organization_id");
CREATE INDEX "organization_invitations_organization_id_login_identifier_idx" ON "organization_invitations"("organization_id", "login_identifier");
CREATE INDEX "organization_invitations_expires_at_idx" ON "organization_invitations"("expires_at");
CREATE UNIQUE INDEX "user_groups_id_organization_id_key" ON "user_groups"("id", "organization_id");
CREATE UNIQUE INDEX "user_groups_organization_id_name_key" ON "user_groups"("organization_id", "name");
CREATE INDEX "user_groups_organization_id_idx" ON "user_groups"("organization_id");
CREATE UNIQUE INDEX "user_group_memberships_group_id_user_id_key" ON "user_group_memberships"("group_id", "user_id");
CREATE INDEX "user_group_memberships_organization_id_user_id_idx" ON "user_group_memberships"("organization_id", "user_id");
CREATE UNIQUE INDEX "space_group_grants_space_id_group_id_key" ON "space_group_grants"("space_id", "group_id");
CREATE INDEX "space_group_grants_organization_id_group_id_idx" ON "space_group_grants"("organization_id", "group_id");
CREATE UNIQUE INDEX "oidc_providers_organization_id_name_key" ON "oidc_providers"("organization_id", "name");
CREATE UNIQUE INDEX "oidc_providers_id_organization_id_key" ON "oidc_providers"("id", "organization_id");
CREATE UNIQUE INDEX "oidc_providers_organization_id_issuer_client_id_key" ON "oidc_providers"("organization_id", "issuer", "client_id");
CREATE INDEX "oidc_providers_organization_id_idx" ON "oidc_providers"("organization_id");
CREATE UNIQUE INDEX "oidc_identities_provider_id_subject_key" ON "oidc_identities"("provider_id", "subject");
CREATE UNIQUE INDEX "oidc_identities_provider_id_user_id_key" ON "oidc_identities"("provider_id", "user_id");
CREATE INDEX "oidc_identities_user_id_idx" ON "oidc_identities"("user_id");
CREATE UNIQUE INDEX "oidc_authorization_attempts_state_digest_key" ON "oidc_authorization_attempts"("state_digest");
CREATE INDEX "oidc_authorization_attempts_expires_at_idx" ON "oidc_authorization_attempts"("expires_at");
CREATE UNIQUE INDEX "kernel_instances_id_space_id_key" ON "kernel_instances"("id", "space_id");
CREATE UNIQUE INDEX "kernel_instances_deployment_handle_key" ON "kernel_instances"("deployment_handle");
CREATE UNIQUE INDEX "kernel_runtime_endpoints_kernel_instance_id_space_id_key" ON "kernel_runtime_endpoints"("kernel_instance_id", "space_id");
CREATE INDEX "kernel_runtime_endpoints_space_id_idx" ON "kernel_runtime_endpoints"("space_id");
CREATE UNIQUE INDEX "document_shares_token_digest_key" ON "document_shares"("token_digest");
CREATE INDEX "document_shares_organization_id_space_id_created_at_idx" ON "document_shares"("organization_id", "space_id", "created_at");
CREATE UNIQUE INDEX "share_challenges_token_digest_key" ON "share_challenges"("token_digest");
CREATE INDEX "share_challenges_share_id_absolute_expires_at_idx" ON "share_challenges"("share_id", "absolute_expires_at");
CREATE UNIQUE INDEX "audit_events_organization_id_sequence_key" ON "audit_events"("organization_id", "sequence");
CREATE INDEX "audit_events_organization_id_space_id_sequence_idx" ON "audit_events"("organization_id", "space_id", "sequence");
CREATE INDEX "audit_events_actor_user_id_idx" ON "audit_events"("actor_user_id");
CREATE UNIQUE INDEX "audit_archives_object_key_key" ON "audit_archives"("object_key");
CREATE UNIQUE INDEX "audit_archives_organization_id_sequence_range_key" ON "audit_archives"("organization_id", "from_sequence", "through_sequence");
CREATE INDEX "worker_jobs_claim_idx" ON "worker_jobs"("status", "kind", "available_at", "created_at");
CREATE INDEX "worker_jobs_organization_id_created_at_idx" ON "worker_jobs"("organization_id", "created_at");
CREATE UNIQUE INDEX "space_backups_object_key_key" ON "space_backups"("object_key");
CREATE UNIQUE INDEX "space_backups_id_organization_id_source_space_id_key" ON "space_backups"("id", "organization_id", "source_space_id");
CREATE INDEX "space_backups_organization_id_source_space_id_created_at_idx" ON "space_backups"("organization_id", "source_space_id", "created_at");
CREATE UNIQUE INDEX "space_restore_jobs_target_space_id_key" ON "space_restore_jobs"("target_space_id");
CREATE INDEX "space_restore_jobs_source_created_idx" ON "space_restore_jobs"("organization_id", "source_space_id", "created_at");
CREATE INDEX "space_restore_jobs_worker_claim_idx" ON "space_restore_jobs"("worker_job_id", "worker_attempt");
CREATE INDEX "kernel_health_observations_kernel_instance_id_sampled_at_idx" ON "kernel_health_observations"("kernel_instance_id", "sampled_at");
CREATE INDEX "space_capacity_observations_kernel_instance_id_sampled_at_idx" ON "space_capacity_observations"("kernel_instance_id", "sampled_at");
CREATE INDEX "space_capacity_observations_space_id_sampled_at_idx" ON "space_capacity_observations"("space_id", "sampled_at");

ALTER TABLE "organization_invitations"
    ADD CONSTRAINT "organization_invitations_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "organization_invitations"
    ADD CONSTRAINT "organization_invitations_invited_by_user_id_fkey"
    FOREIGN KEY ("invited_by_user_id") REFERENCES "users"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "organization_invitations"
    ADD CONSTRAINT "organization_invitations_accepted_by_user_id_fkey"
    FOREIGN KEY ("accepted_by_user_id") REFERENCES "users"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "user_groups"
    ADD CONSTRAINT "user_groups_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "user_group_memberships"
    ADD CONSTRAINT "user_group_memberships_group_id_organization_id_fkey"
    FOREIGN KEY ("group_id", "organization_id")
    REFERENCES "user_groups"("id", "organization_id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "user_group_memberships"
    ADD CONSTRAINT "user_group_memberships_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "user_group_memberships"
    ADD CONSTRAINT "user_group_memberships_organization_id_user_id_fkey"
    FOREIGN KEY ("organization_id", "user_id")
    REFERENCES "organization_memberships"("organization_id", "user_id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "space_group_grants"
    ADD CONSTRAINT "space_group_grants_space_id_organization_id_fkey"
    FOREIGN KEY ("space_id", "organization_id")
    REFERENCES "spaces"("id", "organization_id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "space_group_grants"
    ADD CONSTRAINT "space_group_grants_group_id_organization_id_fkey"
    FOREIGN KEY ("group_id", "organization_id")
    REFERENCES "user_groups"("id", "organization_id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "oidc_providers"
    ADD CONSTRAINT "oidc_providers_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "oidc_identities"
    ADD CONSTRAINT "oidc_identities_provider_id_organization_id_fkey"
    FOREIGN KEY ("provider_id", "organization_id")
    REFERENCES "oidc_providers"("id", "organization_id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "oidc_identities"
    ADD CONSTRAINT "oidc_identities_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "oidc_identities"
    ADD CONSTRAINT "oidc_identities_organization_id_user_id_fkey"
    FOREIGN KEY ("organization_id", "user_id")
    REFERENCES "organization_memberships"("organization_id", "user_id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "oidc_authorization_attempts"
    ADD CONSTRAINT "oidc_authorization_attempts_provider_id_organization_id_fkey"
    FOREIGN KEY ("provider_id", "organization_id")
    REFERENCES "oidc_providers"("id", "organization_id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "oidc_authorization_attempts"
    ADD CONSTRAINT "oidc_authorization_attempts_invitation_id_organization_id_fkey"
    FOREIGN KEY ("invitation_id", "organization_id")
    REFERENCES "organization_invitations"("id", "organization_id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "document_shares"
    ADD CONSTRAINT "document_shares_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "document_shares"
    ADD CONSTRAINT "document_shares_space_id_organization_id_fkey"
    FOREIGN KEY ("space_id", "organization_id")
    REFERENCES "spaces"("id", "organization_id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "document_shares"
    ADD CONSTRAINT "document_shares_created_by_user_id_fkey"
    FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "document_shares"
    ADD CONSTRAINT "document_shares_organization_id_created_by_user_id_fkey"
    FOREIGN KEY ("organization_id", "created_by_user_id")
    REFERENCES "organization_memberships"("organization_id", "user_id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "share_challenges"
    ADD CONSTRAINT "share_challenges_share_id_fkey"
    FOREIGN KEY ("share_id") REFERENCES "document_shares"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "organization_audit_sequences"
    ADD CONSTRAINT "organization_audit_sequences_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "audit_events"
    ADD CONSTRAINT "audit_events_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "audit_events"
    ADD CONSTRAINT "audit_events_space_id_organization_id_fkey"
    FOREIGN KEY ("space_id", "organization_id")
    REFERENCES "spaces"("id", "organization_id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "audit_events"
    ADD CONSTRAINT "audit_events_actor_user_id_fkey"
    FOREIGN KEY ("actor_user_id") REFERENCES "users"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "audit_events"
    ADD CONSTRAINT "audit_events_organization_id_actor_user_id_fkey"
    FOREIGN KEY ("organization_id", "actor_user_id")
    REFERENCES "organization_memberships"("organization_id", "user_id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "audit_archives"
    ADD CONSTRAINT "audit_archives_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "worker_jobs"
    ADD CONSTRAINT "worker_jobs_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "space_backups"
    ADD CONSTRAINT "space_backups_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "space_backups"
    ADD CONSTRAINT "space_backups_source_space_id_organization_id_fkey"
    FOREIGN KEY ("source_space_id", "organization_id")
    REFERENCES "spaces"("id", "organization_id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "space_backups"
    ADD CONSTRAINT "space_backups_created_by_user_id_fkey"
    FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "space_backups"
    ADD CONSTRAINT "space_backups_organization_id_created_by_user_id_fkey"
    FOREIGN KEY ("organization_id", "created_by_user_id")
    REFERENCES "organization_memberships"("organization_id", "user_id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "space_restore_jobs"
    ADD CONSTRAINT "space_restore_jobs_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "space_restore_jobs"
    ADD CONSTRAINT "space_restore_jobs_backup_scope_fkey"
    FOREIGN KEY ("backup_id", "organization_id", "source_space_id")
    REFERENCES "space_backups"("id", "organization_id", "source_space_id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "space_restore_jobs"
    ADD CONSTRAINT "space_restore_jobs_source_space_id_organization_id_fkey"
    FOREIGN KEY ("source_space_id", "organization_id")
    REFERENCES "spaces"("id", "organization_id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "space_restore_jobs"
    ADD CONSTRAINT "space_restore_jobs_target_space_id_organization_id_fkey"
    FOREIGN KEY ("target_space_id", "organization_id")
    REFERENCES "spaces"("id", "organization_id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "space_restore_jobs"
    ADD CONSTRAINT "space_restore_jobs_created_by_user_id_fkey"
    FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "space_restore_jobs"
    ADD CONSTRAINT "space_restore_jobs_organization_id_created_by_user_id_fkey"
    FOREIGN KEY ("organization_id", "created_by_user_id")
    REFERENCES "organization_memberships"("organization_id", "user_id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "kernel_runtime_endpoints"
    ADD CONSTRAINT "kernel_runtime_endpoints_kernel_instance_id_space_id_fkey"
    FOREIGN KEY ("kernel_instance_id", "space_id")
    REFERENCES "kernel_instances"("id", "space_id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "kernel_health_observations"
    ADD CONSTRAINT "kernel_health_observations_kernel_instance_id_fkey"
    FOREIGN KEY ("kernel_instance_id") REFERENCES "kernel_instances"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "space_capacity_observations"
    ADD CONSTRAINT "space_capacity_observations_kernel_instance_id_space_id_fkey"
    FOREIGN KEY ("kernel_instance_id", "space_id")
    REFERENCES "kernel_instances"("id", "space_id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "space_capacity_observations"
    ADD CONSTRAINT "space_capacity_observations_space_id_fkey"
    FOREIGN KEY ("space_id") REFERENCES "spaces"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE FUNCTION "enforce_audit_event_chain_insert"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    expected_sequence BIGINT;
    expected_previous_mac TEXT;
BEGIN
    SELECT "last_sequence" + 1, "last_mac"
    INTO expected_sequence, expected_previous_mac
    FROM "organization_audit_sequences"
    WHERE "organization_id" = NEW."organization_id"
    FOR UPDATE;

    IF NOT FOUND
        OR NEW."sequence" <> expected_sequence
        OR NEW."previous_mac" IS DISTINCT FROM expected_previous_mac
    THEN
        RAISE EXCEPTION USING
            ERRCODE = '23514',
            MESSAGE = 'SINGULARITY_AUDIT_CHAIN_INVALID';
    END IF;
    RETURN NEW;
END;
$$;

CREATE FUNCTION "reject_audit_event_mutation"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION USING
        ERRCODE = '55000',
        MESSAGE = 'SINGULARITY_AUDIT_EVENTS_ARE_APPEND_ONLY';
END;
$$;

CREATE TRIGGER "audit_events_chain_insert_trigger"
BEFORE INSERT ON "audit_events"
FOR EACH ROW
EXECUTE FUNCTION "enforce_audit_event_chain_insert"();

CREATE TRIGGER "audit_events_immutable_trigger"
BEFORE UPDATE OR DELETE ON "audit_events"
FOR EACH ROW
EXECUTE FUNCTION "reject_audit_event_mutation"();
