import { spaceRoles } from "@singularity/authorization";
import { z } from "zod";

import {
  strictObjectOpenApiSchema,
  UUID_OPENAPI_SCHEMA,
} from "./openapi.js";

export const ORGANIZATION_NAME_MAX_LENGTH = 120;
export const SPACE_NAME_MAX_LENGTH = 120;

export const uuidSchema = z.string().uuid();

export const organizationNameInputSchema = z
  .string()
  .trim()
  .min(1)
  .max(ORGANIZATION_NAME_MAX_LENGTH);

export const spaceNameInputSchema = z
  .string()
  .trim()
  .min(1)
  .max(SPACE_NAME_MAX_LENGTH);

const organizationNameSchema = z
  .string()
  .min(1)
  .max(ORGANIZATION_NAME_MAX_LENGTH);
const spaceNameSchema = z.string().min(1).max(SPACE_NAME_MAX_LENGTH);

export const spaceRoleSchema = z.enum(spaceRoles);

export const kernelInstanceStates = [
  "starting",
  "ready",
  "unavailable",
] as const;

export const kernelInstanceStateSchema = z.enum(kernelInstanceStates);

export type KernelInstanceState = z.infer<typeof kernelInstanceStateSchema>;

export const authorizedSpaceSummarySchema = z
  .object({
    organizationId: uuidSchema,
    organizationName: organizationNameSchema,
    spaceId: uuidSchema,
    spaceName: spaceNameSchema,
    role: spaceRoleSchema,
  })
  .strict();

export type AuthorizedSpaceSummary = z.infer<
  typeof authorizedSpaceSummarySchema
>;

export const authorizedSpacesResponseSchema = z
  .object({
    spaces: z.array(authorizedSpaceSummarySchema),
  })
  .strict();

export type AuthorizedSpacesResponse = z.infer<
  typeof authorizedSpacesResponseSchema
>;

export const spaceRuntimePathParametersSchema = z
  .object({
    organizationId: uuidSchema,
    spaceId: uuidSchema,
  })
  .strict();

export type SpaceRuntimePathParameters = z.infer<
  typeof spaceRuntimePathParametersSchema
>;

export const spaceRuntimeBootstrapSchema = z
  .object({
    organizationId: uuidSchema,
    spaceId: uuidSchema,
    role: spaceRoleSchema,
    kernelState: kernelInstanceStateSchema,
  })
  .strict();

export type SpaceRuntimeBootstrap = z.infer<
  typeof spaceRuntimeBootstrapSchema
>;

const organizationNameOpenApiSchema = {
  type: "string" as const,
  minLength: 1,
  maxLength: ORGANIZATION_NAME_MAX_LENGTH,
};
const spaceNameOpenApiSchema = {
  type: "string" as const,
  minLength: 1,
  maxLength: SPACE_NAME_MAX_LENGTH,
};
const spaceRoleOpenApiSchema = {
  type: "string" as const,
  enum: [...spaceRoles],
};
const kernelInstanceStateOpenApiSchema = {
  type: "string" as const,
  enum: [...kernelInstanceStates],
};

export const AUTHORIZED_SPACE_SUMMARY_OPENAPI_SCHEMA =
  strictObjectOpenApiSchema({
    organizationId: UUID_OPENAPI_SCHEMA,
    organizationName: organizationNameOpenApiSchema,
    spaceId: UUID_OPENAPI_SCHEMA,
    spaceName: spaceNameOpenApiSchema,
    role: spaceRoleOpenApiSchema,
  });

export const AUTHORIZED_SPACES_RESPONSE_OPENAPI_SCHEMA =
  strictObjectOpenApiSchema({
    spaces: {
      type: "array",
      items: AUTHORIZED_SPACE_SUMMARY_OPENAPI_SCHEMA,
    },
  });

export const SPACE_RUNTIME_PATH_PARAMETERS_OPENAPI_SCHEMA =
  strictObjectOpenApiSchema({
    organizationId: UUID_OPENAPI_SCHEMA,
    spaceId: UUID_OPENAPI_SCHEMA,
  });

export const SPACE_RUNTIME_BOOTSTRAP_OPENAPI_SCHEMA =
  strictObjectOpenApiSchema({
    organizationId: UUID_OPENAPI_SCHEMA,
    spaceId: UUID_OPENAPI_SCHEMA,
    role: spaceRoleOpenApiSchema,
    kernelState: kernelInstanceStateOpenApiSchema,
  });
