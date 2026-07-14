import type { SpaceRuntimePathParameters } from "@singularity/contracts";

export const EXPLICIT_SPACE_LIST_STATE = "explicit-space-list";

export function spacePagePath({
  organizationId,
  spaceId,
}: SpaceRuntimePathParameters): string {
  return `/organizations/${encodeURIComponent(organizationId)}/spaces/${encodeURIComponent(spaceId)}`;
}
