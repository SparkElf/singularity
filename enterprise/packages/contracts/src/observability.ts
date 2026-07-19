import { z } from "zod";

import {
  strictObjectOpenApiSchema,
  UUID_OPENAPI_SCHEMA,
} from "./openapi.js";
import { uuidSchema } from "./spaces.js";

const dateTimeSchema = z.string().datetime({ offset: true });
const countSchema = z.string().regex(/^(0|[1-9][0-9]*)$/);

const availableCapacitySchema = z
  .object({
    assetBytes: countSchema,
    dataBytes: countSchema,
    fileCount: countSchema,
    sampleDurationMilliseconds: z.number().int().nonnegative(),
    sampledAt: dateTimeSchema,
    status: z.enum(["fresh", "stale"]),
  })
  .strict();
const unavailableSampledCapacitySchema = z
  .object({
    reason: z.literal("sample-failed"),
    sampledAt: dateTimeSchema,
    status: z.literal("unavailable"),
  })
  .strict();
const unavailableUnsampledCapacitySchema = z
  .object({ reason: z.literal("no-sample"), status: z.literal("unavailable") })
  .strict();
export const spaceCapacityViewSchema = z.union([
  availableCapacitySchema,
  unavailableSampledCapacitySchema,
  unavailableUnsampledCapacitySchema,
]);

const availableHealthSchema = z
  .object({
    kernelVersion: z.string().min(1),
    sampledAt: dateTimeSchema,
    status: z.enum(["ready", "stale"]),
  })
  .strict();
const unavailableSampledHealthSchema = z
  .object({
    reason: z.enum(["kernel-unavailable", "sample-failed"]),
    sampledAt: dateTimeSchema,
    status: z.literal("unavailable"),
  })
  .strict();
const unavailableUnsampledHealthSchema = z
  .object({
    reason: z.enum(["kernel-unavailable", "no-sample"]),
    status: z.literal("unavailable"),
  })
  .strict();
export const spaceHealthViewSchema = z.union([
  availableHealthSchema,
  unavailableSampledHealthSchema,
  unavailableUnsampledHealthSchema,
]);

export const spaceObservabilitySchema = z
  .object({
    capacity: spaceCapacityViewSchema,
    health: spaceHealthViewSchema,
    organizationId: uuidSchema,
    spaceId: uuidSchema,
  })
  .strict();
export type SpaceObservabilityView = z.infer<typeof spaceObservabilitySchema>;

const AVAILABLE_CAPACITY_OPENAPI_SCHEMA = strictObjectOpenApiSchema({
  assetBytes: { type: "string", pattern: "^(0|[1-9][0-9]*)$" },
  dataBytes: { type: "string", pattern: "^(0|[1-9][0-9]*)$" },
  fileCount: { type: "string", pattern: "^(0|[1-9][0-9]*)$" },
  sampleDurationMilliseconds: { type: "integer" },
  sampledAt: { type: "string", format: "date-time" },
  status: { type: "string", enum: ["fresh", "stale"] },
});
const UNAVAILABLE_SAMPLED_CAPACITY_OPENAPI_SCHEMA = strictObjectOpenApiSchema({
  reason: { type: "string", enum: ["sample-failed"] },
  sampledAt: { type: "string", format: "date-time" },
  status: { type: "string", enum: ["unavailable"] },
});
const UNAVAILABLE_UNSAMPLED_CAPACITY_OPENAPI_SCHEMA = strictObjectOpenApiSchema({
  reason: { type: "string", enum: ["no-sample"] },
  status: { type: "string", enum: ["unavailable"] },
});
const AVAILABLE_HEALTH_OPENAPI_SCHEMA = strictObjectOpenApiSchema({
  kernelVersion: { type: "string", minLength: 1 },
  sampledAt: { type: "string", format: "date-time" },
  status: { type: "string", enum: ["ready", "stale"] },
});
const UNAVAILABLE_SAMPLED_HEALTH_OPENAPI_SCHEMA = strictObjectOpenApiSchema({
  reason: { type: "string", enum: ["kernel-unavailable", "sample-failed"] },
  sampledAt: { type: "string", format: "date-time" },
  status: { type: "string", enum: ["unavailable"] },
});
const UNAVAILABLE_UNSAMPLED_HEALTH_OPENAPI_SCHEMA =
  strictObjectOpenApiSchema({
    reason: { type: "string", enum: ["kernel-unavailable", "no-sample"] },
    status: { type: "string", enum: ["unavailable"] },
  });

export const SPACE_OBSERVABILITY_OPENAPI_SCHEMA = strictObjectOpenApiSchema({
  capacity: {
    oneOf: [
      AVAILABLE_CAPACITY_OPENAPI_SCHEMA,
      UNAVAILABLE_SAMPLED_CAPACITY_OPENAPI_SCHEMA,
      UNAVAILABLE_UNSAMPLED_CAPACITY_OPENAPI_SCHEMA,
    ],
  },
  health: {
    oneOf: [
      AVAILABLE_HEALTH_OPENAPI_SCHEMA,
      UNAVAILABLE_SAMPLED_HEALTH_OPENAPI_SCHEMA,
      UNAVAILABLE_UNSAMPLED_HEALTH_OPENAPI_SCHEMA,
    ],
  },
  organizationId: UUID_OPENAPI_SCHEMA,
  spaceId: UUID_OPENAPI_SCHEMA,
});
