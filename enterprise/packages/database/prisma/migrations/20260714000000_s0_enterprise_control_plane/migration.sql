CREATE TYPE "user_status" AS ENUM ('active', 'disabled');
CREATE TYPE "organization_status" AS ENUM ('active', 'disabled');
CREATE TYPE "organization_role" AS ENUM ('owner', 'admin', 'member');
CREATE TYPE "membership_status" AS ENUM ('active', 'inactive');
CREATE TYPE "space_status" AS ENUM ('active', 'disabled');
CREATE TYPE "space_role" AS ENUM ('admin', 'editor', 'viewer');
CREATE TYPE "kernel_instance_status" AS ENUM ('starting', 'ready', 'unavailable');

CREATE TABLE "users" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "login_identifier" TEXT NOT NULL,
    "password_digest" TEXT NOT NULL,
    "status" "user_status" NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "auth_sessions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "token_digest" TEXT NOT NULL,
    "csrf_digest" TEXT NOT NULL,
    "absolute_expires_at" TIMESTAMPTZ(3) NOT NULL,
    "idle_expires_at" TIMESTAMPTZ(3) NOT NULL,
    "revoked_at" TIMESTAMPTZ(3),

    CONSTRAINT "auth_sessions_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "organizations" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" TEXT NOT NULL,
    "status" "organization_status" NOT NULL,

    CONSTRAINT "organizations_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "organization_memberships" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "role" "organization_role" NOT NULL,
    "status" "membership_status" NOT NULL,

    CONSTRAINT "organization_memberships_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "spaces" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "status" "space_status" NOT NULL,

    CONSTRAINT "spaces_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "space_memberships" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "space_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "role" "space_role" NOT NULL,
    "status" "membership_status" NOT NULL,

    CONSTRAINT "space_memberships_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "kernel_instances" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "space_id" UUID NOT NULL,
    "status" "kernel_instance_status" NOT NULL,
    "deployment_handle" TEXT NOT NULL,
    "version" TEXT NOT NULL,

    CONSTRAINT "kernel_instances_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "users_login_identifier_key" ON "users"("login_identifier");
CREATE UNIQUE INDEX "auth_sessions_token_digest_key" ON "auth_sessions"("token_digest");
CREATE INDEX "auth_sessions_user_id_idx" ON "auth_sessions"("user_id");
CREATE UNIQUE INDEX "organization_memberships_organization_id_user_id_key" ON "organization_memberships"("organization_id", "user_id");
CREATE INDEX "organization_memberships_user_id_idx" ON "organization_memberships"("user_id");
CREATE UNIQUE INDEX "spaces_id_organization_id_key" ON "spaces"("id", "organization_id");
CREATE INDEX "spaces_organization_id_idx" ON "spaces"("organization_id");
CREATE UNIQUE INDEX "space_memberships_space_id_user_id_key" ON "space_memberships"("space_id", "user_id");
CREATE INDEX "space_memberships_space_id_organization_id_idx" ON "space_memberships"("space_id", "organization_id");
CREATE INDEX "space_memberships_organization_id_user_id_idx" ON "space_memberships"("organization_id", "user_id");
CREATE UNIQUE INDEX "kernel_instances_space_id_key" ON "kernel_instances"("space_id");

ALTER TABLE "auth_sessions"
    ADD CONSTRAINT "auth_sessions_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "organization_memberships"
    ADD CONSTRAINT "organization_memberships_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "organization_memberships"
    ADD CONSTRAINT "organization_memberships_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "spaces"
    ADD CONSTRAINT "spaces_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "space_memberships"
    ADD CONSTRAINT "space_memberships_space_id_organization_id_fkey"
    FOREIGN KEY ("space_id", "organization_id")
    REFERENCES "spaces"("id", "organization_id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "space_memberships"
    ADD CONSTRAINT "space_memberships_organization_id_user_id_fkey"
    FOREIGN KEY ("organization_id", "user_id")
    REFERENCES "organization_memberships"("organization_id", "user_id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "kernel_instances"
    ADD CONSTRAINT "kernel_instances_space_id_fkey"
    FOREIGN KEY ("space_id") REFERENCES "spaces"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
