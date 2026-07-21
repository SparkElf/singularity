CREATE TYPE "document_access_mode" AS ENUM ('inherit', 'restricted');
CREATE TYPE "document_access_role" AS ENUM ('viewer', 'commenter', 'editor');
CREATE TYPE "document_access_grant_kind" AS ENUM ('user', 'group');
CREATE TYPE "comment_thread_status" AS ENUM ('open', 'resolved', 'deleted');
CREATE TYPE "notification_kind" AS ENUM (
    'mention',
    'comment-reply',
    'comment-resolved',
    'permission-changed',
    'history-restored'
);

ALTER TYPE "audit_action" ADD VALUE 'comment.create';
ALTER TYPE "audit_action" ADD VALUE 'comment.reply';
ALTER TYPE "audit_action" ADD VALUE 'comment.edit';
ALTER TYPE "audit_action" ADD VALUE 'comment.resolve';
ALTER TYPE "audit_action" ADD VALUE 'comment.reopen';
ALTER TYPE "audit_action" ADD VALUE 'comment.delete';
ALTER TYPE "audit_action" ADD VALUE 'history.view';
ALTER TYPE "audit_action" ADD VALUE 'history.restore';
ALTER TYPE "audit_action" ADD VALUE 'notification.read';

ALTER TABLE "audit_events"
    DROP CONSTRAINT "audit_events_target_type_check",
    ADD CONSTRAINT "audit_events_target_type_check" CHECK (
        "target_type" IN (
            'backup',
            'comment',
            'document',
            'group',
            'history',
            'invitation',
            'membership',
            'notification',
            'oidc-provider',
            'organization',
            'restore',
            'session',
            'share',
            'space',
            'user'
        )
    );

CREATE TABLE "document_access_policies" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "space_id" UUID NOT NULL,
    "notebook_id" TEXT NOT NULL,
    "document_id" TEXT NOT NULL,
    "mode" "document_access_mode" NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "document_access_policies_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "document_access_policies_identity_check" CHECK (
        "notebook_id" ~ '^[0-9]{14}-[0-9a-z]{7}$'
        AND "document_id" ~ '^[0-9]{14}-[0-9a-z]{7}$'
    )
);

CREATE TABLE "document_access_grants" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "policy_id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "space_id" UUID NOT NULL,
    "notebook_id" TEXT NOT NULL,
    "document_id" TEXT NOT NULL,
    "kind" "document_access_grant_kind" NOT NULL,
    "user_id" UUID,
    "group_id" UUID,
    "role" "document_access_role" NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "document_access_grants_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "document_access_grants_identity_check" CHECK (
        "notebook_id" ~ '^[0-9]{14}-[0-9a-z]{7}$'
        AND "document_id" ~ '^[0-9]{14}-[0-9a-z]{7}$'
    ),
    CONSTRAINT "document_access_grants_subject_check" CHECK (
        ("kind" = 'user' AND "user_id" IS NOT NULL AND "group_id" IS NULL)
        OR ("kind" = 'group' AND "user_id" IS NULL AND "group_id" IS NOT NULL)
    )
);

CREATE TABLE "comment_threads" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "space_id" UUID NOT NULL,
    "notebook_id" TEXT NOT NULL,
    "document_id" TEXT NOT NULL,
    "anchor_block_id" TEXT,
    "status" "comment_thread_status" NOT NULL,
    "created_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolved_at" TIMESTAMPTZ(3),

    CONSTRAINT "comment_threads_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "comment_threads_identity_check" CHECK (
        "notebook_id" ~ '^[0-9]{14}-[0-9a-z]{7}$'
        AND "document_id" ~ '^[0-9]{14}-[0-9a-z]{7}$'
    ),
    CONSTRAINT "comment_threads_anchor_check" CHECK (
        "anchor_block_id" IS NULL OR "anchor_block_id" ~ '^[0-9]{14}-[0-9a-z]{7}$'
    ),
    CONSTRAINT "comment_threads_resolved_at_check" CHECK (
        ("status" = 'resolved' AND "resolved_at" IS NOT NULL)
        OR ("status" <> 'resolved' AND "resolved_at" IS NULL)
    )
);

CREATE TABLE "comment_entries" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "thread_id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "space_id" UUID NOT NULL,
    "notebook_id" TEXT NOT NULL,
    "document_id" TEXT NOT NULL,
    "author_user_id" UUID NOT NULL,
    "body" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "edited_at" TIMESTAMPTZ(3),
    "deleted_at" TIMESTAMPTZ(3),

    CONSTRAINT "comment_entries_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "comment_entries_identity_check" CHECK (
        "notebook_id" ~ '^[0-9]{14}-[0-9a-z]{7}$'
        AND "document_id" ~ '^[0-9]{14}-[0-9a-z]{7}$'
        AND "body" ~ '[^[:space:]]'
    )
);

CREATE TABLE "notifications" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "recipient_user_id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "space_id" UUID NOT NULL,
    "notebook_id" TEXT NOT NULL,
    "document_id" TEXT NOT NULL,
    "kind" "notification_kind" NOT NULL,
    "event_key" TEXT NOT NULL,
    "actor_user_id" UUID,
    "thread_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "read_at" TIMESTAMPTZ(3),

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "notifications_identity_check" CHECK (
        "notebook_id" ~ '^[0-9]{14}-[0-9a-z]{7}$'
        AND "document_id" ~ '^[0-9]{14}-[0-9a-z]{7}$'
        AND "event_key" ~ '[^[:space:]]'
    )
);

CREATE UNIQUE INDEX "document_access_policies_identity_key"
    ON "document_access_policies"("organization_id", "space_id", "notebook_id", "document_id");
CREATE UNIQUE INDEX "document_access_policies_scope_key"
    ON "document_access_policies"("id", "organization_id", "space_id", "notebook_id", "document_id");
CREATE INDEX "document_access_policies_space_updated_idx"
    ON "document_access_policies"("organization_id", "space_id", "updated_at");

CREATE UNIQUE INDEX "document_access_grants_scope_key"
    ON "document_access_grants"("id", "organization_id", "space_id", "notebook_id", "document_id");
CREATE UNIQUE INDEX "document_access_grants_user_key"
    ON "document_access_grants"("policy_id", "user_id") WHERE "user_id" IS NOT NULL;
CREATE UNIQUE INDEX "document_access_grants_group_key"
    ON "document_access_grants"("policy_id", "group_id") WHERE "group_id" IS NOT NULL;
CREATE INDEX "document_access_grants_document_created_idx"
    ON "document_access_grants"("organization_id", "space_id", "notebook_id", "document_id", "created_at");
CREATE INDEX "document_access_grants_user_idx"
    ON "document_access_grants"("organization_id", "user_id");
CREATE INDEX "document_access_grants_group_idx"
    ON "document_access_grants"("organization_id", "group_id");

CREATE UNIQUE INDEX "comment_threads_scope_key"
    ON "comment_threads"("id", "organization_id", "space_id", "notebook_id", "document_id");
CREATE INDEX "comment_threads_document_created_idx"
    ON "comment_threads"("organization_id", "space_id", "notebook_id", "document_id", "created_at", "id");

CREATE UNIQUE INDEX "comment_entries_scope_key"
    ON "comment_entries"("id", "organization_id", "space_id", "notebook_id", "document_id");
CREATE INDEX "comment_entries_thread_created_idx"
    ON "comment_entries"("organization_id", "space_id", "notebook_id", "document_id", "thread_id", "created_at", "id");

CREATE UNIQUE INDEX "notifications_recipient_event_key"
    ON "notifications"("recipient_user_id", "event_key");
CREATE INDEX "notifications_recipient_read_idx"
    ON "notifications"("recipient_user_id", "read_at", "created_at", "id");
CREATE INDEX "notifications_document_created_idx"
    ON "notifications"("organization_id", "space_id", "notebook_id", "document_id", "created_at");

ALTER TABLE "document_access_policies"
    ADD CONSTRAINT "document_access_policies_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
    ADD CONSTRAINT "document_access_policies_space_id_organization_id_fkey"
    FOREIGN KEY ("space_id", "organization_id") REFERENCES "spaces"("id", "organization_id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "document_access_grants"
    ADD CONSTRAINT "document_access_grants_policy_scope_fkey"
    FOREIGN KEY ("policy_id", "organization_id", "space_id", "notebook_id", "document_id")
    REFERENCES "document_access_policies"("id", "organization_id", "space_id", "notebook_id", "document_id")
    ON DELETE CASCADE ON UPDATE CASCADE,
    ADD CONSTRAINT "document_access_grants_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
    ADD CONSTRAINT "document_access_grants_group_scope_fkey"
    FOREIGN KEY ("group_id", "organization_id") REFERENCES "user_groups"("id", "organization_id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "comment_threads"
    ADD CONSTRAINT "comment_threads_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
    ADD CONSTRAINT "comment_threads_space_id_organization_id_fkey"
    FOREIGN KEY ("space_id", "organization_id") REFERENCES "spaces"("id", "organization_id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
    ADD CONSTRAINT "comment_threads_created_by_user_id_fkey"
    FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "comment_entries"
    ADD CONSTRAINT "comment_entries_thread_scope_fkey"
    FOREIGN KEY ("thread_id", "organization_id", "space_id", "notebook_id", "document_id")
    REFERENCES "comment_threads"("id", "organization_id", "space_id", "notebook_id", "document_id")
    ON DELETE CASCADE ON UPDATE CASCADE,
    ADD CONSTRAINT "comment_entries_author_user_id_fkey"
    FOREIGN KEY ("author_user_id") REFERENCES "users"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "notifications"
    ADD CONSTRAINT "notifications_recipient_user_id_fkey"
    FOREIGN KEY ("recipient_user_id") REFERENCES "users"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
    ADD CONSTRAINT "notifications_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
    ADD CONSTRAINT "notifications_space_id_organization_id_fkey"
    FOREIGN KEY ("space_id", "organization_id") REFERENCES "spaces"("id", "organization_id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
    ADD CONSTRAINT "notifications_actor_user_id_fkey"
    FOREIGN KEY ("actor_user_id") REFERENCES "users"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
    ADD CONSTRAINT "notifications_thread_scope_fkey"
    FOREIGN KEY ("thread_id", "organization_id", "space_id", "notebook_id", "document_id")
    REFERENCES "comment_threads"("id", "organization_id", "space_id", "notebook_id", "document_id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
