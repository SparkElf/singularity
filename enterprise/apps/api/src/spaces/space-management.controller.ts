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
  Put,
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
  CREATE_SPACE_REQUEST_OPENAPI_SCHEMA,
  MANAGED_SPACES_RESPONSE_OPENAPI_SCHEMA,
  MANAGED_SPACE_SUMMARY_OPENAPI_SCHEMA,
  ORGANIZATION_SPACES_CONTROLLER_PATH,
  ORGANIZATION_SPACE_CONTROLLER_PATH,
  ORGANIZATION_SPACE_GROUPS_CONTROLLER_PATH,
  ORGANIZATION_SPACE_GROUP_CONTROLLER_PATH,
  ORGANIZATION_SPACE_MEMBERS_CONTROLLER_PATH,
  ORGANIZATION_SPACE_MEMBER_CANDIDATES_CONTROLLER_PATH,
  ORGANIZATION_SPACE_GROUP_CANDIDATES_CONTROLLER_PATH,
  ORGANIZATION_SPACE_MEMBER_CONTROLLER_PATH,
  SET_SPACE_GROUP_GRANT_REQUEST_OPENAPI_SCHEMA,
  SET_SPACE_MEMBER_REQUEST_OPENAPI_SCHEMA,
  SPACE_GROUP_GRANTS_RESPONSE_OPENAPI_SCHEMA,
  SPACE_GROUP_CANDIDATES_RESPONSE_OPENAPI_SCHEMA,
  SPACE_MEMBER_CANDIDATES_RESPONSE_OPENAPI_SCHEMA,
  SPACE_MEMBERS_RESPONSE_OPENAPI_SCHEMA,
  UPDATE_SPACE_REQUEST_OPENAPI_SCHEMA,
  type CreateSpaceRequest,
  type ManagedSpacesResponse,
  type ManagedSpaceSummary,
  type SetSpaceGroupGrantRequest,
  type SetSpaceMemberRequest,
  type SpaceGroupGrantsResponse,
  type SpaceMembersResponse,
  type SpaceMemberCandidatesResponse,
  type SpaceGroupCandidatesResponse,
  type UpdateSpaceRequest,
  createSpaceRequestSchema,
  managedSpacePathParametersSchema,
  organizationPathParametersSchema,
  setSpaceGroupGrantRequestSchema,
  setSpaceMemberRequestSchema,
  spaceGroupGrantPathParametersSchema,
  spaceMemberPathParametersSchema,
  updateSpaceRequestSchema,
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
import { SpaceManagementService } from "./space-management.service.js";

type OrganizationPathParameters = z.infer<typeof organizationPathParametersSchema>;
type ManagedSpacePathParameters = z.infer<
  typeof managedSpacePathParametersSchema
>;
type SpaceMemberPathParameters = z.infer<typeof spaceMemberPathParametersSchema>;
type SpaceGroupGrantPathParameters = z.infer<
  typeof spaceGroupGrantPathParametersSchema
>;

@ApiTags("space-management")
@Controller()
export class SpaceManagementController {
  constructor(private readonly spaces: SpaceManagementService) {}

  @Get(ORGANIZATION_SPACES_CONTROLLER_PATH)
  @Header("Cache-Control", "no-store")
  @Authenticated()
  @ApiProblemResponses(400, 401, 403, 404, 503)
  @ApiOperation({ summary: "List managed organization spaces" })
  @ApiOkResponse({ schema: MANAGED_SPACES_RESPONSE_OPENAPI_SCHEMA })
  async listSpaces(
    @Param(new ZodValidationPipe(organizationPathParametersSchema))
    parameters: OrganizationPathParameters,
    @CurrentSession() session: AuthenticatedSession,
  ): Promise<ManagedSpacesResponse> {
    return {
      spaces: await this.spaces.listSpaces(
        session.userId,
        parameters.organizationId,
      ),
    };
  }

  @Post(ORGANIZATION_SPACES_CONTROLLER_PATH)
  @HttpCode(201)
  @Header("Cache-Control", "no-store")
  @SessionMutation()
  @ApiProblemResponses(400, 401, 403, 404, 409, 503)
  @ApiOperation({ summary: "Create an organization space" })
  @ApiBody({ schema: CREATE_SPACE_REQUEST_OPENAPI_SCHEMA })
  @ApiCreatedResponse({ schema: MANAGED_SPACE_SUMMARY_OPENAPI_SCHEMA })
  async createSpace(
    @Param(new ZodValidationPipe(organizationPathParametersSchema))
    parameters: OrganizationPathParameters,
    @Body(new ZodValidationPipe(createSpaceRequestSchema))
    body: CreateSpaceRequest,
    @Req() request: HttpRequestBoundary,
    @CurrentSession() session: AuthenticatedSession,
  ): Promise<ManagedSpaceSummary> {
    return this.spaces.createSpace(
      session.userId,
      parameters.organizationId,
      body.name,
      request.id,
    );
  }

  @Patch(ORGANIZATION_SPACE_CONTROLLER_PATH)
  @Header("Cache-Control", "no-store")
  @SessionMutation()
  @ApiProblemResponses(400, 401, 403, 404, 409, 503)
  @ApiOperation({ summary: "Rename, archive, or restore an organization space" })
  @ApiBody({ schema: UPDATE_SPACE_REQUEST_OPENAPI_SCHEMA })
  @ApiOkResponse({ schema: MANAGED_SPACE_SUMMARY_OPENAPI_SCHEMA })
  async updateSpace(
    @Param(new ZodValidationPipe(managedSpacePathParametersSchema))
    parameters: ManagedSpacePathParameters,
    @Body(new ZodValidationPipe(updateSpaceRequestSchema))
    body: UpdateSpaceRequest,
    @Req() request: HttpRequestBoundary,
    @CurrentSession() session: AuthenticatedSession,
  ): Promise<ManagedSpaceSummary> {
    return this.spaces.updateSpace(
      session.userId,
      parameters.organizationId,
      parameters.spaceId,
      body,
      request.id,
    );
  }

  @Get(ORGANIZATION_SPACE_CONTROLLER_PATH)
  @Header("Cache-Control", "no-store")
  @Authenticated()
  @ApiProblemResponses(400, 401, 403, 404, 503)
  @ApiOperation({ summary: "Read a managed space, including archived state" })
  @ApiOkResponse({ schema: MANAGED_SPACE_SUMMARY_OPENAPI_SCHEMA })
  async getSpace(
    @Param(new ZodValidationPipe(managedSpacePathParametersSchema))
    parameters: ManagedSpacePathParameters,
    @CurrentSession() session: AuthenticatedSession,
  ): Promise<ManagedSpaceSummary> {
    return this.spaces.getSpace(
      session.userId,
      parameters.organizationId,
      parameters.spaceId,
    );
  }

  @Get(ORGANIZATION_SPACE_MEMBERS_CONTROLLER_PATH)
  @Header("Cache-Control", "no-store")
  @Authenticated()
  @ApiProblemResponses(400, 401, 403, 404, 503)
  @ApiOperation({ summary: "List direct space members" })
  @ApiOkResponse({ schema: SPACE_MEMBERS_RESPONSE_OPENAPI_SCHEMA })
  async listMembers(
    @Param(new ZodValidationPipe(managedSpacePathParametersSchema))
    parameters: ManagedSpacePathParameters,
    @CurrentSession() session: AuthenticatedSession,
  ): Promise<SpaceMembersResponse> {
    return {
      members: await this.spaces.listMembers(
        session.userId,
        parameters.organizationId,
        parameters.spaceId,
      ),
    };
  }

  @Get(ORGANIZATION_SPACE_MEMBER_CANDIDATES_CONTROLLER_PATH)
  @Header("Cache-Control", "no-store")
  @Authenticated()
  @ApiProblemResponses(400, 401, 403, 404, 503)
  @ApiOperation({ summary: "List active organization users eligible for a space" })
  @ApiOkResponse({
    schema: SPACE_MEMBER_CANDIDATES_RESPONSE_OPENAPI_SCHEMA,
  })
  async listMemberCandidates(
    @Param(new ZodValidationPipe(managedSpacePathParametersSchema))
    parameters: ManagedSpacePathParameters,
    @CurrentSession() session: AuthenticatedSession,
  ): Promise<SpaceMemberCandidatesResponse> {
    return {
      members: await this.spaces.listMemberCandidates(
        session.userId,
        parameters.organizationId,
        parameters.spaceId,
      ),
    };
  }

  @Put(ORGANIZATION_SPACE_MEMBER_CONTROLLER_PATH)
  @HttpCode(204)
  @Header("Cache-Control", "no-store")
  @SessionMutation()
  @ApiProblemResponses(400, 401, 403, 404, 409, 503)
  @ApiOperation({ summary: "Grant or change direct space membership" })
  @ApiBody({ schema: SET_SPACE_MEMBER_REQUEST_OPENAPI_SCHEMA })
  @ApiNoContentResponse()
  async setMember(
    @Param(new ZodValidationPipe(spaceMemberPathParametersSchema))
    parameters: SpaceMemberPathParameters,
    @Body(new ZodValidationPipe(setSpaceMemberRequestSchema))
    body: SetSpaceMemberRequest,
    @Req() request: HttpRequestBoundary,
    @CurrentSession() session: AuthenticatedSession,
  ): Promise<void> {
    await this.spaces.setMember(
      session.userId,
      parameters.organizationId,
      parameters.spaceId,
      parameters.userId,
      body.role,
      request.id,
    );
  }

  @Delete(ORGANIZATION_SPACE_MEMBER_CONTROLLER_PATH)
  @HttpCode(204)
  @Header("Cache-Control", "no-store")
  @SessionMutation()
  @ApiProblemResponses(400, 401, 403, 404, 503)
  @ApiOperation({ summary: "Revoke direct space membership" })
  @ApiNoContentResponse()
  async revokeMember(
    @Param(new ZodValidationPipe(spaceMemberPathParametersSchema))
    parameters: SpaceMemberPathParameters,
    @Req() request: HttpRequestBoundary,
    @CurrentSession() session: AuthenticatedSession,
  ): Promise<void> {
    await this.spaces.revokeMember(
      session.userId,
      parameters.organizationId,
      parameters.spaceId,
      parameters.userId,
      request.id,
    );
  }

  @Get(ORGANIZATION_SPACE_GROUPS_CONTROLLER_PATH)
  @Header("Cache-Control", "no-store")
  @Authenticated()
  @ApiProblemResponses(400, 401, 403, 404, 503)
  @ApiOperation({ summary: "List space group grants" })
  @ApiOkResponse({ schema: SPACE_GROUP_GRANTS_RESPONSE_OPENAPI_SCHEMA })
  async listGroupGrants(
    @Param(new ZodValidationPipe(managedSpacePathParametersSchema))
    parameters: ManagedSpacePathParameters,
    @CurrentSession() session: AuthenticatedSession,
  ): Promise<SpaceGroupGrantsResponse> {
    return {
      grants: await this.spaces.listGroupGrants(
        session.userId,
        parameters.organizationId,
        parameters.spaceId,
      ),
    };
  }

  @Get(ORGANIZATION_SPACE_GROUP_CANDIDATES_CONTROLLER_PATH)
  @Header("Cache-Control", "no-store")
  @Authenticated()
  @ApiProblemResponses(400, 401, 403, 404, 503)
  @ApiOperation({ summary: "List active organization groups eligible for a space" })
  @ApiOkResponse({
    schema: SPACE_GROUP_CANDIDATES_RESPONSE_OPENAPI_SCHEMA,
  })
  async listGroupCandidates(
    @Param(new ZodValidationPipe(managedSpacePathParametersSchema))
    parameters: ManagedSpacePathParameters,
    @CurrentSession() session: AuthenticatedSession,
  ): Promise<SpaceGroupCandidatesResponse> {
    return {
      groups: await this.spaces.listGroupCandidates(
        session.userId,
        parameters.organizationId,
        parameters.spaceId,
      ),
    };
  }

  @Put(ORGANIZATION_SPACE_GROUP_CONTROLLER_PATH)
  @HttpCode(204)
  @Header("Cache-Control", "no-store")
  @SessionMutation()
  @ApiProblemResponses(400, 401, 403, 404, 409, 503)
  @ApiOperation({ summary: "Grant or change group access to a space" })
  @ApiBody({ schema: SET_SPACE_GROUP_GRANT_REQUEST_OPENAPI_SCHEMA })
  @ApiNoContentResponse()
  async setGroupGrant(
    @Param(new ZodValidationPipe(spaceGroupGrantPathParametersSchema))
    parameters: SpaceGroupGrantPathParameters,
    @Body(new ZodValidationPipe(setSpaceGroupGrantRequestSchema))
    body: SetSpaceGroupGrantRequest,
    @Req() request: HttpRequestBoundary,
    @CurrentSession() session: AuthenticatedSession,
  ): Promise<void> {
    await this.spaces.setGroupGrant(
      session.userId,
      parameters.organizationId,
      parameters.spaceId,
      parameters.groupId,
      body.role,
      request.id,
    );
  }

  @Delete(ORGANIZATION_SPACE_GROUP_CONTROLLER_PATH)
  @HttpCode(204)
  @Header("Cache-Control", "no-store")
  @SessionMutation()
  @ApiProblemResponses(400, 401, 403, 404, 503)
  @ApiOperation({ summary: "Revoke group access to a space" })
  @ApiNoContentResponse()
  async revokeGroupGrant(
    @Param(new ZodValidationPipe(spaceGroupGrantPathParametersSchema))
    parameters: SpaceGroupGrantPathParameters,
    @Req() request: HttpRequestBoundary,
    @CurrentSession() session: AuthenticatedSession,
  ): Promise<void> {
    await this.spaces.revokeGroupGrant(
      session.userId,
      parameters.organizationId,
      parameters.spaceId,
      parameters.groupId,
      request.id,
    );
  }
}
