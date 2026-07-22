import {
  CSRF_HEADER_NAME,
  buildDocumentAccessPolicyPath,
  buildDocumentCollaborationFeaturePath,
  buildDocumentCommentEntriesPath,
  buildDocumentCommentMentionCandidatesPath,
  buildDocumentCommentThreadPath,
  buildDocumentCommentThreadsPath,
  buildDocumentCommentThreadStatusPath,
  buildDocumentHistoryDiffPath,
  buildDocumentHistoryPath,
  buildDocumentHistoryRestorePath,
  NOTIFICATIONS_PATH,
  NOTIFICATION_UNREAD_COUNT_PATH,
  NOTIFICATIONS_READ_ALL_PATH,
  buildNotificationReadPath,
  commentThreadDetailSchema,
  commentMentionCandidatesResponseSchema,
  commentThreadsResponseSchema,
  collaborationFeatureSchema,
  createCommentReplyRequestSchema,
  createCommentThreadRequestSchema,
  documentAccessPolicySchema,
  historyDiffSchema,
  historyVersionsResponseSchema,
  notificationUnreadCountSchema,
  notificationsResponseSchema,
  restoredHistoryVersionSchema,
  type CommentMentionCandidatesResponse,
  type CreateCommentReplyRequest,
  type CreateCommentThreadRequest,
  type DocumentAccessPolicy,
  type CollaborationFeature,
  type DocumentIdentity,
  type HistoryDiff,
  type HistoryVersionsResponse,
  type NotificationUnreadCount,
  type NotificationsResponse,
  type RestoredHistoryVersion,
  type UpdateCommentThreadStatusRequest,
  type UpdateDocumentAccessPolicyRequest,
  updateCommentThreadStatusRequestSchema,
} from "@singularity/contracts";
import { requestJson, requestNoContent } from "@/api/http.ts";
import { getOrFetchCsrfToken } from "@/auth/api.ts";

export const collaborationThreadsQueryKey = (identity: DocumentIdentity) =>
  ["collaboration", identity.organizationId, identity.spaceId, identity.notebookId, identity.documentId, "threads"] as const;
export const collaborationThreadQueryKey = (identity: DocumentIdentity, threadId: string) =>
  [...collaborationThreadsQueryKey(identity), threadId] as const;
export const documentAccessPolicyQueryKey = (identity: DocumentIdentity) =>
  ["collaboration", identity.organizationId, identity.spaceId, identity.notebookId, identity.documentId, "access-policy"] as const;
export const collaborationFeatureQueryKey = (identity: DocumentIdentity) =>
  ["collaboration", identity.organizationId, identity.spaceId, identity.notebookId, identity.documentId, "feature"] as const;
export const documentHistoryQueryKey = (identity: DocumentIdentity) =>
  ["collaboration", identity.organizationId, identity.spaceId, identity.notebookId, identity.documentId, "history"] as const;
export const notificationsQueryKey = ["collaboration", "notifications"] as const;
export const notificationUnreadCountQueryKey = ["collaboration", "notifications", "unread-count"] as const;
export const commentMentionCandidatesQueryKey = (identity: DocumentIdentity) =>
  [...collaborationThreadsQueryKey(identity), "mention-candidates"] as const;

async function mutationInit(body: unknown): Promise<RequestInit> {
  return {
    body: JSON.stringify(body),
    headers: {
      "Content-Type": "application/json",
      [CSRF_HEADER_NAME]: await getOrFetchCsrfToken(),
    },
    method: "PATCH",
  };
}

export function getCommentThreads(identity: DocumentIdentity, signal?: AbortSignal) {
  return requestJson(commentThreadsResponseSchema, `${buildDocumentCommentThreadsPath(identity)}?limit=50`, { signal: signal ?? null });
}

export function getCommentThread(identity: DocumentIdentity, threadId: string, signal?: AbortSignal) {
  return requestJson(commentThreadDetailSchema, buildDocumentCommentThreadPath({ ...identity, threadId }), { signal: signal ?? null });
}

export function getCommentMentionCandidates(
  identity: DocumentIdentity,
  query?: string,
  signal?: AbortSignal,
): Promise<CommentMentionCandidatesResponse> {
  return requestJson(
    commentMentionCandidatesResponseSchema,
    buildDocumentCommentMentionCandidatesPath(identity, query),
    { signal: signal ?? null },
  );
}

export async function createCommentThread(identity: DocumentIdentity, value: CreateCommentThreadRequest) {
  createCommentThreadRequestSchema.parse(value);
  return requestJson(commentThreadDetailSchema, buildDocumentCommentThreadsPath(identity), {
    ...(await mutationInit(value)),
    method: "POST",
  });
}

export async function createCommentReply(identity: DocumentIdentity, threadId: string, value: CreateCommentReplyRequest) {
  createCommentReplyRequestSchema.parse(value);
  return requestJson(commentThreadDetailSchema.shape.entries.element, buildDocumentCommentEntriesPath({ ...identity, threadId }), {
    ...(await mutationInit(value)),
    method: "POST",
  });
}

export async function updateCommentStatus(identity: DocumentIdentity, threadId: string, value: UpdateCommentThreadStatusRequest) {
  updateCommentThreadStatusRequestSchema.parse(value);
  return requestJson(commentThreadDetailSchema.shape.thread, buildDocumentCommentThreadStatusPath({ ...identity, threadId }), await mutationInit(value));
}

export function getDocumentAccessPolicy(identity: DocumentIdentity, signal?: AbortSignal): Promise<DocumentAccessPolicy> {
  return requestJson(documentAccessPolicySchema, buildDocumentAccessPolicyPath(identity), { signal: signal ?? null });
}

export function getCollaborationFeature(
  identity: DocumentIdentity,
  signal?: AbortSignal,
): Promise<CollaborationFeature> {
  return requestJson(
    collaborationFeatureSchema,
    buildDocumentCollaborationFeaturePath(identity),
    { signal: signal ?? null },
  );
}

export async function updateDocumentAccessPolicy(
  identity: DocumentIdentity,
  value: UpdateDocumentAccessPolicyRequest,
): Promise<DocumentAccessPolicy> {
  return requestJson(documentAccessPolicySchema, buildDocumentAccessPolicyPath(identity), {
    ...(await mutationInit(value)),
  });
}

export function getHistory(identity: DocumentIdentity, signal?: AbortSignal): Promise<HistoryVersionsResponse> {
  return requestJson(historyVersionsResponseSchema, buildDocumentHistoryPath(identity), { signal: signal ?? null });
}

export function getHistoryDiff(identity: DocumentIdentity, versionId: string, signal?: AbortSignal): Promise<HistoryDiff> {
  return requestJson(historyDiffSchema, buildDocumentHistoryDiffPath({ ...identity, versionId }), { signal: signal ?? null });
}

export async function restoreHistory(identity: DocumentIdentity, versionId: string): Promise<RestoredHistoryVersion> {
  return requestJson(restoredHistoryVersionSchema, buildDocumentHistoryRestorePath(identity), {
    ...(await mutationInit({ versionId })),
    method: "POST",
  });
}

export function getNotifications(signal?: AbortSignal): Promise<NotificationsResponse> {
  return requestJson(notificationsResponseSchema, `${NOTIFICATIONS_PATH}?limit=50`, { signal: signal ?? null });
}

export function getNotificationUnreadCount(signal?: AbortSignal): Promise<NotificationUnreadCount> {
  return requestJson(notificationUnreadCountSchema, NOTIFICATION_UNREAD_COUNT_PATH, { signal: signal ?? null });
}

export async function markNotificationRead(notificationId: string): Promise<void> {
  await requestNoContent(buildNotificationReadPath(notificationId), {
    ...(await mutationInit({})),
    method: "PATCH",
  });
}

export async function markAllNotificationsRead(): Promise<void> {
  await requestNoContent(NOTIFICATIONS_READ_ALL_PATH, {
    ...(await mutationInit({})),
    method: "POST",
  });
}
