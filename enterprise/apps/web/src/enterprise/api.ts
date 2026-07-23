import {
  CSRF_HEADER_NAME,
  ENTERPRISE_MANAGEMENT_ACCESS_PATH,
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
  ORGANIZATION_SPACE_GROUP_CANDIDATES_PATH_TEMPLATE,
  ORGANIZATION_SPACE_GROUPS_PATH_TEMPLATE,
  ORGANIZATION_SPACE_AUDIT_EVENTS_PATH_TEMPLATE,
  ORGANIZATION_SPACE_BACKUPS_PATH_TEMPLATE,
  ORGANIZATION_SPACE_BACKUP_RESTORES_PATH_TEMPLATE,
  ORGANIZATION_SPACE_MEMBER_PATH_TEMPLATE,
  ORGANIZATION_SPACE_MEMBER_CANDIDATES_PATH_TEMPLATE,
  ORGANIZATION_SPACE_MEMBERS_PATH_TEMPLATE,
  ORGANIZATION_SPACE_PATH_TEMPLATE,
  ORGANIZATION_SPACE_OBSERVABILITY_PATH_TEMPLATE,
  ORGANIZATION_SPACE_RESTORE_ACTIVATION_PATH_TEMPLATE,
  ORGANIZATION_SPACE_RESTORE_PATH_TEMPLATE,
  ORGANIZATION_SPACE_RESTORES_PATH_TEMPLATE,
  ORGANIZATION_SPACE_SHARE_PASSWORD_PATH_TEMPLATE,
  ORGANIZATION_SPACE_SHARE_PATH_TEMPLATE,
  ORGANIZATION_SPACE_SHARES_PATH_TEMPLATE,
  ORGANIZATION_SPACES_PATH_TEMPLATE,
  ORGANIZATION_GOVERNANCE_DASHBOARD_PATH_TEMPLATE,
  ORGANIZATION_SPACE_GOVERNANCE_POLICY_PATH_TEMPLATE,
  ORGANIZATION_API_KEYS_PATH_TEMPLATE,
  ORGANIZATION_API_KEY_PATH_TEMPLATE,
  ORGANIZATION_SAML_PROVIDERS_PATH_TEMPLATE,
  ORGANIZATION_SAML_PROVIDER_PATH_TEMPLATE,
  ORGANIZATION_SCIM_TOKENS_PATH_TEMPLATE,
  ORGANIZATION_SCIM_TOKEN_PATH_TEMPLATE,
  ORGANIZATION_PERSONAL_SPACE_PATH_TEMPLATE,
  ORGANIZATION_GOVERNANCE_SEARCH_PATH_TEMPLATE,
  ORGANIZATION_SPACE_GOVERNANCE_TEMPLATES_PATH_TEMPLATE,
  ORGANIZATION_SPACE_GOVERNANCE_TEMPLATE_PUBLISH_PATH_TEMPLATE,
  ORGANIZATION_SPACE_GOVERNANCE_TEMPLATE_DOCUMENTS_PATH_TEMPLATE,
  DOCUMENT_GOVERNANCE_PATH_TEMPLATE,
  DOCUMENT_GOVERNANCE_TRANSITION_PATH_TEMPLATE,
  DOCUMENT_GOVERNANCE_CLASSIFICATION_PATH_TEMPLATE,
  DOCUMENT_GOVERNANCE_LEGAL_HOLD_PATH_TEMPLATE,
  DOCUMENT_GOVERNANCE_APPROVALS_PATH_TEMPLATE,
  DOCUMENT_EMBEDDED_OBJECTS_PATH_TEMPLATE,
  DOCUMENT_AI_CHAT_PATH_TEMPLATE,
  AUTH_MFA_FACTORS_PATH,
  AUTH_MFA_VERIFY_PATH,
  governanceDashboardSchema,
  governancePolicyResponseSchema,
  governanceTemplatesResponseSchema,
  governanceTemplateSchema,
  documentGovernanceSchema,
  governanceApprovalsResponseSchema,
  governanceEmbeddedObjectsResponseSchema,
  governanceEmbeddedObjectSchema,
  governanceSearchResponseSchema,
  aiChatResponseSchema,
  mfaFactorsResponseSchema,
  mfaFactorEnrollmentResponseSchema,
  mfaVerificationResponseSchema,
  personalSpaceResponseSchema,
  scimTokenResponseSchema,
  samlProviderMutationResponseSchema,
  enterpriseApiKeyResponseSchema,
  enterpriseApiKeysResponseSchema,
  scimTokensResponseSchema,
  samlProvidersResponseSchema,
  documentIdentitySchema,
  type GovernanceTemplateRequest,
  type GovernanceTemplateDocumentRequest,
  type GovernanceTransitionRequest,
  type GovernanceClassificationRequest,
  type GovernanceLegalHoldRequest,
  type GovernanceEmbeddedObjectRequest,
  type AiChatRequest,
  type EnterpriseApiKeyRequest,
  type MfaFactorRequest,
  type MfaVerifyRequest,
  type GovernancePolicy,
  auditEventsResponseSchema,
  createdDocumentShareSchema,
  createdOrganizationInvitationSchema,
  enterpriseManagementAccessResponseSchema,
  managedOidcProviderSchema,
  managedOidcProvidersResponseSchema,
  managedDocumentSharesResponseSchema,
  managedSpaceSummarySchema,
  managedSpacesResponseSchema,
  organizationInvitationsResponseSchema,
  organizationMemberSummarySchema,
  organizationMembersResponseSchema,
  spaceGroupGrantsResponseSchema,
  spaceGroupCandidatesResponseSchema,
  spaceBackupSchema,
  spaceBackupsResponseSchema,
  spaceMembersResponseSchema,
  spaceMemberCandidatesResponseSchema,
  spaceObservabilitySchema,
  spaceRestoreSchema,
  spaceRestoresResponseSchema,
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
import type { DocumentIdentity } from "@singularity/contracts";

import { requestJson, requestNoContent } from "@/api/http.ts";
import { buildApiPath as buildPath } from "@/api/path.ts";
import { getOrFetchCsrfToken } from "@/auth/api.ts";

async function mutationHeaders(
  signal?: AbortSignal,
  contentType = false,
): Promise<Record<string, string>> {
  const csrfToken = await getOrFetchCsrfToken(signal);
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

export const enterpriseManagementAccessQueryKey = [
  "enterprise",
  "management-access",
] as const;

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

export const spaceMemberCandidatesQueryKey = (
  organizationId: string,
  spaceId: string,
) =>
  [
    "enterprise",
    organizationId,
    "spaces",
    spaceId,
    "member-candidates",
  ] as const;

export const spaceGroupGrantsQueryKey = (
  organizationId: string,
  spaceId: string,
) => ["enterprise", organizationId, "spaces", spaceId, "groups"] as const;

export const spaceGroupCandidatesQueryKey = (
  organizationId: string,
  spaceId: string,
) =>
  [
    "enterprise",
    organizationId,
    "spaces",
    spaceId,
    "group-candidates",
  ] as const;

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

export const spaceRestoresQueryKey = (
  organizationId: string,
  sourceSpaceId: string,
) =>
  [
    "enterprise",
    organizationId,
    "spaces",
    sourceSpaceId,
    "restores",
  ] as const;

export const spaceObservabilityQueryKey = (
  organizationId: string,
  spaceId: string,
) =>
  ["enterprise", organizationId, "spaces", spaceId, "observability"] as const;

export const governanceDashboardQueryKey = (organizationId: string) =>
  ["enterprise", organizationId, "governance", "dashboard"] as const;

export const governancePolicyQueryKey = (organizationId: string, spaceId: string) =>
  ["enterprise", organizationId, "spaces", spaceId, "governance", "policy"] as const;

export const governanceTemplatesQueryKey = (organizationId: string, spaceId: string) =>
  ["enterprise", organizationId, "spaces", spaceId, "governance", "templates"] as const;
export const governanceSearchQueryKey = (organizationId: string, query: string, spaceIds: readonly string[]) =>
  ["enterprise", organizationId, "governance", "search", query, ...spaceIds] as const;
export const enterpriseApiKeysQueryKey = (organizationId: string) => ["enterprise", organizationId, "api-keys"] as const;
export const samlProvidersQueryKey = (organizationId: string) => ["enterprise", organizationId, "saml-providers"] as const;
export const scimTokensQueryKey = (organizationId: string) => ["enterprise", organizationId, "scim-tokens"] as const;
export const mfaFactorsQueryKey = ["identity", "mfa-factors"] as const;
export const documentGovernanceQueryKey = (identity: DocumentIdentity) => ["governance", "document", identity.organizationId, identity.spaceId, identity.notebookId, identity.documentId] as const;
export const documentEmbedsQueryKey = (identity: DocumentIdentity) => ["governance", "embeds", identity.organizationId, identity.spaceId, identity.notebookId, identity.documentId] as const;

function documentPath(template: string, identity: DocumentIdentity): string {
  return buildPath(template, identity);
}

export function getEnterpriseManagementAccess(signal?: AbortSignal) {
  return requestJson(
    enterpriseManagementAccessResponseSchema,
    ENTERPRISE_MANAGEMENT_ACCESS_PATH,
    { signal: signal ?? null },
  );
}

export function getMfaFactors(signal?: AbortSignal) {
  return requestJson(mfaFactorsResponseSchema, AUTH_MFA_FACTORS_PATH, { signal: signal ?? null });
}

export async function enrollMfaFactor(request: MfaFactorRequest) {
  return requestJson(mfaFactorEnrollmentResponseSchema, AUTH_MFA_FACTORS_PATH, { body: JSON.stringify(request), headers: await mutationHeaders(undefined, true), method: "POST" });
}

export async function verifyMfaFactor(request: MfaVerifyRequest) {
  return requestJson(mfaVerificationResponseSchema, AUTH_MFA_VERIFY_PATH, { body: JSON.stringify(request), headers: await mutationHeaders(undefined, true), method: "POST" });
}

export function getGovernanceTemplates(organizationId: string, spaceId: string, signal?: AbortSignal) {
  return requestJson(governanceTemplatesResponseSchema, buildPath(ORGANIZATION_SPACE_GOVERNANCE_TEMPLATES_PATH_TEMPLATE, { organizationId, spaceId }), { signal: signal ?? null });
}

export async function createGovernanceTemplate(organizationId: string, spaceId: string, request: GovernanceTemplateRequest) {
  return requestJson(governanceTemplateSchema, buildPath(ORGANIZATION_SPACE_GOVERNANCE_TEMPLATES_PATH_TEMPLATE, { organizationId, spaceId }), { body: JSON.stringify(request), headers: await mutationHeaders(undefined, true), method: "POST" });
}

export async function publishGovernanceTemplate(organizationId: string, spaceId: string, templateId: string) {
  return requestJson(governanceTemplateSchema, buildPath(ORGANIZATION_SPACE_GOVERNANCE_TEMPLATE_PUBLISH_PATH_TEMPLATE, { organizationId, spaceId, templateId }), { headers: await mutationHeaders(), method: "POST" });
}

export async function createDocumentFromGovernanceTemplate(
  organizationId: string,
  spaceId: string,
  templateId: string,
  request: GovernanceTemplateDocumentRequest,
) {
  return requestJson(
    documentIdentitySchema,
    buildPath(ORGANIZATION_SPACE_GOVERNANCE_TEMPLATE_DOCUMENTS_PATH_TEMPLATE, { organizationId, spaceId, templateId }),
    { body: JSON.stringify(request), headers: await mutationHeaders(undefined, true), method: "POST" },
  );
}

export function getEnterpriseApiKeys(organizationId: string, signal?: AbortSignal) {
  return requestJson(enterpriseApiKeysResponseSchema, organizationPath(ORGANIZATION_API_KEYS_PATH_TEMPLATE, organizationId), { signal: signal ?? null });
}

export async function createEnterpriseApiKey(organizationId: string, request: EnterpriseApiKeyRequest) {
  return requestJson(enterpriseApiKeyResponseSchema, organizationPath(ORGANIZATION_API_KEYS_PATH_TEMPLATE, organizationId), { body: JSON.stringify(request), headers: await mutationHeaders(undefined, true), method: "POST" });
}

export async function revokeEnterpriseApiKey(organizationId: string, apiKeyId: string) {
  return requestNoContent(buildPath(ORGANIZATION_API_KEY_PATH_TEMPLATE, { organizationId, apiKeyId }), { headers: await mutationHeaders(), method: "DELETE" });
}

export function getSamlProviders(organizationId: string, signal?: AbortSignal) {
  return requestJson(samlProvidersResponseSchema, organizationPath(ORGANIZATION_SAML_PROVIDERS_PATH_TEMPLATE, organizationId), { signal: signal ?? null });
}

export async function createSamlProvider(organizationId: string, request: { name: string; entityId: string; ssoUrl: string; certificatePem: string }) {
  return requestJson(samlProviderMutationResponseSchema, organizationPath(ORGANIZATION_SAML_PROVIDERS_PATH_TEMPLATE, organizationId), { body: JSON.stringify(request), headers: await mutationHeaders(undefined, true), method: "POST" });
}

export async function setSamlProviderStatus(organizationId: string, providerId: string, status: "active" | "disabled") {
  return requestJson(samlProviderMutationResponseSchema, buildPath(ORGANIZATION_SAML_PROVIDER_PATH_TEMPLATE, { organizationId, providerId }), { body: JSON.stringify({ status }), headers: await mutationHeaders(undefined, true), method: "PATCH" });
}

export function getScimTokens(organizationId: string, signal?: AbortSignal) {
  return requestJson(scimTokensResponseSchema, organizationPath(ORGANIZATION_SCIM_TOKENS_PATH_TEMPLATE, organizationId), { signal: signal ?? null });
}

export async function createScimToken(organizationId: string, expiresAt?: string) {
  return requestJson(scimTokenResponseSchema, organizationPath(ORGANIZATION_SCIM_TOKENS_PATH_TEMPLATE, organizationId), { body: JSON.stringify(expiresAt === undefined ? {} : { expiresAt }), headers: await mutationHeaders(undefined, true), method: "POST" });
}

export async function revokeScimToken(organizationId: string, tokenId: string) {
  return requestNoContent(buildPath(ORGANIZATION_SCIM_TOKEN_PATH_TEMPLATE, { organizationId, tokenId }), { headers: await mutationHeaders(), method: "DELETE" });
}

export async function getPersonalSpace(organizationId: string) {
  return requestJson(personalSpaceResponseSchema, organizationPath(ORGANIZATION_PERSONAL_SPACE_PATH_TEMPLATE, organizationId), { headers: await mutationHeaders(), method: "POST" });
}

export async function searchAuthorizedSpaces(organizationId: string, request: { query: string; spaceIds: string[] }, signal?: AbortSignal) {
  return requestJson(governanceSearchResponseSchema, organizationPath(ORGANIZATION_GOVERNANCE_SEARCH_PATH_TEMPLATE, organizationId), { body: JSON.stringify(request), headers: await mutationHeaders(signal, true), method: "POST", signal: signal ?? null });
}

export function getDocumentGovernance(identity: DocumentIdentity, signal?: AbortSignal) {
  return requestJson(documentGovernanceSchema, documentPath(DOCUMENT_GOVERNANCE_PATH_TEMPLATE, identity), { signal: signal ?? null });
}

export async function transitionDocumentGovernance(identity: DocumentIdentity, request: GovernanceTransitionRequest) {
  return requestJson(documentGovernanceSchema, documentPath(DOCUMENT_GOVERNANCE_TRANSITION_PATH_TEMPLATE, identity), { body: JSON.stringify(request), headers: await mutationHeaders(undefined, true), method: "POST" });
}

export async function setDocumentClassification(identity: DocumentIdentity, request: GovernanceClassificationRequest) {
  return requestJson(documentGovernanceSchema, documentPath(DOCUMENT_GOVERNANCE_CLASSIFICATION_PATH_TEMPLATE, identity), { body: JSON.stringify(request), headers: await mutationHeaders(undefined, true), method: "PUT" });
}

export async function setDocumentLegalHold(identity: DocumentIdentity, request: GovernanceLegalHoldRequest) {
  return requestJson(documentGovernanceSchema, documentPath(DOCUMENT_GOVERNANCE_LEGAL_HOLD_PATH_TEMPLATE, identity), { body: JSON.stringify(request), headers: await mutationHeaders(undefined, true), method: "PUT" });
}

export function getDocumentApprovals(identity: DocumentIdentity, signal?: AbortSignal) {
  return requestJson(governanceApprovalsResponseSchema, documentPath(DOCUMENT_GOVERNANCE_APPROVALS_PATH_TEMPLATE, identity), { signal: signal ?? null });
}

export function getDocumentEmbeds(identity: DocumentIdentity, signal?: AbortSignal) {
  return requestJson(governanceEmbeddedObjectsResponseSchema, documentPath(DOCUMENT_EMBEDDED_OBJECTS_PATH_TEMPLATE, identity), { signal: signal ?? null });
}

export async function upsertDocumentEmbed(identity: DocumentIdentity, request: GovernanceEmbeddedObjectRequest) {
  return requestJson(governanceEmbeddedObjectSchema, documentPath(DOCUMENT_EMBEDDED_OBJECTS_PATH_TEMPLATE, identity), { body: JSON.stringify(request), headers: await mutationHeaders(undefined, true), method: "PUT" });
}

export async function askDocumentAi(identity: DocumentIdentity, request: AiChatRequest) {
  return requestJson(aiChatResponseSchema, documentPath(DOCUMENT_AI_CHAT_PATH_TEMPLATE, identity), { body: JSON.stringify(request), headers: await mutationHeaders(undefined, true), method: "POST" });
}

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

export function getSpaceMemberCandidates(
  organizationId: string,
  spaceId: string,
  signal?: AbortSignal,
) {
  return requestJson(
    spaceMemberCandidatesResponseSchema,
    spacePath(
      ORGANIZATION_SPACE_MEMBER_CANDIDATES_PATH_TEMPLATE,
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

export function getSpaceGroupCandidates(
  organizationId: string,
  spaceId: string,
  signal?: AbortSignal,
) {
  return requestJson(
    spaceGroupCandidatesResponseSchema,
    spacePath(
      ORGANIZATION_SPACE_GROUP_CANDIDATES_PATH_TEMPLATE,
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

export function getSpaceRestores(
  organizationId: string,
  sourceSpaceId: string,
  signal?: AbortSignal,
) {
  return requestJson(
    spaceRestoresResponseSchema,
    spacePath(
      ORGANIZATION_SPACE_RESTORES_PATH_TEMPLATE,
      organizationId,
      sourceSpaceId,
    ),
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

export function getGovernanceDashboard(organizationId: string, signal?: AbortSignal) {
  return requestJson(
    governanceDashboardSchema,
    organizationPath(ORGANIZATION_GOVERNANCE_DASHBOARD_PATH_TEMPLATE, organizationId),
    { signal: signal ?? null },
  );
}

export function getGovernancePolicy(organizationId: string, spaceId: string, signal?: AbortSignal) {
  return requestJson(
    governancePolicyResponseSchema,
    spacePath(ORGANIZATION_SPACE_GOVERNANCE_POLICY_PATH_TEMPLATE, organizationId, spaceId),
    { signal: signal ?? null },
  );
}

export async function updateGovernancePolicy(organizationId: string, spaceId: string, value: GovernancePolicy) {
  return requestJson(
    governancePolicyResponseSchema,
    spacePath(ORGANIZATION_SPACE_GOVERNANCE_POLICY_PATH_TEMPLATE, organizationId, spaceId),
    { body: JSON.stringify(value), headers: await mutationHeaders(undefined, true), method: "PUT" },
  );
}
