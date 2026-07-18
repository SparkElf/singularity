import type { IncomingMessage } from "node:http";

import {
  Controller,
  Get,
  Header,
  Param,
  Query,
  Req,
} from "@nestjs/common";
import {
  ApiOkResponse,
  ApiOperation,
  ApiQuery,
  ApiTags,
} from "@nestjs/swagger";
import {
  CONTENT_DIRECTORY_CHILD_DOCUMENTS_CONTROLLER_PATH,
  CONTENT_DIRECTORY_DOCUMENTS_RESPONSE_OPENAPI_SCHEMA,
  CONTENT_DIRECTORY_MAX_OFFSET,
  CONTENT_DIRECTORY_NOTEBOOKS_CONTROLLER_PATH,
  CONTENT_DIRECTORY_NOTEBOOKS_RESPONSE_OPENAPI_SCHEMA,
  CONTENT_DIRECTORY_ROOT_DOCUMENTS_CONTROLLER_PATH,
  contentDirectoryChildPathParametersSchema,
  contentDirectoryNotebookPathParametersSchema,
  contentDirectoryNotebooksQuerySchema,
  contentDirectoryQuerySchema,
  contentDirectorySpacePathParametersSchema,
  type ContentDirectoryChildDocumentsPathParameters,
  type ContentDirectoryDocumentsResponse,
  type ContentDirectoryNotebooksPathParameters,
  type ContentDirectoryNotebooksQuery,
  type ContentDirectoryNotebooksResponse,
  type ContentDirectoryQuery,
  type ContentDirectoryRootDocumentsPathParameters,
} from "@singularity/contracts";

import type { HttpRequestBoundary } from "../http-boundary.js";
import {
  Authenticated,
  ApiProblemResponses,
  CurrentSession,
} from "../identity/http-access.js";
import type { AuthenticatedSession } from "../identity/identity.service.js";
import { ZodValidationPipe } from "../identity/zod-validation.pipe.js";
import { ContentDirectoryService } from "./content-directory.service.js";

const DIRECTORY_OFFSET_QUERY = {
  name: "offset",
  required: false,
  schema: {
    default: 0,
    maximum: CONTENT_DIRECTORY_MAX_OFFSET,
    minimum: 0,
    type: "integer" as const,
  },
};

interface ContentDirectoryHttpRequest extends HttpRequestBoundary {
  readonly raw: IncomingMessage;
}

@ApiTags("content-directory")
@Controller()
export class ContentDirectoryController {
  constructor(private readonly directory: ContentDirectoryService) {}

  @Get(CONTENT_DIRECTORY_NOTEBOOKS_CONTROLLER_PATH)
  @Authenticated()
  @Header("Cache-Control", "no-store")
  @ApiProblemResponses(400, 401, 404, 503)
  @ApiOperation({ summary: "List visible notebooks in an authorized space" })
  @ApiOkResponse({
    schema: CONTENT_DIRECTORY_NOTEBOOKS_RESPONSE_OPENAPI_SCHEMA,
  })
  listNotebooks(
    @Param(new ZodValidationPipe(contentDirectorySpacePathParametersSchema))
    parameters: ContentDirectoryNotebooksPathParameters,
    @Query(new ZodValidationPipe(contentDirectoryNotebooksQuerySchema))
    _query: ContentDirectoryNotebooksQuery,
    @Req() request: ContentDirectoryHttpRequest,
    @CurrentSession() session: AuthenticatedSession,
  ): Promise<ContentDirectoryNotebooksResponse> {
    return this.#withRequestSignal(request, (signal) =>
      this.directory.listNotebooks({
        actorUserId: session.userId,
        organizationId: parameters.organizationId,
        requestId: request.id,
        signal,
        spaceId: parameters.spaceId,
      }),
    );
  }

  @Get(CONTENT_DIRECTORY_ROOT_DOCUMENTS_CONTROLLER_PATH)
  @Authenticated()
  @Header("Cache-Control", "no-store")
  @ApiProblemResponses(400, 401, 404, 503)
  @ApiOperation({ summary: "List one page of root documents" })
  @ApiQuery(DIRECTORY_OFFSET_QUERY)
  @ApiOkResponse({
    schema: CONTENT_DIRECTORY_DOCUMENTS_RESPONSE_OPENAPI_SCHEMA,
  })
  listRootDocuments(
    @Param(new ZodValidationPipe(contentDirectoryNotebookPathParametersSchema))
    parameters: Omit<ContentDirectoryRootDocumentsPathParameters, "offset">,
    @Query(new ZodValidationPipe(contentDirectoryQuerySchema))
    query: ContentDirectoryQuery,
    @Req() request: ContentDirectoryHttpRequest,
    @CurrentSession() session: AuthenticatedSession,
  ): Promise<ContentDirectoryDocumentsResponse> {
    return this.#withRequestSignal(request, (signal) =>
      this.directory.listDocuments({
        actorUserId: session.userId,
        notebookId: parameters.notebookId,
        offset: query.offset,
        organizationId: parameters.organizationId,
        requestId: request.id,
        signal,
        spaceId: parameters.spaceId,
      }),
    );
  }

  @Get(CONTENT_DIRECTORY_CHILD_DOCUMENTS_CONTROLLER_PATH)
  @Authenticated()
  @Header("Cache-Control", "no-store")
  @ApiProblemResponses(400, 401, 404, 503)
  @ApiOperation({ summary: "List one page of direct child documents" })
  @ApiQuery(DIRECTORY_OFFSET_QUERY)
  @ApiOkResponse({
    schema: CONTENT_DIRECTORY_DOCUMENTS_RESPONSE_OPENAPI_SCHEMA,
  })
  listChildDocuments(
    @Param(new ZodValidationPipe(contentDirectoryChildPathParametersSchema))
    parameters: Omit<ContentDirectoryChildDocumentsPathParameters, "offset">,
    @Query(new ZodValidationPipe(contentDirectoryQuerySchema))
    query: ContentDirectoryQuery,
    @Req() request: ContentDirectoryHttpRequest,
    @CurrentSession() session: AuthenticatedSession,
  ): Promise<ContentDirectoryDocumentsResponse> {
    return this.#withRequestSignal(request, (signal) =>
      this.directory.listDocuments({
        actorUserId: session.userId,
        notebookId: parameters.notebookId,
        offset: query.offset,
        organizationId: parameters.organizationId,
        parentDocumentId: parameters.documentId,
        requestId: request.id,
        signal,
        spaceId: parameters.spaceId,
      }),
    );
  }

  async #withRequestSignal<Result>(
    request: ContentDirectoryHttpRequest,
    operation: (signal: AbortSignal) => Promise<Result>,
  ): Promise<Result> {
    const abortController = new AbortController();
    const abort = () =>
      abortController.abort(new Error("Browser directory request closed"));
    if (request.raw.aborted) {
      abort();
    } else {
      request.raw.once("aborted", abort);
    }
    try {
      return await operation(abortController.signal);
    } finally {
      request.raw.off("aborted", abort);
    }
  }
}
