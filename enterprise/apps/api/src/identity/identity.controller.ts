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
  ApiConsumes,
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
  AUTH_MFA_CHALLENGE_VERIFY_PATH,
  AUTH_SAML_CALLBACK_PATH,
  AUTH_SAML_START_PATH,
  AUTH_SESSION_COOKIE_NAME,
  CSRF_RESPONSE_OPENAPI_SCHEMA,
  type AcceptLocalOrganizationInvitationRequest,
  type AcceptOrganizationInvitationRequest,
  type CsrfResponse,
  type LoginRequest,
  LOGIN_REQUEST_OPENAPI_SCHEMA,
  LOGIN_RESPONSE_OPENAPI_SCHEMA,
  type LoginResponse,
  type MfaLoginChallengeResponse,
  type MfaLoginChallengeVerifyRequest,
  ACCEPT_LOCAL_ORGANIZATION_INVITATION_REQUEST_OPENAPI_SCHEMA,
  ACCEPT_ORGANIZATION_INVITATION_REQUEST_OPENAPI_SCHEMA,
  acceptLocalOrganizationInvitationRequestSchema,
  acceptOrganizationInvitationRequestSchema,
  loginRequestSchema,
  mfaLoginChallengeVerifyRequestSchema,
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
import { SamlService } from "./saml.service.js";
import { z } from "zod";
import { notFound } from "../problem.js";

const RETRY_AFTER_RESPONSE_HEADER_OPENAPI = {
  description: "Seconds until the login may be retried",
  required: true,
  schema: { type: "integer" as const, minimum: 1 },
};

const samlCallbackRequestSchema = z.object({
  RelayState: z.string().max(4_096).optional(),
  SAMLResponse: z.string().min(1).max(2_000_000),
}).strict();
const SAML_CALLBACK_OPENAPI_SCHEMA = {
  type: "object" as const,
  additionalProperties: false,
  required: ["SAMLResponse"],
  properties: {
    RelayState: { type: "string" as const, maxLength: 4_096 },
    SAMLResponse: { type: "string" as const, minLength: 1, maxLength: 2_000_000 },
  },
};
const MFA_LOGIN_CHALLENGE_RESPONSE_OPENAPI_SCHEMA = {
  type: "object" as const,
  additionalProperties: false,
  required: ["challengeToken", "expiresAt"],
  properties: {
    challengeToken: { type: "string" as const },
    expiresAt: { type: "string" as const, format: "date-time" },
  },
};

/** 从 ACS 请求 URL 读取并验证 providerId；provider 标识不再依赖 IdP 表单附加字段。 */
function samlProviderId(request: HttpRequestBoundary): string {
  const value = new URL(request.url, "https://singularity.invalid").searchParams.get("providerId");
  const parsed = z.string().uuid().safeParse(value);
  if (!parsed.success) {
    throw notFound();
  }
  return parsed.data;
}

@ApiTags("identity")
@Controller()
export class IdentityController {
  constructor(
    private readonly identity: IdentityService,
    private readonly organizations: OrganizationManagementService,
    private readonly saml: SamlService,
  ) {}

  @Post(AUTH_INVITATION_ACCEPT_LOCAL_PATH)
  @HttpCode(200)
  @Header("Cache-Control", "no-store")
  @SameOrigin()
  @ApiProblemResponses(400, 403, 404, 409, 503)
  @ApiOperation({ summary: "Accept an organization invitation with a local account" })
  @ApiBody({
    schema: ACCEPT_LOCAL_ORGANIZATION_INVITATION_REQUEST_OPENAPI_SCHEMA,
  })
  @ApiOkResponse({ schema: LOGIN_RESPONSE_OPENAPI_SCHEMA })
  @ApiResponse({
    status: 429,
    headers: { "Retry-After": RETRY_AFTER_RESPONSE_HEADER_OPENAPI },
    schema: API_PROBLEM_OPENAPI_SCHEMA_BY_STATUS[429],
  })
  async acceptLocalInvitation(
    @Body(new ZodValidationPipe(acceptLocalOrganizationInvitationRequestSchema))
    body: AcceptLocalOrganizationInvitationRequest,
    @Req() request: HttpRequestBoundary,
    @Res({ passthrough: true }) reply: HttpReplyBoundary,
  ): Promise<LoginResponse> {
    const session = await this.organizations.acceptLocalInvitation(
      body.invitationToken,
      body.password,
      request.cookies[AUTH_SESSION_COOKIE_NAME],
      request.id,
    );
    reply.setCookie(AUTH_SESSION_COOKIE_NAME, session.tokenValue, SESSION_COOKIE_OPTIONS);
    return { csrfToken: session.csrfToken };
  }

  @Post(AUTH_MFA_CHALLENGE_VERIFY_PATH)
  @HttpCode(200)
  @Header("Cache-Control", "no-store")
  @SameOrigin()
  @ApiProblemResponses(400, 401, 403, 503)
  @ApiOperation({ summary: "Verify an MFA login challenge" })
  async verifyMfaChallenge(
    @Body(new ZodValidationPipe(mfaLoginChallengeVerifyRequestSchema)) body: MfaLoginChallengeVerifyRequest,
    @Req() request: HttpRequestBoundary,
    @Res({ passthrough: true }) reply: HttpReplyBoundary,
  ): Promise<LoginResponse> {
    const session = await this.identity.verifyMfaLogin({
      challengeToken: body.challengeToken,
      code: body.code,
      currentTokenValue: request.cookies[AUTH_SESSION_COOKIE_NAME],
      requestId: request.id,
    });
    reply.setCookie(AUTH_SESSION_COOKIE_NAME, session.tokenValue, SESSION_COOKIE_OPTIONS);
    return { csrfToken: session.csrfToken };
  }

  @Post(AUTH_SAML_CALLBACK_PATH)
  @HttpCode(200)
  @Header("Cache-Control", "no-store")
  @ApiConsumes("application/x-www-form-urlencoded")
  @ApiBody({ schema: SAML_CALLBACK_OPENAPI_SCHEMA })
  @ApiProblemResponses(400, 401, 403, 404, 503)
  @ApiOperation({ summary: "Complete a SAML login assertion" })
  async samlCallback(
    @Body(new ZodValidationPipe(samlCallbackRequestSchema)) body: { RelayState?: string; SAMLResponse: string },
    @Req() request: HttpRequestBoundary,
    @Res({ passthrough: true }) reply: HttpReplyBoundary,
  ): Promise<LoginResponse> {
    const providerId = samlProviderId(request);
    const session = await this.saml.authenticate({
      currentTokenValue: request.cookies[AUTH_SESSION_COOKIE_NAME],
      encodedResponse: body.SAMLResponse,
      providerId,
      requestId: request.id,
    });
    reply.setCookie(AUTH_SESSION_COOKIE_NAME, session.tokenValue, SESSION_COOKIE_OPTIONS);
    return { csrfToken: session.csrfToken };
  }

  @Get(AUTH_SAML_START_PATH)
  @Header("Cache-Control", "no-store")
  @SameOrigin()
  @ApiProblemResponses(400, 403, 404, 503)
  @ApiOperation({ summary: "Create a SAML login redirect" })
  async samlStart(
    @Req() request: HttpRequestBoundary,
  ): Promise<{ location: string }> {
    const providerId = samlProviderId(request);
    return this.saml.authorize(providerId, request.id);
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
  @ApiResponse({ status: 202, schema: MFA_LOGIN_CHALLENGE_RESPONSE_OPENAPI_SCHEMA })
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
  ): Promise<LoginResponse | MfaLoginChallengeResponse> {
    const session = await this.identity.login({
      currentTokenValue: request.cookies[AUTH_SESSION_COOKIE_NAME],
      loginIdentifier: body.loginIdentifier,
      password: body.password,
      requestId: request.id,
      sourceAddress: request.ip,
    });
    if ("tokenValue" in session) {
      reply.setCookie(AUTH_SESSION_COOKIE_NAME, session.tokenValue, SESSION_COOKIE_OPTIONS);
      return { csrfToken: session.csrfToken };
    }
    reply.status(202);
    return session;
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
  getCsrf(
    @CurrentSession() session: AuthenticatedSession,
  ): CsrfResponse {
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
