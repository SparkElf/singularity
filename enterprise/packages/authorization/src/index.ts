export const organizationRoles = ["owner", "admin", "member"] as const;
export type OrganizationRole = (typeof organizationRoles)[number];

export const spaceRoles = ["admin", "editor", "viewer"] as const;
export type SpaceRole = (typeof spaceRoles)[number];
