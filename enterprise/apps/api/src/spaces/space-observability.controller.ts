import { Controller, Get, Header, Param } from "@nestjs/common";
import {
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from "@nestjs/swagger";
import {
  ORGANIZATION_SPACE_OBSERVABILITY_CONTROLLER_PATH,
  SPACE_OBSERVABILITY_OPENAPI_SCHEMA,
  managedSpacePathParametersSchema,
  type ManagedSpacePathParameters,
  type SpaceObservabilityView,
} from "@singularity/contracts";

import {
  Authenticated,
  ApiProblemResponses,
  CurrentSession,
  type AuthenticatedSession,
} from "../identity/http-access.js";
import { ZodValidationPipe } from "../identity/zod-validation.pipe.js";
import { SpaceObservabilityService } from "./space-observability.service.js";

@ApiTags("space-observability")
@Controller()
export class SpaceObservabilityController {
  constructor(private readonly observability: SpaceObservabilityService) {}

  @Get(ORGANIZATION_SPACE_OBSERVABILITY_CONTROLLER_PATH)
  @Authenticated()
  @Header("Cache-Control", "no-store")
  @ApiProblemResponses(400, 401, 403, 404, 503)
  @ApiOperation({ summary: "Read persisted Kernel health and capacity samples" })
  @ApiOkResponse({ schema: SPACE_OBSERVABILITY_OPENAPI_SCHEMA })
  async read(
    @Param(new ZodValidationPipe(managedSpacePathParametersSchema))
    parameters: ManagedSpacePathParameters,
    @CurrentSession() session: AuthenticatedSession,
  ): Promise<SpaceObservabilityView> {
    return this.observability.read({
      actorUserId: session.userId,
      organizationId: parameters.organizationId,
      spaceId: parameters.spaceId,
    });
  }
}
