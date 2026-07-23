import { z } from "zod";

import { DOCUMENT_IDENTITY_OPENAPI_SCHEMA, documentIdentitySchema } from "./document-identity.js";
import { strictObjectOpenApiSchema, UUID_OPENAPI_SCHEMA, type OpenApiSchema } from "./openapi.js";
import { contentIdSchema } from "./shares.js";
import { uuidSchema } from "./spaces.js";

export const governanceClassifications = [
  "public",
  "internal",
  "confidential",
  "restricted",
] as const;
export const governanceClassificationSchema = z.enum(governanceClassifications);
export type GovernanceClassification = z.infer<typeof governanceClassificationSchema>;

export const governanceLifecycleStatuses = [
  "draft",
  "in-review",
  "approved",
  "published",
  "archived",
  "rejected",
] as const;
export const governanceLifecycleStatusSchema = z.enum(governanceLifecycleStatuses);
export type GovernanceLifecycleStatus = z.infer<typeof governanceLifecycleStatusSchema>;

export const governanceVerificationStatuses = ["verified", "needs-review", "expired"] as const;
export const governanceVerificationStatusSchema = z.enum(governanceVerificationStatuses);

export const governancePolicySchema = z.object({
  archiveAfterDays: z.number().int().positive().max(36500),
  defaultClassification: governanceClassificationSchema,
  governanceEnabled: z.boolean(),
  retentionDays: z.number().int().positive().max(36500),
  verificationGraceDays: z.number().int().nonnegative().max(3650),
  verificationIntervalDays: z.number().int().positive().max(3650),
  watermarkEnabled: z.boolean(),
}).strict();
export type GovernancePolicy = z.infer<typeof governancePolicySchema>;

export const governancePolicyResponseSchema = governancePolicySchema.extend({
  organizationId: uuidSchema,
  policyId: uuidSchema,
  spaceId: uuidSchema,
  updatedAt: z.string().datetime({ offset: true }),
}).strict();
export type GovernancePolicyResponse = z.infer<typeof governancePolicyResponseSchema>;

export const documentGovernanceSchema = z.object({
  archivedAt: z.string().datetime({ offset: true }).optional(),
  classification: governanceClassificationSchema,
  currentVersion: z.string().min(1).max(512).optional(),
  document: documentIdentitySchema,
  legalHold: z.boolean(),
  lifecycle: governanceLifecycleStatusSchema,
  nextVerificationAt: z.string().datetime({ offset: true }).optional(),
  ownerUserId: uuidSchema.optional(),
  retentionUntil: z.string().datetime({ offset: true }).optional(),
  verification: governanceVerificationStatusSchema,
}).strict();
export type DocumentGovernance = z.infer<typeof documentGovernanceSchema>;

export const governanceTransitionRequestSchema = z.object({
  action: z.enum(["submit", "approve", "reject", "publish", "archive", "restore", "verify"]),
  comment: z.string().trim().max(4000).optional(),
  versionToken: z.string().min(1).max(512).optional(),
}).strict();
export type GovernanceTransitionRequest = z.infer<typeof governanceTransitionRequestSchema>;

export const governanceClassificationRequestSchema = z.object({
  classification: governanceClassificationSchema,
}).strict();
export type GovernanceClassificationRequest = z.infer<typeof governanceClassificationRequestSchema>;

export const governanceLegalHoldRequestSchema = z.object({
  enabled: z.boolean(),
}).strict();
export type GovernanceLegalHoldRequest = z.infer<typeof governanceLegalHoldRequestSchema>;

export const scimUserSyncSchema = z.object({
  active: z.boolean(),
  externalId: z.string().min(1).max(512),
  loginIdentifier: z.string().min(3).max(254),
}).strict();
export const scimGroupSyncSchema = z.object({
  externalId: z.string().min(1).max(512),
  name: z.string().trim().min(1).max(120),
}).strict();
export const scimSyncRequestSchema = z.object({
  groups: z.array(scimGroupSyncSchema).max(1000),
  users: z.array(scimUserSyncSchema).max(1000),
}).strict();
export type ScimSyncRequest = z.infer<typeof scimSyncRequestSchema>;

export const mfaFactorRequestSchema = z.object({
  label: z.string().trim().min(1).max(120),
  secret: z.string().trim().min(16).max(256).regex(/^[A-Za-z2-7 =-]+$/i),
}).strict();
export type MfaFactorRequest = z.infer<typeof mfaFactorRequestSchema>;
export const mfaVerifyRequestSchema = z.object({
  code: z.string().regex(/^[0-9]{6}$/),
  label: z.string().trim().min(1).max(120),
}).strict();
export type MfaVerifyRequest = z.infer<typeof mfaVerifyRequestSchema>;

export const governanceApprovalSchema = z.object({
  decidedAt: z.string().datetime({ offset: true }).optional(),
  decisionComment: z.string().optional(),
  requestId: uuidSchema,
  status: z.enum(["pending", "approved", "rejected"]),
  submittedAt: z.string().datetime({ offset: true }),
  versionToken: z.string(),
}).strict();
export const governanceApprovalsResponseSchema = z.object({ approvals: z.array(governanceApprovalSchema) }).strict();

export const governanceTemplateInitialContentSchema = z.object({
  markdown: z.string().max(1_000_000).optional(),
}).strict();

export const governanceTemplateRequestSchema = z.object({
  defaultClassification: governanceClassificationSchema,
  description: z.string().trim().max(4000).optional(),
  initialContent: governanceTemplateInitialContentSchema,
  name: z.string().trim().min(1).max(120),
  verificationIntervalDays: z.number().int().positive().max(3650),
}).strict();
export type GovernanceTemplateRequest = z.infer<typeof governanceTemplateRequestSchema>;

/** 模板应用的输入只描述目标内容库和父文档；正文仍由模板和 Kernel 共同拥有。 */
export const governanceTemplateDocumentRequestSchema = z.object({
  notebookId: contentIdSchema,
  parentDocumentId: contentIdSchema.optional(),
  title: z.string().trim().min(1).max(512).refine((value) => !/[\\/]/.test(value), "title cannot contain path separators"),
}).strict();
export type GovernanceTemplateDocumentRequest = z.infer<typeof governanceTemplateDocumentRequestSchema>;

export const governanceTemplateDocumentResponseSchema = documentIdentitySchema;
export type GovernanceTemplateDocumentResponse = z.infer<typeof governanceTemplateDocumentResponseSchema>;

export const governanceTemplateSchema = governanceTemplateRequestSchema.extend({
  status: z.enum(["draft", "published", "archived"]),
  templateId: uuidSchema,
  updatedAt: z.string().datetime({ offset: true }),
}).strict();
export const governanceTemplatesResponseSchema = z.object({ templates: z.array(governanceTemplateSchema) }).strict();

export const governanceDashboardSchema = z.object({
  approvalsPending: z.number().int().nonnegative(),
  documentsExpired: z.number().int().nonnegative(),
  documentsNeedingReview: z.number().int().nonnegative(),
  legalHolds: z.number().int().nonnegative(),
  tasksFailed: z.number().int().nonnegative(),
}).strict();
export type GovernanceDashboard = z.infer<typeof governanceDashboardSchema>;

export const governanceSearchRequestSchema = z.object({
  query: z.string().trim().min(1).max(200),
  spaceIds: z.array(uuidSchema).min(1).max(100),
}).strict();
export type GovernanceSearchRequest = z.infer<typeof governanceSearchRequestSchema>;

export const governanceSearchResultSchema = z.object({
  classification: governanceClassificationSchema,
  document: documentIdentitySchema,
  excerpt: z.string(),
  title: z.string(),
  updatedAt: z.string().datetime({ offset: true }),
}).strict();
export const governanceSearchResponseSchema = z.object({ results: z.array(governanceSearchResultSchema) }).strict();

export const enterpriseApiKeyRequestSchema = z.object({
  expiresAt: z.string().datetime({ offset: true }).optional(),
  name: z.string().trim().min(1).max(120),
  scopes: z.array(z.string().regex(/^[a-z][a-z0-9_.:-]{1,63}$/)).min(1).max(32),
}).strict();
export type EnterpriseApiKeyRequest = z.infer<typeof enterpriseApiKeyRequestSchema>;

export const enterpriseApiKeyResponseSchema = z.object({
  apiKeyId: uuidSchema,
  expiresAt: z.string().datetime({ offset: true }).optional(),
  keyPrefix: z.string(),
  name: z.string(),
  secret: z.string().optional(),
  scopes: z.array(z.string()),
}).strict();

export const enterpriseApiKeySummarySchema = z.object({
  apiKeyId: uuidSchema,
  createdAt: z.string().datetime({ offset: true }),
  expiresAt: z.string().datetime({ offset: true }).optional(),
  keyPrefix: z.string(),
  lastUsedAt: z.string().datetime({ offset: true }).optional(),
  name: z.string(),
  revokedAt: z.string().datetime({ offset: true }).optional(),
  scopes: z.array(z.string()),
}).strict();
export const enterpriseApiKeysResponseSchema = z.object({ keys: z.array(enterpriseApiKeySummarySchema) }).strict();

export const scimTokenSummarySchema = z.object({
  createdAt: z.string().datetime({ offset: true }),
  expiresAt: z.string().datetime({ offset: true }).optional(),
  lastUsedAt: z.string().datetime({ offset: true }).optional(),
  revokedAt: z.string().datetime({ offset: true }).optional(),
  tokenId: uuidSchema,
  tokenPrefix: z.string(),
}).strict();
export const scimTokensResponseSchema = z.object({ tokens: z.array(scimTokenSummarySchema) }).strict();

export const samlProviderSummarySchema = z.object({
  certificateConfigured: z.boolean(),
  entityId: z.string(),
  name: z.string(),
  providerId: uuidSchema,
  ssoUrl: z.string().url(),
  status: z.enum(["active", "disabled"]),
}).strict();
export const samlProvidersResponseSchema = z.object({ providers: z.array(samlProviderSummarySchema) }).strict();

export const mfaFactorSummarySchema = z.object({
  createdAt: z.string().datetime({ offset: true }),
  enabled: z.boolean(),
  factorId: uuidSchema,
  label: z.string(),
  lastUsedAt: z.string().datetime({ offset: true }).optional(),
}).strict();
export const mfaFactorsResponseSchema = z.object({ factors: z.array(mfaFactorSummarySchema) }).strict();
export const mfaFactorEnrollmentResponseSchema = z.object({ factorId: uuidSchema, label: z.string(), requiresVerification: z.boolean() }).strict();
export const mfaVerificationResponseSchema = z.object({ enabled: z.boolean() }).strict();
export const personalSpaceResponseSchema = z.object({ organizationId: uuidSchema, spaceId: uuidSchema, userId: uuidSchema }).strict();
export const scimTokenResponseSchema = z.object({ expiresAt: z.string().datetime({ offset: true }).optional(), secret: z.string(), tokenId: uuidSchema, tokenPrefix: z.string() }).strict();
export const samlProviderMutationResponseSchema = z.object({ name: z.string().optional(), providerId: uuidSchema, status: z.enum(["active", "disabled"]) }).strict();

export const governanceEmbeddedObjectRequestSchema = z.object({
  kind: z.enum(["drawio", "excalidraw"]),
  payload: z.record(z.string(), z.unknown()),
}).strict();
export type GovernanceEmbeddedObjectRequest = z.infer<typeof governanceEmbeddedObjectRequestSchema>;
export const governanceEmbeddedObjectSchema = governanceEmbeddedObjectRequestSchema.extend({
  embedId: uuidSchema,
  status: z.enum(["active", "failed", "deleted"]),
  version: z.number().int().positive(),
}).strict();
export const governanceEmbeddedObjectsResponseSchema = z.object({ embeds: z.array(governanceEmbeddedObjectSchema) }).strict();

export const aiChatRequestSchema = z.object({
  conversationId: uuidSchema.optional(),
  query: z.string().trim().min(1).max(8_000),
}).strict();
export type AiChatRequest = z.infer<typeof aiChatRequestSchema>;

export const aiCitationSchema = z.object({
  document: documentIdentitySchema,
  excerpt: z.string().min(1),
}).strict();

export const aiChatResponseSchema = z.object({
  answer: z.string().min(1),
  citations: z.array(aiCitationSchema).min(1),
  conversationId: uuidSchema,
  messageId: uuidSchema,
}).strict();
export type AiChatResponse = z.infer<typeof aiChatResponseSchema>;

const GOVERNANCE_CLASSIFICATION_OPENAPI_SCHEMA: OpenApiSchema = {
  type: "string",
  enum: [...governanceClassifications],
};
const GOVERNANCE_IDENTITY_OPENAPI_SCHEMA = DOCUMENT_IDENTITY_OPENAPI_SCHEMA;

export const GOVERNANCE_POLICY_OPENAPI_SCHEMA = strictObjectOpenApiSchema({
  archiveAfterDays: { type: "integer", minimum: 1 },
  defaultClassification: GOVERNANCE_CLASSIFICATION_OPENAPI_SCHEMA,
  governanceEnabled: { type: "boolean" },
  organizationId: UUID_OPENAPI_SCHEMA,
  policyId: UUID_OPENAPI_SCHEMA,
  retentionDays: { type: "integer", minimum: 1 },
  spaceId: UUID_OPENAPI_SCHEMA,
  updatedAt: { type: "string", format: "date-time" },
  verificationGraceDays: { type: "integer", minimum: 0 },
  verificationIntervalDays: { type: "integer", minimum: 1 },
  watermarkEnabled: { type: "boolean" },
});
export const DOCUMENT_GOVERNANCE_OPENAPI_SCHEMA = strictObjectOpenApiSchema({
  classification: GOVERNANCE_CLASSIFICATION_OPENAPI_SCHEMA,
  document: GOVERNANCE_IDENTITY_OPENAPI_SCHEMA,
  legalHold: { type: "boolean" },
  lifecycle: { type: "string" },
  verification: { type: "string" },
});
