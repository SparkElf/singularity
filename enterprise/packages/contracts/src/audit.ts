import { z } from "zod";

import {
  strictObjectOpenApiSchema,
  UUID_OPENAPI_SCHEMA,
  type OpenApiSchema,
} from "./openapi.js";
import { uuidSchema } from "./spaces.js";

export const contentAuditActions = [
  "content.delete",
  "content.edit",
  "content.export",
] as const;
export type ContentAuditAction = (typeof contentAuditActions)[number];

export const auditActions = [
  "authentication.login",
  ...contentAuditActions,
  "permission.change",
  "share.create",
  "share.password-change",
  "share.revoke",
  "backup.create",
  "restore.create",
  "restore.activate",
] as const;
export const auditActionSchema = z.enum(auditActions);
export type AuditAction = z.infer<typeof auditActionSchema>;

export const auditOutcomes = [
  "denied",
  "failed",
  "indeterminate",
  "succeeded",
] as const;
export const auditOutcomeSchema = z.enum(auditOutcomes);
export type AuditOutcome = z.infer<typeof auditOutcomeSchema>;

export const auditTargetTypes = [
  "backup",
  "document",
  "group",
  "invitation",
  "membership",
  "oidc-provider",
  "organization",
  "restore",
  "session",
  "share",
  "space",
  "user",
] as const;
export const auditTargetTypeSchema = z.enum(auditTargetTypes);
export type AuditTargetType = z.infer<typeof auditTargetTypeSchema>;

const positiveSequenceSchema = z
  .string()
  .regex(/^[1-9][0-9]*$/)
  .refine((value) => BigInt(value) <= 9_223_372_036_854_775_807n);
const macSchema = z.string().regex(/^[a-f0-9]{64}$/);

export const auditEventsQuerySchema = z
  .object({
    beforeSequence: positiveSequenceSchema
      .optional()
      .transform((value) => (value === undefined ? null : BigInt(value))),
    limit: z
      .string()
      .regex(/^[1-9][0-9]*$/)
      .transform(Number)
      .refine((value) => Number.isSafeInteger(value) && value <= 200)
      .optional()
      .transform((value) => value ?? 50),
  })
  .strict();
export type AuditEventsQuery = z.infer<typeof auditEventsQuerySchema>;

export const auditEventSchema = z
  .object({
    action: auditActionSchema,
    actorUserId: uuidSchema.nullable(),
    auditEventId: uuidSchema,
    keyVersion: z.string().min(1),
    mac: macSchema,
    occurredAt: z.string().datetime({ offset: true }),
    organizationId: uuidSchema,
    outcome: auditOutcomeSchema,
    previousMac: macSchema.nullable(),
    requestId: uuidSchema,
    sequence: positiveSequenceSchema,
    spaceId: uuidSchema.nullable(),
    targetId: z.string().min(1),
    targetType: auditTargetTypeSchema,
  })
  .strict();
export type AuditEventView = z.infer<typeof auditEventSchema>;

export const auditEventsResponseSchema = z
  .object({ events: z.array(auditEventSchema) })
  .strict();
export type AuditEventsResponse = z.infer<typeof auditEventsResponseSchema>;

const NULLABLE_UUID_OPENAPI_SCHEMA: OpenApiSchema = {
  ...UUID_OPENAPI_SCHEMA,
  nullable: true,
};
const MAC_OPENAPI_SCHEMA: OpenApiSchema = {
  type: "string",
  pattern: "^[a-f0-9]{64}$",
};
const NULLABLE_MAC_OPENAPI_SCHEMA: OpenApiSchema = {
  ...MAC_OPENAPI_SCHEMA,
  nullable: true,
};

export const AUDIT_EVENT_OPENAPI_SCHEMA = strictObjectOpenApiSchema({
  action: { type: "string", enum: [...auditActions] },
  actorUserId: NULLABLE_UUID_OPENAPI_SCHEMA,
  auditEventId: UUID_OPENAPI_SCHEMA,
  keyVersion: { type: "string", minLength: 1 },
  mac: MAC_OPENAPI_SCHEMA,
  occurredAt: { type: "string", format: "date-time" },
  organizationId: UUID_OPENAPI_SCHEMA,
  outcome: { type: "string", enum: [...auditOutcomes] },
  previousMac: NULLABLE_MAC_OPENAPI_SCHEMA,
  requestId: UUID_OPENAPI_SCHEMA,
  sequence: { type: "string", pattern: "^[1-9][0-9]*$" },
  spaceId: NULLABLE_UUID_OPENAPI_SCHEMA,
  targetId: { type: "string", minLength: 1 },
  targetType: { type: "string", enum: [...auditTargetTypes] },
});
export const AUDIT_EVENTS_RESPONSE_OPENAPI_SCHEMA = strictObjectOpenApiSchema({
  events: { type: "array", items: AUDIT_EVENT_OPENAPI_SCHEMA },
});
