import { Controller, Get, Header, Param, Req } from "@nestjs/common";
import {
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
  SPACE_RUNTIME_BOOTSTRAP_OPENAPI_SCHEMA,
  SPACE_RUNTIME_CONTROLLER_PATH,
  type SpaceRuntimeBootstrap,
  type SpaceRuntimePathParameters,
  spaceRuntimePathParametersSchema,
  UUID_OPENAPI_SCHEMA,
} from "@singularity/contracts";

import type { HttpRequestBoundary } from "../http-boundary.js";
import { Authenticated, CurrentSession } from "../identity/http-access.js";
import type { AuthenticatedSession } from "../identity/identity.service.js";
import { ZodValidationPipe } from "../identity/zod-validation.pipe.js";
import { runtimeAccessLost, serviceUnavailable } from "../problem.js";
import { SpaceAccessService } from "./space-access.service.js";

@ApiTags("spaces")
@Controller()
export class SpacesController {
  constructor(
    private readonly spaces: SpaceAccessService,
  ) {}

  @Get(AUTHORIZED_SPACES_PATH)
  @Header("Cache-Control", "no-store")
  @Authenticated()
  @ApiOperation({ summary: "List the current user's authorized spaces" })
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
    @CurrentSession() session: AuthenticatedSession,
  ): Promise<AuthorizedSpacesResponse> {
    return { spaces: await this.spaces.listAuthorizedSpaces(session.userId) };
  }

  @Get(SPACE_RUNTIME_CONTROLLER_PATH)
  @Header("Cache-Control", "no-store")
  @Authenticated()
  @ApiOperation({ summary: "Read an authorized space runtime state" })
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
    @Param(new ZodValidationPipe(spaceRuntimePathParametersSchema))
    parameters: SpaceRuntimePathParameters,
    @Req() request: HttpRequestBoundary,
    @CurrentSession() session: AuthenticatedSession,
  ): Promise<SpaceRuntimeBootstrap> {
    const runtime = await this.spaces.getRuntime(
      session.userId,
      parameters.organizationId,
      parameters.spaceId,
      request.id,
    );
    if (runtime === null) {
      // 空间从当前会话授权范围消失时保持隐藏式 404，并显式标记为访问丢失。
      throw runtimeAccessLost();
    }
    if (runtime === "kernel-missing") {
      throw serviceUnavailable();
    }
    return runtime;
  }
}
