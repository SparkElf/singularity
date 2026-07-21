import { z } from "zod";

import {
  DOCUMENT_IDENTITY_OPENAPI_SCHEMA,
  documentIdentitySchema,
} from "./document-identity.js";
import { strictObjectOpenApiSchema, UUID_OPENAPI_SCHEMA } from "./openapi.js";
import { contentIdSchema } from "./shares.js";
import { uuidSchema } from "./spaces.js";

const nonNegativeIntegerSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const positiveIntegerSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const blockTypeSchema = z.enum(["paragraph", "heading", "list", "container"]);
const targetIdentitySchema = z
  .object({
    blockId: contentIdSchema,
    documentId: contentIdSchema,
    notebookId: contentIdSchema,
  })
  .strict();

export const collaborationCapabilities = ["editor", "viewer", "commenter"] as const;
export const collaborationCapabilitySchema = z.enum(collaborationCapabilities);
export type CollaborationCapability = z.infer<typeof collaborationCapabilitySchema>;

export const collaborationSessionStates = [
  "connecting",
  "ready",
  "reconnecting",
  "revoked",
  "closed",
] as const;
export const collaborationSessionStateSchema = z.enum(collaborationSessionStates);
export type CollaborationSessionState = z.infer<typeof collaborationSessionStateSchema>;

export const collaborationRejectionCodes = [
  "invalid-operation",
  "missing-identity",
  "permission-revoked",
  "causal-context-expired",
  "duplicate-operation-conflict",
  "structure-conflict",
  "reference-target-missing",
  "attribute-view-conflict",
  "session-not-ready",
] as const;
export const collaborationRejectionCodeSchema = z.enum(collaborationRejectionCodes);
export type CollaborationRejectionCode = z.infer<typeof collaborationRejectionCodeSchema>;

const collaborationOperationUnionSchema = z.discriminatedUnion("kind", [
  z.object({
    blockId: contentIdSchema,
    kind: z.literal("text.insert"),
    position: nonNegativeIntegerSchema,
    text: z.string().min(1).max(100_000),
  }).strict(),
  z.object({
    blockId: contentIdSchema,
    from: nonNegativeIntegerSchema,
    kind: z.literal("text.delete"),
    to: positiveIntegerSchema,
  }).strict(),
  z.object({
    blockId: contentIdSchema,
    blockType: blockTypeSchema,
    content: z.string().max(100_000),
    index: nonNegativeIntegerSchema,
    kind: z.literal("block.insert"),
    parentBlockId: contentIdSchema.nullable(),
  }).strict(),
  z.object({
    blockId: contentIdSchema,
    index: nonNegativeIntegerSchema,
    kind: z.literal("block.move"),
    parentBlockId: contentIdSchema.nullable(),
  }).strict(),
  z.object({
    blockId: contentIdSchema,
    kind: z.literal("block.delete"),
  }).strict(),
  z.object({
    blockId: contentIdSchema,
    kind: z.literal("reference.update"),
    target: targetIdentitySchema.nullable(),
  }).strict(),
  z.object({
    blockId: contentIdSchema,
    embedType: z.string().min(1).max(120),
    kind: z.literal("embed.update"),
    target: targetIdentitySchema.nullable(),
  }).strict(),
  z.object({
    attributeViewId: contentIdSchema,
    columnId: contentIdSchema,
    kind: z.literal("attribute-view.cell-set"),
    rowId: contentIdSchema,
    value: z.union([z.string().max(100_000), z.number(), z.boolean(), z.null()]),
  }).strict(),
]);
export const collaborationOperationSchema = collaborationOperationUnionSchema.superRefine((value, context) => {
  if (value.kind === "text.delete" && value.to <= value.from) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "text.delete range must be non-empty" });
  }
});
export type CollaborationOperation = z.infer<typeof collaborationOperationSchema>;

export const collaborationVersionVectorSchema = z.record(
  z.string().min(1).max(120),
  nonNegativeIntegerSchema,
);
export type CollaborationVersionVector = z.infer<typeof collaborationVersionVectorSchema>;

export const collaborationOperationEnvelopeSchema = z.object({
  causalContext: collaborationVersionVectorSchema,
  clientId: uuidSchema,
  clientSequence: positiveIntegerSchema,
  identity: documentIdentitySchema,
  operation: collaborationOperationSchema,
  operationId: uuidSchema,
}).strict();
export type CollaborationOperationEnvelope = z.infer<typeof collaborationOperationEnvelopeSchema>;

const operationResultIdentity = { identity: documentIdentitySchema };
export const collaborationOperationResultSchema = z.discriminatedUnion("outcome", [
  z.object({
    ...operationResultIdentity,
    operationId: uuidSchema,
    outcome: z.literal("accepted"),
    serverSequence: positiveIntegerSchema,
  }).strict(),
  z.object({
    ...operationResultIdentity,
    operationId: uuidSchema,
    outcome: z.literal("duplicate"),
    serverSequence: positiveIntegerSchema,
  }).strict(),
  z.object({
    ...operationResultIdentity,
    code: collaborationRejectionCodeSchema,
    operationId: uuidSchema,
    outcome: z.literal("rejected"),
  }).strict(),
]);
export type CollaborationOperationResult = z.infer<typeof collaborationOperationResultSchema>;

export const collaborationBroadcastSchema = z.object({
  identity: documentIdentitySchema,
  operation: collaborationOperationEnvelopeSchema,
  serverSequence: positiveIntegerSchema,
}).strict();
export type CollaborationBroadcast = z.infer<typeof collaborationBroadcastSchema>;

export const collaborationJoinRequestSchema = z.object({
  capability: collaborationCapabilitySchema,
  clientId: uuidSchema,
  identity: documentIdentitySchema,
}).strict();
export type CollaborationJoinRequest = z.infer<typeof collaborationJoinRequestSchema>;

export const collaborationJoinResponseSchema = z.object({
  capability: collaborationCapabilitySchema,
  identity: documentIdentitySchema,
  sessionState: z.literal("ready"),
  version: collaborationVersionVectorSchema,
}).strict();
export type CollaborationJoinResponse = z.infer<typeof collaborationJoinResponseSchema>;

export const collaborationResumeRequestSchema = z.object({
  causalContext: collaborationVersionVectorSchema,
  clientId: uuidSchema,
  identity: documentIdentitySchema,
}).strict();
export type CollaborationResumeRequest = z.infer<typeof collaborationResumeRequestSchema>;

export const collaborationPresenceSchema = z.object({
  clientId: uuidSchema,
  cursor: z.object({ blockId: contentIdSchema, offset: nonNegativeIntegerSchema }).nullable(),
  identity: documentIdentitySchema,
  ttlMs: z.number().int().min(1_000).max(60_000),
}).strict();
export type CollaborationPresence = z.infer<typeof collaborationPresenceSchema>;

export const collaborationRevocationSchema = z.object({
  identity: documentIdentitySchema,
  reason: z.literal("permission-revoked"),
  sessionState: z.literal("revoked"),
}).strict();
export type CollaborationRevocation = z.infer<typeof collaborationRevocationSchema>;

export const COLLABORATION_OPERATION_OPENAPI_SCHEMA = strictObjectOpenApiSchema({
  kind: { type: "string" },
});
export const COLLABORATION_OPERATION_ENVELOPE_OPENAPI_SCHEMA = strictObjectOpenApiSchema({
  causalContext: { type: "object", additionalProperties: false },
  clientId: UUID_OPENAPI_SCHEMA,
  clientSequence: { type: "integer", minimum: 1 },
  identity: DOCUMENT_IDENTITY_OPENAPI_SCHEMA,
  operation: COLLABORATION_OPERATION_OPENAPI_SCHEMA,
  operationId: UUID_OPENAPI_SCHEMA,
});
