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
export type SpaceRole = z.infer<typeof spaceRoleSchema>;

export const kernelInstanceStates = [
  "starting",
  "ready",
  "unavailable",
] as const;

export const kernelInstanceStateSchema = z.enum(kernelInstanceStates);

export type KernelInstanceState = z.infer<typeof kernelInstanceStateSchema>;

export const spaceStatuses = ["active", "archived", "disabled"] as const;
export const spaceStatusSchema = z.enum(spaceStatuses);
export const manageableSpaceStatuses = ["active", "archived"] as const;
export const manageableSpaceStatusSchema = z.enum(manageableSpaceStatuses);

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

export const managedSpacePathParametersSchema = z
  .object({ organizationId: uuidSchema, spaceId: uuidSchema })
  .strict();
export type ManagedSpacePathParameters = z.infer<
  typeof managedSpacePathParametersSchema
>;
export const spaceMemberPathParametersSchema = z
  .object({
    organizationId: uuidSchema,
    spaceId: uuidSchema,
    userId: uuidSchema,
  })
  .strict();
export const spaceGroupGrantPathParametersSchema = z
  .object({
    groupId: uuidSchema,
    organizationId: uuidSchema,
    spaceId: uuidSchema,
  })
  .strict();

export const createSpaceRequestSchema = z
  .object({ name: spaceNameInputSchema })
  .strict();
export type CreateSpaceRequest = z.infer<typeof createSpaceRequestSchema>;

export const updateSpaceRequestSchema = z
  .object({
    name: spaceNameInputSchema.optional(),
    status: manageableSpaceStatusSchema.optional(),
  })
  .strict()
  .refine((value) => value.name !== undefined || value.status !== undefined);
export type UpdateSpaceRequest = z.infer<typeof updateSpaceRequestSchema>;

export const managedSpaceSummarySchema = z
  .object({
    organizationId: uuidSchema,
    spaceId: uuidSchema,
    spaceName: spaceNameSchema,
    status: spaceStatusSchema,
  })
  .strict();
export type ManagedSpaceSummary = z.infer<typeof managedSpaceSummarySchema>;

export const managedSpacesResponseSchema = z
  .object({ spaces: z.array(managedSpaceSummarySchema) })
  .strict();
export type ManagedSpacesResponse = z.infer<typeof managedSpacesResponseSchema>;

export const setSpaceMemberRequestSchema = z
  .object({ role: spaceRoleSchema })
  .strict();
export type SetSpaceMemberRequest = z.infer<typeof setSpaceMemberRequestSchema>;

export const spaceMemberSummarySchema = z
  .object({
    loginIdentifier: z.string().min(1).max(254),
    role: spaceRoleSchema,
    status: z.enum(["active", "inactive"]),
    userId: uuidSchema,
  })
  .strict();
export type SpaceMemberSummary = z.infer<typeof spaceMemberSummarySchema>;

export const spaceMembersResponseSchema = z
  .object({ members: z.array(spaceMemberSummarySchema) })
  .strict();
export type SpaceMembersResponse = z.infer<typeof spaceMembersResponseSchema>;

export const spaceMemberCandidateSchema = z
  .object({ loginIdentifier: z.string().min(1).max(254), userId: uuidSchema })
  .strict();
export type SpaceMemberCandidate = z.infer<typeof spaceMemberCandidateSchema>;

export const spaceMemberCandidatesResponseSchema = z
  .object({ members: z.array(spaceMemberCandidateSchema) })
  .strict();
export type SpaceMemberCandidatesResponse = z.infer<
  typeof spaceMemberCandidatesResponseSchema
>;

export const setSpaceGroupGrantRequestSchema = z
  .object({ role: spaceRoleSchema })
  .strict();
export type SetSpaceGroupGrantRequest = z.infer<
  typeof setSpaceGroupGrantRequestSchema
>;

export const spaceGroupGrantSummarySchema = z
  .object({
    groupId: uuidSchema,
    groupName: z.string().min(1).max(120),
    groupStatus: z.enum(["active", "disabled"]),
    role: spaceRoleSchema,
  })
  .strict();
export type SpaceGroupGrantSummary = z.infer<
  typeof spaceGroupGrantSummarySchema
>;

export const spaceGroupGrantsResponseSchema = z
  .object({ grants: z.array(spaceGroupGrantSummarySchema) })
  .strict();
export type SpaceGroupGrantsResponse = z.infer<
  typeof spaceGroupGrantsResponseSchema
>;

export const spaceGroupCandidateSchema = z
  .object({
    groupId: uuidSchema,
    groupName: z.string().min(1).max(120),
    groupStatus: z.literal("active"),
  })
  .strict();
export type SpaceGroupCandidate = z.infer<typeof spaceGroupCandidateSchema>;

export const spaceGroupCandidatesResponseSchema = z
  .object({ groups: z.array(spaceGroupCandidateSchema) })
  .strict();
export type SpaceGroupCandidatesResponse = z.infer<
  typeof spaceGroupCandidatesResponseSchema
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
const spaceStatusOpenApiSchema = {
  type: "string" as const,
  enum: [...spaceStatuses],
};
const manageableSpaceStatusOpenApiSchema = {
  type: "string" as const,
  enum: [...manageableSpaceStatuses],
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

export const CREATE_SPACE_REQUEST_OPENAPI_SCHEMA = strictObjectOpenApiSchema({
  name: spaceNameOpenApiSchema,
});
export const UPDATE_SPACE_REQUEST_OPENAPI_SCHEMA = strictObjectOpenApiSchema(
  {
    name: spaceNameOpenApiSchema,
    status: manageableSpaceStatusOpenApiSchema,
  },
  [],
);
export const MANAGED_SPACE_SUMMARY_OPENAPI_SCHEMA = strictObjectOpenApiSchema({
  organizationId: UUID_OPENAPI_SCHEMA,
  spaceId: UUID_OPENAPI_SCHEMA,
  spaceName: spaceNameOpenApiSchema,
  status: spaceStatusOpenApiSchema,
});
export const MANAGED_SPACES_RESPONSE_OPENAPI_SCHEMA = strictObjectOpenApiSchema({
  spaces: { type: "array", items: MANAGED_SPACE_SUMMARY_OPENAPI_SCHEMA },
});
export const SET_SPACE_MEMBER_REQUEST_OPENAPI_SCHEMA =
  strictObjectOpenApiSchema({ role: spaceRoleOpenApiSchema });
export const SPACE_MEMBER_SUMMARY_OPENAPI_SCHEMA = strictObjectOpenApiSchema({
  loginIdentifier: { type: "string", minLength: 1, maxLength: 254 },
  role: spaceRoleOpenApiSchema,
  status: { type: "string", enum: ["active", "inactive"] },
  userId: UUID_OPENAPI_SCHEMA,
});
export const SPACE_MEMBERS_RESPONSE_OPENAPI_SCHEMA = strictObjectOpenApiSchema({
  members: { type: "array", items: SPACE_MEMBER_SUMMARY_OPENAPI_SCHEMA },
});
export const SPACE_MEMBER_CANDIDATE_OPENAPI_SCHEMA = strictObjectOpenApiSchema({
  loginIdentifier: { type: "string", minLength: 1, maxLength: 254 },
  userId: UUID_OPENAPI_SCHEMA,
});
export const SPACE_MEMBER_CANDIDATES_RESPONSE_OPENAPI_SCHEMA =
  strictObjectOpenApiSchema({
    members: { type: "array", items: SPACE_MEMBER_CANDIDATE_OPENAPI_SCHEMA },
  });
export const SET_SPACE_GROUP_GRANT_REQUEST_OPENAPI_SCHEMA =
  strictObjectOpenApiSchema({ role: spaceRoleOpenApiSchema });
export const SPACE_GROUP_GRANT_SUMMARY_OPENAPI_SCHEMA =
  strictObjectOpenApiSchema({
    groupId: UUID_OPENAPI_SCHEMA,
    groupName: { type: "string", minLength: 1, maxLength: 120 },
    groupStatus: { type: "string", enum: ["active", "disabled"] },
    role: spaceRoleOpenApiSchema,
  });
export const SPACE_GROUP_GRANTS_RESPONSE_OPENAPI_SCHEMA =
  strictObjectOpenApiSchema({
    grants: { type: "array", items: SPACE_GROUP_GRANT_SUMMARY_OPENAPI_SCHEMA },
  });
export const SPACE_GROUP_CANDIDATE_OPENAPI_SCHEMA = strictObjectOpenApiSchema({
  groupId: UUID_OPENAPI_SCHEMA,
  groupName: { type: "string", minLength: 1, maxLength: 120 },
  groupStatus: { type: "string", enum: ["active"] },
});
export const SPACE_GROUP_CANDIDATES_RESPONSE_OPENAPI_SCHEMA =
  strictObjectOpenApiSchema({
    groups: { type: "array", items: SPACE_GROUP_CANDIDATE_OPENAPI_SCHEMA },
  });
