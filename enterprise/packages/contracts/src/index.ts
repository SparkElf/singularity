export const DATABASE_READINESS_PATH = "/api/v1/health/database";
export const OPENAPI_DOCUMENT_PATH = "/api/openapi.json";

export const DATABASE_READY_RESPONSE = {
  status: "ready",
} as const;

export const DATABASE_UNAVAILABLE_RESPONSE = {
  status: "unavailable",
} as const;

export type DatabaseReadinessResponse =
  | typeof DATABASE_READY_RESPONSE
  | typeof DATABASE_UNAVAILABLE_RESPONSE;

export type DatabaseReadinessStatus = DatabaseReadinessResponse["status"];

export const databaseReadinessStatuses = [
  DATABASE_READY_RESPONSE.status,
  DATABASE_UNAVAILABLE_RESPONSE.status,
] as const satisfies readonly DatabaseReadinessStatus[];

interface OpenApiStringEnumObjectSchema {
  type: "object";
  additionalProperties: false;
  required: string[];
  properties: Record<
    string,
    {
      type: "string";
      enum: string[];
    }
  >;
}

function createDatabaseReadinessOpenApiSchema(
  response: DatabaseReadinessResponse,
): OpenApiStringEnumObjectSchema {
  return {
    type: "object",
    additionalProperties: false,
    required: ["status"],
    properties: {
      status: {
        type: "string",
        enum: [response.status],
      },
    },
  };
}

export const DATABASE_READY_OPENAPI_SCHEMA =
  createDatabaseReadinessOpenApiSchema(DATABASE_READY_RESPONSE);

export const DATABASE_UNAVAILABLE_OPENAPI_SCHEMA: OpenApiStringEnumObjectSchema =
  createDatabaseReadinessOpenApiSchema(DATABASE_UNAVAILABLE_RESPONSE);

export const kernelInstanceStates = [
  "starting",
  "ready",
  "unavailable",
] as const;

export type KernelInstanceState = (typeof kernelInstanceStates)[number];
