import type {
  ContentDirectoryChildDocumentsPathParameters,
  ContentDirectoryNotebooksPathParameters,
  ContentDirectoryRootDocumentsPathParameters,
} from "./content-directory.js";
import type { SpaceRuntimePathParameters } from "./spaces.js";

export const DATABASE_READINESS_PATH = "/api/v1/health/database";
export const OPENAPI_DOCUMENT_PATH = "/api/openapi.json";

export const AUTH_LOGIN_PATH = "/api/v1/auth/login";
export const AUTH_CSRF_PATH = "/api/v1/auth/csrf";
export const AUTH_LOGOUT_PATH = "/api/v1/auth/logout";
export const AUTH_INVITATION_ACCEPT_PATH = "/api/v1/auth/invitations/accept";
export const AUTH_INVITATION_ACCEPT_LOCAL_PATH =
  "/api/v1/auth/invitations/accept-local";
export const AUTH_OIDC_PROVIDERS_PATH = "/api/v1/auth/oidc/providers";
export const AUTH_OIDC_START_PATH = "/api/v1/auth/oidc/start";
export const AUTH_OIDC_CALLBACK_PATH = "/api/v1/auth/oidc/callback";
export const AUTHORIZED_SPACES_PATH = "/api/v1/spaces";
export const ENTERPRISE_MANAGEMENT_ACCESS_PATH =
  "/api/v1/enterprise-management-access";

export const ORGANIZATION_MEMBERS_PATH_TEMPLATE =
  "/api/v1/organizations/{organizationId}/members";
export const ORGANIZATION_MEMBER_PATH_TEMPLATE =
  "/api/v1/organizations/{organizationId}/members/{userId}";
export const ORGANIZATION_MEMBER_SESSIONS_PATH_TEMPLATE =
  "/api/v1/organizations/{organizationId}/members/{userId}/sessions";
export const ORGANIZATION_OWNERSHIP_PATH_TEMPLATE =
  "/api/v1/organizations/{organizationId}/ownership";
export const ORGANIZATION_INVITATIONS_PATH_TEMPLATE =
  "/api/v1/organizations/{organizationId}/invitations";
export const ORGANIZATION_INVITATION_PATH_TEMPLATE =
  "/api/v1/organizations/{organizationId}/invitations/{invitationId}";
export const ORGANIZATION_GROUPS_PATH_TEMPLATE =
  "/api/v1/organizations/{organizationId}/groups";
export const ORGANIZATION_GROUP_PATH_TEMPLATE =
  "/api/v1/organizations/{organizationId}/groups/{groupId}";
export const ORGANIZATION_GROUP_MEMBERS_PATH_TEMPLATE =
  "/api/v1/organizations/{organizationId}/groups/{groupId}/members";
export const ORGANIZATION_GROUP_MEMBER_PATH_TEMPLATE =
  "/api/v1/organizations/{organizationId}/groups/{groupId}/members/{userId}";
export const ORGANIZATION_SPACES_PATH_TEMPLATE =
  "/api/v1/organizations/{organizationId}/spaces";
export const ORGANIZATION_SPACE_PATH_TEMPLATE =
  "/api/v1/organizations/{organizationId}/spaces/{spaceId}";
export const ORGANIZATION_SPACE_MEMBERS_PATH_TEMPLATE =
  "/api/v1/organizations/{organizationId}/spaces/{spaceId}/members";
export const ORGANIZATION_SPACE_MEMBER_CANDIDATES_PATH_TEMPLATE =
  "/api/v1/organizations/{organizationId}/spaces/{spaceId}/member-candidates";
export const ORGANIZATION_SPACE_GROUP_CANDIDATES_PATH_TEMPLATE =
  "/api/v1/organizations/{organizationId}/spaces/{spaceId}/group-candidates";
export const ORGANIZATION_SPACE_MEMBER_PATH_TEMPLATE =
  "/api/v1/organizations/{organizationId}/spaces/{spaceId}/members/{userId}";
export const ORGANIZATION_SPACE_GROUPS_PATH_TEMPLATE =
  "/api/v1/organizations/{organizationId}/spaces/{spaceId}/groups";
export const ORGANIZATION_SPACE_GROUP_PATH_TEMPLATE =
  "/api/v1/organizations/{organizationId}/spaces/{spaceId}/groups/{groupId}";
export const ORGANIZATION_OIDC_PROVIDERS_PATH_TEMPLATE =
  "/api/v1/organizations/{organizationId}/oidc-providers";
export const ORGANIZATION_OIDC_PROVIDER_PATH_TEMPLATE =
  "/api/v1/organizations/{organizationId}/oidc-providers/{providerId}";
export const ORGANIZATION_AUDIT_EVENTS_PATH_TEMPLATE =
  "/api/v1/organizations/{organizationId}/audit-events";
export const ORGANIZATION_SPACE_AUDIT_EVENTS_PATH_TEMPLATE =
  "/api/v1/organizations/{organizationId}/spaces/{spaceId}/audit-events";
export const ORGANIZATION_SPACE_SHARES_PATH_TEMPLATE =
  "/api/v1/organizations/{organizationId}/spaces/{spaceId}/shares";
export const ORGANIZATION_SPACE_SHARE_PATH_TEMPLATE =
  "/api/v1/organizations/{organizationId}/spaces/{spaceId}/shares/{shareId}";
export const ORGANIZATION_SPACE_SHARE_PASSWORD_PATH_TEMPLATE =
  "/api/v1/organizations/{organizationId}/spaces/{spaceId}/shares/{shareId}/password";
export const ORGANIZATION_SPACE_BACKUPS_PATH_TEMPLATE =
  "/api/v1/organizations/{organizationId}/spaces/{spaceId}/backups";
export const ORGANIZATION_SPACE_BACKUP_RESTORES_PATH_TEMPLATE =
  "/api/v1/organizations/{organizationId}/spaces/{spaceId}/backups/{backupId}/restores";
export const ORGANIZATION_SPACE_RESTORES_PATH_TEMPLATE =
  "/api/v1/organizations/{organizationId}/spaces/{spaceId}/restores";
export const ORGANIZATION_SPACE_RESTORE_PATH_TEMPLATE =
  "/api/v1/organizations/{organizationId}/spaces/{spaceId}/restores/{restoreId}";
export const ORGANIZATION_SPACE_RESTORE_ACTIVATION_PATH_TEMPLATE =
  "/api/v1/organizations/{organizationId}/spaces/{spaceId}/restores/{restoreId}/activation";
export const ORGANIZATION_SPACE_OBSERVABILITY_PATH_TEMPLATE =
  "/api/v1/organizations/{organizationId}/spaces/{spaceId}/observability";
export const PUBLIC_SHARE_PATH_TEMPLATE = "/api/v1/shares/{shareToken}";
export const PUBLIC_SHARE_CHALLENGE_PATH_TEMPLATE =
  "/api/v1/shares/{shareToken}/challenge";
export const PUBLIC_SHARE_ASSET_PATH_TEMPLATE =
  "/api/v1/shares/{shareToken}/assets/{assetId}";

export const SPACE_RUNTIME_PATH_TEMPLATE =
  "/api/v1/organizations/{organizationId}/spaces/{spaceId}/runtime";
export const CONTENT_DIRECTORY_NOTEBOOKS_PATH_TEMPLATE =
  "/api/v1/organizations/{organizationId}/spaces/{spaceId}/content-directory/notebooks";
export const CONTENT_DIRECTORY_ROOT_DOCUMENTS_PATH_TEMPLATE =
  "/api/v1/organizations/{organizationId}/spaces/{spaceId}/content-directory/notebooks/{notebookId}/documents";
export const CONTENT_DIRECTORY_CHILD_DOCUMENTS_PATH_TEMPLATE =
  "/api/v1/organizations/{organizationId}/spaces/{spaceId}/content-directory/notebooks/{notebookId}/documents/{documentId}/children";

function toControllerPath(template: string): string {
  return template.replace(/\{([^}]+)\}/g, ":$1");
}

export const SPACE_RUNTIME_CONTROLLER_PATH = toControllerPath(
  SPACE_RUNTIME_PATH_TEMPLATE,
);
export const CONTENT_DIRECTORY_NOTEBOOKS_CONTROLLER_PATH = toControllerPath(
  CONTENT_DIRECTORY_NOTEBOOKS_PATH_TEMPLATE,
);
export const CONTENT_DIRECTORY_ROOT_DOCUMENTS_CONTROLLER_PATH =
  toControllerPath(CONTENT_DIRECTORY_ROOT_DOCUMENTS_PATH_TEMPLATE);
export const CONTENT_DIRECTORY_CHILD_DOCUMENTS_CONTROLLER_PATH =
  toControllerPath(CONTENT_DIRECTORY_CHILD_DOCUMENTS_PATH_TEMPLATE);
export const ORGANIZATION_MEMBERS_CONTROLLER_PATH = toControllerPath(
  ORGANIZATION_MEMBERS_PATH_TEMPLATE,
);
export const ORGANIZATION_MEMBER_CONTROLLER_PATH = toControllerPath(
  ORGANIZATION_MEMBER_PATH_TEMPLATE,
);
export const ORGANIZATION_MEMBER_SESSIONS_CONTROLLER_PATH = toControllerPath(
  ORGANIZATION_MEMBER_SESSIONS_PATH_TEMPLATE,
);
export const ORGANIZATION_OWNERSHIP_CONTROLLER_PATH = toControllerPath(
  ORGANIZATION_OWNERSHIP_PATH_TEMPLATE,
);
export const ORGANIZATION_INVITATIONS_CONTROLLER_PATH = toControllerPath(
  ORGANIZATION_INVITATIONS_PATH_TEMPLATE,
);
export const ORGANIZATION_INVITATION_CONTROLLER_PATH = toControllerPath(
  ORGANIZATION_INVITATION_PATH_TEMPLATE,
);
export const ORGANIZATION_GROUPS_CONTROLLER_PATH = toControllerPath(
  ORGANIZATION_GROUPS_PATH_TEMPLATE,
);
export const ORGANIZATION_GROUP_CONTROLLER_PATH = toControllerPath(
  ORGANIZATION_GROUP_PATH_TEMPLATE,
);
export const ORGANIZATION_GROUP_MEMBERS_CONTROLLER_PATH = toControllerPath(
  ORGANIZATION_GROUP_MEMBERS_PATH_TEMPLATE,
);
export const ORGANIZATION_GROUP_MEMBER_CONTROLLER_PATH = toControllerPath(
  ORGANIZATION_GROUP_MEMBER_PATH_TEMPLATE,
);
export const ORGANIZATION_SPACES_CONTROLLER_PATH = toControllerPath(
  ORGANIZATION_SPACES_PATH_TEMPLATE,
);
export const ORGANIZATION_SPACE_CONTROLLER_PATH = toControllerPath(
  ORGANIZATION_SPACE_PATH_TEMPLATE,
);
export const ORGANIZATION_SPACE_MEMBERS_CONTROLLER_PATH = toControllerPath(
  ORGANIZATION_SPACE_MEMBERS_PATH_TEMPLATE,
);
export const ORGANIZATION_SPACE_MEMBER_CANDIDATES_CONTROLLER_PATH =
  toControllerPath(ORGANIZATION_SPACE_MEMBER_CANDIDATES_PATH_TEMPLATE);
export const ORGANIZATION_SPACE_GROUP_CANDIDATES_CONTROLLER_PATH =
  toControllerPath(ORGANIZATION_SPACE_GROUP_CANDIDATES_PATH_TEMPLATE);
export const ORGANIZATION_SPACE_MEMBER_CONTROLLER_PATH = toControllerPath(
  ORGANIZATION_SPACE_MEMBER_PATH_TEMPLATE,
);
export const ORGANIZATION_SPACE_GROUPS_CONTROLLER_PATH = toControllerPath(
  ORGANIZATION_SPACE_GROUPS_PATH_TEMPLATE,
);
export const ORGANIZATION_SPACE_GROUP_CONTROLLER_PATH = toControllerPath(
  ORGANIZATION_SPACE_GROUP_PATH_TEMPLATE,
);
export const ORGANIZATION_OIDC_PROVIDERS_CONTROLLER_PATH = toControllerPath(
  ORGANIZATION_OIDC_PROVIDERS_PATH_TEMPLATE,
);
export const ORGANIZATION_OIDC_PROVIDER_CONTROLLER_PATH = toControllerPath(
  ORGANIZATION_OIDC_PROVIDER_PATH_TEMPLATE,
);
export const ORGANIZATION_AUDIT_EVENTS_CONTROLLER_PATH = toControllerPath(
  ORGANIZATION_AUDIT_EVENTS_PATH_TEMPLATE,
);
export const ORGANIZATION_SPACE_AUDIT_EVENTS_CONTROLLER_PATH =
  toControllerPath(ORGANIZATION_SPACE_AUDIT_EVENTS_PATH_TEMPLATE);
export const ORGANIZATION_SPACE_SHARES_CONTROLLER_PATH = toControllerPath(
  ORGANIZATION_SPACE_SHARES_PATH_TEMPLATE,
);
export const ORGANIZATION_SPACE_SHARE_CONTROLLER_PATH = toControllerPath(
  ORGANIZATION_SPACE_SHARE_PATH_TEMPLATE,
);
export const ORGANIZATION_SPACE_SHARE_PASSWORD_CONTROLLER_PATH =
  toControllerPath(ORGANIZATION_SPACE_SHARE_PASSWORD_PATH_TEMPLATE);
export const ORGANIZATION_SPACE_BACKUPS_CONTROLLER_PATH = toControllerPath(
  ORGANIZATION_SPACE_BACKUPS_PATH_TEMPLATE,
);
export const ORGANIZATION_SPACE_BACKUP_RESTORES_CONTROLLER_PATH =
  toControllerPath(ORGANIZATION_SPACE_BACKUP_RESTORES_PATH_TEMPLATE);
export const ORGANIZATION_SPACE_RESTORES_CONTROLLER_PATH = toControllerPath(
  ORGANIZATION_SPACE_RESTORES_PATH_TEMPLATE,
);
export const ORGANIZATION_SPACE_RESTORE_CONTROLLER_PATH = toControllerPath(
  ORGANIZATION_SPACE_RESTORE_PATH_TEMPLATE,
);
export const ORGANIZATION_SPACE_RESTORE_ACTIVATION_CONTROLLER_PATH =
  toControllerPath(ORGANIZATION_SPACE_RESTORE_ACTIVATION_PATH_TEMPLATE);
export const ORGANIZATION_SPACE_OBSERVABILITY_CONTROLLER_PATH =
  toControllerPath(ORGANIZATION_SPACE_OBSERVABILITY_PATH_TEMPLATE);
export const PUBLIC_SHARE_CONTROLLER_PATH = toControllerPath(
  PUBLIC_SHARE_PATH_TEMPLATE,
);
export const PUBLIC_SHARE_CHALLENGE_CONTROLLER_PATH = toControllerPath(
  PUBLIC_SHARE_CHALLENGE_PATH_TEMPLATE,
);
export const PUBLIC_SHARE_ASSET_CONTROLLER_PATH = toControllerPath(
  PUBLIC_SHARE_ASSET_PATH_TEMPLATE,
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

function buildContentDirectoryPath(
  template: string,
  parameters: ContentDirectoryNotebooksPathParameters,
): string {
  return template
    .replace(
      "{organizationId}",
      encodeURIComponent(parameters.organizationId),
    )
    .replace("{spaceId}", encodeURIComponent(parameters.spaceId));
}

export function buildContentDirectoryNotebooksPath(
  parameters: ContentDirectoryNotebooksPathParameters,
): string {
  return buildContentDirectoryPath(
    CONTENT_DIRECTORY_NOTEBOOKS_PATH_TEMPLATE,
    parameters,
  );
}

export function buildContentDirectoryRootDocumentsPath(
  parameters: ContentDirectoryRootDocumentsPathParameters,
): string {
  const path = buildContentDirectoryPath(
    CONTENT_DIRECTORY_ROOT_DOCUMENTS_PATH_TEMPLATE,
    parameters,
  ).replace("{notebookId}", encodeURIComponent(parameters.notebookId));
  return `${path}?${new URLSearchParams({ offset: String(parameters.offset) })}`;
}

export function buildContentDirectoryChildDocumentsPath(
  parameters: ContentDirectoryChildDocumentsPathParameters,
): string {
  const path = buildContentDirectoryPath(
    CONTENT_DIRECTORY_CHILD_DOCUMENTS_PATH_TEMPLATE,
    parameters,
  )
    .replace("{notebookId}", encodeURIComponent(parameters.notebookId))
    .replace("{documentId}", encodeURIComponent(parameters.documentId));
  return `${path}?${new URLSearchParams({ offset: String(parameters.offset) })}`;
}
