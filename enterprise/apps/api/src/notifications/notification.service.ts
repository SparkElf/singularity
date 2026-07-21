import { Injectable } from "@nestjs/common";
import type {
  Notification as NotificationView,
  NotificationKind,
  NotificationsResponse,
} from "@singularity/contracts";
import { AuditWriter, DatabaseRuntime } from "@singularity/database";

import { DocumentAccessPolicyService } from "../document-access/document-access.service.js";
import { notFound, validationFailed } from "../problem.js";

type PrismaNotificationKind =
  | "mention"
  | "comment_reply"
  | "comment_resolved"
  | "permission_changed"
  | "history_restored";

interface NotificationRow {
  actorUserId: string | null;
  createdAt: Date;
  documentId: string;
  id: string;
  kind: PrismaNotificationKind;
  notebookId: string;
  organizationId: string;
  readAt: Date | null;
  spaceId: string;
  threadId: string | null;
}

function toContractKind(kind: PrismaNotificationKind): NotificationKind {
  return {
    mention: "mention",
    comment_reply: "comment-reply",
    comment_resolved: "comment-resolved",
    permission_changed: "permission-changed",
    history_restored: "history-restored",
  }[kind] as NotificationKind;
}

function projectNotification(
  row: NotificationRow,
): NotificationView {
  return {
    actorUserId: row.actorUserId,
    createdAt: row.createdAt.toISOString(),
    document: {
      documentId: row.documentId,
      notebookId: row.notebookId,
      organizationId: row.organizationId,
      spaceId: row.spaceId,
    },
    kind: toContractKind(row.kind),
    notificationId: row.id,
    readAt: row.readAt?.toISOString() ?? null,
    threadId: row.threadId,
  };
}

/** 解析服务端生成的通知游标；非法游标在 API 边界失败，不回退到首屏数据。 */
function decodeCursor(cursor: string | undefined): { createdAt: Date; id: string } | null {
  if (cursor === undefined) {
    return null;
  }
  try {
    const value: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (
      !Array.isArray(value) ||
      value.length !== 2 ||
      typeof value[0] !== "string" ||
      typeof value[1] !== "string"
    ) {
      throw new Error("Notification cursor shape is invalid");
    }
    const createdAt = new Date(value[0]);
    if (Number.isNaN(createdAt.valueOf()) || value[1].length === 0) {
      throw new Error("Notification cursor value is invalid");
    }
    return { createdAt, id: value[1] };
  } catch (error) {
    throw validationFailed({ cause: error });
  }
}

@Injectable()
export class NotificationService {
  constructor(
    private readonly database: DatabaseRuntime,
    private readonly access: DocumentAccessPolicyService,
    private readonly audit: AuditWriter,
  ) {}

  /** 读取当前用户仍有权限的通知；失权来源只被过滤，不向客户端返回文档元数据。 */
  async list(input: {
    actorUserId: string;
    cursor?: string;
    limit: number;
  }): Promise<NotificationsResponse> {
    return this.database.client.$transaction(async (transaction) => {
      const cursor = decodeCursor(input.cursor);
      const visible: NotificationRow[] = [];
      let scanCursor = cursor;
      let hasMore = false;
      let lastScanned: { createdAt: Date; id: string } | null = null;
      while (visible.length < input.limit) {
        const rows: NotificationRow[] = await transaction.notification.findMany({
          where: {
            recipientUserId: input.actorUserId,
            ...(scanCursor === null
              ? {}
              : {
                  OR: [
                    { createdAt: { lt: scanCursor.createdAt } },
                    { createdAt: scanCursor.createdAt, id: { lt: scanCursor.id } },
                  ],
                }),
          },
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          take: 100,
        });
        for (const [index, row] of rows.entries()) {
          lastScanned = { createdAt: row.createdAt, id: row.id };
          const decision = await this.access.decideInTransaction(transaction, {
            actorUserId: input.actorUserId,
            documentId: row.documentId,
            notebookId: row.notebookId,
            organizationId: row.organizationId,
            spaceId: row.spaceId,
          });
          if (decision.role !== null) {
            visible.push(row);
          }
          if (visible.length === input.limit) {
            // 批内尚有未扫描行时，即使本批不足 100 条也必须保留游标。
            hasMore = index < rows.length - 1 || rows.length === 100;
            break;
          }
        }
        if (rows.length < 100 || rows.length === 0) {
          break;
        }
        scanCursor = lastScanned;
        hasMore = true;
      }
      return {
        cursor:
          hasMore && lastScanned !== null
            ? Buffer.from(JSON.stringify([lastScanned.createdAt.toISOString(), lastScanned.id])).toString(
                "base64url",
              )
            : null,
        notifications: visible.map(projectNotification),
      };
    });
  }

  /** 读取未读计数时重新套用文档 ACL，防止迟到通知泄露受限文档存在性。 */
  async unreadCount(actorUserId: string): Promise<{ unreadCount: number }> {
    return this.database.client.$transaction(async (transaction) => {
      let unreadCount = 0;
      let cursor: { createdAt: Date; id: string } | null = null;
      while (true) {
        const rows: Array<{
          createdAt: Date;
          documentId: string;
          id: string;
          notebookId: string;
          organizationId: string;
          spaceId: string;
        }> = await transaction.notification.findMany({
          where: {
            readAt: null,
            recipientUserId: actorUserId,
            ...(cursor === null
              ? {}
              : {
                  OR: [
                    { createdAt: { lt: cursor.createdAt } },
                    { createdAt: cursor.createdAt, id: { lt: cursor.id } },
                  ],
                }),
          },
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          select: {
            createdAt: true,
            documentId: true,
            id: true,
            notebookId: true,
            organizationId: true,
            spaceId: true,
          },
          take: 200,
        });
        for (const row of rows) {
          const decision = await this.access.decideInTransaction(transaction, {
            actorUserId,
            documentId: row.documentId,
            notebookId: row.notebookId,
            organizationId: row.organizationId,
            spaceId: row.spaceId,
          });
          if (decision.role !== null) {
            unreadCount += 1;
          }
        }
        const last = rows.at(-1);
        if (last === undefined || rows.length < 200) {
          break;
        }
        cursor = { createdAt: last.createdAt, id: last.id };
      }
      return { unreadCount };
    });
  }

  /** 只有仍可见的来源通知才允许单条标记已读，失权来源统一返回不可见。 */
  async markRead(input: {
    actorUserId: string;
    notificationId: string;
    requestId: string;
  }): Promise<void> {
    await this.database.client.$transaction(async (transaction) => {
      const row = await transaction.notification.findFirst({
        where: { id: input.notificationId, recipientUserId: input.actorUserId },
      });
      if (row === null) {
        throw notFound();
      }
      await this.access.requireRole(
        transaction,
        {
          actorUserId: input.actorUserId,
          documentId: row.documentId,
          notebookId: row.notebookId,
          organizationId: row.organizationId,
          spaceId: row.spaceId,
        },
        "viewer",
      );
      if (row.readAt === null) {
        await transaction.notification.update({
          data: { readAt: new Date() },
          where: { id: row.id },
        });
      }
      await this.audit.append(transaction, {
        action: "notification.read",
        actorUserId: input.actorUserId,
        occurredAt: new Date(),
        organizationId: row.organizationId,
        outcome: "succeeded",
        requestId: input.requestId,
        spaceId: row.spaceId,
        targetId: row.id,
        targetType: "notification",
      });
    });
  }

  /** 全部已读只改变当前账号的收件箱状态，不把失权通知重新暴露给客户端。 */
  async markAllRead(input: { actorUserId: string; requestId: string }): Promise<void> {
    await this.database.client.$transaction(async (transaction) => {
      const scopes = await transaction.notification.findMany({
        distinct: ["organizationId", "spaceId"],
        select: { organizationId: true, spaceId: true },
        where: { readAt: null, recipientUserId: input.actorUserId },
      });
      await transaction.notification.updateMany({
        data: { readAt: new Date() },
        where: { readAt: null, recipientUserId: input.actorUserId },
      });
      for (const scope of scopes) {
        await this.audit.append(transaction, {
          action: "notification.read",
          actorUserId: input.actorUserId,
          occurredAt: new Date(),
          organizationId: scope.organizationId,
          outcome: "succeeded",
          requestId: input.requestId,
          spaceId: scope.spaceId,
          targetId: input.actorUserId,
          targetType: "notification",
        });
      }
    });
  }
}
