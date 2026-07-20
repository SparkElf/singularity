import { z } from "zod";

import {
  strictObjectOpenApiSchema,
  type OpenApiSchema,
} from "./openapi.js";
import { CONTENT_ID_PATTERN, contentIdSchema } from "./shares.js";
import { spaceRuntimePathParametersSchema } from "./spaces.js";

export const CONTENT_DIRECTORY_PAGE_SIZE = 128;
export const CONTENT_DIRECTORY_MAX_OFFSET = 1_000_000;

export const contentDirectorySpacePathParametersSchema =
  spaceRuntimePathParametersSchema;
export type ContentDirectoryNotebooksPathParameters = z.infer<
  typeof contentDirectorySpacePathParametersSchema
>;

export const contentDirectoryNotebookPathParametersSchema =
  spaceRuntimePathParametersSchema
    .extend({ notebookId: contentIdSchema })
    .strict();
export type ContentDirectoryRootDocumentsPathParameters = z.infer<
  typeof contentDirectoryNotebookPathParametersSchema
> & { readonly offset: number };

export const contentDirectoryChildPathParametersSchema =
  contentDirectoryNotebookPathParametersSchema
    .extend({ documentId: contentIdSchema })
    .strict();
export type ContentDirectoryChildDocumentsPathParameters = z.infer<
  typeof contentDirectoryChildPathParametersSchema
> & { readonly offset: number };

const contentDirectoryOffsetSchema = z
  .string()
  .regex(/^(0|[1-9][0-9]*)$/)
  .transform(Number)
  .refine(
    (value) =>
      Number.isSafeInteger(value) && value <= CONTENT_DIRECTORY_MAX_OFFSET,
  );

export const contentDirectoryQuerySchema = z
  .object({
    offset: contentDirectoryOffsetSchema
      .optional()
      .transform((value) => value ?? 0),
  })
  .strict();
export type ContentDirectoryQuery = z.infer<
  typeof contentDirectoryQuerySchema
>;

export const contentDirectoryNotebooksQuerySchema = z.object({}).strict();
export type ContentDirectoryNotebooksQuery = z.infer<
  typeof contentDirectoryNotebooksQuerySchema
>;

export const contentDirectoryNotebookSchema = z
  .object({
    icon: z.string(),
    locked: z.boolean(),
    name: z.string(),
    notebookId: contentIdSchema,
    supportsGraph: z.boolean(),
  })
  .strict();
export type ContentDirectoryNotebook = z.infer<
  typeof contentDirectoryNotebookSchema
>;

export const contentDirectoryDocumentSchema = z
  .object({
    documentId: contentIdSchema,
    hasChildren: z.boolean(),
    icon: z.string(),
    notebookId: contentIdSchema,
    title: z.string(),
  })
  .strict();
export type ContentDirectoryDocument = z.infer<
  typeof contentDirectoryDocumentSchema
>;

export const contentDirectoryNotebooksResponseSchema = z
  .object({ notebooks: z.array(contentDirectoryNotebookSchema) })
  .strict();
export type ContentDirectoryNotebooksResponse = z.infer<
  typeof contentDirectoryNotebooksResponseSchema
>;

export const contentDirectoryDocumentsResponseSchema = z
  .object({
    documents: z
      .array(contentDirectoryDocumentSchema)
      .max(CONTENT_DIRECTORY_PAGE_SIZE),
    locked: z.boolean(),
    nextOffset: z
      .number()
      .int()
      .min(0)
      .max(CONTENT_DIRECTORY_MAX_OFFSET)
      .nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.locked &&
      (value.documents.length !== 0 || value.nextOffset !== null)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Locked content directories cannot expose documents",
      });
    }
  });
export type ContentDirectoryDocumentsResponse = z.infer<
  typeof contentDirectoryDocumentsResponseSchema
>;

const CONTENT_ID_OPENAPI_SCHEMA: OpenApiSchema = {
  type: "string",
  pattern: CONTENT_ID_PATTERN.source,
};

export const CONTENT_DIRECTORY_NOTEBOOK_OPENAPI_SCHEMA =
  strictObjectOpenApiSchema({
    icon: { type: "string" },
    locked: { type: "boolean" },
    name: { type: "string" },
    notebookId: CONTENT_ID_OPENAPI_SCHEMA,
    supportsGraph: { type: "boolean" },
  });

export const CONTENT_DIRECTORY_DOCUMENT_OPENAPI_SCHEMA =
  strictObjectOpenApiSchema({
    documentId: CONTENT_ID_OPENAPI_SCHEMA,
    hasChildren: { type: "boolean" },
    icon: { type: "string" },
    notebookId: CONTENT_ID_OPENAPI_SCHEMA,
    title: { type: "string" },
  });

export const CONTENT_DIRECTORY_NOTEBOOKS_RESPONSE_OPENAPI_SCHEMA =
  strictObjectOpenApiSchema({
    notebooks: {
      type: "array",
      items: CONTENT_DIRECTORY_NOTEBOOK_OPENAPI_SCHEMA,
    },
  });

export const CONTENT_DIRECTORY_DOCUMENTS_RESPONSE_OPENAPI_SCHEMA =
  strictObjectOpenApiSchema({
    documents: {
      type: "array",
      items: CONTENT_DIRECTORY_DOCUMENT_OPENAPI_SCHEMA,
      maxItems: CONTENT_DIRECTORY_PAGE_SIZE,
    },
    locked: { type: "boolean" },
    nextOffset: { type: "integer", nullable: true },
  });
