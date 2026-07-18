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
  CREATE_USER_GROUP_REQUEST_OPENAPI_SCHEMA,
  ORGANIZATION_GROUPS_CONTROLLER_PATH,
  ORGANIZATION_GROUP_CONTROLLER_PATH,
  ORGANIZATION_GROUP_MEMBERS_CONTROLLER_PATH,
  ORGANIZATION_GROUP_MEMBER_CONTROLLER_PATH,
  UPDATE_USER_GROUP_REQUEST_OPENAPI_SCHEMA,
  USER_GROUPS_RESPONSE_OPENAPI_SCHEMA,
  USER_GROUP_MEMBERS_RESPONSE_OPENAPI_SCHEMA,
  USER_GROUP_SUMMARY_OPENAPI_SCHEMA,
  type UserGroupMembersResponse,
  type UserGroupSummary,
  type UserGroupsResponse,
  type CreateUserGroupRequest,
  type UpdateUserGroupRequest,
  createUserGroupRequestSchema,
  organizationPathParametersSchema,
  updateUserGroupRequestSchema,
  userGroupMemberPathParametersSchema,
  userGroupPathParametersSchema,
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
import { GroupManagementService } from "./group-management.service.js";

type OrganizationPathParameters = z.infer<typeof organizationPathParametersSchema>;
type UserGroupPathParameters = z.infer<typeof userGroupPathParametersSchema>;
type UserGroupMemberPathParameters = z.infer<
  typeof userGroupMemberPathParametersSchema
>;

@ApiTags("groups")
@Controller()
export class GroupsController {
  constructor(
    private readonly groups: GroupManagementService,
  ) {}

  @Get(ORGANIZATION_GROUPS_CONTROLLER_PATH)
  @Header("Cache-Control", "no-store")
  @Authenticated()
  @ApiProblemResponses(400, 401, 403, 404, 503)
  @ApiOperation({ summary: "List organization groups" })
  @ApiOkResponse({ schema: USER_GROUPS_RESPONSE_OPENAPI_SCHEMA })
  async listGroups(
    @Param(new ZodValidationPipe(organizationPathParametersSchema))
    parameters: OrganizationPathParameters,
    @CurrentSession() session: AuthenticatedSession,
  ): Promise<UserGroupsResponse> {
    return {
      groups: await this.groups.listGroups(
        session.userId,
        parameters.organizationId,
      ),
    };
  }

  @Post(ORGANIZATION_GROUPS_CONTROLLER_PATH)
  @HttpCode(201)
  @Header("Cache-Control", "no-store")
  @SessionMutation()
  @ApiProblemResponses(400, 401, 403, 404, 409, 503)
  @ApiOperation({ summary: "Create an organization group" })
  @ApiBody({ schema: CREATE_USER_GROUP_REQUEST_OPENAPI_SCHEMA })
  @ApiCreatedResponse({ schema: USER_GROUP_SUMMARY_OPENAPI_SCHEMA })
  async createGroup(
    @Param(new ZodValidationPipe(organizationPathParametersSchema))
    parameters: OrganizationPathParameters,
    @Body(new ZodValidationPipe(createUserGroupRequestSchema))
    body: CreateUserGroupRequest,
    @Req() request: HttpRequestBoundary,
    @CurrentSession() session: AuthenticatedSession,
  ): Promise<UserGroupSummary> {
    return this.groups.createGroup(
      session.userId,
      parameters.organizationId,
      body.name,
      request.id,
    );
  }

  @Patch(ORGANIZATION_GROUP_CONTROLLER_PATH)
  @Header("Cache-Control", "no-store")
  @SessionMutation()
  @ApiProblemResponses(400, 401, 403, 404, 409, 503)
  @ApiOperation({ summary: "Update an organization group" })
  @ApiBody({ schema: UPDATE_USER_GROUP_REQUEST_OPENAPI_SCHEMA })
  @ApiOkResponse({ schema: USER_GROUP_SUMMARY_OPENAPI_SCHEMA })
  async updateGroup(
    @Param(new ZodValidationPipe(userGroupPathParametersSchema))
    parameters: UserGroupPathParameters,
    @Body(new ZodValidationPipe(updateUserGroupRequestSchema))
    body: UpdateUserGroupRequest,
    @Req() request: HttpRequestBoundary,
    @CurrentSession() session: AuthenticatedSession,
  ): Promise<UserGroupSummary> {
    return this.groups.updateGroup(
      session.userId,
      parameters.organizationId,
      parameters.groupId,
      body,
      request.id,
    );
  }

  @Get(ORGANIZATION_GROUP_MEMBERS_CONTROLLER_PATH)
  @Header("Cache-Control", "no-store")
  @Authenticated()
  @ApiProblemResponses(400, 401, 403, 404, 503)
  @ApiOperation({ summary: "List organization group members" })
  @ApiOkResponse({ schema: USER_GROUP_MEMBERS_RESPONSE_OPENAPI_SCHEMA })
  async listMembers(
    @Param(new ZodValidationPipe(userGroupPathParametersSchema))
    parameters: UserGroupPathParameters,
    @CurrentSession() session: AuthenticatedSession,
  ): Promise<UserGroupMembersResponse> {
    return {
      members: await this.groups.listMembers(
        session.userId,
        parameters.organizationId,
        parameters.groupId,
      ),
    };
  }

  @Put(ORGANIZATION_GROUP_MEMBER_CONTROLLER_PATH)
  @HttpCode(204)
  @Header("Cache-Control", "no-store")
  @SessionMutation()
  @ApiProblemResponses(400, 401, 403, 404, 503)
  @ApiOperation({ summary: "Add an organization group member" })
  @ApiNoContentResponse()
  async addMember(
    @Param(new ZodValidationPipe(userGroupMemberPathParametersSchema))
    parameters: UserGroupMemberPathParameters,
    @Req() request: HttpRequestBoundary,
    @CurrentSession() session: AuthenticatedSession,
  ): Promise<void> {
    await this.groups.addMember(
      session.userId,
      parameters.organizationId,
      parameters.groupId,
      parameters.userId,
      request.id,
    );
  }

  @Delete(ORGANIZATION_GROUP_MEMBER_CONTROLLER_PATH)
  @HttpCode(204)
  @Header("Cache-Control", "no-store")
  @SessionMutation()
  @ApiProblemResponses(400, 401, 403, 404, 503)
  @ApiOperation({ summary: "Remove an organization group member" })
  @ApiNoContentResponse()
  async removeMember(
    @Param(new ZodValidationPipe(userGroupMemberPathParametersSchema))
    parameters: UserGroupMemberPathParameters,
    @Req() request: HttpRequestBoundary,
    @CurrentSession() session: AuthenticatedSession,
  ): Promise<void> {
    await this.groups.removeMember(
      session.userId,
      parameters.organizationId,
      parameters.groupId,
      parameters.userId,
      request.id,
    );
  }

}
