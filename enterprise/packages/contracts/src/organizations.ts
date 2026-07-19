import { organizationRoles } from "@singularity/authorization";
import { z } from "zod";

import { loginIdentifierSchema, passwordSchema } from "./identity.js";
import {
  strictObjectOpenApiSchema,
  UUID_OPENAPI_SCHEMA,
  type OpenApiSchema,
} from "./openapi.js";
import { ORGANIZATION_NAME_MAX_LENGTH, uuidSchema } from "./spaces.js";

export const organizationMembershipStatuses = ["active", "inactive"] as const;
export const organizationMembershipStatusSchema = z.enum(
  organizationMembershipStatuses,
);
export const organizationRoleSchema = z.enum(organizationRoles);
export const assignableOrganizationRoles = ["admin", "member"] as const;
export const assignableOrganizationRoleSchema = z.enum(
  assignableOrganizationRoles,
);

export const organizationManagementCapabilities = [
  "members",
  "groups",
  "spaces",
  "oidc",
  "audit",
  "ownership",
] as const;
export const organizationManagementCapabilitySchema = z.enum(
  organizationManagementCapabilities,
);
export type OrganizationManagementCapability = z.infer<
  typeof organizationManagementCapabilitySchema
>;

export const spaceManagementCapabilities = [
  "access",
  "shares",
  "audit",
  "backups",
  "observability",
] as const;
export const spaceManagementCapabilitySchema = z.enum(
  spaceManagementCapabilities,
);
export type SpaceManagementCapability = z.infer<
  typeof spaceManagementCapabilitySchema
>;

export const managedSpaceAccessSchema = z
  .object({
    capabilities: z.array(spaceManagementCapabilitySchema),
    spaceId: uuidSchema,
    spaceName: z.string().min(1).max(120),
  })
  .strict();
export type ManagedSpaceAccess = z.infer<typeof managedSpaceAccessSchema>;

export const organizationManagementAccessSchema = z
  .object({
    organizationCapabilities: z.array(organizationManagementCapabilitySchema),
    organizationId: uuidSchema,
    organizationName: z.string().min(1).max(ORGANIZATION_NAME_MAX_LENGTH),
    spaces: z.array(managedSpaceAccessSchema),
  })
  .strict();
export type OrganizationManagementAccess = z.infer<
  typeof organizationManagementAccessSchema
>;

export const enterpriseManagementAccessResponseSchema = z
  .object({ organizations: z.array(organizationManagementAccessSchema) })
  .strict();
export type EnterpriseManagementAccessResponse = z.infer<
  typeof enterpriseManagementAccessResponseSchema
>;

const dateTimeSchema = z.string().datetime({ offset: true });
const invitationTokenPattern = /^[A-Za-z0-9_-]{43}$/;
export const invitationTokenSchema = z.string().regex(invitationTokenPattern);

export const organizationPathParametersSchema = z
  .object({ organizationId: uuidSchema })
  .strict();
export const organizationMemberPathParametersSchema = z
  .object({ organizationId: uuidSchema, userId: uuidSchema })
  .strict();
export const organizationInvitationPathParametersSchema = z
  .object({ invitationId: uuidSchema, organizationId: uuidSchema })
  .strict();

export const organizationMemberSummarySchema = z
  .object({
    loginIdentifier: loginIdentifierSchema,
    role: organizationRoleSchema,
    status: organizationMembershipStatusSchema,
    userId: uuidSchema,
  })
  .strict();
export type OrganizationMemberSummary = z.infer<
  typeof organizationMemberSummarySchema
>;

export const organizationMembersResponseSchema = z
  .object({ members: z.array(organizationMemberSummarySchema) })
  .strict();
export type OrganizationMembersResponse = z.infer<
  typeof organizationMembersResponseSchema
>;

export const createOrganizationInvitationRequestSchema = z
  .object({
    expiresInHours: z.number().int().min(1).max(720),
    loginIdentifier: loginIdentifierSchema,
    role: assignableOrganizationRoleSchema,
  })
  .strict();
export type CreateOrganizationInvitationRequest = z.infer<
  typeof createOrganizationInvitationRequestSchema
>;

export const organizationInvitationSummarySchema = z
  .object({
    acceptedAt: dateTimeSchema.optional(),
    expiresAt: dateTimeSchema,
    invitationId: uuidSchema,
    loginIdentifier: loginIdentifierSchema,
    organizationId: uuidSchema,
    revokedAt: dateTimeSchema.optional(),
    role: assignableOrganizationRoleSchema,
  })
  .strict();
export type OrganizationInvitationSummary = z.infer<
  typeof organizationInvitationSummarySchema
>;

export const createdOrganizationInvitationSchema =
  organizationInvitationSummarySchema.extend({
    invitationToken: invitationTokenSchema,
  });
export type CreatedOrganizationInvitation = z.infer<
  typeof createdOrganizationInvitationSchema
>;

export const organizationInvitationsResponseSchema = z
  .object({ invitations: z.array(organizationInvitationSummarySchema) })
  .strict();
export type OrganizationInvitationsResponse = z.infer<
  typeof organizationInvitationsResponseSchema
>;

export const updateOrganizationMemberRequestSchema = z
  .object({
    role: assignableOrganizationRoleSchema.optional(),
    status: organizationMembershipStatusSchema.optional(),
  })
  .strict()
  .refine((value) => value.role !== undefined || value.status !== undefined);
export type UpdateOrganizationMemberRequest = z.infer<
  typeof updateOrganizationMemberRequestSchema
>;

export const transferOrganizationOwnershipRequestSchema = z
  .object({ newOwnerUserId: uuidSchema })
  .strict();
export type TransferOrganizationOwnershipRequest = z.infer<
  typeof transferOrganizationOwnershipRequestSchema
>;

export const acceptOrganizationInvitationRequestSchema = z
  .object({ invitationToken: invitationTokenSchema })
  .strict();
export type AcceptOrganizationInvitationRequest = z.infer<
  typeof acceptOrganizationInvitationRequestSchema
>;

export const acceptLocalOrganizationInvitationRequestSchema = z
  .object({ invitationToken: invitationTokenSchema, password: passwordSchema })
  .strict();
export type AcceptLocalOrganizationInvitationRequest = z.infer<
  typeof acceptLocalOrganizationInvitationRequestSchema
>;

const ORGANIZATION_ROLE_OPENAPI_SCHEMA: OpenApiSchema = {
  type: "string",
  enum: [...organizationRoles],
};
const ASSIGNABLE_ORGANIZATION_ROLE_OPENAPI_SCHEMA: OpenApiSchema = {
  type: "string",
  enum: [...assignableOrganizationRoles],
};
const MEMBERSHIP_STATUS_OPENAPI_SCHEMA: OpenApiSchema = {
  type: "string",
  enum: [...organizationMembershipStatuses],
};
const ORGANIZATION_MANAGEMENT_CAPABILITY_OPENAPI_SCHEMA: OpenApiSchema = {
  type: "string",
  enum: [...organizationManagementCapabilities],
};
const SPACE_MANAGEMENT_CAPABILITY_OPENAPI_SCHEMA: OpenApiSchema = {
  type: "string",
  enum: [...spaceManagementCapabilities],
};
const DATE_TIME_OPENAPI_SCHEMA: OpenApiSchema = {
  type: "string",
  format: "date-time",
};
export const INVITATION_TOKEN_OPENAPI_SCHEMA: OpenApiSchema = {
  type: "string",
  pattern: invitationTokenPattern.source,
};

export const ORGANIZATION_MEMBER_SUMMARY_OPENAPI_SCHEMA =
  strictObjectOpenApiSchema({
    loginIdentifier: { type: "string" },
    role: ORGANIZATION_ROLE_OPENAPI_SCHEMA,
    status: MEMBERSHIP_STATUS_OPENAPI_SCHEMA,
    userId: UUID_OPENAPI_SCHEMA,
  });
export const MANAGED_SPACE_ACCESS_OPENAPI_SCHEMA = strictObjectOpenApiSchema({
  capabilities: {
    type: "array",
    items: SPACE_MANAGEMENT_CAPABILITY_OPENAPI_SCHEMA,
  },
  spaceId: UUID_OPENAPI_SCHEMA,
  spaceName: { type: "string", minLength: 1, maxLength: 120 },
});
export const ORGANIZATION_MANAGEMENT_ACCESS_OPENAPI_SCHEMA =
  strictObjectOpenApiSchema({
    organizationCapabilities: {
      type: "array",
      items: ORGANIZATION_MANAGEMENT_CAPABILITY_OPENAPI_SCHEMA,
    },
    organizationId: UUID_OPENAPI_SCHEMA,
    organizationName: {
      type: "string",
      minLength: 1,
      maxLength: ORGANIZATION_NAME_MAX_LENGTH,
    },
    spaces: { type: "array", items: MANAGED_SPACE_ACCESS_OPENAPI_SCHEMA },
  });
export const ENTERPRISE_MANAGEMENT_ACCESS_RESPONSE_OPENAPI_SCHEMA =
  strictObjectOpenApiSchema({
    organizations: {
      type: "array",
      items: ORGANIZATION_MANAGEMENT_ACCESS_OPENAPI_SCHEMA,
    },
  });
export const ORGANIZATION_MEMBERS_RESPONSE_OPENAPI_SCHEMA =
  strictObjectOpenApiSchema({
    members: { type: "array", items: ORGANIZATION_MEMBER_SUMMARY_OPENAPI_SCHEMA },
  });
export const CREATE_ORGANIZATION_INVITATION_REQUEST_OPENAPI_SCHEMA =
  strictObjectOpenApiSchema({
    expiresInHours: { type: "integer" },
    loginIdentifier: { type: "string" },
    role: ASSIGNABLE_ORGANIZATION_ROLE_OPENAPI_SCHEMA,
  });
export const ORGANIZATION_INVITATION_SUMMARY_OPENAPI_SCHEMA =
  strictObjectOpenApiSchema(
    {
      acceptedAt: DATE_TIME_OPENAPI_SCHEMA,
      expiresAt: DATE_TIME_OPENAPI_SCHEMA,
      invitationId: UUID_OPENAPI_SCHEMA,
      loginIdentifier: { type: "string" },
      organizationId: UUID_OPENAPI_SCHEMA,
      revokedAt: DATE_TIME_OPENAPI_SCHEMA,
      role: ASSIGNABLE_ORGANIZATION_ROLE_OPENAPI_SCHEMA,
    },
    ["expiresAt", "invitationId", "loginIdentifier", "organizationId", "role"],
  );
export const CREATED_ORGANIZATION_INVITATION_OPENAPI_SCHEMA =
  strictObjectOpenApiSchema(
    {
      acceptedAt: DATE_TIME_OPENAPI_SCHEMA,
      expiresAt: DATE_TIME_OPENAPI_SCHEMA,
      invitationId: UUID_OPENAPI_SCHEMA,
      invitationToken: INVITATION_TOKEN_OPENAPI_SCHEMA,
      loginIdentifier: { type: "string" },
      organizationId: UUID_OPENAPI_SCHEMA,
      revokedAt: DATE_TIME_OPENAPI_SCHEMA,
      role: ASSIGNABLE_ORGANIZATION_ROLE_OPENAPI_SCHEMA,
    },
    [
      "expiresAt",
      "invitationId",
      "invitationToken",
      "loginIdentifier",
      "organizationId",
      "role",
    ],
  );
export const ORGANIZATION_INVITATIONS_RESPONSE_OPENAPI_SCHEMA =
  strictObjectOpenApiSchema({
    invitations: {
      type: "array",
      items: ORGANIZATION_INVITATION_SUMMARY_OPENAPI_SCHEMA,
    },
  });
export const UPDATE_ORGANIZATION_MEMBER_REQUEST_OPENAPI_SCHEMA =
  strictObjectOpenApiSchema(
    {
      role: ASSIGNABLE_ORGANIZATION_ROLE_OPENAPI_SCHEMA,
      status: MEMBERSHIP_STATUS_OPENAPI_SCHEMA,
    },
    [],
  );
export const TRANSFER_ORGANIZATION_OWNERSHIP_REQUEST_OPENAPI_SCHEMA =
  strictObjectOpenApiSchema({ newOwnerUserId: UUID_OPENAPI_SCHEMA });
export const ACCEPT_ORGANIZATION_INVITATION_REQUEST_OPENAPI_SCHEMA =
  strictObjectOpenApiSchema({
    invitationToken: INVITATION_TOKEN_OPENAPI_SCHEMA,
  });
export const ACCEPT_LOCAL_ORGANIZATION_INVITATION_REQUEST_OPENAPI_SCHEMA =
  strictObjectOpenApiSchema({
    invitationToken: INVITATION_TOKEN_OPENAPI_SCHEMA,
    password: { type: "string" },
  });
