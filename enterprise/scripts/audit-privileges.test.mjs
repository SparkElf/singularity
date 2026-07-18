import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, test } from "node:test";

const sqlPath = fileURLToPath(
  new URL("../packages/database/deploy/audit-privileges.sql", import.meta.url),
);
const runbookPath = fileURLToPath(
  new URL("../../docs/runbooks/singularity-audit-database-privileges.md", import.meta.url),
);

const sql = readFileSync(sqlPath, "utf8");
const compactSql = sql.replace(/\s+/g, " ");
const sqlCode = sql.replace(/^\s*--.*$/gm, "");
const runbook = readFileSync(runbookPath, "utf8");

describe("ADR-017 audit privilege deployment artifacts", () => {
  test("requires explicit deployment identifiers without provisioning credentials", () => {
    assert.match(sql, /\\if :\{\?singularity_schema\}/);
    assert.match(sql, /\\if :\{\?audit_writer_role\}/);
    assert.match(sql, /\\if :\{\?audit_reader_role\}/);
    assert.doesNotMatch(sqlCode, /\bCREATE\s+(ROLE|USER)\b/i);
    assert.doesNotMatch(sqlCode, /\bALTER\s+ROLE\b/i);
    assert.doesNotMatch(sqlCode, /\bPASSWORD\b/i);
    assert.doesNotMatch(sqlCode, /postgres(?:ql)?:\/\/[^\s]*:[^\s@]+@/i);
  });

  test("declares append, sequence, and query capabilities separately", () => {
    assert.ok(
      compactSql.includes(
        'GRANT INSERT ON TABLE :"singularity_schema"."audit_events" TO :"audit_writer_role";',
      ),
    );
    assert.ok(
      compactSql.includes(
        'GRANT SELECT, INSERT, UPDATE ON TABLE :"singularity_schema"."organization_audit_sequences" TO :"audit_writer_role";',
      ),
    );
    assert.ok(
      compactSql.includes(
        'GRANT SELECT ON TABLE :"singularity_schema"."audit_events" TO :"audit_reader_role";',
      ),
    );
  });

  test("revokes event mutation and keeps both immutable triggers active", () => {
    assert.ok(
      compactSql.includes(
        'REVOKE ALL PRIVILEGES ON TABLE :"singularity_schema"."audit_events" FROM PUBLIC, :"audit_writer_role", :"audit_reader_role";',
      ),
    );
    assert.match(
      compactSql,
      /ENABLE ALWAYS TRIGGER "audit_events_chain_insert_trigger"/,
    );
    assert.match(
      compactSql,
      /ENABLE ALWAYS TRIGGER "audit_events_immutable_trigger"/,
    );
    assert.match(compactSql, /has_table_privilege\(/);
  });

  test("runbook documents pre-created roles, atomic application, and sequence updates", () => {
    assert.match(runbook, /does not create roles/i);
    assert.match(runbook, /pre-created/i);
    assert.match(runbook, /--single-transaction/);
    assert.match(runbook, /organization_audit_sequences/);
    assert.match(runbook, /DATABASE_URL/);
    assert.doesNotMatch(runbook, /postgres(?:ql)?:\/\/[^\s]*:[^\s@]+@/i);
  });
});
