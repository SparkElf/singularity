DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM (
            SELECT 1 FROM "users"
            UNION ALL SELECT 1 FROM "auth_sessions"
            UNION ALL SELECT 1 FROM "organizations"
            UNION ALL SELECT 1 FROM "organization_memberships"
            UNION ALL SELECT 1 FROM "spaces"
            UNION ALL SELECT 1 FROM "space_memberships"
            UNION ALL SELECT 1 FROM "kernel_instances"
        ) AS "s0_domain_rows"
    ) THEN
        RAISE EXCEPTION USING
            ERRCODE = 'P0001',
            MESSAGE = 'SINGULARITY_S1_REQUIRES_EMPTY_S0_DOMAIN_TABLES';
    END IF;
END $$;

CREATE TABLE "system_installations" (
    "id" INTEGER NOT NULL,
    "initialized_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "system_installations_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "system_installations_singleton_check" CHECK ("id" = 1)
);

ALTER TABLE "kernel_instances"
    ALTER COLUMN "deployment_handle" DROP NOT NULL,
    ALTER COLUMN "version" DROP NOT NULL;

ALTER TABLE "kernel_instances"
    ADD CONSTRAINT "kernel_instances_state_deployment_check"
    CHECK (
        (
            "status" = 'starting'
            AND "deployment_handle" IS NULL
            AND "version" IS NULL
        )
        OR
        (
            "status" IN ('ready', 'unavailable')
            AND "deployment_handle" IS NOT NULL
            AND "deployment_handle" ~ '[^[:space:]]'
            AND "version" IS NOT NULL
            AND "version" ~ '[^[:space:]]'
        )
    );
