import { z } from "zod";

import { strictObjectOpenApiSchema, UUID_OPENAPI_SCHEMA } from "./openapi.js";
import { CONTENT_ID_PATTERN, contentIdSchema } from "./shares.js";
import { uuidSchema } from "./spaces.js";

/** L2 所有文档请求共享的内容身份；下游不得从路径、DOM 或首个响应推断缺失 ID。 */
export const documentIdentitySchema = z
  .object({
    documentId: contentIdSchema,
    notebookId: contentIdSchema,
    organizationId: uuidSchema,
    spaceId: uuidSchema,
  })
  .strict();
export type DocumentIdentity = z.infer<typeof documentIdentitySchema>;

export const DOCUMENT_IDENTITY_OPENAPI_SCHEMA = strictObjectOpenApiSchema({
  documentId: { type: "string", pattern: CONTENT_ID_PATTERN.source },
  notebookId: { type: "string", pattern: CONTENT_ID_PATTERN.source },
  organizationId: UUID_OPENAPI_SCHEMA,
  spaceId: UUID_OPENAPI_SCHEMA,
});

export const documentPageQuerySchema = z
  .object({
    cursor: z
      .string()
      .min(1)
      .max(256)
      .regex(/^[A-Za-z0-9_-]+$/)
      .optional(),
    limit: z
      .string()
      .regex(/^[1-9][0-9]*$/)
      .transform(Number)
      .refine((value) => Number.isSafeInteger(value) && value <= 100)
      .optional()
      .transform((value) => value ?? 50),
  })
  .strict();
export type DocumentPageQuery = z.infer<typeof documentPageQuerySchema>;

export const DOCUMENT_PAGE_QUERY_OPENAPI_SCHEMA = strictObjectOpenApiSchema(
  {
    cursor: { type: "string", maxLength: 256, minLength: 1 },
    limit: { type: "integer", maximum: 100, minimum: 1 },
  },
  [],
);

export const documentPathParametersSchema = documentIdentitySchema;
export type DocumentPathParameters = DocumentIdentity;
