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
  ApiParam,
  ApiQuery,
  ApiTags,
} from "@nestjs/swagger";
import {
  CONTENT_ID_PATTERN,
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
  UUID_OPENAPI_SCHEMA,
  type ContentDirectoryChildDocumentsPathParameters,
  type ContentDirectoryDocumentsResponse,
  type ContentDirectoryNotebooksPathParameters,
  type ContentDirectoryNotebooksQuery,
  type ContentDirectoryNotebooksResponse,
  type ContentDirectoryQuery,
  type ContentDirectoryRootDocumentsPathParameters,
} from "@singularity/contracts";

import type { HttpRequestBoundary } from "../http-boundary.js";
import { bindHttpRequestAbortSignal } from "../http-request-signal.js";
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
  @ApiParam({ name: "organizationId", schema: UUID_OPENAPI_SCHEMA })
  @ApiParam({ name: "spaceId", schema: UUID_OPENAPI_SCHEMA })
  @ApiOkResponse({
    schema: CONTENT_DIRECTORY_NOTEBOOKS_RESPONSE_OPENAPI_SCHEMA,
  })
  /** 建立请求 AbortSignal，调用目录服务并在响应完成后释放 socket 监听。 */
  async listNotebooks(
    @Param(new ZodValidationPipe(contentDirectorySpacePathParametersSchema))
    parameters: ContentDirectoryNotebooksPathParameters,
    @Query(new ZodValidationPipe(contentDirectoryNotebooksQuerySchema))
    _query: ContentDirectoryNotebooksQuery,
    @Req() request: ContentDirectoryHttpRequest,
    @CurrentSession() session: AuthenticatedSession,
  ): Promise<ContentDirectoryNotebooksResponse> {
    const abortScope = bindHttpRequestAbortSignal(request.raw);
    try {
      return await this.directory.listNotebooks({
        actorUserId: session.userId,
        organizationId: parameters.organizationId,
        requestId: request.id,
        signal: abortScope.signal,
        spaceId: parameters.spaceId,
      });
    } finally {
      abortScope.dispose();
    }
  }

  @Get(CONTENT_DIRECTORY_ROOT_DOCUMENTS_CONTROLLER_PATH)
  @Authenticated()
  @Header("Cache-Control", "no-store")
  @ApiProblemResponses(400, 401, 404, 503)
  @ApiOperation({ summary: "List one page of root documents" })
  @ApiParam({
    name: "notebookId",
    schema: { pattern: CONTENT_ID_PATTERN.source, type: "string" },
  })
  @ApiParam({ name: "organizationId", schema: UUID_OPENAPI_SCHEMA })
  @ApiParam({ name: "spaceId", schema: UUID_OPENAPI_SCHEMA })
  @ApiQuery(DIRECTORY_OFFSET_QUERY)
  @ApiOkResponse({
    schema: CONTENT_DIRECTORY_DOCUMENTS_RESPONSE_OPENAPI_SCHEMA,
  })
  /** 获取根文档页；文档身份只来自当前路由目录参数。 */
  async listRootDocuments(
    @Param(new ZodValidationPipe(contentDirectoryNotebookPathParametersSchema))
    parameters: Omit<ContentDirectoryRootDocumentsPathParameters, "offset">,
    @Query(new ZodValidationPipe(contentDirectoryQuerySchema))
    query: ContentDirectoryQuery,
    @Req() request: ContentDirectoryHttpRequest,
    @CurrentSession() session: AuthenticatedSession,
  ): Promise<ContentDirectoryDocumentsResponse> {
    const abortScope = bindHttpRequestAbortSignal(request.raw);
    try {
      return await this.directory.listDocuments({
        actorUserId: session.userId,
        notebookId: parameters.notebookId,
        offset: query.offset,
        organizationId: parameters.organizationId,
        requestId: request.id,
        signal: abortScope.signal,
        spaceId: parameters.spaceId,
      });
    } finally {
      abortScope.dispose();
    }
  }

  @Get(CONTENT_DIRECTORY_CHILD_DOCUMENTS_CONTROLLER_PATH)
  @Authenticated()
  @Header("Cache-Control", "no-store")
  @ApiProblemResponses(400, 401, 404, 503)
  @ApiOperation({ summary: "List one page of direct child documents" })
  @ApiParam({
    name: "documentId",
    schema: { pattern: CONTENT_ID_PATTERN.source, type: "string" },
  })
  @ApiParam({
    name: "notebookId",
    schema: { pattern: CONTENT_ID_PATTERN.source, type: "string" },
  })
  @ApiParam({ name: "organizationId", schema: UUID_OPENAPI_SCHEMA })
  @ApiParam({ name: "spaceId", schema: UUID_OPENAPI_SCHEMA })
  @ApiQuery(DIRECTORY_OFFSET_QUERY)
  @ApiOkResponse({
    schema: CONTENT_DIRECTORY_DOCUMENTS_RESPONSE_OPENAPI_SCHEMA,
  })
  /** 获取指定 notebook/document 下的直接子文档页，不从响应或编辑器推断身份。 */
  async listChildDocuments(
    @Param(new ZodValidationPipe(contentDirectoryChildPathParametersSchema))
    parameters: Omit<ContentDirectoryChildDocumentsPathParameters, "offset">,
    @Query(new ZodValidationPipe(contentDirectoryQuerySchema))
    query: ContentDirectoryQuery,
    @Req() request: ContentDirectoryHttpRequest,
    @CurrentSession() session: AuthenticatedSession,
  ): Promise<ContentDirectoryDocumentsResponse> {
    const abortScope = bindHttpRequestAbortSignal(request.raw);
    try {
      return await this.directory.listDocuments({
        actorUserId: session.userId,
        notebookId: parameters.notebookId,
        offset: query.offset,
        organizationId: parameters.organizationId,
        parentDocumentId: parameters.documentId,
        requestId: request.id,
        signal: abortScope.signal,
        spaceId: parameters.spaceId,
      });
    } finally {
      abortScope.dispose();
    }
  }
}
