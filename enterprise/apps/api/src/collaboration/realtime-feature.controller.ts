import type { IncomingMessage } from "node:http";

import {
  Body,
  Controller,
  Get,
  Header,
  Param,
  Patch,
  Req,
} from "@nestjs/common";
import { ApiBody, ApiOkResponse, ApiOperation, ApiTags } from "@nestjs/swagger";
import {
  COLLABORATION_FEATURE_OPENAPI_SCHEMA,
  DOCUMENT_COLLABORATION_FEATURE_CONTROLLER_PATH,
  documentPathParametersSchema,
  UPDATE_COLLABORATION_FEATURE_REQUEST_OPENAPI_SCHEMA,
  updateCollaborationFeatureRequestSchema,
  type DocumentIdentity,
  type UpdateCollaborationFeatureRequest,
} from "@singularity/contracts";

import {
  ApiProblemResponses,
  Authenticated,
  CurrentSession,
  SessionMutation,
} from "../identity/http-access.js";
import type { AuthenticatedSession } from "../identity/identity.service.js";
import { ZodValidationPipe } from "../identity/zod-validation.pipe.js";
import type { HttpRequestBoundary } from "../http-boundary.js";
import { bindHttpRequestAbortSignal } from "../http-request-signal.js";
import { CollaborationControlService } from "./collaboration-control.service.js";

type CollaborationFeatureHttpRequest = HttpRequestBoundary & {
  readonly raw: IncomingMessage;
};

/** 仅空间管理员可管理协作开关；普通协作者只能通过 WSS join 消费已批准的文档配置。 */
@ApiTags("collaboration")
@Controller()
export class RealtimeFeatureController {
  constructor(private readonly control: CollaborationControlService) {}

  @Get(DOCUMENT_COLLABORATION_FEATURE_CONTROLLER_PATH)
  @Header("Cache-Control", "no-store")
  @Authenticated()
  @ApiProblemResponses(400, 401, 403, 404, 503)
  @ApiOperation({ summary: "Read document collaboration feature" })
  @ApiOkResponse({ schema: COLLABORATION_FEATURE_OPENAPI_SCHEMA })
  get(
    @Param(new ZodValidationPipe(documentPathParametersSchema))
    identity: DocumentIdentity,
    @Req() request: CollaborationFeatureHttpRequest,
    @CurrentSession() session: AuthenticatedSession,
  ) {
    const abortScope = bindHttpRequestAbortSignal(request.raw);
    return this.control.getFeature({
      actorUserId: session.userId,
      identity,
      requestId: request.id,
      signal: abortScope.signal,
    }).finally(() => abortScope.dispose());
  }

  @Patch(DOCUMENT_COLLABORATION_FEATURE_CONTROLLER_PATH)
  @Header("Cache-Control", "no-store")
  @SessionMutation()
  @ApiProblemResponses(400, 401, 403, 404, 503)
  @ApiOperation({ summary: "Update document collaboration feature" })
  @ApiBody({ schema: UPDATE_COLLABORATION_FEATURE_REQUEST_OPENAPI_SCHEMA })
  @ApiOkResponse({ schema: COLLABORATION_FEATURE_OPENAPI_SCHEMA })
  update(
    @Param(new ZodValidationPipe(documentPathParametersSchema))
    identity: DocumentIdentity,
    @Body(new ZodValidationPipe(updateCollaborationFeatureRequestSchema))
    body: UpdateCollaborationFeatureRequest,
    @Req() request: CollaborationFeatureHttpRequest,
    @CurrentSession() session: AuthenticatedSession,
  ) {
    const abortScope = bindHttpRequestAbortSignal(request.raw);
    return this.control.updateFeature({
      actorUserId: session.userId,
      identity,
      requestId: request.id,
      signal: abortScope.signal,
      value: body,
    }).finally(() => abortScope.dispose());
  }
}
