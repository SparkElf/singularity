import { z } from "zod";

import {
  DOCUMENT_IDENTITY_OPENAPI_SCHEMA,
  documentIdentitySchema,
} from "./document-identity.js";
import { strictObjectOpenApiSchema } from "./openapi.js";
import { uuidSchema } from "./spaces.js";

export const historyVersionIdSchema = z.string().min(1).max(2048);
export const historyVersionSchema = z
  .object({
    createdAt: z.string().datetime({ offset: true }),
    createdByUserId: uuidSchema.nullable(),
    isCurrent: z.boolean(),
    summary: z.string().max(500),
    versionId: historyVersionIdSchema,
  })
  .strict();
export type HistoryVersion = z.infer<typeof historyVersionSchema>;

export const historyVersionsResponseSchema = z
  .object({ versions: z.array(historyVersionSchema) })
  .strict();
export type HistoryVersionsResponse = z.infer<
  typeof historyVersionsResponseSchema
>;

export const historyChangeKinds = ["added", "updated", "removed"] as const;
export const historyChangeSchema = z
  .object({
    after: z.string().nullable(),
    before: z.string().nullable(),
    blockId: z.string().min(1).max(256),
    kind: z.enum(historyChangeKinds),
  })
  .strict();
export type HistoryChange = z.infer<typeof historyChangeSchema>;

export const historyDiffSchema = z
  .object({
    changes: z.array(historyChangeSchema),
    document: documentIdentitySchema,
    fromVersionId: historyVersionIdSchema.nullable(),
    toVersionId: historyVersionIdSchema,
  })
  .strict();
export type HistoryDiff = z.infer<typeof historyDiffSchema>;

export const restoreHistoryVersionRequestSchema = z
  .object({ versionId: historyVersionIdSchema })
  .strict();
export type RestoreHistoryVersionRequest = z.infer<
  typeof restoreHistoryVersionRequestSchema
>;

export const restoredHistoryVersionSchema = z
  .object({
    document: documentIdentitySchema,
    restoredVersionId: historyVersionIdSchema,
    versionId: historyVersionIdSchema,
  })
  .strict();
export type RestoredHistoryVersion = z.infer<
  typeof restoredHistoryVersionSchema
>;

export const historyVersionPathParametersSchema = documentIdentitySchema
  .extend({ versionId: historyVersionIdSchema })
  .strict();
export type HistoryVersionPathParameters = z.infer<
  typeof historyVersionPathParametersSchema
>;
export const historyDocumentPathParametersSchema = documentIdentitySchema;
export type HistoryDocumentPathParameters = z.infer<
  typeof historyDocumentPathParametersSchema
>;

export const HISTORY_VERSION_OPENAPI_SCHEMA = strictObjectOpenApiSchema({
  createdAt: { type: "string", format: "date-time" },
  createdByUserId: { type: "string", format: "uuid", nullable: true },
  isCurrent: { type: "boolean" },
  summary: { type: "string", maxLength: 500 },
  versionId: { type: "string", maxLength: 2048, minLength: 1 },
});
export const HISTORY_VERSIONS_RESPONSE_OPENAPI_SCHEMA = strictObjectOpenApiSchema(
  { versions: { type: "array", items: HISTORY_VERSION_OPENAPI_SCHEMA } },
);
export const HISTORY_CHANGE_OPENAPI_SCHEMA = strictObjectOpenApiSchema({
  after: { type: "string", nullable: true },
  before: { type: "string", nullable: true },
  blockId: { type: "string", maxLength: 256, minLength: 1 },
  kind: { type: "string", enum: [...historyChangeKinds] },
});
export const HISTORY_DIFF_OPENAPI_SCHEMA = strictObjectOpenApiSchema({
  changes: { type: "array", items: HISTORY_CHANGE_OPENAPI_SCHEMA },
  document: DOCUMENT_IDENTITY_OPENAPI_SCHEMA,
  fromVersionId: { type: "string", maxLength: 2048, minLength: 1, nullable: true },
  toVersionId: { type: "string", maxLength: 2048, minLength: 1 },
});
export const RESTORE_HISTORY_VERSION_REQUEST_OPENAPI_SCHEMA =
  strictObjectOpenApiSchema({
    versionId: { type: "string", maxLength: 2048, minLength: 1 },
  });
export const RESTORED_HISTORY_VERSION_OPENAPI_SCHEMA = strictObjectOpenApiSchema(
  {
    document: DOCUMENT_IDENTITY_OPENAPI_SCHEMA,
    restoredVersionId: { type: "string", maxLength: 2048, minLength: 1 },
    versionId: { type: "string", maxLength: 2048, minLength: 1 },
  },
);
