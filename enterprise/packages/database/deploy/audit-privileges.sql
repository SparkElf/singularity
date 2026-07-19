-- ADR-017/027 audit event and delivery-state privilege boundary.
--
-- This is a deployment-time ACL script, not a Prisma migration.  The caller
-- must provide all identifiers explicitly with psql -v/--set.  No role,
-- login or account is created here.

\set ON_ERROR_STOP on

\if :{?singularity_schema}
\else
  \error 'singularity_schema is required (the migrated PostgreSQL schema)'
\endif
\if :{?audit_writer_role}
\else
  \error 'audit_writer_role is required (a pre-created non-owner role)'
\endif
\if :{?audit_reader_role}
\else
  \error 'audit_reader_role is required (a pre-created non-owner role)'
\endif

SELECT EXISTS (
    SELECT 1
    FROM pg_namespace
    WHERE nspname = :'singularity_schema'
      AND nspname NOT IN ('pg_catalog', 'information_schema')
) AS singularity_schema_exists;
\gset
\if :singularity_schema_exists
\else
  \error 'singularity_schema does not name an application schema'
\endif

SELECT EXISTS (
    SELECT 1
    FROM pg_roles
    WHERE rolname = :'audit_writer_role'
) AS audit_writer_exists;
\gset
\if :audit_writer_exists
\else
  \error 'audit_writer_role does not exist; provision roles before running this file'
\endif

SELECT EXISTS (
    SELECT 1
    FROM pg_roles
    WHERE rolname = :'audit_reader_role'
) AS audit_reader_exists;
\gset
\if :audit_reader_exists
\else
  \error 'audit_reader_role does not exist; provision roles before running this file'
\endif

SELECT :'audit_writer_role' <> :'audit_reader_role' AS audit_roles_are_distinct;
\gset
\if :audit_roles_are_distinct
\else
  \error 'audit_writer_role and audit_reader_role must be distinct roles'
\endif

SELECT
    NOT EXISTS (
        SELECT 1
        FROM pg_roles
        WHERE rolname IN (:'audit_writer_role', :'audit_reader_role')
          AND (rolsuper OR rolbypassrls)
    ) AS audit_roles_are_restricted;
\gset
\if :audit_roles_are_restricted
\else
  \error 'audit roles must not be superusers or BYPASSRLS roles'
\endif

SELECT
    NOT EXISTS (
        SELECT 1
        FROM pg_class AS relation
        JOIN pg_namespace AS namespace
          ON namespace.oid = relation.relnamespace
        WHERE namespace.nspname = :'singularity_schema'
          AND relation.relname IN (
              'audit_events',
              'content_audit_intents',
              'organization_audit_sequences'
          )
          AND pg_get_userbyid(relation.relowner) IN (
              :'audit_writer_role', :'audit_reader_role'
          )
    ) AS audit_roles_are_not_table_owners;
\gset
\if :audit_roles_are_not_table_owners
\else
  \error 'audit roles must not own audit tables; use a separate migration owner'
\endif

SELECT
    to_regclass(format('%I.%I', :'singularity_schema', 'audit_events')) IS NOT NULL
        AS audit_events_exists,
    to_regclass(
        format('%I.%I', :'singularity_schema', 'organization_audit_sequences')
    ) IS NOT NULL AS audit_sequences_exists,
    to_regclass(
        format('%I.%I', :'singularity_schema', 'content_audit_intents')
    ) IS NOT NULL AS content_audit_intents_exists;
\gset
\if :audit_events_exists
\else
  \error 'audit_events is missing; apply the L1 Prisma migration first'
\endif
\if :audit_sequences_exists
\else
  \error 'organization_audit_sequences is missing; apply the L1 Prisma migration first'
\endif
\if :content_audit_intents_exists
\else
  \error 'content_audit_intents is missing; apply the ADR-027 Prisma migration first'
\endif

SELECT
    EXISTS (
        SELECT 1
        FROM pg_trigger AS trigger_row
        JOIN pg_class AS relation
          ON relation.oid = trigger_row.tgrelid
        JOIN pg_namespace AS namespace
          ON namespace.oid = relation.relnamespace
        WHERE namespace.nspname = :'singularity_schema'
          AND relation.relname = 'audit_events'
          AND trigger_row.tgname = 'audit_events_chain_insert_trigger'
          AND NOT trigger_row.tgisinternal
    ) AS audit_chain_trigger_exists,
    EXISTS (
        SELECT 1
        FROM pg_trigger AS trigger_row
        JOIN pg_class AS relation
          ON relation.oid = trigger_row.tgrelid
        JOIN pg_namespace AS namespace
          ON namespace.oid = relation.relnamespace
        WHERE namespace.nspname = :'singularity_schema'
          AND relation.relname = 'audit_events'
          AND trigger_row.tgname = 'audit_events_immutable_trigger'
          AND NOT trigger_row.tgisinternal
    ) AS audit_immutable_trigger_exists;
\gset
\if :audit_chain_trigger_exists
\else
  \error 'audit_events_chain_insert_trigger is missing; refuse incomplete audit protection'
\endif
\if :audit_immutable_trigger_exists
\else
  \error 'audit_events_immutable_trigger is missing; refuse incomplete audit protection'
\endif

-- Trigger functions use an explicit schema so a caller-provided search_path
-- cannot redirect the chain check to another table.
ALTER FUNCTION :"singularity_schema"."enforce_audit_event_chain_insert"()
    SET search_path = :"singularity_schema", pg_catalog;
ALTER FUNCTION :"singularity_schema"."reject_audit_event_mutation"()
    SET search_path = :"singularity_schema", pg_catalog;

-- ENABLE ALWAYS keeps the immutable guard active even for replication-mode
-- sessions.  A superuser can still deliberately disable all protections;
-- application roles are rejected above when they have elevated attributes.
ALTER TABLE :"singularity_schema"."audit_events"
    ENABLE ALWAYS TRIGGER "audit_events_chain_insert_trigger";
ALTER TABLE :"singularity_schema"."audit_events"
    ENABLE ALWAYS TRIGGER "audit_events_immutable_trigger";

-- Remove PUBLIC/direct privileges before granting the two narrow
-- capabilities.  The writer never receives UPDATE or DELETE on audit_events.
REVOKE ALL PRIVILEGES
    ON TABLE :"singularity_schema"."audit_events"
    FROM PUBLIC, :"audit_writer_role", :"audit_reader_role";
REVOKE ALL PRIVILEGES
    ON TABLE :"singularity_schema"."organization_audit_sequences"
    FROM PUBLIC, :"audit_writer_role", :"audit_reader_role";
REVOKE ALL PRIVILEGES
    ON TABLE :"singularity_schema"."content_audit_intents"
    FROM PUBLIC, :"audit_writer_role", :"audit_reader_role";

GRANT USAGE
    ON SCHEMA :"singularity_schema"
    TO :"audit_writer_role", :"audit_reader_role";

-- Append owner: the insert trigger performs SELECT ... FOR UPDATE on the
-- organization row; AuditWriter then advances that row in the same transaction.
GRANT INSERT
    ON TABLE :"singularity_schema"."audit_events"
    TO :"audit_writer_role";
GRANT SELECT, INSERT, UPDATE
    ON TABLE :"singularity_schema"."organization_audit_sequences"
    TO :"audit_writer_role";

-- Query owner: no event mutation or sequence access.
GRANT SELECT
    ON TABLE :"singularity_schema"."audit_events"
    TO :"audit_reader_role";

-- Verify effective privileges, including inherited role privileges.  This
-- fails closed if an operator accidentally supplied an owner/elevated role.
SELECT
    has_table_privilege(
        :'audit_writer_role',
        format('%I.%I', :'singularity_schema', 'audit_events'),
        'INSERT'
    )
    AND NOT has_table_privilege(
        :'audit_writer_role',
        format('%I.%I', :'singularity_schema', 'audit_events'),
        'UPDATE'
    )
    AND NOT has_table_privilege(
        :'audit_writer_role',
        format('%I.%I', :'singularity_schema', 'audit_events'),
        'DELETE'
    )
    AND NOT has_table_privilege(
        :'audit_writer_role',
        format('%I.%I', :'singularity_schema', 'audit_events'),
        'TRUNCATE'
    )
    AND NOT has_table_privilege(
        :'audit_writer_role',
        format('%I.%I', :'singularity_schema', 'audit_events'),
        'REFERENCES'
    )
    AND NOT has_table_privilege(
        :'audit_writer_role',
        format('%I.%I', :'singularity_schema', 'audit_events'),
        'TRIGGER'
    )
    AND has_table_privilege(
        :'audit_writer_role',
        format('%I.%I', :'singularity_schema', 'organization_audit_sequences'),
        'SELECT'
    )
    AND has_table_privilege(
        :'audit_writer_role',
        format('%I.%I', :'singularity_schema', 'organization_audit_sequences'),
        'INSERT'
    )
    AND has_table_privilege(
        :'audit_writer_role',
        format('%I.%I', :'singularity_schema', 'organization_audit_sequences'),
        'UPDATE'
    )
    AND NOT has_table_privilege(
        :'audit_writer_role',
        format('%I.%I', :'singularity_schema', 'organization_audit_sequences'),
        'DELETE'
    )
    AND NOT has_table_privilege(
        :'audit_writer_role',
        format('%I.%I', :'singularity_schema', 'organization_audit_sequences'),
        'TRUNCATE'
    ) AS audit_writer_privileges_valid,
    has_table_privilege(
        :'audit_reader_role',
        format('%I.%I', :'singularity_schema', 'audit_events'),
        'SELECT'
    )
    AND NOT has_table_privilege(
        :'audit_reader_role',
        format('%I.%I', :'singularity_schema', 'audit_events'),
        'INSERT'
    )
    AND NOT has_table_privilege(
        :'audit_reader_role',
        format('%I.%I', :'singularity_schema', 'audit_events'),
        'UPDATE'
    )
    AND NOT has_table_privilege(
        :'audit_reader_role',
        format('%I.%I', :'singularity_schema', 'audit_events'),
        'DELETE'
    )
    AND NOT has_table_privilege(
        :'audit_reader_role',
        format('%I.%I', :'singularity_schema', 'audit_events'),
        'TRUNCATE'
    )
    AND NOT has_table_privilege(
        :'audit_reader_role',
        format('%I.%I', :'singularity_schema', 'audit_events'),
        'REFERENCES'
    )
    AND NOT has_table_privilege(
        :'audit_reader_role',
        format('%I.%I', :'singularity_schema', 'audit_events'),
        'TRIGGER'
    ) AS audit_reader_privileges_valid;
\gset
\if :audit_writer_privileges_valid
\else
  \error 'effective audit writer privileges do not match the append-only contract'
\endif
\if :audit_reader_privileges_valid
\else
  \error 'effective audit reader privileges do not match the query-only contract'
\endif

SELECT
    :'singularity_schema' AS configured_schema,
    :'audit_writer_role' AS audit_writer_role,
    :'audit_reader_role' AS audit_reader_role,
    'append-only ACL applied' AS result;
