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
  Req,
  Res,
  StreamableFile,
} from "@nestjs/common";
import {
  ApiBody,
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from "@nestjs/swagger";
import {
  CHANGE_DOCUMENT_SHARE_PASSWORD_REQUEST_OPENAPI_SCHEMA,
  CREATE_DOCUMENT_SHARE_REQUEST_OPENAPI_SCHEMA,
  CREATED_DOCUMENT_SHARE_OPENAPI_SCHEMA,
  CREATE_SHARE_CHALLENGE_REQUEST_OPENAPI_SCHEMA,
  MANAGED_DOCUMENT_SHARES_RESPONSE_OPENAPI_SCHEMA,
  ORGANIZATION_SPACE_SHARE_CONTROLLER_PATH,
  ORGANIZATION_SPACE_SHARE_PASSWORD_CONTROLLER_PATH,
  ORGANIZATION_SPACE_SHARES_CONTROLLER_PATH,
  PUBLIC_SHARE_ASSET_CONTROLLER_PATH,
  PUBLIC_SHARE_CHALLENGE_CONTROLLER_PATH,
  PUBLIC_SHARE_CONTROLLER_PATH,
  SHARED_DOCUMENT_PAYLOAD_OPENAPI_SCHEMA,
  changeDocumentSharePasswordRequestSchema,
  createDocumentShareRequestSchema,
  createShareChallengeRequestSchema,
  managedSharePathParametersSchema,
  managedSharesPathParametersSchema,
  publicShareAssetPathParametersSchema,
  publicSharePathParametersSchema,
  type ChangeDocumentSharePasswordRequest,
  type CreateDocumentShareRequest,
  type CreatedDocumentShare,
  type CreateShareChallengeRequest,
  type ManagedDocumentSharesResponse,
  type ManagedSharePathParameters,
  type ManagedSharesPathParameters,
  type PublicShareAssetPathParameters,
  type PublicSharePathParameters,
  type SharedDocumentPayload,
} from "@singularity/contracts";

import type {
  HttpReplyBoundary,
  HttpRequestBoundary,
} from "../http-boundary.js";
import {
  Authenticated,
  ApiProblemResponses,
  CurrentSession,
  SameOrigin,
  SessionMutation,
  type AuthenticatedSession,
} from "../identity/http-access.js";
import { ZodValidationPipe } from "../identity/zod-validation.pipe.js";
import { ShareService } from "./share.service.js";

function setPublicHeaders(reply: HttpReplyBoundary): void {
  reply
    .header("Cache-Control", "no-store")
    .header("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'; base-uri 'none'")
    .header("Referrer-Policy", "no-referrer")
    .header("X-Content-Type-Options", "nosniff")
    .header("X-Robots-Tag", "noindex, nofollow, noarchive");
}

function encodedFileName(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (character) =>
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

@ApiTags("shares")
@Controller()
export class ShareManagementController {
  constructor(private readonly shares: ShareService) {}

  @Get(ORGANIZATION_SPACE_SHARES_CONTROLLER_PATH)
  @Authenticated()
  @Header("Cache-Control", "no-store")
  @ApiProblemResponses(400, 401, 403, 404, 503)
  @ApiOperation({ summary: "List managed document shares" })
  @ApiOkResponse({ schema: MANAGED_DOCUMENT_SHARES_RESPONSE_OPENAPI_SCHEMA })
  async list(
    @Param(new ZodValidationPipe(managedSharesPathParametersSchema))
    parameters: ManagedSharesPathParameters,
    @CurrentSession() session: AuthenticatedSession,
  ): Promise<ManagedDocumentSharesResponse> {
    return {
      shares: await this.shares.listShares({
        actorUserId: session.userId,
        organizationId: parameters.organizationId,
        spaceId: parameters.spaceId,
      }),
    };
  }

  @Post(ORGANIZATION_SPACE_SHARES_CONTROLLER_PATH)
  @HttpCode(201)
  @SessionMutation()
  @Header("Cache-Control", "no-store")
  @ApiProblemResponses(400, 401, 403, 404, 503)
  @ApiOperation({ summary: "Create a live read-only document share" })
  @ApiBody({ schema: CREATE_DOCUMENT_SHARE_REQUEST_OPENAPI_SCHEMA })
  @ApiCreatedResponse({ schema: CREATED_DOCUMENT_SHARE_OPENAPI_SCHEMA })
  async create(
    @Param(new ZodValidationPipe(managedSharesPathParametersSchema))
    parameters: ManagedSharesPathParameters,
    @Body(new ZodValidationPipe(createDocumentShareRequestSchema))
    body: CreateDocumentShareRequest,
    @Req() request: HttpRequestBoundary,
    @CurrentSession() session: AuthenticatedSession,
  ): Promise<CreatedDocumentShare> {
    return this.shares.createShare({
      actorUserId: session.userId,
      documentId: body.documentId,
      expiresAt: new Date(body.expiresAt),
      notebookId: body.notebookId,
      organizationId: parameters.organizationId,
      password: body.password ?? null,
      requestId: request.id,
      spaceId: parameters.spaceId,
    });
  }

  @Patch(ORGANIZATION_SPACE_SHARE_PASSWORD_CONTROLLER_PATH)
  @SessionMutation()
  @HttpCode(204)
  @Header("Cache-Control", "no-store")
  @ApiProblemResponses(400, 401, 403, 404, 503)
  @ApiOperation({ summary: "Replace or remove a share password" })
  @ApiBody({ schema: CHANGE_DOCUMENT_SHARE_PASSWORD_REQUEST_OPENAPI_SCHEMA })
  @ApiNoContentResponse()
  async changePassword(
    @Param(new ZodValidationPipe(managedSharePathParametersSchema))
    parameters: ManagedSharePathParameters,
    @Body(new ZodValidationPipe(changeDocumentSharePasswordRequestSchema))
    body: ChangeDocumentSharePasswordRequest,
    @Req() request: HttpRequestBoundary,
    @CurrentSession() session: AuthenticatedSession,
  ): Promise<void> {
    await this.shares.changePassword({
      actorUserId: session.userId,
      organizationId: parameters.organizationId,
      password: body.password,
      requestId: request.id,
      shareId: parameters.shareId,
      spaceId: parameters.spaceId,
    });
  }

  @Delete(ORGANIZATION_SPACE_SHARE_CONTROLLER_PATH)
  @SessionMutation()
  @HttpCode(204)
  @Header("Cache-Control", "no-store")
  @ApiProblemResponses(400, 401, 403, 404, 503)
  @ApiOperation({ summary: "Revoke a document share" })
  @ApiNoContentResponse()
  async revoke(
    @Param(new ZodValidationPipe(managedSharePathParametersSchema))
    parameters: ManagedSharePathParameters,
    @Req() request: HttpRequestBoundary,
    @CurrentSession() session: AuthenticatedSession,
  ): Promise<void> {
    await this.shares.revokeShare({
      actorUserId: session.userId,
      organizationId: parameters.organizationId,
      requestId: request.id,
      shareId: parameters.shareId,
      spaceId: parameters.spaceId,
    });
  }

}

@ApiTags("public-shares")
@Controller()
export class PublicShareController {
  constructor(private readonly shares: ShareService) {}

  @Get(PUBLIC_SHARE_CONTROLLER_PATH)
  @ApiProblemResponses(400, 401, 404, 503)
  @ApiOperation({ summary: "Read the current shared document" })
  @ApiOkResponse({ schema: SHARED_DOCUMENT_PAYLOAD_OPENAPI_SCHEMA })
  async readDocument(
    @Param(new ZodValidationPipe(publicSharePathParametersSchema))
    parameters: PublicSharePathParameters,
    @Req() request: HttpRequestBoundary,
    @Res({ passthrough: true }) reply: HttpReplyBoundary,
  ): Promise<SharedDocumentPayload> {
    setPublicHeaders(reply);
    return this.shares.readDocument({
      cookies: request.cookies,
      requestId: request.id,
      shareToken: parameters.shareToken,
      sourceAddress: request.ip,
    });
  }

  @Post(PUBLIC_SHARE_CHALLENGE_CONTROLLER_PATH)
  @SameOrigin()
  @HttpCode(204)
  @ApiProblemResponses(400, 401, 404, 409, 429, 503)
  @ApiOperation({ summary: "Create a short-lived share password challenge" })
  @ApiBody({ schema: CREATE_SHARE_CHALLENGE_REQUEST_OPENAPI_SCHEMA })
  @ApiNoContentResponse()
  async createChallenge(
    @Param(new ZodValidationPipe(publicSharePathParametersSchema))
    parameters: PublicSharePathParameters,
    @Body(new ZodValidationPipe(createShareChallengeRequestSchema))
    body: CreateShareChallengeRequest,
    @Req() request: HttpRequestBoundary,
    @Res({ passthrough: true }) reply: HttpReplyBoundary,
  ): Promise<void> {
    setPublicHeaders(reply);
    const challenge = await this.shares.issueChallenge({
      password: body.password,
      requestId: request.id,
      shareToken: parameters.shareToken,
      sourceAddress: request.ip,
    });
    reply.setCookie(challenge.cookieName, challenge.cookieValue, {
      httpOnly: true,
      expires: challenge.expiresAt,
      path: "/",
      sameSite: "lax",
      secure: true,
    });
  }

  @Get(PUBLIC_SHARE_ASSET_CONTROLLER_PATH)
  @ApiProblemResponses(400, 401, 404, 503)
  @ApiOperation({ summary: "Read an asset in the current shared document closure" })
  @ApiOkResponse()
  async readAsset(
    @Param(new ZodValidationPipe(publicShareAssetPathParametersSchema))
    parameters: PublicShareAssetPathParameters,
    @Req() request: HttpRequestBoundary,
    @Res({ passthrough: true }) reply: HttpReplyBoundary,
  ): Promise<StreamableFile> {
    setPublicHeaders(reply);
    const asset = await this.shares.readAsset({
      assetId: parameters.assetId,
      cookies: request.cookies,
      requestId: request.id,
      shareToken: parameters.shareToken,
      sourceAddress: request.ip,
    });
    const disposition = `${asset.disposition}; filename*=UTF-8''${encodedFileName(asset.fileName)}`;
    reply
      .header("Content-Disposition", disposition)
      .header("Content-Length", asset.sizeBytes)
      .header("Content-Type", asset.mediaType);
    return new StreamableFile(asset.body);
  }
}
