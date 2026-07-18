import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Post,
  Req,
  Res,
} from "@nestjs/common";
import {
  ApiBody,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from "@nestjs/swagger";
import {
  API_PROBLEM_OPENAPI_SCHEMA_BY_STATUS,
  AUTH_CSRF_PATH,
  AUTH_INVITATION_ACCEPT_LOCAL_PATH,
  AUTH_INVITATION_ACCEPT_PATH,
  AUTH_LOGIN_PATH,
  AUTH_LOGOUT_PATH,
  AUTH_SESSION_COOKIE_NAME,
  CSRF_RESPONSE_OPENAPI_SCHEMA,
  type AcceptLocalOrganizationInvitationRequest,
  type AcceptOrganizationInvitationRequest,
  type CsrfResponse,
  type LoginRequest,
  LOGIN_REQUEST_OPENAPI_SCHEMA,
  LOGIN_RESPONSE_OPENAPI_SCHEMA,
  type LoginResponse,
  ACCEPT_LOCAL_ORGANIZATION_INVITATION_REQUEST_OPENAPI_SCHEMA,
  ACCEPT_ORGANIZATION_INVITATION_REQUEST_OPENAPI_SCHEMA,
  acceptLocalOrganizationInvitationRequestSchema,
  acceptOrganizationInvitationRequestSchema,
  loginRequestSchema,
} from "@singularity/contracts";

import type {
  HttpReplyBoundary,
  HttpRequestBoundary,
} from "../http-boundary.js";
import {
  Authenticated,
  ApiProblemResponses,
  CurrentSession,
  SameOrigin,
  SessionMutation,
} from "./http-access.js";
import { IdentityService, type AuthenticatedSession } from "./identity.service.js";
import { SESSION_COOKIE_OPTIONS } from "./session-crypto.js";
import { OrganizationManagementService } from "../organizations/organization-management.service.js";
import { ZodValidationPipe } from "./zod-validation.pipe.js";

const RETRY_AFTER_RESPONSE_HEADER_OPENAPI = {
  description: "Seconds until the login may be retried",
  required: true,
  schema: { type: "integer" as const, minimum: 1 },
};

@ApiTags("identity")
@Controller()
export class IdentityController {
  constructor(
    private readonly identity: IdentityService,
    private readonly organizations: OrganizationManagementService,
  ) {}

  @Post(AUTH_INVITATION_ACCEPT_LOCAL_PATH)
  @HttpCode(200)
  @Header("Cache-Control", "no-store")
  @SameOrigin()
  @ApiProblemResponses(400, 404, 409, 429, 503)
  @ApiOperation({ summary: "Accept an organization invitation with a local account" })
  @ApiBody({
    schema: ACCEPT_LOCAL_ORGANIZATION_INVITATION_REQUEST_OPENAPI_SCHEMA,
  })
  @ApiOkResponse({ schema: LOGIN_RESPONSE_OPENAPI_SCHEMA })
  async acceptLocalInvitation(
    @Body(new ZodValidationPipe(acceptLocalOrganizationInvitationRequestSchema))
    body: AcceptLocalOrganizationInvitationRequest,
    @Req() request: HttpRequestBoundary,
    @Res({ passthrough: true }) reply: HttpReplyBoundary,
  ): Promise<LoginResponse> {
    const accepted = await this.organizations.acceptLocalInvitation(
      body.invitationToken,
      body.password,
      request.id,
    );
    const session = await this.identity.issueSessionForUser({
      currentTokenValue: request.cookies[AUTH_SESSION_COOKIE_NAME],
      requestId: request.id,
      userId: accepted.userId,
    });
    reply.setCookie(
      AUTH_SESSION_COOKIE_NAME,
      session.tokenValue,
      SESSION_COOKIE_OPTIONS,
    );
    return { csrfToken: session.csrfToken };
  }

  @Post(AUTH_INVITATION_ACCEPT_PATH)
  @HttpCode(204)
  @Header("Cache-Control", "no-store")
  @SessionMutation()
  @ApiProblemResponses(400, 401, 403, 404, 409, 503)
  @ApiOperation({ summary: "Accept an organization invitation as the current user" })
  @ApiBody({ schema: ACCEPT_ORGANIZATION_INVITATION_REQUEST_OPENAPI_SCHEMA })
  @ApiNoContentResponse()
  async acceptInvitation(
    @Body(new ZodValidationPipe(acceptOrganizationInvitationRequestSchema))
    body: AcceptOrganizationInvitationRequest,
    @Req() request: HttpRequestBoundary,
    @CurrentSession() session: AuthenticatedSession,
  ): Promise<void> {
    await this.organizations.acceptInvitation(
      session.userId,
      body.invitationToken,
      request.id,
    );
  }

  @Post(AUTH_LOGIN_PATH)
  @HttpCode(200)
  @Header("Cache-Control", "no-store")
  @SameOrigin()
  @ApiOperation({ summary: "Create a local authenticated session" })
  @ApiBody({ schema: LOGIN_REQUEST_OPENAPI_SCHEMA })
  @ApiOkResponse({ schema: LOGIN_RESPONSE_OPENAPI_SCHEMA })
  @ApiResponse({
    status: 400,
    schema: API_PROBLEM_OPENAPI_SCHEMA_BY_STATUS[400],
  })
  @ApiResponse({
    status: 401,
    schema: API_PROBLEM_OPENAPI_SCHEMA_BY_STATUS[401],
  })
  @ApiResponse({
    status: 403,
    schema: API_PROBLEM_OPENAPI_SCHEMA_BY_STATUS[403],
  })
  @ApiResponse({
    status: 429,
    headers: { "Retry-After": RETRY_AFTER_RESPONSE_HEADER_OPENAPI },
    schema: API_PROBLEM_OPENAPI_SCHEMA_BY_STATUS[429],
  })
  @ApiResponse({
    status: 503,
    schema: API_PROBLEM_OPENAPI_SCHEMA_BY_STATUS[503],
  })
  async login(
    @Body(new ZodValidationPipe(loginRequestSchema)) body: LoginRequest,
    @Req() request: HttpRequestBoundary,
    @Res({ passthrough: true }) reply: HttpReplyBoundary,
  ): Promise<LoginResponse> {
    const session = await this.identity.login({
      currentTokenValue: request.cookies[AUTH_SESSION_COOKIE_NAME],
      loginIdentifier: body.loginIdentifier,
      password: body.password,
      requestId: request.id,
      sourceAddress: request.ip,
    });
    reply.setCookie(
      AUTH_SESSION_COOKIE_NAME,
      session.tokenValue,
      SESSION_COOKIE_OPTIONS,
    );
    return { csrfToken: session.csrfToken };
  }

  @Get(AUTH_CSRF_PATH)
  @Header("Cache-Control", "no-store")
  @Authenticated()
  @ApiOperation({ summary: "Recover the current session CSRF token" })
  @ApiOkResponse({ schema: CSRF_RESPONSE_OPENAPI_SCHEMA })
  @ApiResponse({
    status: 401,
    schema: API_PROBLEM_OPENAPI_SCHEMA_BY_STATUS[401],
  })
  @ApiResponse({
    status: 503,
    schema: API_PROBLEM_OPENAPI_SCHEMA_BY_STATUS[503],
  })
  async getCsrf(
    @CurrentSession() session: AuthenticatedSession,
  ): Promise<CsrfResponse> {
    return { csrfToken: session.csrfToken };
  }

  @Post(AUTH_LOGOUT_PATH)
  @HttpCode(204)
  @Header("Cache-Control", "no-store")
  @SessionMutation()
  @ApiOperation({ summary: "Revoke the current local session" })
  @ApiNoContentResponse()
  @ApiResponse({
    status: 401,
    schema: API_PROBLEM_OPENAPI_SCHEMA_BY_STATUS[401],
  })
  @ApiResponse({
    status: 403,
    schema: API_PROBLEM_OPENAPI_SCHEMA_BY_STATUS[403],
  })
  @ApiResponse({
    status: 503,
    schema: API_PROBLEM_OPENAPI_SCHEMA_BY_STATUS[503],
  })
  async logout(
    @Req() request: HttpRequestBoundary,
    @CurrentSession() session: AuthenticatedSession,
    @Res({ passthrough: true }) reply: HttpReplyBoundary,
  ): Promise<void> {
    await this.identity.revokeCurrentSession(session, request.id);
    reply.clearCookie(AUTH_SESSION_COOKIE_NAME, SESSION_COOKIE_OPTIONS);
  }
}
