import {
  Body,
  Controller,
  Get,
  Header,
  Param,
  Post,
  Req,
} from "@nestjs/common";
import {
  ApiBody,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from "@nestjs/swagger";
import {
  DOCUMENT_HISTORY_CONTROLLER_PATH,
  DOCUMENT_HISTORY_DIFF_CONTROLLER_PATH,
  DOCUMENT_HISTORY_RESTORE_CONTROLLER_PATH,
  HISTORY_DIFF_OPENAPI_SCHEMA,
  HISTORY_VERSIONS_RESPONSE_OPENAPI_SCHEMA,
  RESTORED_HISTORY_VERSION_OPENAPI_SCHEMA,
  RESTORE_HISTORY_VERSION_REQUEST_OPENAPI_SCHEMA,
  documentIdentitySchema,
  historyVersionPathParametersSchema,
  restoreHistoryVersionRequestSchema,
  type DocumentIdentity,
  type HistoryVersionPathParameters,
  type RestoreHistoryVersionRequest,
} from "@singularity/contracts";

import type { HttpRequestBoundary } from "../http-boundary.js";
import {
  ApiProblemResponses,
  Authenticated,
  CurrentSession,
  SessionMutation,
} from "../identity/http-access.js";
import type { AuthenticatedSession } from "../identity/identity.service.js";
import { ZodValidationPipe } from "../identity/zod-validation.pipe.js";
import { HistoryService } from "./history.service.js";

@ApiTags("history")
@Controller()
export class HistoryController {
  constructor(private readonly history: HistoryService) {}

  @Get(DOCUMENT_HISTORY_CONTROLLER_PATH)
  @Header("Cache-Control", "no-store")
  @Authenticated()
  @ApiProblemResponses(400, 401, 404, 502, 503)
  @ApiOperation({ summary: "List document history versions" })
  @ApiOkResponse({ schema: HISTORY_VERSIONS_RESPONSE_OPENAPI_SCHEMA })
  list(
    @Param(new ZodValidationPipe(documentIdentitySchema)) parameters: DocumentIdentity,
    @Req() request: HttpRequestBoundary,
    @CurrentSession() session: AuthenticatedSession,
  ) {
    return this.history.listVersions({ ...parameters, actorUserId: session.userId, requestId: request.id });
  }

  @Get(DOCUMENT_HISTORY_DIFF_CONTROLLER_PATH)
  @Header("Cache-Control", "no-store")
  @Authenticated()
  @ApiProblemResponses(400, 401, 404, 502, 503)
  @ApiOperation({ summary: "Read a document history version diff" })
  @ApiOkResponse({ schema: HISTORY_DIFF_OPENAPI_SCHEMA })
  diff(
    @Param(new ZodValidationPipe(historyVersionPathParametersSchema)) parameters: HistoryVersionPathParameters,
    @Req() request: HttpRequestBoundary,
    @CurrentSession() session: AuthenticatedSession,
  ) {
    return this.history.diff({ ...parameters, actorUserId: session.userId, requestId: request.id, versionId: parameters.versionId });
  }

  @Post(DOCUMENT_HISTORY_RESTORE_CONTROLLER_PATH)
  @Header("Cache-Control", "no-store")
  @SessionMutation()
  @ApiProblemResponses(400, 401, 403, 404, 502, 503)
  @ApiOperation({ summary: "Restore a history version as a new current version" })
  @ApiBody({ schema: RESTORE_HISTORY_VERSION_REQUEST_OPENAPI_SCHEMA })
  @ApiOkResponse({ schema: RESTORED_HISTORY_VERSION_OPENAPI_SCHEMA })
  restore(
    @Param(new ZodValidationPipe(documentIdentitySchema)) parameters: DocumentIdentity,
    @Body(new ZodValidationPipe(restoreHistoryVersionRequestSchema)) body: RestoreHistoryVersionRequest,
    @Req() request: HttpRequestBoundary,
    @CurrentSession() session: AuthenticatedSession,
  ) {
    return this.history.restore({ ...parameters, actorUserId: session.userId, requestId: request.id, versionId: body.versionId });
  }
}
