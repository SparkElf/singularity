export const organizationRoles = ["owner", "admin", "member"] as const;
export type OrganizationRole = (typeof organizationRoles)[number];

export const spaceRoles = ["admin", "editor", "viewer"] as const;
export type SpaceRole = (typeof spaceRoles)[number];

export {
  type KernelAction,
  kernelActions,
  type KernelAuditMode,
  kernelAuditModes,
  type KernelContentMode,
  kernelContentModes,
  type KernelIdentityRequirement,
  KERNEL_BACKUP_MAXIMUM_BYTES_HEADER,
  KERNEL_BACKUP_MAXIMUM_FILES_HEADER,
  type KernelRoutePolicy,
  kernelRoutePolicies,
  spaceRoleAllowsKernelAction,
} from "./kernel-routes.js";
