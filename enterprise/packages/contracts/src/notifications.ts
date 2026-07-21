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
import { uuidSchema } from "./spaces.js";

export const notificationKinds = [
  "mention",
  "comment-reply",
  "comment-resolved",
  "permission-changed",
  "history-restored",
] as const;
export const notificationKindSchema = z.enum(notificationKinds);
export type NotificationKind = z.infer<typeof notificationKindSchema>;

export const notificationSchema = z
  .object({
    actorUserId: uuidSchema.nullable(),
    createdAt: z.string().datetime({ offset: true }),
    document: documentIdentitySchema,
    kind: notificationKindSchema,
    notificationId: uuidSchema,
    readAt: z.string().datetime({ offset: true }).nullable(),
    threadId: uuidSchema.nullable(),
  })
  .strict();
export type Notification = z.infer<typeof notificationSchema>;

export const notificationsResponseSchema = z
  .object({
    cursor: z.string().nullable(),
    notifications: z.array(notificationSchema),
  })
  .strict();
export type NotificationsResponse = z.infer<typeof notificationsResponseSchema>;

export const notificationUnreadCountSchema = z
  .object({ unreadCount: z.number().int().min(0) })
  .strict();
export type NotificationUnreadCount = z.infer<
  typeof notificationUnreadCountSchema
>;

export const notificationPathParametersSchema = z
  .object({ notificationId: uuidSchema })
  .strict();
export type NotificationPathParameters = z.infer<
  typeof notificationPathParametersSchema
>;
export const notificationsQuerySchema = documentPageQuerySchema;

export const NOTIFICATION_OPENAPI_SCHEMA = strictObjectOpenApiSchema({
  actorUserId: { ...UUID_OPENAPI_SCHEMA, nullable: true },
  createdAt: { type: "string", format: "date-time" },
  document: DOCUMENT_IDENTITY_OPENAPI_SCHEMA,
  kind: { type: "string", enum: [...notificationKinds] },
  notificationId: UUID_OPENAPI_SCHEMA,
  readAt: { type: "string", format: "date-time", nullable: true },
  threadId: { ...UUID_OPENAPI_SCHEMA, nullable: true },
});
export const NOTIFICATIONS_RESPONSE_OPENAPI_SCHEMA = strictObjectOpenApiSchema({
  cursor: { type: "string", nullable: true },
  notifications: { type: "array", items: NOTIFICATION_OPENAPI_SCHEMA },
});
export const NOTIFICATION_UNREAD_COUNT_OPENAPI_SCHEMA = strictObjectOpenApiSchema(
  { unreadCount: { type: "integer", minimum: 0 } },
);
