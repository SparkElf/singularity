import { z } from "zod";

import {
  strictObjectOpenApiSchema,
  UUID_OPENAPI_SCHEMA,
  type OpenApiSchema,
} from "./openapi.js";
import { loginIdentifierSchema } from "./identity.js";
import { uuidSchema } from "./spaces.js";

export const USER_GROUP_NAME_MAX_LENGTH = 120;
export const userGroupStatuses = ["active", "disabled"] as const;
export const userGroupStatusSchema = z.enum(userGroupStatuses);
export const userGroupNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(USER_GROUP_NAME_MAX_LENGTH);

export const userGroupPathParametersSchema = z
  .object({ groupId: uuidSchema, organizationId: uuidSchema })
  .strict();
export const userGroupMemberPathParametersSchema = z
  .object({
    groupId: uuidSchema,
    organizationId: uuidSchema,
    userId: uuidSchema,
  })
  .strict();

export const createUserGroupRequestSchema = z
  .object({ name: userGroupNameSchema })
  .strict();
export type CreateUserGroupRequest = z.infer<typeof createUserGroupRequestSchema>;

export const updateUserGroupRequestSchema = z
  .object({
    name: userGroupNameSchema.optional(),
    status: userGroupStatusSchema.optional(),
  })
  .strict()
  .refine((value) => value.name !== undefined || value.status !== undefined);
export type UpdateUserGroupRequest = z.infer<typeof updateUserGroupRequestSchema>;

export const userGroupSummarySchema = z
  .object({
    groupId: uuidSchema,
    memberCount: z.number().int().nonnegative(),
    name: userGroupNameSchema,
    organizationId: uuidSchema,
    status: userGroupStatusSchema,
  })
  .strict();
export type UserGroupSummary = z.infer<typeof userGroupSummarySchema>;

export const userGroupsResponseSchema = z
  .object({ groups: z.array(userGroupSummarySchema) })
  .strict();
export type UserGroupsResponse = z.infer<typeof userGroupsResponseSchema>;

export const userGroupMemberSummarySchema = z
  .object({
    loginIdentifier: loginIdentifierSchema,
    userId: uuidSchema,
  })
  .strict();
export type UserGroupMemberSummary = z.infer<
  typeof userGroupMemberSummarySchema
>;

export const userGroupMembersResponseSchema = z
  .object({ members: z.array(userGroupMemberSummarySchema) })
  .strict();
export type UserGroupMembersResponse = z.infer<
  typeof userGroupMembersResponseSchema
>;

const USER_GROUP_STATUS_OPENAPI_SCHEMA: OpenApiSchema = {
  type: "string",
  enum: [...userGroupStatuses],
};
export const USER_GROUP_SUMMARY_OPENAPI_SCHEMA = strictObjectOpenApiSchema({
  groupId: UUID_OPENAPI_SCHEMA,
  memberCount: { type: "integer", minimum: 0 },
  name: { type: "string", minLength: 1, maxLength: USER_GROUP_NAME_MAX_LENGTH },
  organizationId: UUID_OPENAPI_SCHEMA,
  status: USER_GROUP_STATUS_OPENAPI_SCHEMA,
});
export const USER_GROUPS_RESPONSE_OPENAPI_SCHEMA = strictObjectOpenApiSchema({
  groups: { type: "array", items: USER_GROUP_SUMMARY_OPENAPI_SCHEMA },
});
export const USER_GROUP_MEMBER_SUMMARY_OPENAPI_SCHEMA =
  strictObjectOpenApiSchema({
    loginIdentifier: { type: "string" },
    userId: UUID_OPENAPI_SCHEMA,
  });
export const USER_GROUP_MEMBERS_RESPONSE_OPENAPI_SCHEMA =
  strictObjectOpenApiSchema({
    members: { type: "array", items: USER_GROUP_MEMBER_SUMMARY_OPENAPI_SCHEMA },
  });
export const CREATE_USER_GROUP_REQUEST_OPENAPI_SCHEMA =
  strictObjectOpenApiSchema({
    name: {
      type: "string",
      minLength: 1,
      maxLength: USER_GROUP_NAME_MAX_LENGTH,
    },
  });
export const UPDATE_USER_GROUP_REQUEST_OPENAPI_SCHEMA =
  {
    ...strictObjectOpenApiSchema(
      {
        name: {
          type: "string",
          minLength: 1,
          maxLength: USER_GROUP_NAME_MAX_LENGTH,
        },
        status: USER_GROUP_STATUS_OPENAPI_SCHEMA,
      },
      [],
    ),
    minProperties: 1,
  };
