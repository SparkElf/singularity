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
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from "@nestjs/swagger";
import {
  API_PROBLEM_OPENAPI_SCHEMA,
  AUTH_CSRF_PATH,
  AUTH_LOGIN_PATH,
  AUTH_LOGOUT_PATH,
  AUTH_SESSION_COOKIE_NAME,
  CSRF_HEADER_NAME,
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
  @ApiBody({ schema: LOGIN_REQUEST_OPENAPI_SCHEMA })
  @ApiOkResponse({ schema: LOGIN_RESPONSE_OPENAPI_SCHEMA })
  @ApiResponse({ status: 400, schema: API_PROBLEM_OPENAPI_SCHEMA })
  @ApiResponse({ status: 401, schema: API_PROBLEM_OPENAPI_SCHEMA })
  @ApiResponse({ status: 403, schema: API_PROBLEM_OPENAPI_SCHEMA })
  @ApiResponse({ status: 429, schema: API_PROBLEM_OPENAPI_SCHEMA })
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
  @ApiOkResponse({ schema: CSRF_RESPONSE_OPENAPI_SCHEMA })
  @ApiResponse({ status: 401, schema: API_PROBLEM_OPENAPI_SCHEMA })
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
  @ApiNoContentResponse()
  @ApiResponse({ status: 401, schema: API_PROBLEM_OPENAPI_SCHEMA })
  @ApiResponse({ status: 403, schema: API_PROBLEM_OPENAPI_SCHEMA })
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
