export function organizationSettingsPath(
  organizationId: string,
  section: "audit" | "groups" | "members" | "oidc" | "spaces" = "members",
): string {
  return `/organizations/${encodeURIComponent(organizationId)}/settings/${section}`;
}

export function spaceSettingsPath(
  organizationId: string,
  spaceId: string,
  section:
    | "access"
    | "audit"
    | "backups"
    | "observability"
    | "shares" = "access",
): string {
  return `/organizations/${encodeURIComponent(organizationId)}/settings/spaces/${encodeURIComponent(spaceId)}/${section}`;
}
