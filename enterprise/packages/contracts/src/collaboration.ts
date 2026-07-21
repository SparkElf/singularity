import { z } from "zod";

import {
  DOCUMENT_IDENTITY_OPENAPI_SCHEMA,
  documentIdentitySchema,
  documentPageQuerySchema,
} from "./document-identity.js";
import {
  strictObjectOpenApiSchema,
  UUID_OPENAPI_SCHEMA,
} from "./openapi.js";
import { contentIdSchema } from "./shares.js";
import { uuidSchema } from "./spaces.js";

export const commentThreadStatuses = ["open", "resolved", "deleted"] as const;
export const commentThreadStatusSchema = z.enum(commentThreadStatuses);
export type CommentThreadStatus = z.infer<typeof commentThreadStatusSchema>;

export const commentBodySchema = z.string().trim().min(1).max(20_000);
export const commentAnchorBlockIdSchema = contentIdSchema;

export const commentThreadSchema = z
  .object({
    ...documentIdentitySchema.shape,
    anchorBlockId: commentAnchorBlockIdSchema.nullable(),
    createdAt: z.string().datetime({ offset: true }),
    createdByUserId: uuidSchema,
    resolvedAt: z.string().datetime({ offset: true }).nullable(),
    status: commentThreadStatusSchema,
    threadId: uuidSchema,
  })
  .strict();
export type CommentThread = z.infer<typeof commentThreadSchema>;

export const commentEntrySchema = z
  .object({
    authorUserId: uuidSchema,
    body: z.string(),
    createdAt: z.string().datetime({ offset: true }),
    deletedAt: z.string().datetime({ offset: true }).nullable(),
    editedAt: z.string().datetime({ offset: true }).nullable(),
    entryId: uuidSchema,
    threadId: uuidSchema,
  })
  .strict();
export type CommentEntry = z.infer<typeof commentEntrySchema>;

export const commentThreadDetailSchema = z
  .object({
    entries: z.array(commentEntrySchema),
    thread: commentThreadSchema,
  })
  .strict();
export type CommentThreadDetail = z.infer<typeof commentThreadDetailSchema>;

export const commentThreadsResponseSchema = z
  .object({
    cursor: z.string().nullable(),
    threads: z.array(commentThreadSchema),
  })
  .strict();
export type CommentThreadsResponse = z.infer<
  typeof commentThreadsResponseSchema
>;

export const createCommentThreadRequestSchema = z
  .object({
    anchorBlockId: commentAnchorBlockIdSchema.nullable(),
    body: commentBodySchema,
    mentionedUserIds: z.array(uuidSchema).max(100),
  })
  .strict();
export type CreateCommentThreadRequest = z.infer<
  typeof createCommentThreadRequestSchema
>;

export const createCommentReplyRequestSchema = z
  .object({
    body: commentBodySchema,
    mentionedUserIds: z.array(uuidSchema).max(100),
  })
  .strict();
export type CreateCommentReplyRequest = z.infer<
  typeof createCommentReplyRequestSchema
>;

export const updateCommentEntryRequestSchema = z
  .object({ body: commentBodySchema })
  .strict();
export type UpdateCommentEntryRequest = z.infer<
  typeof updateCommentEntryRequestSchema
>;

export const updateCommentThreadStatusRequestSchema = z
  .object({ status: z.enum(["open", "resolved"]) })
  .strict();
export type UpdateCommentThreadStatusRequest = z.infer<
  typeof updateCommentThreadStatusRequestSchema
>;

export const commentThreadPathParametersSchema = documentIdentitySchema
  .extend({ threadId: uuidSchema })
  .strict();
export const commentEntryPathParametersSchema = commentThreadPathParametersSchema
  .extend({ entryId: uuidSchema })
  .strict();
export type CommentThreadPathParameters = z.infer<
  typeof commentThreadPathParametersSchema
>;
export type CommentEntryPathParameters = z.infer<
  typeof commentEntryPathParametersSchema
>;
export const commentThreadsQuerySchema = documentPageQuerySchema;

export const commentMentionCandidatesQuerySchema = z
  .object({ query: z.string().trim().max(120).optional() })
  .strict();
export type CommentMentionCandidatesQuery = z.infer<
  typeof commentMentionCandidatesQuerySchema
>;

export const commentMentionCandidateSchema = z
  .object({ loginIdentifier: z.string().min(1).max(254), userId: uuidSchema })
  .strict();
export type CommentMentionCandidate = z.infer<
  typeof commentMentionCandidateSchema
>;
export const commentMentionCandidatesResponseSchema = z
  .object({ candidates: z.array(commentMentionCandidateSchema).max(100) })
  .strict();
export type CommentMentionCandidatesResponse = z.infer<
  typeof commentMentionCandidatesResponseSchema
>;

const NULLABLE_DATE_TIME_OPENAPI_SCHEMA = {
  type: "string" as const,
  format: "date-time",
  nullable: true,
};
export const COMMENT_THREAD_OPENAPI_SCHEMA = strictObjectOpenApiSchema({
  ...DOCUMENT_IDENTITY_OPENAPI_SCHEMA.properties,
  anchorBlockId: { type: "string", nullable: true },
  createdAt: { type: "string", format: "date-time" },
  createdByUserId: UUID_OPENAPI_SCHEMA,
  resolvedAt: NULLABLE_DATE_TIME_OPENAPI_SCHEMA,
  status: { type: "string", enum: [...commentThreadStatuses] },
  threadId: UUID_OPENAPI_SCHEMA,
});
export const COMMENT_ENTRY_OPENAPI_SCHEMA = strictObjectOpenApiSchema({
  authorUserId: UUID_OPENAPI_SCHEMA,
  body: { type: "string" },
  createdAt: { type: "string", format: "date-time" },
  deletedAt: NULLABLE_DATE_TIME_OPENAPI_SCHEMA,
  editedAt: NULLABLE_DATE_TIME_OPENAPI_SCHEMA,
  entryId: UUID_OPENAPI_SCHEMA,
  threadId: UUID_OPENAPI_SCHEMA,
});
export const COMMENT_THREAD_DETAIL_OPENAPI_SCHEMA = strictObjectOpenApiSchema({
  entries: { type: "array", items: COMMENT_ENTRY_OPENAPI_SCHEMA },
  thread: COMMENT_THREAD_OPENAPI_SCHEMA,
});
export const COMMENT_THREADS_RESPONSE_OPENAPI_SCHEMA = strictObjectOpenApiSchema(
  {
    cursor: { type: "string", nullable: true },
    threads: { type: "array", items: COMMENT_THREAD_OPENAPI_SCHEMA },
  },
);
export const CREATE_COMMENT_THREAD_REQUEST_OPENAPI_SCHEMA =
  strictObjectOpenApiSchema({
    anchorBlockId: { type: "string", nullable: true },
    body: { type: "string", maxLength: 20_000, minLength: 1 },
    mentionedUserIds: { type: "array", items: UUID_OPENAPI_SCHEMA, maxItems: 100 },
  });
export const CREATE_COMMENT_REPLY_REQUEST_OPENAPI_SCHEMA =
  strictObjectOpenApiSchema({
    body: { type: "string", maxLength: 20_000, minLength: 1 },
    mentionedUserIds: { type: "array", items: UUID_OPENAPI_SCHEMA, maxItems: 100 },
  });
export const UPDATE_COMMENT_ENTRY_REQUEST_OPENAPI_SCHEMA =
  strictObjectOpenApiSchema({
    body: { type: "string", maxLength: 20_000, minLength: 1 },
  });
export const UPDATE_COMMENT_THREAD_STATUS_REQUEST_OPENAPI_SCHEMA =
  strictObjectOpenApiSchema({
    status: { type: "string", enum: ["open", "resolved"] },
  });
export const COMMENT_MENTION_CANDIDATE_OPENAPI_SCHEMA = strictObjectOpenApiSchema(
  {
    loginIdentifier: { type: "string", maxLength: 254, minLength: 1 },
    userId: UUID_OPENAPI_SCHEMA,
  },
);
export const COMMENT_MENTION_CANDIDATES_RESPONSE_OPENAPI_SCHEMA =
  strictObjectOpenApiSchema({
    candidates: {
      type: "array",
      items: COMMENT_MENTION_CANDIDATE_OPENAPI_SCHEMA,
      maxItems: 100,
    },
  });
