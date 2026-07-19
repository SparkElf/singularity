import { z } from "zod";

import {
  strictObjectOpenApiSchema,
  UUID_OPENAPI_SCHEMA,
  type OpenApiSchema,
} from "./openapi.js";
import { spaceNameInputSchema, uuidSchema } from "./spaces.js";

export const spaceBackupStatuses = [
  "failed",
  "queued",
  "running",
  "succeeded",
] as const;
export const spaceBackupStatusSchema = z.enum(spaceBackupStatuses);
export type SpaceBackupStatus = z.infer<typeof spaceBackupStatusSchema>;

export const spaceRestoreStatuses = [
  "activated",
  "failed",
  "queued",
  "restoring",
  "ready-for-activation",
] as const;
export const unactivatedSpaceRestoreStatuses = [
  "queued",
  "restoring",
  "ready-for-activation",
] as const satisfies readonly (typeof spaceRestoreStatuses)[number][];
export type UnactivatedSpaceRestoreStatus =
  (typeof unactivatedSpaceRestoreStatuses)[number];
export const spaceRestoreStatusSchema = z.enum(spaceRestoreStatuses);
export type SpaceRestoreStatus = z.infer<typeof spaceRestoreStatusSchema>;

const dateTimeSchema = z.string().datetime({ offset: true });
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const sizeBytesSchema = z.string().regex(/^(0|[1-9][0-9]*)$/);

export const spaceBackupPathParametersSchema = z
  .object({ organizationId: uuidSchema, spaceId: uuidSchema })
  .strict();
export type SpaceBackupPathParameters = z.infer<
  typeof spaceBackupPathParametersSchema
>;

export const spaceBackupRestorePathParametersSchema = z
  .object({
    backupId: uuidSchema,
    organizationId: uuidSchema,
    spaceId: uuidSchema,
  })
  .strict();
export type SpaceBackupRestorePathParameters = z.infer<
  typeof spaceBackupRestorePathParametersSchema
>;

export const spaceRestorePathParametersSchema = z
  .object({
    organizationId: uuidSchema,
    restoreId: uuidSchema,
    spaceId: uuidSchema,
  })
  .strict();
export type SpaceRestorePathParameters = z.infer<
  typeof spaceRestorePathParametersSchema
>;

export const createSpaceRestoreRequestSchema = z
  .object({ targetSpaceName: spaceNameInputSchema })
  .strict();
export type CreateSpaceRestoreRequest = z.infer<
  typeof createSpaceRestoreRequestSchema
>;

export const spaceBackupSchema = z
  .object({
    backupId: uuidSchema,
    completedAt: dateTimeSchema.nullable(),
    createdAt: dateTimeSchema,
    formatVersion: z.number().int().positive().nullable(),
    kernelVersion: z.string().min(1).nullable(),
    organizationId: uuidSchema,
    sha256: sha256Schema.nullable(),
    sizeBytes: sizeBytesSchema.nullable(),
    sourceSpaceId: uuidSchema,
    status: spaceBackupStatusSchema,
  })
  .strict();
export type SpaceBackupView = z.infer<typeof spaceBackupSchema>;

export const spaceBackupsResponseSchema = z
  .object({ backups: z.array(spaceBackupSchema) })
  .strict();
export type SpaceBackupsResponse = z.infer<typeof spaceBackupsResponseSchema>;

export const spaceRestoreSchema = z
  .object({
    activatedAt: dateTimeSchema.nullable(),
    backupId: uuidSchema,
    createdAt: dateTimeSchema,
    organizationId: uuidSchema,
    restoreId: uuidSchema,
    sourceSpaceId: uuidSchema,
    status: spaceRestoreStatusSchema,
    targetSpaceId: uuidSchema.nullable(),
  })
  .strict();
export type SpaceRestoreView = z.infer<typeof spaceRestoreSchema>;

export const spaceRestoresResponseSchema = z
  .object({ restores: z.array(spaceRestoreSchema) })
  .strict();
export type SpaceRestoresResponse = z.infer<typeof spaceRestoresResponseSchema>;

const DATE_TIME_OPENAPI_SCHEMA: OpenApiSchema = {
  type: "string",
  format: "date-time",
};
const NULLABLE_DATE_TIME_OPENAPI_SCHEMA: OpenApiSchema = {
  ...DATE_TIME_OPENAPI_SCHEMA,
  nullable: true,
};
const NULLABLE_UUID_OPENAPI_SCHEMA: OpenApiSchema = {
  ...UUID_OPENAPI_SCHEMA,
  nullable: true,
};
const NULLABLE_STRING_OPENAPI_SCHEMA: OpenApiSchema = {
  type: "string",
  minLength: 1,
  nullable: true,
};
const NULLABLE_INTEGER_OPENAPI_SCHEMA: OpenApiSchema = {
  type: "integer",
  nullable: true,
};

export const CREATE_SPACE_RESTORE_REQUEST_OPENAPI_SCHEMA =
  strictObjectOpenApiSchema({
    targetSpaceName: { type: "string", minLength: 1, maxLength: 120 },
  });
export const SPACE_BACKUP_OPENAPI_SCHEMA = strictObjectOpenApiSchema({
  backupId: UUID_OPENAPI_SCHEMA,
  completedAt: NULLABLE_DATE_TIME_OPENAPI_SCHEMA,
  createdAt: DATE_TIME_OPENAPI_SCHEMA,
  formatVersion: NULLABLE_INTEGER_OPENAPI_SCHEMA,
  kernelVersion: NULLABLE_STRING_OPENAPI_SCHEMA,
  organizationId: UUID_OPENAPI_SCHEMA,
  sha256: {
    type: "string",
    pattern: "^[a-f0-9]{64}$",
    nullable: true,
  },
  sizeBytes: {
    type: "string",
    pattern: "^(0|[1-9][0-9]*)$",
    nullable: true,
  },
  sourceSpaceId: UUID_OPENAPI_SCHEMA,
  status: { type: "string", enum: [...spaceBackupStatuses] },
});
export const SPACE_BACKUPS_RESPONSE_OPENAPI_SCHEMA = strictObjectOpenApiSchema({
  backups: { type: "array", items: SPACE_BACKUP_OPENAPI_SCHEMA },
});
export const SPACE_RESTORE_OPENAPI_SCHEMA = strictObjectOpenApiSchema({
  activatedAt: NULLABLE_DATE_TIME_OPENAPI_SCHEMA,
  backupId: UUID_OPENAPI_SCHEMA,
  createdAt: DATE_TIME_OPENAPI_SCHEMA,
  organizationId: UUID_OPENAPI_SCHEMA,
  restoreId: UUID_OPENAPI_SCHEMA,
  sourceSpaceId: UUID_OPENAPI_SCHEMA,
  status: { type: "string", enum: [...spaceRestoreStatuses] },
  targetSpaceId: NULLABLE_UUID_OPENAPI_SCHEMA,
});
export const SPACE_RESTORES_RESPONSE_OPENAPI_SCHEMA = strictObjectOpenApiSchema({
  restores: { type: "array", items: SPACE_RESTORE_OPENAPI_SCHEMA },
});
