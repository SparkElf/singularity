import { z } from "zod";

import {
  type OpenApiSchema,
  strictObjectOpenApiSchema,
  UUID_OPENAPI_SCHEMA,
} from "./openapi.js";

export const RUNTIME_ACCESS_LOST_HEADER_NAME =
  "X-Singularity-Runtime-Access-Lost";
export const RUNTIME_ACCESS_LOST_HEADER_VALUE = "true";

export const apiProblemCodes = [
  "unauthenticated",
  "forbidden",
  "not-found",
  "validation-failed",
  "conflict",
  "rate-limited",
  "service-unavailable",
] as const;

export type ApiProblemCode = (typeof apiProblemCodes)[number];

export const apiProblemStatuses = {
  unauthenticated: [401],
  forbidden: [403],
  "not-found": [404],
  "validation-failed": [400, 422],
  conflict: [409],
  "rate-limited": [429],
  "service-unavailable": [502, 503, 504],
} as const satisfies Record<ApiProblemCode, readonly [number, ...number[]]>;

export type ApiProblemStatus =
  (typeof apiProblemStatuses)[ApiProblemCode][number];

function statusSchema<const TStatuses extends readonly [number, ...number[]]>(
  statuses: TStatuses,
): z.ZodType<TStatuses[number]> {
  return z.number().int().refine((status) => statuses.includes(status));
}

function problemVariantSchema<
  const TCode extends ApiProblemCode,
  const TStatuses extends readonly [number, ...number[]],
>(code: TCode, statuses: TStatuses) {
  return z
    .object({
      code: z.literal(code),
      status: statusSchema(statuses),
      requestId: z.string().uuid(),
    })
    .strict();
}

export const apiProblemSchema = z.discriminatedUnion("code", [
  problemVariantSchema(
    "unauthenticated",
    apiProblemStatuses.unauthenticated,
  ),
  problemVariantSchema("forbidden", apiProblemStatuses.forbidden),
  problemVariantSchema("not-found", apiProblemStatuses["not-found"]),
  problemVariantSchema(
    "validation-failed",
    apiProblemStatuses["validation-failed"],
  ),
  problemVariantSchema("conflict", apiProblemStatuses.conflict),
  problemVariantSchema("rate-limited", apiProblemStatuses["rate-limited"]),
  problemVariantSchema(
    "service-unavailable",
    apiProblemStatuses["service-unavailable"],
  ),
]);

export type ApiProblem = z.infer<typeof apiProblemSchema>;

function createProblemVariantOpenApiSchema(
  code: ApiProblemCode,
  status: ApiProblemStatus,
): OpenApiSchema {
  return strictObjectOpenApiSchema({
    code: {
      type: "string",
      enum: [code],
    },
    status: {
      type: "integer",
      enum: [status],
    },
    requestId: UUID_OPENAPI_SCHEMA,
  });
}

export const API_PROBLEM_OPENAPI_SCHEMA_BY_STATUS = {
  400: createProblemVariantOpenApiSchema("validation-failed", 400),
  401: createProblemVariantOpenApiSchema("unauthenticated", 401),
  403: createProblemVariantOpenApiSchema("forbidden", 403),
  404: createProblemVariantOpenApiSchema("not-found", 404),
  409: createProblemVariantOpenApiSchema("conflict", 409),
  422: createProblemVariantOpenApiSchema("validation-failed", 422),
  429: createProblemVariantOpenApiSchema("rate-limited", 429),
  502: createProblemVariantOpenApiSchema("service-unavailable", 502),
  503: createProblemVariantOpenApiSchema("service-unavailable", 503),
  504: createProblemVariantOpenApiSchema("service-unavailable", 504),
} as const satisfies Record<ApiProblemStatus, OpenApiSchema>;
