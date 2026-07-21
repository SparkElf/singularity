import { Injectable } from "@nestjs/common";
import type {
  CommentEntry,
  CommentThread,
  CommentThreadDetail,
  CommentMentionCandidatesResponse,
  CommentThreadsResponse,
  CreateCommentReplyRequest,
  CreateCommentThreadRequest,
  DocumentIdentity,
  UpdateCommentEntryRequest,
  UpdateCommentThreadStatusRequest,
} from "@singularity/contracts";
import { AuditWriter, DatabaseRuntime, Prisma } from "@singularity/database";

import { DocumentAccessPolicyService } from "../document-access/document-access.service.js";
import { writeNotificationsInTransaction } from "../notifications/notification-writer.js";
import { forbidden, notFound, validationFailed } from "../problem.js";

interface CommentContext extends DocumentIdentity {
  actorUserId: string;
  requestId: string;
}

/** 解析评论列表的服务端游标，保证迟到分页请求不会重新从首屏推断文档状态。 */
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
      throw new Error("Comment cursor shape is invalid");
    }
    const createdAt = new Date(value[0]);
    if (Number.isNaN(createdAt.valueOf()) || value[1].length === 0) {
      throw new Error("Comment cursor value is invalid");
    }
    return { createdAt, id: value[1] };
  } catch (error) {
    throw validationFailed({ cause: error });
  }
}

function projectThread(row: {
  anchorBlockId: string | null;
  createdAt: Date;
  createdByUserId: string;
  documentId: string;
  id: string;
  notebookId: string;
  organizationId: string;
  resolvedAt: Date | null;
  spaceId: string;
  status: CommentThread["status"];
}): CommentThread {
  return {
    anchorBlockId: row.anchorBlockId,
    createdAt: row.createdAt.toISOString(),
    createdByUserId: row.createdByUserId,
    documentId: row.documentId,
    notebookId: row.notebookId,
    organizationId: row.organizationId,
    resolvedAt: row.resolvedAt?.toISOString() ?? null,
    spaceId: row.spaceId,
    status: row.status,
    threadId: row.id,
  };
}

function projectEntry(row: {
  authorUserId: string;
  body: string;
  createdAt: Date;
  deletedAt: Date | null;
  editedAt: Date | null;
  id: string;
  threadId: string;
}): CommentEntry {
  return {
    authorUserId: row.authorUserId,
    body: row.deletedAt === null ? row.body : "",
    createdAt: row.createdAt.toISOString(),
    deletedAt: row.deletedAt?.toISOString() ?? null,
    editedAt: row.editedAt?.toISOString() ?? null,
    entryId: row.id,
    threadId: row.threadId,
  };
}

@Injectable()
export class CommentService {
  constructor(
    private readonly database: DatabaseRuntime,
    private readonly access: DocumentAccessPolicyService,
    private readonly audit: AuditWriter,
  ) {}

  /** 按真实文档身份分页列出线程；已删除线程保留审计事实但不进入用户列表。 */
  async listThreads(input: {
    actorUserId: string;
    cursor?: string;
    document: DocumentIdentity;
    limit: number;
  }): Promise<CommentThreadsResponse> {
    return this.database.client.$transaction(async (transaction) => {
      await this.access.requireRole(
        transaction,
        { ...input.document, actorUserId: input.actorUserId },
        "viewer",
      );
      const cursor = decodeCursor(input.cursor);
      const rows = await transaction.commentThread.findMany({
        where: {
          documentId: input.document.documentId,
          notebookId: input.document.notebookId,
          organizationId: input.document.organizationId,
          spaceId: input.document.spaceId,
          status: { not: "deleted" },
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
        take: input.limit + 1,
      });
      const hasMore = rows.length > input.limit;
      const visible = rows.slice(0, input.limit);
      const last = visible.at(-1);
      return {
        cursor:
          hasMore && last !== undefined
            ? Buffer.from(JSON.stringify([last.createdAt.toISOString(), last.id])).toString(
                "base64url",
              )
            : null,
        threads: visible.map(projectThread),
      };
    });
  }

  /** 读取线程与条目详情；评论元数据和正文在同一次文档 ACL 判定后返回。 */
  async getThread(input: {
    actorUserId: string;
    document: DocumentIdentity;
    threadId: string;
  }): Promise<CommentThreadDetail> {
    return this.database.client.$transaction(async (transaction) => {
      await this.access.requireRole(
        transaction,
        { ...input.document, actorUserId: input.actorUserId },
        "viewer",
      );
      const thread = await this.#findThread(transaction, input.document, input.threadId);
      if (thread === null || thread.status === "deleted") {
        throw notFound();
      }
      const entries = await transaction.commentEntry.findMany({
        where: {
          documentId: input.document.documentId,
          notebookId: input.document.notebookId,
          organizationId: input.document.organizationId,
          spaceId: input.document.spaceId,
          threadId: input.threadId,
        },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      });
      return {
        entries: entries.map(projectEntry),
        thread: projectThread(thread),
      };
    });
  }

  /** 只返回当前文档仍可读的活跃组织成员，提交时仍由评论事务再次计算收件人。 */
  async listMentionCandidates(input: {
    actorUserId: string;
    document: DocumentIdentity;
    query?: string;
  }): Promise<CommentMentionCandidatesResponse> {
    return this.database.client.$transaction(async (transaction) => {
      await this.access.requireRole(
        transaction,
        { ...input.document, actorUserId: input.actorUserId },
        "viewer",
      );
      const members = await transaction.organizationMembership.findMany({
        where: {
          organizationId: input.document.organizationId,
          status: "active",
          user: {
            status: "active",
            ...(input.query === undefined
              ? {}
              : { loginIdentifier: { contains: input.query, mode: "insensitive" } }),
          },
        },
        orderBy: { user: { loginIdentifier: "asc" } },
        take: 100,
        select: { user: { select: { id: true, loginIdentifier: true } } },
      });
      const candidates: CommentMentionCandidatesResponse["candidates"] = [];
      for (const member of members) {
        const decision = await this.access.decideInTransaction(transaction, {
          actorUserId: member.user.id,
          documentId: input.document.documentId,
          notebookId: input.document.notebookId,
          organizationId: input.document.organizationId,
          spaceId: input.document.spaceId,
        });
        if (decision.role !== null) {
          candidates.push({
            loginIdentifier: member.user.loginIdentifier,
            userId: member.user.id,
          });
        }
      }
      return { candidates };
    });
  }

  /** 创建线程和首条评论，在控制面事务中同时提交提及通知与审计。 */
  async createThread(
    input: CommentContext & { value: CreateCommentThreadRequest },
  ): Promise<CommentThreadDetail> {
    return this.database.client.$transaction(async (transaction) => {
      await this.access.requireRole(
        transaction,
        input,
        "commenter",
      );
      const thread = await transaction.commentThread.create({
        data: {
          anchorBlockId: input.value.anchorBlockId,
          createdByUserId: input.actorUserId,
          documentId: input.documentId,
          notebookId: input.notebookId,
          organizationId: input.organizationId,
          spaceId: input.spaceId,
          status: "open",
        },
      });
      const entry = await transaction.commentEntry.create({
        data: {
          authorUserId: input.actorUserId,
          body: input.value.body,
          documentId: input.documentId,
          notebookId: input.notebookId,
          organizationId: input.organizationId,
          spaceId: input.spaceId,
          threadId: thread.id,
        },
      });
      const recipients = await this.#visibleMentionRecipients(
        transaction,
        input,
        input.value.mentionedUserIds,
      );
      await writeNotificationsInTransaction(transaction, {
        actorUserId: input.actorUserId,
        documentId: input.documentId,
        eventId: entry.id,
        kind: "mention",
        notebookId: input.notebookId,
        organizationId: input.organizationId,
        recipientUserIds: recipients,
        spaceId: input.spaceId,
        threadId: thread.id,
      });
      await this.#appendAudit(transaction, input, "comment.create", thread.id);
      return { entries: [projectEntry(entry)], thread: projectThread(thread) };
    });
  }

  /** 回复线程并通知已有参与者和当前可见的提及对象，避免浏览器快照直接决定收件人。 */
  async createReply(
    input: CommentContext & {
      threadId: string;
      value: CreateCommentReplyRequest;
    },
  ): Promise<CommentEntry> {
    return this.database.client.$transaction(async (transaction) => {
      await this.access.requireRole(
        transaction,
        input,
        "commenter",
      );
      const thread = await this.#findThread(transaction, input, input.threadId);
      if (thread === null || thread.status === "deleted") {
        throw notFound();
      }
      const entry = await transaction.commentEntry.create({
        data: {
          authorUserId: input.actorUserId,
          body: input.value.body,
          documentId: input.documentId,
          notebookId: input.notebookId,
          organizationId: input.organizationId,
          spaceId: input.spaceId,
          threadId: thread.id,
        },
      });
      const participants = await transaction.commentEntry.findMany({
        where: {
          deletedAt: null,
          documentId: input.documentId,
          notebookId: input.notebookId,
          organizationId: input.organizationId,
          spaceId: input.spaceId,
          threadId: thread.id,
        },
        distinct: ["authorUserId"],
        select: { authorUserId: true },
      });
      const mentions = await this.#visibleMentionRecipients(
        transaction,
        input,
        input.value.mentionedUserIds,
      );
      await writeNotificationsInTransaction(transaction, {
        actorUserId: input.actorUserId,
        documentId: input.documentId,
        eventId: entry.id,
        kind: "comment-reply",
        notebookId: input.notebookId,
        organizationId: input.organizationId,
        recipientUserIds: participants.map((item) => item.authorUserId),
        spaceId: input.spaceId,
        threadId: thread.id,
      });
      await writeNotificationsInTransaction(transaction, {
        actorUserId: input.actorUserId,
        documentId: input.documentId,
        eventId: `${entry.id}:mention`,
        kind: "mention",
        notebookId: input.notebookId,
        organizationId: input.organizationId,
        recipientUserIds: mentions,
        spaceId: input.spaceId,
        threadId: thread.id,
      });
      await this.#appendAudit(transaction, input, "comment.reply", thread.id);
      return projectEntry(entry);
    });
  }

  /** 解决或重新打开线程；普通评论者只能改变自己创建的线程，编辑者可治理整个文档线程。 */
  async updateStatus(
    input: CommentContext & {
      threadId: string;
      value: UpdateCommentThreadStatusRequest;
    },
  ): Promise<CommentThread> {
    return this.database.client.$transaction(async (transaction) => {
      const decision = await this.access.requireRole(
        transaction,
        input,
        "commenter",
      );
      const thread = await this.#findThread(transaction, input, input.threadId);
      if (thread === null || thread.status === "deleted") {
        throw notFound();
      }
      if (decision.role !== "editor" && thread.createdByUserId !== input.actorUserId) {
        throw forbidden();
      }
      if (thread.status === input.value.status) {
        return projectThread(thread);
      }
      const updated = await transaction.commentThread.update({
        data: {
          resolvedAt: input.value.status === "resolved" ? new Date() : null,
          status: input.value.status,
        },
        where: {
          id_organizationId_spaceId_notebookId_documentId: {
            documentId: input.documentId,
            id: thread.id,
            notebookId: input.notebookId,
            organizationId: input.organizationId,
            spaceId: input.spaceId,
          },
        },
      });
      if (input.value.status === "resolved") {
        const participants = await transaction.commentEntry.findMany({
          where: {
            deletedAt: null,
            documentId: input.documentId,
            notebookId: input.notebookId,
            organizationId: input.organizationId,
            spaceId: input.spaceId,
            threadId: thread.id,
          },
          distinct: ["authorUserId"],
          select: { authorUserId: true },
        });
        await writeNotificationsInTransaction(transaction, {
          actorUserId: input.actorUserId,
          documentId: input.documentId,
          eventId: thread.id,
          kind: "comment-resolved",
          notebookId: input.notebookId,
          organizationId: input.organizationId,
          recipientUserIds: participants.map((item) => item.authorUserId),
          spaceId: input.spaceId,
          threadId: thread.id,
        });
      }
      await this.#appendAudit(
        transaction,
        input,
        input.value.status === "resolved" ? "comment.resolve" : "comment.reopen",
        thread.id,
      );
      return projectThread(updated);
    });
  }

  /** 只允许作者或文档 editor 修改自己的评论，并保持条目身份与线程身份一致。 */
  async updateEntry(
    input: CommentContext & {
      entryId: string;
      threadId: string;
      value: UpdateCommentEntryRequest;
    },
  ): Promise<CommentEntry> {
    return this.database.client.$transaction(async (transaction) => {
      const decision = await this.access.requireRole(
        transaction,
        input,
        "commenter",
      );
      const entry = await this.#findEntry(transaction, input);
      if (entry === null || entry.deletedAt !== null) {
        throw notFound();
      }
      if (entry.authorUserId !== input.actorUserId && decision.role !== "editor") {
        throw forbidden();
      }
      const updated = await transaction.commentEntry.update({
        data: { body: input.value.body, editedAt: new Date() },
        where: {
          id_organizationId_spaceId_notebookId_documentId: {
            documentId: input.documentId,
            id: entry.id,
            notebookId: input.notebookId,
            organizationId: input.organizationId,
            spaceId: input.spaceId,
          },
        },
      });
      await this.#appendAudit(transaction, input, "comment.edit", entry.id);
      return projectEntry(updated);
    });
  }

  /** 软删除评论正文但保留条目行和删除时间，保证线程和审计线索不会断裂。 */
  async deleteEntry(input: CommentContext & { entryId: string; threadId: string }): Promise<void> {
    await this.database.client.$transaction(async (transaction) => {
      const decision = await this.access.requireRole(
        transaction,
        input,
        "commenter",
      );
      const entry = await this.#findEntry(transaction, input);
      if (entry === null || entry.deletedAt !== null) {
        throw notFound();
      }
      if (entry.authorUserId !== input.actorUserId && decision.role !== "editor") {
        throw forbidden();
      }
      await transaction.commentEntry.update({
        data: { deletedAt: new Date() },
        where: {
          id_organizationId_spaceId_notebookId_documentId: {
            documentId: input.documentId,
            id: entry.id,
            notebookId: input.notebookId,
            organizationId: input.organizationId,
            spaceId: input.spaceId,
          },
        },
      });
      await this.#appendAudit(transaction, input, "comment.delete", entry.id);
    });
  }

  /** 在评论事务内重新读取成员与 ACL，只把当前仍可见的提及对象交给通知 writer。 */
  async #visibleMentionRecipients(
    transaction: Prisma.TransactionClient,
    input: CommentContext,
    userIds: readonly string[],
  ): Promise<string[]> {
    const candidates = await transaction.organizationMembership.findMany({
      where: {
        organizationId: input.organizationId,
        status: "active",
        user: { status: "active" },
        userId: { in: [...new Set(userIds)] },
      },
      select: { userId: true },
    });
    const visible: string[] = [];
    for (const candidate of candidates) {
      const decision = await this.access.decideInTransaction(transaction, {
        actorUserId: candidate.userId,
        documentId: input.documentId,
        notebookId: input.notebookId,
        organizationId: input.organizationId,
        spaceId: input.spaceId,
      });
      if (decision.role !== null) {
        visible.push(candidate.userId);
      }
    }
    return visible;
  }

  /** 在当前事务中按四段文档身份读取线程，拒绝跨文档或跨空间引用。 */
  async #findThread(
    transaction: Prisma.TransactionClient,
    document: DocumentIdentity,
    threadId: string,
  ) {
    return transaction.commentThread.findUnique({
      where: {
        id_organizationId_spaceId_notebookId_documentId: {
          documentId: document.documentId,
          id: threadId,
          notebookId: document.notebookId,
          organizationId: document.organizationId,
          spaceId: document.spaceId,
        },
      },
    });
  }

  /** 在当前事务中同时约束条目、线程和文档身份，避免路径参数串库。 */
  async #findEntry(
    transaction: Prisma.TransactionClient,
    input: CommentContext & { entryId: string; threadId: string },
  ) {
    const entry = await transaction.commentEntry.findUnique({
      where: {
        id_organizationId_spaceId_notebookId_documentId: {
          documentId: input.documentId,
          id: input.entryId,
          notebookId: input.notebookId,
          organizationId: input.organizationId,
          spaceId: input.spaceId,
        },
      },
    });
    return entry?.threadId === input.threadId ? entry : null;
  }

  /** 记录评论状态变化的审计事实；调用方事务回滚时审计也一并回滚。 */
  async #appendAudit(
    transaction: Prisma.TransactionClient,
    input: CommentContext,
    action:
      | "comment.create"
      | "comment.delete"
      | "comment.edit"
      | "comment.reopen"
      | "comment.reply"
      | "comment.resolve",
    targetId: string,
  ): Promise<void> {
    await this.audit.append(transaction, {
      action,
      actorUserId: input.actorUserId,
      occurredAt: new Date(),
      organizationId: input.organizationId,
      outcome: "succeeded",
      requestId: input.requestId,
      spaceId: input.spaceId,
      targetId,
      targetType: "comment",
    });
  }
}
