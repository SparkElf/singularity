import type { SpaceRuntimePathParameters } from "./spaces.js";

export const DATABASE_READINESS_PATH = "/api/v1/health/database";
export const OPENAPI_DOCUMENT_PATH = "/api/openapi.json";

export const AUTH_LOGIN_PATH = "/api/v1/auth/login";
export const AUTH_CSRF_PATH = "/api/v1/auth/csrf";
export const AUTH_LOGOUT_PATH = "/api/v1/auth/logout";
export const AUTHORIZED_SPACES_PATH = "/api/v1/spaces";

export const SPACE_RUNTIME_PATH_TEMPLATE =
  "/api/v1/organizations/{organizationId}/spaces/{spaceId}/runtime";

export const SPACE_RUNTIME_CONTROLLER_PATH = SPACE_RUNTIME_PATH_TEMPLATE.replace(
  /\{([^}]+)\}/g,
  ":$1",
);

export function buildSpaceRuntimePath({
  organizationId,
  spaceId,
}: SpaceRuntimePathParameters): string {
  return SPACE_RUNTIME_PATH_TEMPLATE.replace(
    "{organizationId}",
    encodeURIComponent(organizationId),
  ).replace("{spaceId}", encodeURIComponent(spaceId));
}
