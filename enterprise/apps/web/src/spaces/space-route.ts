import type { SpaceRuntimePathParameters } from "@singularity/contracts";

export function spacePagePath({
  organizationId,
  spaceId,
}: SpaceRuntimePathParameters): string {
  return `/organizations/${encodeURIComponent(organizationId)}/spaces/${encodeURIComponent(spaceId)}`;
}
