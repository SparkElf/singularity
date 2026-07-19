import { z } from "zod";

import {
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  passwordSchema,
} from "./identity.js";
import {
  strictObjectOpenApiSchema,
  UUID_OPENAPI_SCHEMA,
  type OpenApiSchema,
} from "./openapi.js";
import { uuidSchema } from "./spaces.js";

export const CONTENT_ID_PATTERN = /^\d{14}-[0-9a-z]{7}$/;
export const SHARE_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
export const SHARE_ASSET_ID_PATTERN = /^[a-f0-9]{64}$/;

export const contentIdSchema = z.string().regex(CONTENT_ID_PATTERN);
export const shareTokenSchema = z.string().regex(SHARE_TOKEN_PATTERN);
export const shareAssetIdSchema = z.string().regex(SHARE_ASSET_ID_PATTERN);

export const managedSharesPathParametersSchema = z
  .object({ organizationId: uuidSchema, spaceId: uuidSchema })
  .strict();
export type ManagedSharesPathParameters = z.infer<
  typeof managedSharesPathParametersSchema
>;

export const managedSharePathParametersSchema = z
  .object({
    organizationId: uuidSchema,
    shareId: uuidSchema,
    spaceId: uuidSchema,
  })
  .strict();
export type ManagedSharePathParameters = z.infer<
  typeof managedSharePathParametersSchema
>;

export const publicSharePathParametersSchema = z
  .object({ shareToken: shareTokenSchema })
  .strict();
export type PublicSharePathParameters = z.infer<
  typeof publicSharePathParametersSchema
>;

export const publicShareAssetPathParametersSchema = z
  .object({ assetId: shareAssetIdSchema, shareToken: shareTokenSchema })
  .strict();
export type PublicShareAssetPathParameters = z.infer<
  typeof publicShareAssetPathParametersSchema
>;

export const createDocumentShareRequestSchema = z
  .object({
    documentId: contentIdSchema,
    expiresAt: z.string().datetime({ offset: true }),
    notebookId: contentIdSchema,
    password: passwordSchema.nullable().optional(),
  })
  .strict();
export type CreateDocumentShareRequest = z.infer<
  typeof createDocumentShareRequestSchema
>;

export const changeDocumentSharePasswordRequestSchema = z
  .object({ password: passwordSchema.nullable() })
  .strict();
export type ChangeDocumentSharePasswordRequest = z.infer<
  typeof changeDocumentSharePasswordRequestSchema
>;

export const createShareChallengeRequestSchema = z
  .object({ password: passwordSchema })
  .strict();
export type CreateShareChallengeRequest = z.infer<
  typeof createShareChallengeRequestSchema
>;

export const managedDocumentShareSchema = z
  .object({
    createdAt: z.string().datetime({ offset: true }),
    documentId: contentIdSchema,
    expiresAt: z.string().datetime({ offset: true }),
    hasPassword: z.boolean(),
    notebookId: contentIdSchema,
    organizationId: uuidSchema,
    revokedAt: z.string().datetime({ offset: true }).nullable(),
    shareId: uuidSchema,
    spaceId: uuidSchema,
  })
  .strict();
export type ManagedDocumentShare = z.infer<typeof managedDocumentShareSchema>;

export const createdDocumentShareSchema = managedDocumentShareSchema.extend({
  shareToken: shareTokenSchema,
});
export type CreatedDocumentShare = z.infer<typeof createdDocumentShareSchema>;

export const managedDocumentSharesResponseSchema = z
  .object({ shares: z.array(managedDocumentShareSchema) })
  .strict();
export type ManagedDocumentSharesResponse = z.infer<
  typeof managedDocumentSharesResponseSchema
>;

export const sharedAssetDispositions = ["attachment", "inline"] as const;
export const sharedAssetDispositionSchema = z.enum(sharedAssetDispositions);

export const sharedAssetDescriptorSchema = z
  .object({
    assetId: shareAssetIdSchema,
    disposition: sharedAssetDispositionSchema,
    fileName: z.string().min(1),
    mediaType: z.string().min(1),
  })
  .strict();
export type SharedAssetDescriptor = z.infer<
  typeof sharedAssetDescriptorSchema
>;

export const sharedDocumentPayloadSchema = z
  .object({
    assets: z.array(sharedAssetDescriptorSchema),
    documentId: contentIdSchema,
    html: z.string(),
    title: z.string(),
  })
  .strict();
export type SharedDocumentPayload = z.infer<typeof sharedDocumentPayloadSchema>;

const DATE_TIME_OPENAPI_SCHEMA: OpenApiSchema = {
  type: "string",
  format: "date-time",
};
const NULLABLE_DATE_TIME_OPENAPI_SCHEMA: OpenApiSchema = {
  ...DATE_TIME_OPENAPI_SCHEMA,
  nullable: true,
};
const CONTENT_ID_OPENAPI_SCHEMA: OpenApiSchema = {
  type: "string",
  pattern: CONTENT_ID_PATTERN.source,
};
const SHARE_TOKEN_OPENAPI_SCHEMA: OpenApiSchema = {
  type: "string",
  pattern: SHARE_TOKEN_PATTERN.source,
};
const SHARE_ASSET_ID_OPENAPI_SCHEMA: OpenApiSchema = {
  type: "string",
  pattern: SHARE_ASSET_ID_PATTERN.source,
};
const NULLABLE_PASSWORD_OPENAPI_SCHEMA: OpenApiSchema = {
  type: "string",
  minLength: PASSWORD_MIN_LENGTH,
  maxLength: PASSWORD_MAX_LENGTH,
  nullable: true,
};

export const CREATE_DOCUMENT_SHARE_REQUEST_OPENAPI_SCHEMA =
  strictObjectOpenApiSchema(
    {
      documentId: CONTENT_ID_OPENAPI_SCHEMA,
      expiresAt: DATE_TIME_OPENAPI_SCHEMA,
      notebookId: CONTENT_ID_OPENAPI_SCHEMA,
      password: NULLABLE_PASSWORD_OPENAPI_SCHEMA,
    },
    ["documentId", "expiresAt", "notebookId"],
  );
export const CHANGE_DOCUMENT_SHARE_PASSWORD_REQUEST_OPENAPI_SCHEMA =
  strictObjectOpenApiSchema({ password: NULLABLE_PASSWORD_OPENAPI_SCHEMA });
export const CREATE_SHARE_CHALLENGE_REQUEST_OPENAPI_SCHEMA =
  strictObjectOpenApiSchema({
    password: {
      type: "string",
      minLength: PASSWORD_MIN_LENGTH,
      maxLength: PASSWORD_MAX_LENGTH,
    },
  });
export const MANAGED_DOCUMENT_SHARE_OPENAPI_SCHEMA = strictObjectOpenApiSchema({
  createdAt: DATE_TIME_OPENAPI_SCHEMA,
  documentId: CONTENT_ID_OPENAPI_SCHEMA,
  expiresAt: DATE_TIME_OPENAPI_SCHEMA,
  hasPassword: { type: "boolean" },
  notebookId: CONTENT_ID_OPENAPI_SCHEMA,
  organizationId: UUID_OPENAPI_SCHEMA,
  revokedAt: NULLABLE_DATE_TIME_OPENAPI_SCHEMA,
  shareId: UUID_OPENAPI_SCHEMA,
  spaceId: UUID_OPENAPI_SCHEMA,
});
export const CREATED_DOCUMENT_SHARE_OPENAPI_SCHEMA = strictObjectOpenApiSchema({
  ...(MANAGED_DOCUMENT_SHARE_OPENAPI_SCHEMA.properties ?? {}),
  shareToken: SHARE_TOKEN_OPENAPI_SCHEMA,
});
export const MANAGED_DOCUMENT_SHARES_RESPONSE_OPENAPI_SCHEMA =
  strictObjectOpenApiSchema({
    shares: { type: "array", items: MANAGED_DOCUMENT_SHARE_OPENAPI_SCHEMA },
  });
export const SHARED_ASSET_DESCRIPTOR_OPENAPI_SCHEMA =
  strictObjectOpenApiSchema({
    assetId: SHARE_ASSET_ID_OPENAPI_SCHEMA,
    disposition: { type: "string", enum: [...sharedAssetDispositions] },
    fileName: { type: "string", minLength: 1 },
    mediaType: { type: "string", minLength: 1 },
  });
export const SHARED_DOCUMENT_PAYLOAD_OPENAPI_SCHEMA = strictObjectOpenApiSchema({
  assets: { type: "array", items: SHARED_ASSET_DESCRIPTOR_OPENAPI_SCHEMA },
  documentId: CONTENT_ID_OPENAPI_SCHEMA,
  html: { type: "string" },
  title: { type: "string" },
});
