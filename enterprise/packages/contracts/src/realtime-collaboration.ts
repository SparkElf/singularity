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

export const collaborationFeatureModes = ["standard", "restricted-encrypted"] as const;
export const collaborationFeatureModeSchema = z.enum(collaborationFeatureModes);
export type CollaborationFeatureMode = z.infer<typeof collaborationFeatureModeSchema>;

export const collaborationFeatureSchema = z.object({
  documentId: contentIdSchema,
  notebookId: contentIdSchema,
  organizationId: uuidSchema,
  restrictedEncryptedEnabled: z.boolean(),
  spaceId: uuidSchema,
  standardEnabled: z.boolean(),
}).strict();
export type CollaborationFeature = z.infer<typeof collaborationFeatureSchema>;

export const updateCollaborationFeatureRequestSchema = z.object({
  restrictedEncryptedEnabled: z.boolean(),
  standardEnabled: z.boolean(),
}).strict();
export type UpdateCollaborationFeatureRequest = z.infer<typeof updateCollaborationFeatureRequestSchema>;

export const collaborationProtocolVersionSchema = z.number().int().positive().max(100);
export type CollaborationProtocolVersion = z.infer<typeof collaborationProtocolVersionSchema>;

export const collaborationSessionStates = [
  "connecting",
  "ready",
  "reconnecting",
  "conflict",
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
  "session-generation-mismatch",
  "collaboration-disabled",
  "encrypted-collaboration-unavailable",
  "unsupported-client-version",
  "operation-too-large",
  "rate-limited",
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
    value: z.union([
      z.string().max(100_000),
      z.number(),
      z.boolean(),
      z.record(z.string(), z.unknown()),
      z.null(),
    ]),
  }).strict(),
]);
export const collaborationOperationKinds = [
  "text.insert",
  "text.delete",
  "block.insert",
  "block.move",
  "block.delete",
  "reference.update",
  "embed.update",
  "attribute-view.cell-set",
] as const;
export const collaborationOperationKindSchema = z.enum(collaborationOperationKinds);
export type CollaborationOperationKind = z.infer<typeof collaborationOperationKindSchema>;

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
  sessionGeneration: positiveIntegerSchema,
}).strict();
export type CollaborationOperationEnvelope = z.infer<typeof collaborationOperationEnvelopeSchema>;

export const collaborationConflictKinds = [
  "delete-edit",
  "block-move",
  "attribute-view-cell",
  "reference-target",
] as const;
export const collaborationConflictKindSchema = z.enum(collaborationConflictKinds);
export type CollaborationConflictKind = z.infer<typeof collaborationConflictKindSchema>;

export const collaborationConflictSchema = z.object({
  code: collaborationRejectionCodeSchema,
  conflictId: uuidSchema,
  identity: documentIdentitySchema,
  kind: collaborationConflictKindSchema,
  operationId: uuidSchema,
  sessionGeneration: positiveIntegerSchema,
  status: z.enum(["open", "resolved"]),
}).strict();
export type CollaborationConflict = z.infer<typeof collaborationConflictSchema>;

const operationResultIdentity = { identity: documentIdentitySchema };
export const collaborationOperationResultSchema = z.discriminatedUnion("outcome", [
  z.object({
    ...operationResultIdentity,
    operationId: uuidSchema,
    outcome: z.literal("accepted"),
    serverSequence: positiveIntegerSchema,
    sessionGeneration: positiveIntegerSchema,
  }).strict(),
  z.object({
    ...operationResultIdentity,
    operationId: uuidSchema,
    outcome: z.literal("duplicate"),
    serverSequence: positiveIntegerSchema,
    sessionGeneration: positiveIntegerSchema,
  }).strict(),
  z.object({
    ...operationResultIdentity,
    code: collaborationRejectionCodeSchema,
    operationId: uuidSchema,
    outcome: z.literal("rejected"),
    sessionGeneration: positiveIntegerSchema,
  }).strict(),
  z.object({
    ...operationResultIdentity,
    conflict: collaborationConflictSchema,
    operationId: uuidSchema,
    outcome: z.literal("conflict"),
    sessionGeneration: positiveIntegerSchema,
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
  featureMode: collaborationFeatureModeSchema,
  identity: documentIdentitySchema,
  protocolVersion: collaborationProtocolVersionSchema,
}).strict();
export type CollaborationJoinRequest = z.infer<typeof collaborationJoinRequestSchema>;

export const collaborationJoinResponseSchema = z.object({
  capability: collaborationCapabilitySchema,
  featureMode: collaborationFeatureModeSchema,
  identity: documentIdentitySchema,
  protocolVersion: collaborationProtocolVersionSchema,
  sessionState: z.literal("ready"),
  sessionGeneration: positiveIntegerSchema,
  version: collaborationVersionVectorSchema,
}).strict();
export type CollaborationJoinResponse = z.infer<typeof collaborationJoinResponseSchema>;

export const collaborationResumeRequestSchema = z.object({
  causalContext: collaborationVersionVectorSchema,
  clientId: uuidSchema,
  identity: documentIdentitySchema,
  sessionGeneration: positiveIntegerSchema,
}).strict();
export type CollaborationResumeRequest = z.infer<typeof collaborationResumeRequestSchema>;

export const collaborationPresenceSchema = z.object({
  clientId: uuidSchema,
  cursor: z.object({ blockId: contentIdSchema, offset: nonNegativeIntegerSchema }).nullable(),
  identity: documentIdentitySchema,
  sessionGeneration: positiveIntegerSchema,
  ttlMs: z.number().int().min(1_000).max(60_000),
}).strict();
export type CollaborationPresence = z.infer<typeof collaborationPresenceSchema>;

export const collaborationRevocationSchema = z.object({
  identity: documentIdentitySchema,
  reason: z.literal("permission-revoked"),
  sessionGeneration: positiveIntegerSchema,
  sessionState: z.literal("revoked"),
}).strict();
export type CollaborationRevocation = z.infer<typeof collaborationRevocationSchema>;

export const collaborationClientMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("join"), request: collaborationJoinRequestSchema }).strict(),
  z.object({ type: z.literal("submit"), envelope: collaborationOperationEnvelopeSchema }).strict(),
  z.object({ type: z.literal("resume"), request: collaborationResumeRequestSchema }).strict(),
  z.object({ type: z.literal("presence"), presence: collaborationPresenceSchema }).strict(),
  z.object({ type: z.literal("leave") }).strict(),
]);
export type CollaborationClientMessage = z.infer<typeof collaborationClientMessageSchema>;

export const collaborationWebSocketErrorCodes = [
  "unauthenticated",
  "forbidden",
  "invalid-message",
  "service-unavailable",
  "duplicate-session",
  "collaboration-capacity-exceeded",
  "collaboration-disabled",
  "encrypted-collaboration-unavailable",
  "unsupported-client-version",
] as const;
export const collaborationWebSocketErrorCodeSchema = z.enum(collaborationWebSocketErrorCodes);
export type CollaborationWebSocketErrorCode = z.infer<typeof collaborationWebSocketErrorCodeSchema>;

export const collaborationServerMessageSchema = z.discriminatedUnion("type", [
  z.object({ response: collaborationJoinResponseSchema, type: z.literal("joined") }).strict(),
  z.object({ result: collaborationOperationResultSchema, type: z.literal("operation-result") }).strict(),
  z.object({ broadcast: collaborationBroadcastSchema, type: z.literal("operation-broadcast") }).strict(),
  z.object({ broadcasts: z.array(collaborationBroadcastSchema), type: z.literal("resumed") }).strict(),
  z.object({ presence: z.array(collaborationPresenceSchema), type: z.literal("presence") }).strict(),
  z.object({ revocation: collaborationRevocationSchema, type: z.literal("revoked") }).strict(),
  z.object({ code: collaborationWebSocketErrorCodeSchema, type: z.literal("error") }).strict(),
]);
export type CollaborationServerMessage = z.infer<typeof collaborationServerMessageSchema>;

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
  sessionGeneration: { type: "integer", minimum: 1 },
});

export const COLLABORATION_FEATURE_OPENAPI_SCHEMA = strictObjectOpenApiSchema({
  ...DOCUMENT_IDENTITY_OPENAPI_SCHEMA.properties,
  restrictedEncryptedEnabled: { type: "boolean" },
  standardEnabled: { type: "boolean" },
});

export const UPDATE_COLLABORATION_FEATURE_REQUEST_OPENAPI_SCHEMA =
  strictObjectOpenApiSchema({
    restrictedEncryptedEnabled: { type: "boolean" },
    standardEnabled: { type: "boolean" },
  });
