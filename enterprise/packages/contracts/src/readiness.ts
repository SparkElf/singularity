import { z } from "zod";

import {
  type OpenApiSchema,
  strictObjectOpenApiSchema,
} from "./openapi.js";

export const databaseReadinessStatuses = ["ready", "unavailable"] as const;

export const databaseReadinessStatusSchema = z.enum(
  databaseReadinessStatuses,
);

export const databaseReadinessResponseSchema = z
  .object({
    status: databaseReadinessStatusSchema,
  })
  .strict();

export type DatabaseReadinessResponse = z.infer<
  typeof databaseReadinessResponseSchema
>;
export type DatabaseReadinessStatus = DatabaseReadinessResponse["status"];

export const DATABASE_READY_RESPONSE = {
  status: "ready",
} as const satisfies DatabaseReadinessResponse;

export const DATABASE_UNAVAILABLE_RESPONSE = {
  status: "unavailable",
} as const satisfies DatabaseReadinessResponse;

function createDatabaseReadinessOpenApiSchema(
  response: DatabaseReadinessResponse,
): OpenApiSchema {
  return strictObjectOpenApiSchema({
    status: {
      type: "string",
      enum: [response.status],
    },
  });
}

export const DATABASE_READY_OPENAPI_SCHEMA =
  createDatabaseReadinessOpenApiSchema(DATABASE_READY_RESPONSE);

export const DATABASE_UNAVAILABLE_OPENAPI_SCHEMA =
  createDatabaseReadinessOpenApiSchema(DATABASE_UNAVAILABLE_RESPONSE);
