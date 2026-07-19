import type {
  ManagedSpaceAccess,
  OrganizationManagementAccess,
  OrganizationManagementCapability,
  SpaceManagementCapability,
} from "@singularity/contracts";

type OrganizationSettingsSection =
  | "audit"
  | "groups"
  | "members"
  | "oidc"
  | "spaces";
type SpaceSettingsSection = SpaceManagementCapability;

const organizationManagementRoutePriority = [
  { capability: "members", section: "members" },
  { capability: "ownership", section: "members" },
  { capability: "groups", section: "groups" },
  { capability: "spaces", section: "spaces" },
  { capability: "oidc", section: "oidc" },
  { capability: "audit", section: "audit" },
] as const satisfies readonly {
  capability: OrganizationManagementCapability;
  section: OrganizationSettingsSection;
}[];

const spaceManagementRoutePriority = [
  "access",
  "shares",
  "audit",
  "backups",
  "observability",
] as const satisfies readonly SpaceManagementCapability[];

export function organizationSettingsPath(
  organizationId: string,
  section: OrganizationSettingsSection = "members",
): string {
  return `/organizations/${encodeURIComponent(organizationId)}/settings/${section}`;
}

export function spaceSettingsPath(
  organizationId: string,
  spaceId: string,
  section: SpaceSettingsSection = "access",
): string {
  return `/organizations/${encodeURIComponent(organizationId)}/settings/spaces/${encodeURIComponent(spaceId)}/${section}`;
}

export function organizationManagementSectionIsAccessible(
  capabilities: readonly OrganizationManagementCapability[],
  section: string,
): boolean {
  return organizationManagementRoutePriority.some(
    (candidate) =>
      candidate.section === section && capabilities.includes(candidate.capability),
  );
}

export function spaceManagementSectionIsAccessible(
  capabilities: readonly SpaceManagementCapability[],
  section: string,
): boolean {
  return spaceManagementRoutePriority.some(
    (capability) => capability === section && capabilities.includes(capability),
  );
}

export function spaceManagementPath(
  organizationId: string,
  access: ManagedSpaceAccess,
): string | null {
  const capability = spaceManagementRoutePriority.find((candidate) =>
    access.capabilities.includes(candidate),
  );
  return capability === undefined
    ? null
    : spaceSettingsPath(organizationId, access.spaceId, capability);
}

export function enterpriseManagementPath(
  access: OrganizationManagementAccess,
): string | null {
  const organizationRoute = organizationManagementRoutePriority.find((candidate) =>
    access.organizationCapabilities.includes(candidate.capability),
  );
  if (organizationRoute !== undefined) {
    return organizationSettingsPath(access.organizationId, organizationRoute.section);
  }

  for (const space of access.spaces) {
    const path = spaceManagementPath(access.organizationId, space);
    if (path !== null) {
      return path;
    }
  }
  return null;
}
