import type { DocumentIdentity, NotificationKind } from "@singularity/contracts";
import { Prisma } from "@singularity/database";

interface NotificationIdentity extends DocumentIdentity {
  actorUserId: string | null;
  kind: NotificationKind;
  threadId: string | null;
}

type PrismaNotificationKind =
  | "mention"
  | "comment_reply"
  | "comment_resolved"
  | "permission_changed"
  | "history_restored";

function toPrismaKind(kind: NotificationKind): PrismaNotificationKind {
  return {
    mention: "mention",
    "comment-reply": "comment_reply",
    "comment-resolved": "comment_resolved",
    "permission-changed": "permission_changed",
    "history-restored": "history_restored",
  }[kind] as PrismaNotificationKind;
}

/** 在评论、权限或历史事务内写入收件箱；eventKey 保证同一事件对同一收件人只出现一次。 */
export async function writeNotificationsInTransaction(
  transaction: Prisma.TransactionClient,
  input: NotificationIdentity & {
    eventId: string;
    recipientUserIds: readonly string[];
  },
): Promise<void> {
  const recipients = [...new Set(input.recipientUserIds)].filter(
    (userId) => userId !== input.actorUserId,
  );
  if (recipients.length === 0) {
    return;
  }
  await transaction.notification.createMany({
    data: recipients.map((recipientUserId) => ({
      actorUserId: input.actorUserId,
      documentId: input.documentId,
      eventKey: `${input.kind}:${input.eventId}:${recipientUserId}`,
      kind: toPrismaKind(input.kind),
      notebookId: input.notebookId,
      organizationId: input.organizationId,
      recipientUserId,
      spaceId: input.spaceId,
      threadId: input.threadId,
    })),
    skipDuplicates: true,
  });
}
