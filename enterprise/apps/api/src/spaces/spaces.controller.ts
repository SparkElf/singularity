import { Controller, Get, Header, Param, Req, Res } from "@nestjs/common";
import {
  ApiCookieAuth,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
} from "@nestjs/swagger";
import {
  API_PROBLEM_OPENAPI_SCHEMA_BY_STATUS,
  AUTHORIZED_SPACES_PATH,
  AUTHORIZED_SPACES_RESPONSE_OPENAPI_SCHEMA,
  type AuthorizedSpacesResponse,
  AUTH_SESSION_COOKIE_NAME,
  SPACE_RUNTIME_BOOTSTRAP_OPENAPI_SCHEMA,
  SPACE_RUNTIME_CONTROLLER_PATH,
  type SpaceRuntimeBootstrap,
  spaceRuntimePathParametersSchema,
  UUID_OPENAPI_SCHEMA,
} from "@singularity/contracts";

import type {
  HttpReplyBoundary,
  HttpRequestBoundary,
} from "../http-boundary.js";
import {
  ApiProblemError,
  notFound,
  serviceUnavailable,
  validationFailed,
} from "../problem.js";
import { IdentityService } from "../identity/identity.service.js";
import { SESSION_COOKIE_OPTIONS } from "../identity/session-crypto.js";
import { SpaceAccessService } from "./space-access.service.js";

@ApiTags("spaces")
@Controller()
export class SpacesController {
  constructor(
    private readonly identity: IdentityService,
    private readonly spaces: SpaceAccessService,
  ) {}

  @Get(AUTHORIZED_SPACES_PATH)
  @Header("Cache-Control", "no-store")
  @ApiOperation({ summary: "List the current user's authorized spaces" })
  @ApiCookieAuth(AUTH_SESSION_COOKIE_NAME)
  @ApiOkResponse({ schema: AUTHORIZED_SPACES_RESPONSE_OPENAPI_SCHEMA })
  @ApiResponse({
    status: 401,
    schema: API_PROBLEM_OPENAPI_SCHEMA_BY_STATUS[401],
  })
  @ApiResponse({
    status: 503,
    schema: API_PROBLEM_OPENAPI_SCHEMA_BY_STATUS[503],
  })
  async listSpaces(
    @Req() request: HttpRequestBoundary,
    @Res({ passthrough: true }) reply: HttpReplyBoundary,
  ): Promise<AuthorizedSpacesResponse> {
    const session = await this.#authenticateOrClear(request, reply);
    return { spaces: await this.spaces.listAuthorizedSpaces(session.userId) };
  }

  @Get(SPACE_RUNTIME_CONTROLLER_PATH)
  @Header("Cache-Control", "no-store")
  @ApiOperation({ summary: "Read an authorized space runtime state" })
  @ApiCookieAuth(AUTH_SESSION_COOKIE_NAME)
  @ApiParam({ name: "organizationId", schema: UUID_OPENAPI_SCHEMA })
  @ApiParam({ name: "spaceId", schema: UUID_OPENAPI_SCHEMA })
  @ApiOkResponse({ schema: SPACE_RUNTIME_BOOTSTRAP_OPENAPI_SCHEMA })
  @ApiResponse({
    status: 400,
    schema: API_PROBLEM_OPENAPI_SCHEMA_BY_STATUS[400],
  })
  @ApiResponse({
    status: 401,
    schema: API_PROBLEM_OPENAPI_SCHEMA_BY_STATUS[401],
  })
  @ApiResponse({
    status: 404,
    schema: API_PROBLEM_OPENAPI_SCHEMA_BY_STATUS[404],
  })
  @ApiResponse({
    status: 503,
    schema: API_PROBLEM_OPENAPI_SCHEMA_BY_STATUS[503],
  })
  async getRuntime(
    @Param() parameters: unknown,
    @Req() request: HttpRequestBoundary,
    @Res({ passthrough: true }) reply: HttpReplyBoundary,
  ): Promise<SpaceRuntimeBootstrap> {
    const parsed = spaceRuntimePathParametersSchema.safeParse(parameters);
    if (!parsed.success) {
      throw validationFailed();
    }
    const session = await this.#authenticateOrClear(request, reply);
    const runtime = await this.spaces.getRuntime(
      session.userId,
      parsed.data.organizationId,
      parsed.data.spaceId,
      request.id,
    );
    if (runtime === null) {
      throw notFound();
    }
    if (runtime === "kernel-missing") {
      throw serviceUnavailable();
    }
    return runtime;
  }

  async #authenticateOrClear(
    request: HttpRequestBoundary,
    reply: HttpReplyBoundary,
  ) {
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
}
