import {
  Body,
  Controller,
  Get,
  Header,
  Param,
  Patch,
  Req,
} from "@nestjs/common";
import {
  ApiBody,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from "@nestjs/swagger";
import {
  DOCUMENT_ACCESS_POLICY_CONTROLLER_PATH,
  DOCUMENT_ACCESS_POLICY_OPENAPI_SCHEMA,
  UPDATE_DOCUMENT_ACCESS_POLICY_REQUEST_OPENAPI_SCHEMA,
  documentPathParametersSchema,
  updateDocumentAccessPolicyRequestSchema,
  type DocumentIdentity,
  type UpdateDocumentAccessPolicyRequest,
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
import { DocumentAccessPolicyService } from "./document-access.service.js";

@ApiTags("document-access")
@Controller()
export class DocumentAccessController {
  constructor(private readonly access: DocumentAccessPolicyService) {}

  @Get(DOCUMENT_ACCESS_POLICY_CONTROLLER_PATH)
  @Header("Cache-Control", "no-store")
  @Authenticated()
  @ApiProblemResponses(400, 401, 403, 404, 503)
  @ApiOperation({ summary: "Read a document access policy" })
  @ApiParam({ name: "organizationId", schema: { type: "string", format: "uuid" } })
  @ApiParam({ name: "spaceId", schema: { type: "string", format: "uuid" } })
  @ApiParam({ name: "notebookId", schema: { type: "string" } })
  @ApiParam({ name: "documentId", schema: { type: "string" } })
  @ApiOkResponse({ schema: DOCUMENT_ACCESS_POLICY_OPENAPI_SCHEMA })
  async get(
    @Param(new ZodValidationPipe(documentPathParametersSchema))
    parameters: DocumentIdentity,
    @CurrentSession() session: AuthenticatedSession,
  ) {
    return this.access.getPolicy({ ...parameters, actorUserId: session.userId });
  }

  @Patch(DOCUMENT_ACCESS_POLICY_CONTROLLER_PATH)
  @Header("Cache-Control", "no-store")
  @SessionMutation()
  @ApiProblemResponses(400, 401, 403, 404, 409, 503)
  @ApiOperation({ summary: "Replace a document access policy" })
  @ApiBody({ schema: UPDATE_DOCUMENT_ACCESS_POLICY_REQUEST_OPENAPI_SCHEMA })
  @ApiOkResponse({ schema: DOCUMENT_ACCESS_POLICY_OPENAPI_SCHEMA })
  async update(
    @Param(new ZodValidationPipe(documentPathParametersSchema))
    parameters: DocumentIdentity,
    @Body(new ZodValidationPipe(updateDocumentAccessPolicyRequestSchema))
    body: UpdateDocumentAccessPolicyRequest,
    @Req() request: HttpRequestBoundary,
    @CurrentSession() session: AuthenticatedSession,
  ) {
    return this.access.updatePolicy({
      actorUserId: session.userId,
      identity: parameters,
      requestId: request.id,
      value: body,
    });
  }
}
