import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  Param,
  Patch,
  Post,
  Req,
} from "@nestjs/common";
import {
  ApiBody,
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from "@nestjs/swagger";
import {
  CREATED_ORGANIZATION_INVITATION_OPENAPI_SCHEMA,
  CREATE_ORGANIZATION_INVITATION_REQUEST_OPENAPI_SCHEMA,
  ORGANIZATION_INVITATION_CONTROLLER_PATH,
  ORGANIZATION_INVITATIONS_CONTROLLER_PATH,
  ORGANIZATION_INVITATIONS_RESPONSE_OPENAPI_SCHEMA,
  ORGANIZATION_MEMBERS_CONTROLLER_PATH,
  ORGANIZATION_MEMBERS_RESPONSE_OPENAPI_SCHEMA,
  ORGANIZATION_MEMBER_CONTROLLER_PATH,
  ORGANIZATION_MEMBER_SESSIONS_CONTROLLER_PATH,
  ORGANIZATION_MEMBER_SUMMARY_OPENAPI_SCHEMA,
  ORGANIZATION_OWNERSHIP_CONTROLLER_PATH,
  TRANSFER_ORGANIZATION_OWNERSHIP_REQUEST_OPENAPI_SCHEMA,
  UPDATE_ORGANIZATION_MEMBER_REQUEST_OPENAPI_SCHEMA,
  type CreatedOrganizationInvitation,
  type OrganizationInvitationsResponse,
  type OrganizationMemberSummary,
  type OrganizationMembersResponse,
  type CreateOrganizationInvitationRequest,
  type TransferOrganizationOwnershipRequest,
  type UpdateOrganizationMemberRequest,
  createOrganizationInvitationRequestSchema,
  organizationInvitationPathParametersSchema,
  organizationMemberPathParametersSchema,
  organizationPathParametersSchema,
  transferOrganizationOwnershipRequestSchema,
  updateOrganizationMemberRequestSchema,
} from "@singularity/contracts";
import { z } from "zod";

import type { HttpRequestBoundary } from "../http-boundary.js";
import {
  Authenticated,
  ApiProblemResponses,
  CurrentSession,
  SessionMutation,
} from "../identity/http-access.js";
import type { AuthenticatedSession } from "../identity/identity.service.js";
import { ZodValidationPipe } from "../identity/zod-validation.pipe.js";
import { OrganizationManagementService } from "./organization-management.service.js";

type OrganizationPathParameters = z.infer<typeof organizationPathParametersSchema>;
type OrganizationMemberPathParameters = z.infer<
  typeof organizationMemberPathParametersSchema
>;
type OrganizationInvitationPathParameters = z.infer<
  typeof organizationInvitationPathParametersSchema
>;

@ApiTags("organizations")
@Controller()
export class OrganizationsController {
  constructor(
    private readonly organizations: OrganizationManagementService,
  ) {}

  @Get(ORGANIZATION_MEMBERS_CONTROLLER_PATH)
  @Header("Cache-Control", "no-store")
  @Authenticated()
  @ApiProblemResponses(400, 401, 403, 404, 503)
  @ApiOperation({ summary: "List organization members" })
  @ApiOkResponse({ schema: ORGANIZATION_MEMBERS_RESPONSE_OPENAPI_SCHEMA })
  async listMembers(
    @Param(new ZodValidationPipe(organizationPathParametersSchema))
    parameters: OrganizationPathParameters,
    @CurrentSession() session: AuthenticatedSession,
  ): Promise<OrganizationMembersResponse> {
    return {
      members: await this.organizations.listMembers(
        session.userId,
        parameters.organizationId,
      ),
    };
  }

  @Patch(ORGANIZATION_MEMBER_CONTROLLER_PATH)
  @Header("Cache-Control", "no-store")
  @SessionMutation()
  @ApiProblemResponses(400, 401, 403, 404, 409, 503)
  @ApiOperation({ summary: "Update an organization member" })
  @ApiBody({ schema: UPDATE_ORGANIZATION_MEMBER_REQUEST_OPENAPI_SCHEMA })
  @ApiOkResponse({ schema: ORGANIZATION_MEMBER_SUMMARY_OPENAPI_SCHEMA })
  async updateMember(
    @Param(new ZodValidationPipe(organizationMemberPathParametersSchema))
    parameters: OrganizationMemberPathParameters,
    @Body(new ZodValidationPipe(updateOrganizationMemberRequestSchema))
    body: UpdateOrganizationMemberRequest,
    @Req() request: HttpRequestBoundary,
    @CurrentSession() session: AuthenticatedSession,
  ): Promise<OrganizationMemberSummary> {
    return this.organizations.updateMember(
      session.userId,
      parameters.organizationId,
      parameters.userId,
      body,
      request.id,
    );
  }

  @Post(ORGANIZATION_MEMBER_SESSIONS_CONTROLLER_PATH)
  @HttpCode(204)
  @Header("Cache-Control", "no-store")
  @SessionMutation()
  @ApiProblemResponses(400, 401, 403, 404, 503)
  @ApiOperation({ summary: "Revoke every session for an organization member" })
  @ApiNoContentResponse()
  async revokeMemberSessions(
    @Param(new ZodValidationPipe(organizationMemberPathParametersSchema))
    parameters: OrganizationMemberPathParameters,
    @Req() request: HttpRequestBoundary,
    @CurrentSession() session: AuthenticatedSession,
  ): Promise<void> {
    await this.organizations.revokeMemberSessions(
      session.userId,
      parameters.organizationId,
      parameters.userId,
      request.id,
    );
  }

  @Post(ORGANIZATION_OWNERSHIP_CONTROLLER_PATH)
  @HttpCode(204)
  @Header("Cache-Control", "no-store")
  @SessionMutation()
  @ApiProblemResponses(400, 401, 403, 404, 409, 503)
  @ApiOperation({ summary: "Transfer organization ownership" })
  @ApiBody({
    schema: TRANSFER_ORGANIZATION_OWNERSHIP_REQUEST_OPENAPI_SCHEMA,
  })
  @ApiNoContentResponse()
  async transferOwnership(
    @Param(new ZodValidationPipe(organizationPathParametersSchema))
    parameters: OrganizationPathParameters,
    @Body(new ZodValidationPipe(transferOrganizationOwnershipRequestSchema))
    body: TransferOrganizationOwnershipRequest,
    @Req() request: HttpRequestBoundary,
    @CurrentSession() session: AuthenticatedSession,
  ): Promise<void> {
    await this.organizations.transferOwnership(
      session.userId,
      parameters.organizationId,
      body.newOwnerUserId,
      request.id,
    );
  }

  @Get(ORGANIZATION_INVITATIONS_CONTROLLER_PATH)
  @Header("Cache-Control", "no-store")
  @Authenticated()
  @ApiProblemResponses(400, 401, 403, 404, 503)
  @ApiOperation({ summary: "List organization invitations" })
  @ApiOkResponse({ schema: ORGANIZATION_INVITATIONS_RESPONSE_OPENAPI_SCHEMA })
  async listInvitations(
    @Param(new ZodValidationPipe(organizationPathParametersSchema))
    parameters: OrganizationPathParameters,
    @CurrentSession() session: AuthenticatedSession,
  ): Promise<OrganizationInvitationsResponse> {
    return {
      invitations: await this.organizations.listInvitations(
        session.userId,
        parameters.organizationId,
      ),
    };
  }

  @Post(ORGANIZATION_INVITATIONS_CONTROLLER_PATH)
  @HttpCode(201)
  @Header("Cache-Control", "no-store")
  @SessionMutation()
  @ApiProblemResponses(400, 401, 403, 404, 409, 503)
  @ApiOperation({ summary: "Create an organization invitation" })
  @ApiBody({ schema: CREATE_ORGANIZATION_INVITATION_REQUEST_OPENAPI_SCHEMA })
  @ApiCreatedResponse({ schema: CREATED_ORGANIZATION_INVITATION_OPENAPI_SCHEMA })
  async createInvitation(
    @Param(new ZodValidationPipe(organizationPathParametersSchema))
    parameters: OrganizationPathParameters,
    @Body(new ZodValidationPipe(createOrganizationInvitationRequestSchema))
    body: CreateOrganizationInvitationRequest,
    @Req() request: HttpRequestBoundary,
    @CurrentSession() session: AuthenticatedSession,
  ): Promise<CreatedOrganizationInvitation> {
    return this.organizations.createInvitation({
      actorUserId: session.userId,
      expiresInHours: body.expiresInHours,
      loginIdentifier: body.loginIdentifier,
      organizationId: parameters.organizationId,
      requestId: request.id,
      role: body.role,
    });
  }

  @Delete(ORGANIZATION_INVITATION_CONTROLLER_PATH)
  @HttpCode(204)
  @Header("Cache-Control", "no-store")
  @SessionMutation()
  @ApiProblemResponses(400, 401, 403, 404, 503)
  @ApiOperation({ summary: "Revoke an organization invitation" })
  @ApiNoContentResponse()
  async revokeInvitation(
    @Param(new ZodValidationPipe(organizationInvitationPathParametersSchema))
    parameters: OrganizationInvitationPathParameters,
    @Req() request: HttpRequestBoundary,
    @CurrentSession() session: AuthenticatedSession,
  ): Promise<void> {
    await this.organizations.revokeInvitation(
      session.userId,
      parameters.organizationId,
      parameters.invitationId,
      request.id,
    );
  }
}
