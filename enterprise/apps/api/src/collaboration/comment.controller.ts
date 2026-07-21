import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  Req,
} from "@nestjs/common";
import {
  ApiBody,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from "@nestjs/swagger";
import {
  COMMENT_ENTRY_OPENAPI_SCHEMA,
  COMMENT_THREAD_OPENAPI_SCHEMA,
  DOCUMENT_COMMENT_MENTION_CANDIDATES_CONTROLLER_PATH,
  COMMENT_MENTION_CANDIDATES_RESPONSE_OPENAPI_SCHEMA,
  COMMENT_THREAD_DETAIL_OPENAPI_SCHEMA,
  COMMENT_THREADS_RESPONSE_OPENAPI_SCHEMA,
  CREATE_COMMENT_REPLY_REQUEST_OPENAPI_SCHEMA,
  CREATE_COMMENT_THREAD_REQUEST_OPENAPI_SCHEMA,
  DOCUMENT_COMMENT_ENTRIES_CONTROLLER_PATH,
  DOCUMENT_COMMENT_ENTRY_CONTROLLER_PATH,
  DOCUMENT_COMMENT_THREAD_CONTROLLER_PATH,
  DOCUMENT_COMMENT_THREAD_STATUS_CONTROLLER_PATH,
  DOCUMENT_COMMENT_THREADS_CONTROLLER_PATH,
  UPDATE_COMMENT_ENTRY_REQUEST_OPENAPI_SCHEMA,
  UPDATE_COMMENT_THREAD_STATUS_REQUEST_OPENAPI_SCHEMA,
  commentEntryPathParametersSchema,
  commentThreadPathParametersSchema,
  commentThreadsQuerySchema,
  commentMentionCandidatesQuerySchema,
  createCommentReplyRequestSchema,
  createCommentThreadRequestSchema,
  documentPathParametersSchema,
  type CommentEntryPathParameters,
  type CommentThreadPathParameters,
  type CreateCommentReplyRequest,
  type CreateCommentThreadRequest,
  type DocumentIdentity,
  type UpdateCommentEntryRequest,
  type UpdateCommentThreadStatusRequest,
  updateCommentEntryRequestSchema,
  updateCommentThreadStatusRequestSchema,
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
import { CommentService } from "./comment.service.js";

@ApiTags("comments")
@Controller()
export class CommentController {
  constructor(private readonly comments: CommentService) {}

  @Get(DOCUMENT_COMMENT_THREADS_CONTROLLER_PATH)
  @Header("Cache-Control", "no-store")
  @Authenticated()
  @ApiProblemResponses(400, 401, 404, 503)
  @ApiOperation({ summary: "List visible document comment threads" })
  @ApiOkResponse({ schema: COMMENT_THREADS_RESPONSE_OPENAPI_SCHEMA })
  listThreads(
    @Param(new ZodValidationPipe(documentPathParametersSchema))
    parameters: DocumentIdentity,
    @Query(new ZodValidationPipe(commentThreadsQuerySchema))
    query: { cursor?: string; limit: number },
    @CurrentSession() session: AuthenticatedSession,
  ) {
    return this.comments.listThreads({
      actorUserId: session.userId,
      document: parameters,
      limit: query.limit,
      ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
    });
  }

  @Post(DOCUMENT_COMMENT_THREADS_CONTROLLER_PATH)
  @HttpCode(201)
  @Header("Cache-Control", "no-store")
  @SessionMutation()
  @ApiProblemResponses(400, 401, 403, 404, 503)
  @ApiOperation({ summary: "Create a document comment thread" })
  @ApiBody({ schema: CREATE_COMMENT_THREAD_REQUEST_OPENAPI_SCHEMA })
  @ApiOkResponse({ schema: COMMENT_THREAD_DETAIL_OPENAPI_SCHEMA })
  createThread(
    @Param(new ZodValidationPipe(documentPathParametersSchema))
    parameters: DocumentIdentity,
    @Body(new ZodValidationPipe(createCommentThreadRequestSchema))
    body: CreateCommentThreadRequest,
    @Req() request: HttpRequestBoundary,
    @CurrentSession() session: AuthenticatedSession,
  ) {
    return this.comments.createThread({
      ...parameters,
      actorUserId: session.userId,
      requestId: request.id,
      value: body,
    });
  }

  @Get(DOCUMENT_COMMENT_MENTION_CANDIDATES_CONTROLLER_PATH)
  @Header("Cache-Control", "no-store")
  @Authenticated()
  @ApiProblemResponses(400, 401, 404, 503)
  @ApiOperation({ summary: "List visible mention candidates for a document" })
  @ApiOkResponse({ schema: COMMENT_MENTION_CANDIDATES_RESPONSE_OPENAPI_SCHEMA })
  listMentionCandidates(
    @Param(new ZodValidationPipe(documentPathParametersSchema))
    parameters: DocumentIdentity,
    @Query(new ZodValidationPipe(commentMentionCandidatesQuerySchema))
    query: { query?: string },
    @CurrentSession() session: AuthenticatedSession,
  ) {
    return this.comments.listMentionCandidates({
      actorUserId: session.userId,
      document: parameters,
      ...(query.query === undefined ? {} : { query: query.query }),
    });
  }

  @Get(DOCUMENT_COMMENT_THREAD_CONTROLLER_PATH)
  @Header("Cache-Control", "no-store")
  @Authenticated()
  @ApiProblemResponses(400, 401, 404, 503)
  @ApiOperation({ summary: "Read one comment thread" })
  @ApiOkResponse({ schema: COMMENT_THREAD_DETAIL_OPENAPI_SCHEMA })
  getThread(
    @Param(new ZodValidationPipe(commentThreadPathParametersSchema))
    parameters: CommentThreadPathParameters,
    @CurrentSession() session: AuthenticatedSession,
  ) {
    return this.comments.getThread({
      actorUserId: session.userId,
      document: parameters,
      threadId: parameters.threadId,
    });
  }

  @Post(DOCUMENT_COMMENT_ENTRIES_CONTROLLER_PATH)
  @HttpCode(201)
  @Header("Cache-Control", "no-store")
  @SessionMutation()
  @ApiProblemResponses(400, 401, 403, 404, 503)
  @ApiOperation({ summary: "Reply to a comment thread" })
  @ApiBody({ schema: CREATE_COMMENT_REPLY_REQUEST_OPENAPI_SCHEMA })
  @ApiOkResponse({ schema: COMMENT_ENTRY_OPENAPI_SCHEMA })
  createReply(
    @Param(new ZodValidationPipe(commentThreadPathParametersSchema))
    parameters: CommentThreadPathParameters,
    @Body(new ZodValidationPipe(createCommentReplyRequestSchema))
    body: CreateCommentReplyRequest,
    @Req() request: HttpRequestBoundary,
    @CurrentSession() session: AuthenticatedSession,
  ) {
    return this.comments.createReply({
      ...parameters,
      actorUserId: session.userId,
      requestId: request.id,
      threadId: parameters.threadId,
      value: body,
    });
  }

  @Patch(DOCUMENT_COMMENT_ENTRY_CONTROLLER_PATH)
  @Header("Cache-Control", "no-store")
  @SessionMutation()
  @ApiProblemResponses(400, 401, 403, 404, 503)
  @ApiOperation({ summary: "Edit a comment entry" })
  @ApiBody({ schema: UPDATE_COMMENT_ENTRY_REQUEST_OPENAPI_SCHEMA })
  @ApiOkResponse({ schema: COMMENT_ENTRY_OPENAPI_SCHEMA })
  updateEntry(
    @Param(new ZodValidationPipe(commentEntryPathParametersSchema))
    parameters: CommentEntryPathParameters,
    @Body(new ZodValidationPipe(updateCommentEntryRequestSchema))
    body: UpdateCommentEntryRequest,
    @Req() request: HttpRequestBoundary,
    @CurrentSession() session: AuthenticatedSession,
  ) {
    return this.comments.updateEntry({
      ...parameters,
      actorUserId: session.userId,
      requestId: request.id,
      threadId: parameters.threadId,
      value: body,
    });
  }

  @Delete(DOCUMENT_COMMENT_ENTRY_CONTROLLER_PATH)
  @HttpCode(204)
  @SessionMutation()
  @ApiProblemResponses(400, 401, 403, 404, 503)
  @ApiOperation({ summary: "Delete a comment entry" })
  @ApiNoContentResponse()
  async deleteEntry(
    @Param(new ZodValidationPipe(commentEntryPathParametersSchema))
    parameters: CommentEntryPathParameters,
    @Req() request: HttpRequestBoundary,
    @CurrentSession() session: AuthenticatedSession,
  ): Promise<void> {
    await this.comments.deleteEntry({
      ...parameters,
      actorUserId: session.userId,
      requestId: request.id,
      threadId: parameters.threadId,
    });
  }

  @Patch(DOCUMENT_COMMENT_THREAD_STATUS_CONTROLLER_PATH)
  @Header("Cache-Control", "no-store")
  @SessionMutation()
  @ApiProblemResponses(400, 401, 403, 404, 503)
  @ApiOperation({ summary: "Resolve or reopen a comment thread" })
  @ApiBody({ schema: UPDATE_COMMENT_THREAD_STATUS_REQUEST_OPENAPI_SCHEMA })
  @ApiOkResponse({ schema: COMMENT_THREAD_OPENAPI_SCHEMA })
  updateStatus(
    @Param(new ZodValidationPipe(commentThreadPathParametersSchema))
    parameters: CommentThreadPathParameters,
    @Body(new ZodValidationPipe(updateCommentThreadStatusRequestSchema))
    body: UpdateCommentThreadStatusRequest,
    @Req() request: HttpRequestBoundary,
    @CurrentSession() session: AuthenticatedSession,
  ) {
    return this.comments.updateStatus({
      ...parameters,
      actorUserId: session.userId,
      requestId: request.id,
      threadId: parameters.threadId,
      value: body,
    });
  }
}
