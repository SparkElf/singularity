import type { DatabaseClient } from "@singularity/database";

const TEST_TABLES = `
  "audit_events",
  "audit_archives",
  "organization_audit_sequences",
  "share_challenges",
  "document_shares",
  "space_capacity_observations",
  "kernel_health_observations",
  "space_restore_jobs",
  "kernel_runtime_endpoints",
  "space_backups",
  "worker_jobs",
  "kernel_instances",
  "space_memberships",
  "oidc_authorization_attempts",
  "oidc_identities",
  "oidc_providers",
  "space_group_grants",
  "user_group_memberships",
  "user_groups",
  "organization_invitations",
  "spaces",
  "organization_memberships",
  "auth_sessions",
  "organizations",
  "users",
  "system_installations"
`;

export async function truncateTestDatabase(
  database: DatabaseClient,
): Promise<void> {
  await database.$executeRawUnsafe(
    `TRUNCATE TABLE ${TEST_TABLES} RESTART IDENTITY CASCADE`,
  );
}
