import { z } from "zod";

import {
  type OpenApiSchema,
  strictObjectOpenApiSchema,
  UUID_OPENAPI_SCHEMA,
} from "./openapi.js";

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
  statuses: readonly number[],
): OpenApiSchema {
  return strictObjectOpenApiSchema({
    code: {
      type: "string",
      enum: [code],
    },
    status: {
      type: "integer",
      enum: [...statuses],
    },
    requestId: UUID_OPENAPI_SCHEMA,
  });
}

export const API_PROBLEM_OPENAPI_SCHEMA: OpenApiSchema = {
  oneOf: apiProblemCodes.map((code) =>
    createProblemVariantOpenApiSchema(code, apiProblemStatuses[code]),
  ),
};
