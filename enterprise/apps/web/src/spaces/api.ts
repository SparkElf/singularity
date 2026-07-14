import {
  AUTHORIZED_SPACES_PATH,
  authorizedSpacesResponseSchema,
  buildSpaceRuntimePath,
  spaceRuntimeBootstrapSchema,
  type AuthorizedSpacesResponse,
  type SpaceRuntimePathParameters,
  type SpaceRuntimeBootstrap,
} from "@singularity/contracts";

import { requestJson } from "@/api/http.ts";

export const authorizedSpacesQueryKey = ["authorized-spaces"] as const;

export function getAuthorizedSpaces(
  signal?: AbortSignal,
): Promise<AuthorizedSpacesResponse> {
  return requestJson(authorizedSpacesResponseSchema, AUTHORIZED_SPACES_PATH, {
    signal: signal ?? null,
  });
}

export function spaceRuntimeQueryKey(identity: SpaceRuntimePathParameters) {
  return ["space-runtime", identity.organizationId, identity.spaceId] as const;
}

export function getSpaceRuntime(
  identity: SpaceRuntimePathParameters,
  signal?: AbortSignal,
): Promise<SpaceRuntimeBootstrap> {
  return requestJson(
    spaceRuntimeBootstrapSchema,
    buildSpaceRuntimePath(identity),
    { signal: signal ?? null },
  );
}
