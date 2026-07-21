import {
  Controller,
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
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from "@nestjs/swagger";
import {
  NOTIFICATION_READ_CONTROLLER_PATH,
  NOTIFICATION_UNREAD_COUNT_OPENAPI_SCHEMA,
  NOTIFICATION_UNREAD_COUNT_PATH,
  NOTIFICATIONS_PATH,
  NOTIFICATIONS_READ_ALL_PATH,
  NOTIFICATIONS_RESPONSE_OPENAPI_SCHEMA,
  notificationPathParametersSchema,
  notificationsQuerySchema,
  type NotificationPathParameters,
  type NotificationsResponse,
} from "@singularity/contracts";

import {
  ApiProblemResponses,
  Authenticated,
  CurrentSession,
  SessionMutation,
} from "../identity/http-access.js";
import type { HttpRequestBoundary } from "../http-boundary.js";
import type { AuthenticatedSession } from "../identity/identity.service.js";
import { ZodValidationPipe } from "../identity/zod-validation.pipe.js";
import { NotificationService } from "./notification.service.js";

@ApiTags("notifications")
@Controller()
export class NotificationController {
  constructor(private readonly notifications: NotificationService) {}

  @Get(NOTIFICATIONS_PATH)
  @Header("Cache-Control", "no-store")
  @Authenticated()
  @ApiProblemResponses(401, 503)
  @ApiOperation({ summary: "List visible notifications" })
  @ApiOkResponse({ schema: NOTIFICATIONS_RESPONSE_OPENAPI_SCHEMA })
  async list(
    @Query(new ZodValidationPipe(notificationsQuerySchema))
    query: { cursor?: string; limit: number },
    @CurrentSession() session: AuthenticatedSession,
  ): Promise<NotificationsResponse> {
    return this.notifications.list({
      actorUserId: session.userId,
      limit: query.limit,
      ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
    });
  }

  @Get(NOTIFICATION_UNREAD_COUNT_PATH)
  @Header("Cache-Control", "no-store")
  @Authenticated()
  @ApiProblemResponses(401, 503)
  @ApiOperation({ summary: "Read visible notification unread count" })
  @ApiOkResponse({ schema: NOTIFICATION_UNREAD_COUNT_OPENAPI_SCHEMA })
  unreadCount(@CurrentSession() session: AuthenticatedSession) {
    return this.notifications.unreadCount(session.userId);
  }

  @Patch(NOTIFICATION_READ_CONTROLLER_PATH)
  @HttpCode(204)
  @SessionMutation()
  @ApiProblemResponses(401, 403, 404, 503)
  @ApiOperation({ summary: "Mark one notification as read" })
  @ApiNoContentResponse()
  async markRead(
    @Param(new ZodValidationPipe(notificationPathParametersSchema))
    parameters: NotificationPathParameters,
    @CurrentSession() session: AuthenticatedSession,
    @Req() request: HttpRequestBoundary,
  ): Promise<void> {
    await this.notifications.markRead({
      actorUserId: session.userId,
      notificationId: parameters.notificationId,
      requestId: request.id,
    });
  }

  @Post(NOTIFICATIONS_READ_ALL_PATH)
  @HttpCode(204)
  @SessionMutation()
  @ApiProblemResponses(401, 503)
  @ApiOperation({ summary: "Mark all notifications as read" })
  @ApiNoContentResponse()
  async markAllRead(
    @Req() request: HttpRequestBoundary,
    @CurrentSession() session: AuthenticatedSession,
  ): Promise<void> {
    await this.notifications.markAllRead({
      actorUserId: session.userId,
      requestId: request.id,
    });
  }
}
