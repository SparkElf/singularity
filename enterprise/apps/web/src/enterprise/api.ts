import {
  CSRF_HEADER_NAME,
  ORGANIZATION_AUDIT_EVENTS_PATH_TEMPLATE,
  ORGANIZATION_GROUP_MEMBER_PATH_TEMPLATE,
  ORGANIZATION_GROUP_MEMBERS_PATH_TEMPLATE,
  ORGANIZATION_GROUP_PATH_TEMPLATE,
  ORGANIZATION_GROUPS_PATH_TEMPLATE,
  ORGANIZATION_INVITATION_PATH_TEMPLATE,
  ORGANIZATION_INVITATIONS_PATH_TEMPLATE,
  ORGANIZATION_MEMBER_PATH_TEMPLATE,
  ORGANIZATION_MEMBER_SESSIONS_PATH_TEMPLATE,
  ORGANIZATION_MEMBERS_PATH_TEMPLATE,
  ORGANIZATION_OIDC_PROVIDER_PATH_TEMPLATE,
  ORGANIZATION_OIDC_PROVIDERS_PATH_TEMPLATE,
  ORGANIZATION_OWNERSHIP_PATH_TEMPLATE,
  ORGANIZATION_SPACE_GROUP_PATH_TEMPLATE,
  ORGANIZATION_SPACE_GROUPS_PATH_TEMPLATE,
  ORGANIZATION_SPACE_AUDIT_EVENTS_PATH_TEMPLATE,
  ORGANIZATION_SPACE_BACKUPS_PATH_TEMPLATE,
  ORGANIZATION_SPACE_BACKUP_RESTORES_PATH_TEMPLATE,
  ORGANIZATION_SPACE_MEMBER_PATH_TEMPLATE,
  ORGANIZATION_SPACE_MEMBERS_PATH_TEMPLATE,
  ORGANIZATION_SPACE_PATH_TEMPLATE,
  ORGANIZATION_SPACE_OBSERVABILITY_PATH_TEMPLATE,
  ORGANIZATION_SPACE_RESTORE_ACTIVATION_PATH_TEMPLATE,
  ORGANIZATION_SPACE_RESTORE_PATH_TEMPLATE,
  ORGANIZATION_SPACE_SHARE_PASSWORD_PATH_TEMPLATE,
  ORGANIZATION_SPACE_SHARE_PATH_TEMPLATE,
  ORGANIZATION_SPACE_SHARES_PATH_TEMPLATE,
  ORGANIZATION_SPACES_PATH_TEMPLATE,
  auditEventsResponseSchema,
  createdDocumentShareSchema,
  createdOrganizationInvitationSchema,
  managedOidcProviderSchema,
  managedOidcProvidersResponseSchema,
  managedDocumentSharesResponseSchema,
  managedSpaceSummarySchema,
  managedSpacesResponseSchema,
  organizationInvitationsResponseSchema,
  organizationMemberSummarySchema,
  organizationMembersResponseSchema,
  spaceGroupGrantsResponseSchema,
  spaceBackupSchema,
  spaceBackupsResponseSchema,
  spaceMembersResponseSchema,
  spaceObservabilitySchema,
  spaceRestoreSchema,
  userGroupMembersResponseSchema,
  userGroupSummarySchema,
  userGroupsResponseSchema,
  type ChangeDocumentSharePasswordRequest,
  type CreateDocumentShareRequest,
  type CreateOidcProviderRequest,
  type CreateOrganizationInvitationRequest,
  type CreateSpaceRequest,
  type CreateSpaceRestoreRequest,
  type CreateUserGroupRequest,
  type SetSpaceGroupGrantRequest,
  type SetSpaceMemberRequest,
  type TransferOrganizationOwnershipRequest,
  type UpdateOidcProviderRequest,
  type UpdateOrganizationMemberRequest,
  type UpdateSpaceRequest,
  type UpdateUserGroupRequest,
} from "@singularity/contracts";

import { requestJson, requestNoContent } from "@/api/http.ts";
import { buildApiPath as buildPath } from "@/api/path.ts";
import { getCsrfToken } from "@/auth/api.ts";
import { useCsrfStore } from "@/auth/csrf-store.ts";

async function mutationHeaders(
  signal?: AbortSignal,
  contentType = false,
): Promise<Record<string, string>> {
  let csrfToken = useCsrfStore.getState().csrfToken;
  if (csrfToken === null) {
    const response = await getCsrfToken(signal);
    csrfToken = response.csrfToken;
    useCsrfStore.getState().setCsrfToken(csrfToken);
  }
  return {
    [CSRF_HEADER_NAME]: csrfToken,
    ...(contentType ? { "Content-Type": "application/json" } : {}),
  };
}

function organizationPath(template: string, organizationId: string): string {
  return buildPath(template, { organizationId });
}

function organizationResourcePath(
  template: string,
  organizationId: string,
  resourceName: string,
  resourceId: string,
): string {
  return buildPath(template, {
    organizationId,
    [resourceName]: resourceId,
  });
}

function spacePath(
  template: string,
  organizationId: string,
  spaceId: string,
): string {
  return buildPath(template, { organizationId, spaceId });
}

function auditEventsPath(
  path: string,
  beforeSequence: string | null,
  limit: number,
): string {
  const query = new URLSearchParams({ limit: String(limit) });
  if (beforeSequence !== null) {
    query.set("beforeSequence", beforeSequence);
  }
  return `${path}?${query.toString()}`;
}

export const organizationMembersQueryKey = (organizationId: string) =>
  ["enterprise", organizationId, "members"] as const;

export const organizationInvitationsQueryKey = (organizationId: string) =>
  ["enterprise", organizationId, "invitations"] as const;

export const organizationGroupsQueryKey = (organizationId: string) =>
  ["enterprise", organizationId, "groups"] as const;

export const groupMembersQueryKey = (
  organizationId: string,
  groupId: string,
) => ["enterprise", organizationId, "groups", groupId, "members"] as const;

export const managedSpacesQueryKey = (organizationId: string) =>
  ["enterprise", organizationId, "spaces"] as const;

export const managedSpaceQueryKey = (
  organizationId: string,
  spaceId: string,
) => ["enterprise", organizationId, "spaces", spaceId] as const;

export const spaceMembersQueryKey = (
  organizationId: string,
  spaceId: string,
) => ["enterprise", organizationId, "spaces", spaceId, "members"] as const;

export const spaceGroupGrantsQueryKey = (
  organizationId: string,
  spaceId: string,
) => ["enterprise", organizationId, "spaces", spaceId, "groups"] as const;

export const managedOidcProvidersQueryKey = (organizationId: string) =>
  ["enterprise", organizationId, "oidc-providers"] as const;

export const organizationAuditEventsQueryKey = (
  organizationId: string,
  beforeSequence: string | null,
) => ["enterprise", organizationId, "audit-events", beforeSequence] as const;

export const spaceAuditEventsQueryKey = (
  organizationId: string,
  spaceId: string,
  beforeSequence: string | null,
) =>
  [
    "enterprise",
    organizationId,
    "spaces",
    spaceId,
    "audit-events",
    beforeSequence,
  ] as const;

export const spaceSharesQueryKey = (
  organizationId: string,
  spaceId: string,
) => ["enterprise", organizationId, "spaces", spaceId, "shares"] as const;

export const spaceBackupsQueryKey = (
  organizationId: string,
  spaceId: string,
) => ["enterprise", organizationId, "spaces", spaceId, "backups"] as const;

export const spaceRestoreQueryKey = (
  organizationId: string,
  sourceSpaceId: string,
  restoreId: string,
) =>
  [
    "enterprise",
    organizationId,
    "spaces",
    sourceSpaceId,
    "restores",
    restoreId,
  ] as const;

export const spaceObservabilityQueryKey = (
  organizationId: string,
  spaceId: string,
) =>
  ["enterprise", organizationId, "spaces", spaceId, "observability"] as const;

export function getOrganizationMembers(
  organizationId: string,
  signal?: AbortSignal,
) {
  return requestJson(
    organizationMembersResponseSchema,
    organizationPath(ORGANIZATION_MEMBERS_PATH_TEMPLATE, organizationId),
    { signal: signal ?? null },
  );
}

export async function updateOrganizationMember(
  organizationId: string,
  userId: string,
  request: UpdateOrganizationMemberRequest,
) {
  return requestJson(
    organizationMemberSummarySchema,
    organizationResourcePath(
      ORGANIZATION_MEMBER_PATH_TEMPLATE,
      organizationId,
      "userId",
      userId,
    ),
    {
      body: JSON.stringify(request),
      headers: await mutationHeaders(undefined, true),
      method: "PATCH",
    },
  );
}

export async function revokeOrganizationMemberSessions(
  organizationId: string,
  userId: string,
) {
  return requestNoContent(
    organizationResourcePath(
      ORGANIZATION_MEMBER_SESSIONS_PATH_TEMPLATE,
      organizationId,
      "userId",
      userId,
    ),
    { headers: await mutationHeaders(), method: "POST" },
  );
}

export async function transferOrganizationOwnership(
  organizationId: string,
  request: TransferOrganizationOwnershipRequest,
) {
  return requestNoContent(
    organizationPath(ORGANIZATION_OWNERSHIP_PATH_TEMPLATE, organizationId),
    {
      body: JSON.stringify(request),
      headers: await mutationHeaders(undefined, true),
      method: "POST",
    },
  );
}

export function getOrganizationInvitations(
  organizationId: string,
  signal?: AbortSignal,
) {
  return requestJson(
    organizationInvitationsResponseSchema,
    organizationPath(ORGANIZATION_INVITATIONS_PATH_TEMPLATE, organizationId),
    { signal: signal ?? null },
  );
}

export async function createOrganizationInvitation(
  organizationId: string,
  request: CreateOrganizationInvitationRequest,
) {
  return requestJson(
    createdOrganizationInvitationSchema,
    organizationPath(ORGANIZATION_INVITATIONS_PATH_TEMPLATE, organizationId),
    {
      body: JSON.stringify(request),
      headers: await mutationHeaders(undefined, true),
      method: "POST",
    },
  );
}

export async function revokeOrganizationInvitation(
  organizationId: string,
  invitationId: string,
) {
  return requestNoContent(
    organizationResourcePath(
      ORGANIZATION_INVITATION_PATH_TEMPLATE,
      organizationId,
      "invitationId",
      invitationId,
    ),
    { headers: await mutationHeaders(), method: "DELETE" },
  );
}

export function getOrganizationGroups(
  organizationId: string,
  signal?: AbortSignal,
) {
  return requestJson(
    userGroupsResponseSchema,
    organizationPath(ORGANIZATION_GROUPS_PATH_TEMPLATE, organizationId),
    { signal: signal ?? null },
  );
}

export async function createOrganizationGroup(
  organizationId: string,
  request: CreateUserGroupRequest,
) {
  return requestJson(
    userGroupSummarySchema,
    organizationPath(ORGANIZATION_GROUPS_PATH_TEMPLATE, organizationId),
    {
      body: JSON.stringify(request),
      headers: await mutationHeaders(undefined, true),
      method: "POST",
    },
  );
}

export async function updateOrganizationGroup(
  organizationId: string,
  groupId: string,
  request: UpdateUserGroupRequest,
) {
  return requestJson(
    userGroupSummarySchema,
    organizationResourcePath(
      ORGANIZATION_GROUP_PATH_TEMPLATE,
      organizationId,
      "groupId",
      groupId,
    ),
    {
      body: JSON.stringify(request),
      headers: await mutationHeaders(undefined, true),
      method: "PATCH",
    },
  );
}

export function getGroupMembers(
  organizationId: string,
  groupId: string,
  signal?: AbortSignal,
) {
  return requestJson(
    userGroupMembersResponseSchema,
    buildPath(ORGANIZATION_GROUP_MEMBERS_PATH_TEMPLATE, {
      groupId,
      organizationId,
    }),
    { signal: signal ?? null },
  );
}

export async function addGroupMember(
  organizationId: string,
  groupId: string,
  userId: string,
) {
  return requestNoContent(
    buildPath(ORGANIZATION_GROUP_MEMBER_PATH_TEMPLATE, {
      groupId,
      organizationId,
      userId,
    }),
    { headers: await mutationHeaders(), method: "PUT" },
  );
}

export async function removeGroupMember(
  organizationId: string,
  groupId: string,
  userId: string,
) {
  return requestNoContent(
    buildPath(ORGANIZATION_GROUP_MEMBER_PATH_TEMPLATE, {
      groupId,
      organizationId,
      userId,
    }),
    { headers: await mutationHeaders(), method: "DELETE" },
  );
}

export function getManagedSpaces(
  organizationId: string,
  signal?: AbortSignal,
) {
  return requestJson(
    managedSpacesResponseSchema,
    organizationPath(ORGANIZATION_SPACES_PATH_TEMPLATE, organizationId),
    { signal: signal ?? null },
  );
}

export async function createManagedSpace(
  organizationId: string,
  request: CreateSpaceRequest,
) {
  return requestJson(
    managedSpaceSummarySchema,
    organizationPath(ORGANIZATION_SPACES_PATH_TEMPLATE, organizationId),
    {
      body: JSON.stringify(request),
      headers: await mutationHeaders(undefined, true),
      method: "POST",
    },
  );
}

export function getManagedSpace(
  organizationId: string,
  spaceId: string,
  signal?: AbortSignal,
) {
  return requestJson(
    managedSpaceSummarySchema,
    spacePath(ORGANIZATION_SPACE_PATH_TEMPLATE, organizationId, spaceId),
    { signal: signal ?? null },
  );
}

export async function updateManagedSpace(
  organizationId: string,
  spaceId: string,
  request: UpdateSpaceRequest,
) {
  return requestJson(
    managedSpaceSummarySchema,
    spacePath(ORGANIZATION_SPACE_PATH_TEMPLATE, organizationId, spaceId),
    {
      body: JSON.stringify(request),
      headers: await mutationHeaders(undefined, true),
      method: "PATCH",
    },
  );
}

export function getSpaceMembers(
  organizationId: string,
  spaceId: string,
  signal?: AbortSignal,
) {
  return requestJson(
    spaceMembersResponseSchema,
    spacePath(
      ORGANIZATION_SPACE_MEMBERS_PATH_TEMPLATE,
      organizationId,
      spaceId,
    ),
    { signal: signal ?? null },
  );
}

export async function setSpaceMember(
  organizationId: string,
  spaceId: string,
  userId: string,
  request: SetSpaceMemberRequest,
) {
  return requestNoContent(
    buildPath(ORGANIZATION_SPACE_MEMBER_PATH_TEMPLATE, {
      organizationId,
      spaceId,
      userId,
    }),
    {
      body: JSON.stringify(request),
      headers: await mutationHeaders(undefined, true),
      method: "PUT",
    },
  );
}

export async function revokeSpaceMember(
  organizationId: string,
  spaceId: string,
  userId: string,
) {
  return requestNoContent(
    buildPath(ORGANIZATION_SPACE_MEMBER_PATH_TEMPLATE, {
      organizationId,
      spaceId,
      userId,
    }),
    { headers: await mutationHeaders(), method: "DELETE" },
  );
}

export function getSpaceGroupGrants(
  organizationId: string,
  spaceId: string,
  signal?: AbortSignal,
) {
  return requestJson(
    spaceGroupGrantsResponseSchema,
    spacePath(
      ORGANIZATION_SPACE_GROUPS_PATH_TEMPLATE,
      organizationId,
      spaceId,
    ),
    { signal: signal ?? null },
  );
}

export async function setSpaceGroupGrant(
  organizationId: string,
  spaceId: string,
  groupId: string,
  request: SetSpaceGroupGrantRequest,
) {
  return requestNoContent(
    buildPath(ORGANIZATION_SPACE_GROUP_PATH_TEMPLATE, {
      groupId,
      organizationId,
      spaceId,
    }),
    {
      body: JSON.stringify(request),
      headers: await mutationHeaders(undefined, true),
      method: "PUT",
    },
  );
}

export async function revokeSpaceGroupGrant(
  organizationId: string,
  spaceId: string,
  groupId: string,
) {
  return requestNoContent(
    buildPath(ORGANIZATION_SPACE_GROUP_PATH_TEMPLATE, {
      groupId,
      organizationId,
      spaceId,
    }),
    { headers: await mutationHeaders(), method: "DELETE" },
  );
}

export function getManagedOidcProviders(
  organizationId: string,
  signal?: AbortSignal,
) {
  return requestJson(
    managedOidcProvidersResponseSchema,
    organizationPath(
      ORGANIZATION_OIDC_PROVIDERS_PATH_TEMPLATE,
      organizationId,
    ),
    { signal: signal ?? null },
  );
}

export async function createManagedOidcProvider(
  organizationId: string,
  request: CreateOidcProviderRequest,
) {
  return requestJson(
    managedOidcProviderSchema,
    organizationPath(
      ORGANIZATION_OIDC_PROVIDERS_PATH_TEMPLATE,
      organizationId,
    ),
    {
      body: JSON.stringify(request),
      headers: await mutationHeaders(undefined, true),
      method: "POST",
    },
  );
}

export async function updateManagedOidcProvider(
  organizationId: string,
  providerId: string,
  request: UpdateOidcProviderRequest,
) {
  return requestJson(
    managedOidcProviderSchema,
    organizationResourcePath(
      ORGANIZATION_OIDC_PROVIDER_PATH_TEMPLATE,
      organizationId,
      "providerId",
      providerId,
    ),
    {
      body: JSON.stringify(request),
      headers: await mutationHeaders(undefined, true),
      method: "PATCH",
    },
  );
}

export function getOrganizationAuditEvents(
  organizationId: string,
  beforeSequence: string | null,
  limit: number,
  signal?: AbortSignal,
) {
  return requestJson(
    auditEventsResponseSchema,
    auditEventsPath(
      organizationPath(
        ORGANIZATION_AUDIT_EVENTS_PATH_TEMPLATE,
        organizationId,
      ),
      beforeSequence,
      limit,
    ),
    { signal: signal ?? null },
  );
}

export function getSpaceAuditEvents(
  organizationId: string,
  spaceId: string,
  beforeSequence: string | null,
  limit: number,
  signal?: AbortSignal,
) {
  return requestJson(
    auditEventsResponseSchema,
    auditEventsPath(
      spacePath(
        ORGANIZATION_SPACE_AUDIT_EVENTS_PATH_TEMPLATE,
        organizationId,
        spaceId,
      ),
      beforeSequence,
      limit,
    ),
    { signal: signal ?? null },
  );
}

export function getSpaceShares(
  organizationId: string,
  spaceId: string,
  signal?: AbortSignal,
) {
  return requestJson(
    managedDocumentSharesResponseSchema,
    spacePath(
      ORGANIZATION_SPACE_SHARES_PATH_TEMPLATE,
      organizationId,
      spaceId,
    ),
    { signal: signal ?? null },
  );
}

export async function createSpaceShare(
  organizationId: string,
  spaceId: string,
  request: CreateDocumentShareRequest,
) {
  return requestJson(
    createdDocumentShareSchema,
    spacePath(
      ORGANIZATION_SPACE_SHARES_PATH_TEMPLATE,
      organizationId,
      spaceId,
    ),
    {
      body: JSON.stringify(request),
      headers: await mutationHeaders(undefined, true),
      method: "POST",
    },
  );
}

export async function changeSpaceSharePassword(
  organizationId: string,
  spaceId: string,
  shareId: string,
  request: ChangeDocumentSharePasswordRequest,
) {
  return requestNoContent(
    buildPath(ORGANIZATION_SPACE_SHARE_PASSWORD_PATH_TEMPLATE, {
      organizationId,
      shareId,
      spaceId,
    }),
    {
      body: JSON.stringify(request),
      headers: await mutationHeaders(undefined, true),
      method: "PATCH",
    },
  );
}

export async function revokeSpaceShare(
  organizationId: string,
  spaceId: string,
  shareId: string,
) {
  return requestNoContent(
    buildPath(ORGANIZATION_SPACE_SHARE_PATH_TEMPLATE, {
      organizationId,
      shareId,
      spaceId,
    }),
    { headers: await mutationHeaders(), method: "DELETE" },
  );
}

export function getSpaceBackups(
  organizationId: string,
  spaceId: string,
  signal?: AbortSignal,
) {
  return requestJson(
    spaceBackupsResponseSchema,
    spacePath(
      ORGANIZATION_SPACE_BACKUPS_PATH_TEMPLATE,
      organizationId,
      spaceId,
    ),
    { signal: signal ?? null },
  );
}

export async function createSpaceBackup(
  organizationId: string,
  spaceId: string,
) {
  return requestJson(
    spaceBackupSchema,
    spacePath(
      ORGANIZATION_SPACE_BACKUPS_PATH_TEMPLATE,
      organizationId,
      spaceId,
    ),
    { headers: await mutationHeaders(), method: "POST" },
  );
}

export async function createSpaceRestore(
  organizationId: string,
  sourceSpaceId: string,
  backupId: string,
  request: CreateSpaceRestoreRequest,
) {
  return requestJson(
    spaceRestoreSchema,
    buildPath(ORGANIZATION_SPACE_BACKUP_RESTORES_PATH_TEMPLATE, {
      backupId,
      organizationId,
      spaceId: sourceSpaceId,
    }),
    {
      body: JSON.stringify(request),
      headers: await mutationHeaders(undefined, true),
      method: "POST",
    },
  );
}

export function getSpaceRestore(
  organizationId: string,
  sourceSpaceId: string,
  restoreId: string,
  signal?: AbortSignal,
) {
  return requestJson(
    spaceRestoreSchema,
    buildPath(ORGANIZATION_SPACE_RESTORE_PATH_TEMPLATE, {
      organizationId,
      restoreId,
      spaceId: sourceSpaceId,
    }),
    { signal: signal ?? null },
  );
}

export async function activateSpaceRestore(
  organizationId: string,
  targetSpaceId: string,
  restoreId: string,
) {
  return requestJson(
    spaceRestoreSchema,
    buildPath(ORGANIZATION_SPACE_RESTORE_ACTIVATION_PATH_TEMPLATE, {
      organizationId,
      restoreId,
      spaceId: targetSpaceId,
    }),
    { headers: await mutationHeaders(), method: "POST" },
  );
}

export function getSpaceObservability(
  organizationId: string,
  spaceId: string,
  signal?: AbortSignal,
) {
  return requestJson(
    spaceObservabilitySchema,
    spacePath(
      ORGANIZATION_SPACE_OBSERVABILITY_PATH_TEMPLATE,
      organizationId,
      spaceId,
    ),
    { signal: signal ?? null },
  );
}
