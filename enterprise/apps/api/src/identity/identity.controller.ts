import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Inject,
  Post,
  Req,
  Res,
} from "@nestjs/common";
import {
  ApiBody,
  ApiCookieAuth,
  ApiHeader,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from "@nestjs/swagger";
import {
  API_PROBLEM_OPENAPI_SCHEMA_BY_STATUS,
  AUTH_CSRF_PATH,
  AUTH_LOGIN_PATH,
  AUTH_LOGOUT_PATH,
  AUTH_SESSION_COOKIE_NAME,
  CSRF_HEADER_NAME,
  CSRF_TOKEN_OPENAPI_SCHEMA,
  CSRF_RESPONSE_OPENAPI_SCHEMA,
  type CsrfResponse,
  LOGIN_REQUEST_OPENAPI_SCHEMA,
  LOGIN_RESPONSE_OPENAPI_SCHEMA,
  type LoginResponse,
  loginRequestSchema,
} from "@singularity/contracts";

import type { ApiConfiguration } from "../configuration.js";
import type {
  HttpReplyBoundary,
  HttpRequestBoundary,
} from "../http-boundary.js";
import { singleHeader } from "../http-boundary.js";
import {
  ApiProblemError,
  forbidden,
  validationFailed,
} from "../problem.js";
import { IdentityService, type AuthenticatedSession } from "./identity.service.js";
import { SESSION_COOKIE_OPTIONS } from "./session-crypto.js";
import { API_CONFIGURATION } from "../tokens.js";

const ORIGIN_HEADER_OPENAPI = {
  name: "Origin",
  required: true,
  schema: { type: "string" as const, format: "uri" },
};

const CSRF_HEADER_OPENAPI = {
  name: CSRF_HEADER_NAME,
  required: true,
  schema: CSRF_TOKEN_OPENAPI_SCHEMA,
};

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
    @Inject(API_CONFIGURATION)
    private readonly configuration: ApiConfiguration,
  ) {}

  @Post(AUTH_LOGIN_PATH)
  @HttpCode(200)
  @Header("Cache-Control", "no-store")
  @ApiOperation({ summary: "Create a local authenticated session" })
  @ApiHeader(ORIGIN_HEADER_OPENAPI)
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
    @Body() body: unknown,
    @Req() request: HttpRequestBoundary,
    @Res({ passthrough: true }) reply: HttpReplyBoundary,
  ): Promise<LoginResponse> {
    this.#requireOrigin(request);
    const parsed = loginRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw validationFailed();
    }

    const session = await this.identity.login({
      currentTokenValue: request.cookies[AUTH_SESSION_COOKIE_NAME],
      loginIdentifier: parsed.data.loginIdentifier,
      password: parsed.data.password,
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
  @ApiOperation({ summary: "Recover the current session CSRF token" })
  @ApiCookieAuth(AUTH_SESSION_COOKIE_NAME)
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
    @Req() request: HttpRequestBoundary,
    @Res({ passthrough: true }) reply: HttpReplyBoundary,
  ): Promise<CsrfResponse> {
    const session = await this.#authenticateOrClear(request, reply);
    return { csrfToken: session.csrfToken };
  }

  @Post(AUTH_LOGOUT_PATH)
  @HttpCode(204)
  @Header("Cache-Control", "no-store")
  @ApiOperation({ summary: "Revoke the current local session" })
  @ApiCookieAuth(AUTH_SESSION_COOKIE_NAME)
  @ApiHeader(ORIGIN_HEADER_OPENAPI)
  @ApiHeader(CSRF_HEADER_OPENAPI)
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
    @Res({ passthrough: true }) reply: HttpReplyBoundary,
  ): Promise<void> {
    this.#requireOrigin(request);
    const session = await this.#authenticateWithCsrfOrClear(
      request,
      reply,
      singleHeader(request.headers[CSRF_HEADER_NAME.toLowerCase()]),
    );
    await this.identity.revokeCurrentSession(session, request.id);
    reply.clearCookie(AUTH_SESSION_COOKIE_NAME, SESSION_COOKIE_OPTIONS);
  }

  #requireOrigin(request: HttpRequestBoundary): void {
    if (singleHeader(request.headers.origin) !== this.configuration.publicOrigin) {
      throw forbidden();
    }
  }

  async #authenticateOrClear(
    request: HttpRequestBoundary,
    reply: HttpReplyBoundary,
  ): Promise<AuthenticatedSession> {
    try {
      return await this.identity.authenticate(
        request.cookies[AUTH_SESSION_COOKIE_NAME],
        request.id,
      );
    } catch (error) {
      if (
        error instanceof ApiProblemError &&
        error.code === "unauthenticated"
      ) {
        reply.clearCookie(AUTH_SESSION_COOKIE_NAME, SESSION_COOKIE_OPTIONS);
      }
      throw error;
    }
  }

  async #authenticateWithCsrfOrClear(
    request: HttpRequestBoundary,
    reply: HttpReplyBoundary,
    csrfToken: string | undefined,
  ): Promise<AuthenticatedSession> {
    try {
      return await this.identity.authenticateWithCsrf(
        request.cookies[AUTH_SESSION_COOKIE_NAME],
        csrfToken,
        request.id,
      );
    } catch (error) {
      if (
        error instanceof ApiProblemError &&
        error.code === "unauthenticated"
      ) {
        reply.clearCookie(AUTH_SESSION_COOKIE_NAME, SESSION_COOKIE_OPTIONS);
      }
      throw error;
    }
  }
}
