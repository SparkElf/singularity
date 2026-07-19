import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Param,
  Post,
  Req,
} from "@nestjs/common";
import {
  ApiBody,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from "@nestjs/swagger";
import {
  CREATE_SPACE_RESTORE_REQUEST_OPENAPI_SCHEMA,
  ORGANIZATION_SPACE_BACKUPS_CONTROLLER_PATH,
  ORGANIZATION_SPACE_BACKUP_RESTORES_CONTROLLER_PATH,
  ORGANIZATION_SPACE_RESTORES_CONTROLLER_PATH,
  ORGANIZATION_SPACE_RESTORE_ACTIVATION_CONTROLLER_PATH,
  ORGANIZATION_SPACE_RESTORE_CONTROLLER_PATH,
  SPACE_BACKUP_OPENAPI_SCHEMA,
  SPACE_BACKUPS_RESPONSE_OPENAPI_SCHEMA,
  SPACE_RESTORE_OPENAPI_SCHEMA,
  SPACE_RESTORES_RESPONSE_OPENAPI_SCHEMA,
  createSpaceRestoreRequestSchema,
  spaceBackupPathParametersSchema,
  spaceBackupRestorePathParametersSchema,
  spaceRestorePathParametersSchema,
  type CreateSpaceRestoreRequest,
  type SpaceBackupPathParameters,
  type SpaceBackupRestorePathParameters,
  type SpaceBackupsResponse,
  type SpaceBackupView,
  type SpaceRestorePathParameters,
  type SpaceRestoresResponse,
  type SpaceRestoreView,
} from "@singularity/contracts";

import type { HttpRequestBoundary } from "../http-boundary.js";
import {
  Authenticated,
  ApiProblemResponses,
  CurrentSession,
  SessionMutation,
  type AuthenticatedSession,
} from "../identity/http-access.js";
import { ZodValidationPipe } from "../identity/zod-validation.pipe.js";
import { BackupService } from "./backup.service.js";

@ApiTags("backups")
@Controller()
export class BackupController {
  constructor(private readonly backups: BackupService) {}

  @Get(ORGANIZATION_SPACE_BACKUPS_CONTROLLER_PATH)
  @Authenticated()
  @Header("Cache-Control", "no-store")
  @ApiProblemResponses(400, 401, 403, 404, 503)
  @ApiOperation({ summary: "List space backups" })
  @ApiOkResponse({ schema: SPACE_BACKUPS_RESPONSE_OPENAPI_SCHEMA })
  async listBackups(
    @Param(new ZodValidationPipe(spaceBackupPathParametersSchema))
    parameters: SpaceBackupPathParameters,
    @CurrentSession() session: AuthenticatedSession,
  ): Promise<SpaceBackupsResponse> {
    return {
      backups: await this.backups.listBackups({
        actorUserId: session.userId,
        organizationId: parameters.organizationId,
        sourceSpaceId: parameters.spaceId,
      }),
    };
  }

  @Get(ORGANIZATION_SPACE_RESTORES_CONTROLLER_PATH)
  @Authenticated()
  @Header("Cache-Control", "no-store")
  @ApiProblemResponses(400, 401, 403, 404, 503)
  @ApiOperation({ summary: "List restore jobs created from a source space" })
  @ApiOkResponse({ schema: SPACE_RESTORES_RESPONSE_OPENAPI_SCHEMA })
  async listRestores(
    @Param(new ZodValidationPipe(spaceBackupPathParametersSchema))
    parameters: SpaceBackupPathParameters,
    @CurrentSession() session: AuthenticatedSession,
  ): Promise<SpaceRestoresResponse> {
    return {
      restores: await this.backups.listRestores({
        actorUserId: session.userId,
        organizationId: parameters.organizationId,
        sourceSpaceId: parameters.spaceId,
      }),
    };
  }

  @Post(ORGANIZATION_SPACE_BACKUPS_CONTROLLER_PATH)
  @HttpCode(201)
  @SessionMutation()
  @Header("Cache-Control", "no-store")
  @ApiProblemResponses(400, 401, 403, 404, 503)
  @ApiOperation({ summary: "Queue a space backup" })
  @ApiCreatedResponse({ schema: SPACE_BACKUP_OPENAPI_SCHEMA })
  async createBackup(
    @Param(new ZodValidationPipe(spaceBackupPathParametersSchema))
    parameters: SpaceBackupPathParameters,
    @Req() request: HttpRequestBoundary,
    @CurrentSession() session: AuthenticatedSession,
  ): Promise<SpaceBackupView> {
    return this.backups.createBackup({
      actorUserId: session.userId,
      organizationId: parameters.organizationId,
      requestId: request.id,
      sourceSpaceId: parameters.spaceId,
    });
  }

  @Post(ORGANIZATION_SPACE_BACKUP_RESTORES_CONTROLLER_PATH)
  @HttpCode(201)
  @SessionMutation()
  @Header("Cache-Control", "no-store")
  @ApiProblemResponses(400, 401, 403, 404, 409, 503)
  @ApiOperation({ summary: "Queue a backup restore into an isolated space" })
  @ApiBody({ schema: CREATE_SPACE_RESTORE_REQUEST_OPENAPI_SCHEMA })
  @ApiCreatedResponse({ schema: SPACE_RESTORE_OPENAPI_SCHEMA })
  async createRestore(
    @Param(new ZodValidationPipe(spaceBackupRestorePathParametersSchema))
    parameters: SpaceBackupRestorePathParameters,
    @Body(new ZodValidationPipe(createSpaceRestoreRequestSchema))
    body: CreateSpaceRestoreRequest,
    @Req() request: HttpRequestBoundary,
    @CurrentSession() session: AuthenticatedSession,
  ): Promise<SpaceRestoreView> {
    return this.backups.createRestore({
      actorUserId: session.userId,
      backupId: parameters.backupId,
      organizationId: parameters.organizationId,
      requestId: request.id,
      sourceSpaceId: parameters.spaceId,
      targetSpaceName: body.targetSpaceName,
    });
  }

  @Get(ORGANIZATION_SPACE_RESTORE_CONTROLLER_PATH)
  @Authenticated()
  @Header("Cache-Control", "no-store")
  @ApiProblemResponses(400, 401, 403, 404, 503)
  @ApiOperation({ summary: "Read an isolated restore job" })
  @ApiOkResponse({ schema: SPACE_RESTORE_OPENAPI_SCHEMA })
  async getRestore(
    @Param(new ZodValidationPipe(spaceRestorePathParametersSchema))
    parameters: SpaceRestorePathParameters,
    @CurrentSession() session: AuthenticatedSession,
  ): Promise<SpaceRestoreView> {
    return this.backups.getRestore({
      actorUserId: session.userId,
      organizationId: parameters.organizationId,
      restoreId: parameters.restoreId,
      sourceSpaceId: parameters.spaceId,
    });
  }

  @Post(ORGANIZATION_SPACE_RESTORE_ACTIVATION_CONTROLLER_PATH)
  @SessionMutation()
  @HttpCode(200)
  @Header("Cache-Control", "no-store")
  @ApiProblemResponses(400, 401, 403, 404, 409, 503)
  @ApiOperation({ summary: "Activate a validated isolated restore" })
  @ApiOkResponse({ schema: SPACE_RESTORE_OPENAPI_SCHEMA })
  async activateRestore(
    @Param(new ZodValidationPipe(spaceRestorePathParametersSchema))
    parameters: SpaceRestorePathParameters,
    @Req() request: HttpRequestBoundary,
    @CurrentSession() session: AuthenticatedSession,
  ): Promise<SpaceRestoreView> {
    return this.backups.activateRestore({
      actorUserId: session.userId,
      organizationId: parameters.organizationId,
      requestId: request.id,
      restoreId: parameters.restoreId,
      targetSpaceId: parameters.spaceId,
    });
  }
}
