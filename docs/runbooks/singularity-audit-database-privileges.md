---
title: "Singularity ADR-017 audit database privileges"
description: "Deploy and verify the append-only PostgreSQL ACL for audit events"
author: "Codex"
date: "2026-07-18"
version: "1.0.0"
status: "approved"
tags: ["security", "postgresql", "audit", "permissions"]
---

# ADR-017 audit database privileges

This runbook applies the database ACL required by [ADR-017](../adr/0017-l1-share-audit-backup.md).
It is deliberately separate from the Prisma migrations: migrations own tables and
constraints, while the deployment operator owns production role provisioning and
privilege grants.

## Contract

| Capability | Required role privilege |
| --- | --- |
| Append an audit event | `INSERT` on `audit_events` |
| Advance an organization chain | `SELECT`, `INSERT`, and `UPDATE` on `organization_audit_sequences` |
| Query audit events | `SELECT` on `audit_events` |
| Mutate audit events | No `UPDATE`, `DELETE`, `TRUNCATE`, `REFERENCES`, or `TRIGGER` privilege for either application role |

The append role is the only role used by the audit writer. The query role is a
separate role used by API/worker readers. A login role may inherit both capability
roles when one process must append and query, but the login role itself must not be
the table owner, a superuser, or a `BYPASSRLS` role. Audit-event mutation is also
blocked by the migration's immutable trigger, which this script enables as an
`ALWAYS` trigger.

The worker's archive handler may need separate privileges on `audit_archives` and
`worker_jobs`; those are outside this file and must not be inferred by broadening
the audit-event writer role.

The script does not create roles, assign passwords, change role memberships, or
grant privileges to an unspecified login. Provision the two roles and any login
membership through the organization's database/secret-management process first.

## Preconditions

1. The target PostgreSQL database is reachable through `DATABASE_URL` (or an
   equivalent operator-controlled connection string). Do not put a password in
   this repository or in the command line history.
2. The L1 migration
   `enterprise/packages/database/prisma/migrations/20260718000000_l1_enterprise_control_plane/migration.sql`
   is already applied in the target schema.
3. The operator is the migration/table owner or an administrator allowed to run
   `ALTER TABLE`, `ALTER FUNCTION`, `GRANT`, and `REVOKE`.
4. `audit_writer_role` and `audit_reader_role` are pre-created, distinct,
   non-superuser, non-`BYPASSRLS` roles. They must not own the audit tables or
   inherit an elevated owner role. This file intentionally fails closed when
   those conditions are not met.

## Apply

Run from the repository root. Supply every psql identifier explicitly; the SQL
file has no role-name or credential defaults.

```sh
psql \
  --no-psqlrc \
  --set=ON_ERROR_STOP=1 \
  --single-transaction \
  --set=singularity_schema="$SINGULARITY_DB_SCHEMA" \
  --set=audit_writer_role="$SINGULARITY_AUDIT_WRITER_ROLE" \
  --set=audit_reader_role="$SINGULARITY_AUDIT_READER_ROLE" \
  "$DATABASE_URL" \
  --file enterprise/packages/database/deploy/audit-privileges.sql
```

`SINGULARITY_DB_SCHEMA`, `SINGULARITY_AUDIT_WRITER_ROLE`, and
`SINGULARITY_AUDIT_READER_ROLE` are operator-owned environment variables. The
usual production schema is supplied by deployment configuration; this runbook
does not assume or embed a schema name. `--single-transaction` prevents a
partially applied ACL if a precondition or effective-privilege assertion fails.

The script is safe to rerun with the same role names. If a role is replaced, run
the script once with the old role (or issue an explicitly reviewed revoke) before
removing it; changing the variables alone cannot revoke privileges previously
granted to a different role.

## Verify

The script performs effective privilege assertions before it exits successfully.
The expected result is:

- writer: `INSERT` on `audit_events`; `SELECT`/`INSERT`/`UPDATE` on
  `organization_audit_sequences`; no event `UPDATE` or `DELETE`;
- reader: `SELECT` on `audit_events`; no event `INSERT`, `UPDATE`, or `DELETE`;
- both roles: no direct table mutation privilege beyond the append contract;
- `audit_events_chain_insert_trigger` and `audit_events_immutable_trigger` are
  present and enabled `ALWAYS`.

For an independent operator check, use the same three psql variables and query
the catalog without changing data:

```sql
SELECT grantee, table_name, privilege_type
FROM information_schema.role_table_grants
WHERE table_schema = :'singularity_schema'
  AND table_name IN ('audit_events', 'organization_audit_sequences')
  AND grantee IN (:'audit_writer_role', :'audit_reader_role')
ORDER BY grantee, table_name, privilege_type;
```

`organization_audit_sequences` access is intentional. The audit append transaction
creates the organization row when needed, locks it with `SELECT ... FOR UPDATE`,
inserts the next event, and advances `last_sequence`/`last_mac` in one transaction.
Removing the writer's sequence `SELECT` or `UPDATE` privilege breaks the chain
write even though `audit_events` still accepts `INSERT`.

## Ownership and escalation boundary

PostgreSQL owners and superusers can bypass ordinary ACLs. The deployment script
rejects those roles as the supplied writer/reader and verifies effective
privileges, but it cannot govern an unrelated inherited administrator role. Keep
the migration owner and production login roles separate, review role memberships,
and do not run the application as a superuser.

The immutable trigger is defense in depth, not a replacement for ACL review. A
database administrator who intentionally disables triggers or changes table
ownership is outside this application contract and must be handled by the
organization's database audit process.
