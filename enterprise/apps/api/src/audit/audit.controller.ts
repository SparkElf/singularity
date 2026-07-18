import { Controller, Get, Header, Param, Query } from "@nestjs/common";
import {
  ApiOkResponse,
  ApiOperation,
  ApiQuery,
  ApiTags,
} from "@nestjs/swagger";
import {
  AUDIT_EVENTS_RESPONSE_OPENAPI_SCHEMA,
  ORGANIZATION_AUDIT_EVENTS_CONTROLLER_PATH,
  ORGANIZATION_SPACE_AUDIT_EVENTS_CONTROLLER_PATH,
  auditEventsQuerySchema,
  managedSpacePathParametersSchema,
  organizationPathParametersSchema,
  type AuditEventsQuery,
  type AuditEventsResponse,
  type ManagedSpacePathParameters,
} from "@singularity/contracts";
import { z } from "zod";

import {
  Authenticated,
  ApiProblemResponses,
  CurrentSession,
  type AuthenticatedSession,
} from "../identity/http-access.js";
import { ZodValidationPipe } from "../identity/zod-validation.pipe.js";
import { AuditService } from "./audit.service.js";

type OrganizationPathParameters = z.infer<
  typeof organizationPathParametersSchema
>;

const AUDIT_QUERY_OPENAPI = [
  { name: "beforeSequence", required: false, schema: { type: "string" } },
  {
    name: "limit",
    required: false,
    schema: { type: "integer", minimum: 1, maximum: 200, default: 50 },
  },
] as const;

@ApiTags("audit")
@Controller()
export class AuditController {
  constructor(private readonly audit: AuditService) {}

  @Get(ORGANIZATION_AUDIT_EVENTS_CONTROLLER_PATH)
  @Authenticated()
  @Header("Cache-Control", "no-store")
  @ApiProblemResponses(400, 401, 403, 404, 503)
  @ApiOperation({ summary: "List organization audit events" })
  @ApiQuery(AUDIT_QUERY_OPENAPI[0])
  @ApiQuery(AUDIT_QUERY_OPENAPI[1])
  @ApiOkResponse({ schema: AUDIT_EVENTS_RESPONSE_OPENAPI_SCHEMA })
  async listOrganizationEvents(
    @Param(new ZodValidationPipe(organizationPathParametersSchema))
    parameters: OrganizationPathParameters,
    @Query(new ZodValidationPipe(auditEventsQuerySchema))
    query: AuditEventsQuery,
    @CurrentSession() session: AuthenticatedSession,
  ): Promise<AuditEventsResponse> {
    return {
      events: await this.audit.listOrganizationEvents({
        actorUserId: session.userId,
        ...query,
        organizationId: parameters.organizationId,
      }),
    };
  }

  @Get(ORGANIZATION_SPACE_AUDIT_EVENTS_CONTROLLER_PATH)
  @Authenticated()
  @Header("Cache-Control", "no-store")
  @ApiProblemResponses(400, 401, 403, 404, 503)
  @ApiOperation({ summary: "List space audit events" })
  @ApiQuery(AUDIT_QUERY_OPENAPI[0])
  @ApiQuery(AUDIT_QUERY_OPENAPI[1])
  @ApiOkResponse({ schema: AUDIT_EVENTS_RESPONSE_OPENAPI_SCHEMA })
  async listSpaceEvents(
    @Param(new ZodValidationPipe(managedSpacePathParametersSchema))
    parameters: ManagedSpacePathParameters,
    @Query(new ZodValidationPipe(auditEventsQuerySchema))
    query: AuditEventsQuery,
    @CurrentSession() session: AuthenticatedSession,
  ): Promise<AuditEventsResponse> {
    return {
      events: await this.audit.listSpaceEvents({
        actorUserId: session.userId,
        ...query,
        organizationId: parameters.organizationId,
        spaceId: parameters.spaceId,
      }),
    };
  }

}
