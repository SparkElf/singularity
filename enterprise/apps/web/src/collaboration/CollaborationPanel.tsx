import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  BellIcon,
  CheckIcon,
  Clock3Icon,
  LockKeyholeIcon,
  MessageSquareTextIcon,
  PlusIcon,
  RotateCcwIcon,
  SendIcon,
  Trash2Icon,
} from "lucide-react";
import type {
  DocumentAccessGrant,
  DocumentAccessGrantInput,
  DocumentAccessMode,
  DocumentAccessRole,
  DocumentIdentity,
} from "@singularity/contracts";

import { Badge } from "@/components/ui/badge.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Textarea } from "@/components/ui/textarea.tsx";
import { Select } from "@/components/ui/select.tsx";
import {
  getSpaceGroupCandidates,
  getSpaceMemberCandidates,
  spaceGroupCandidatesQueryKey,
  spaceMemberCandidatesQueryKey,
} from "@/enterprise/api.ts";
import {
  collaborationThreadQueryKey,
  collaborationThreadsQueryKey,
  commentMentionCandidatesQueryKey,
  documentAccessPolicyQueryKey,
  documentHistoryQueryKey,
  getCommentThread,
  getCommentMentionCandidates,
  getCommentThreads,
  getDocumentAccessPolicy,
  getHistory,
  getHistoryDiff,
  getNotificationUnreadCount,
  getNotifications,
  markAllNotificationsRead,
  markNotificationRead,
  notificationUnreadCountQueryKey,
  notificationsQueryKey,
  createCommentReply,
  createCommentThread,
  restoreHistory,
  updateCommentStatus,
  updateDocumentAccessPolicy,
} from "./api.ts";
import { collaborationStatusVariants } from "./collaboration-variants.ts";

type CollaborationTab = "comments" | "history" | "notifications" | "access";
const COLLABORATION_TABS = ["comments", "history", "notifications", "access"] as const satisfies readonly CollaborationTab[];

interface CollaborationPanelProps {
  readonly identity: DocumentIdentity | null;
  readonly onNavigate?: (identity: DocumentIdentity) => void;
}

function tabLabel(tab: CollaborationTab): string {
  switch (tab) {
    case "comments":
      return "评论";
    case "history":
      return "历史";
    case "notifications":
      return "通知";
    case "access":
      return "权限";
  }
}

function grantInput(grant: DocumentAccessGrant): DocumentAccessGrantInput {
  return grant.kind === "group"
    ? { groupId: grant.groupId!, kind: "group", role: grant.role }
    : { kind: "user", role: grant.role, userId: grant.userId! };
}

function accessRoleLabel(role: DocumentAccessRole): string {
  switch (role) {
    case "viewer":
      return "阅读者";
    case "commenter":
      return "评论者";
    case "editor":
      return "编辑者";
  }
}

/** 文档协作侧栏只消费当前四段身份，评论、历史、通知和 ACL 均通过 React Query 保持服务端事实源。 */
export function CollaborationPanel({ identity, onNavigate }: CollaborationPanelProps) {
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<CollaborationTab>("comments");
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [replyDraft, setReplyDraft] = useState("");
  const [mentionedUserIds, setMentionedUserIds] = useState<string[]>([]);
  const [selectedVersionId, setSelectedVersionId] = useState<string | null>(null);
  const [grantKind, setGrantKind] = useState<"user" | "group">("user");
  const [grantSubjectId, setGrantSubjectId] = useState("");
  const [grantRole, setGrantRole] = useState<DocumentAccessRole>("viewer");

  const commentsQuery = useQuery({
    enabled: identity !== null,
    queryFn: ({ signal }) => getCommentThreads(identity!, signal),
    queryKey: identity === null ? ["collaboration", "comments", "empty"] : collaborationThreadsQueryKey(identity),
    staleTime: 5_000,
  });
  const threads = commentsQuery.data?.threads ?? [];
  const selectedThreadIsVisible = selectedThreadId !== null && threads.some((thread) => thread.threadId === selectedThreadId);
  const activeThreadId = selectedThreadIsVisible ? selectedThreadId : threads[0]?.threadId ?? null;
  const visibleThreadId = activeThreadId;
  const threadQuery = useQuery({
    enabled: identity !== null && visibleThreadId !== null,
    queryFn: ({ signal }) => getCommentThread(identity!, visibleThreadId!, signal),
    queryKey:
      identity === null || visibleThreadId === null
        ? ["collaboration", "thread", "empty"]
        : collaborationThreadQueryKey(identity, visibleThreadId),
  });
  const mentionCandidatesQuery = useQuery({
    enabled: identity !== null && tab === "comments",
    queryFn: ({ signal }) => getCommentMentionCandidates(identity!, undefined, signal),
    queryKey: identity === null ? ["collaboration", "mention-candidates", "empty"] : commentMentionCandidatesQueryKey(identity),
    staleTime: 30_000,
  });
  const historyQuery = useQuery({
    enabled: identity !== null && tab === "history",
    queryFn: ({ signal }) => getHistory(identity!, signal),
    queryKey: identity === null ? ["collaboration", "history", "empty"] : documentHistoryQueryKey(identity),
  });
  const diffQuery = useQuery({
    enabled: identity !== null && selectedVersionId !== null,
    queryFn: ({ signal }) => getHistoryDiff(identity!, selectedVersionId!, signal),
    queryKey:
      identity === null || selectedVersionId === null
        ? ["collaboration", "history-diff", "empty"]
        : [...documentHistoryQueryKey(identity), selectedVersionId],
  });
  const policyQuery = useQuery({
    enabled: identity !== null && tab === "access",
    queryFn: ({ signal }) => getDocumentAccessPolicy(identity!, signal),
    queryKey: identity === null ? ["collaboration", "access", "empty"] : documentAccessPolicyQueryKey(identity),
  });
  const memberCandidatesQuery = useQuery({
    enabled: identity !== null && tab === "access",
    queryFn: ({ signal }) =>
      getSpaceMemberCandidates(identity!.organizationId, identity!.spaceId, signal),
    queryKey:
      identity === null
        ? ["collaboration", "access", "member-candidates", "empty"]
        : spaceMemberCandidatesQueryKey(identity.organizationId, identity.spaceId),
    staleTime: 30_000,
  });
  const groupCandidatesQuery = useQuery({
    enabled: identity !== null && tab === "access",
    queryFn: ({ signal }) =>
      getSpaceGroupCandidates(identity!.organizationId, identity!.spaceId, signal),
    queryKey:
      identity === null
        ? ["collaboration", "access", "group-candidates", "empty"]
        : spaceGroupCandidatesQueryKey(identity.organizationId, identity.spaceId),
    staleTime: 30_000,
  });
  const unreadQuery = useQuery({
    enabled: identity !== null,
    queryFn: ({ signal }) => getNotificationUnreadCount(signal),
    queryKey: notificationUnreadCountQueryKey,
    refetchInterval: 30_000,
  });
  const notificationsQuery = useQuery({
    enabled: tab === "notifications",
    queryFn: ({ signal }) => getNotifications(signal),
    queryKey: notificationsQueryKey,
  });

  const createThreadMutation = useMutation({
    mutationFn: () => createCommentThread(identity!, {
      anchorBlockId: null,
      body: draft,
      mentionedUserIds,
    }),
    onSuccess: () => {
      setDraft("");
      setMentionedUserIds([]);
      void queryClient.invalidateQueries({ queryKey: collaborationThreadsQueryKey(identity!) });
    },
  });
  const replyMutation = useMutation({
    mutationFn: () => createCommentReply(identity!, activeThreadId!, {
      body: replyDraft,
      mentionedUserIds,
    }),
    onSuccess: () => {
      setReplyDraft("");
      setMentionedUserIds([]);
      void queryClient.invalidateQueries({ queryKey: collaborationThreadQueryKey(identity!, activeThreadId!) });
    },
  });
  const statusMutation = useMutation({
    mutationFn: (status: "open" | "resolved") => updateCommentStatus(identity!, activeThreadId!, { status }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: collaborationThreadsQueryKey(identity!) });
      void queryClient.invalidateQueries({ queryKey: collaborationThreadQueryKey(identity!, activeThreadId!) });
    },
  });
  const restoreMutation = useMutation({
    mutationFn: (versionId: string) => restoreHistory(identity!, versionId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: documentHistoryQueryKey(identity!) });
    },
  });
  const accessMutation = useMutation({
    mutationFn: async (value: {
      grants: DocumentAccessGrantInput[];
      mode: DocumentAccessMode;
    }) => {
      if (!identity || !policy) {
        throw new Error("Document access policy is unavailable");
      }
      return updateDocumentAccessPolicy(identity, value);
    },
    onError: (error: unknown) => {
      console.error("[collaboration.access]", { error, phase: "update", result: "failed" });
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: documentAccessPolicyQueryKey(identity!) });
    },
  });
  const markReadMutation = useMutation({
    mutationFn: markNotificationRead,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: notificationsQueryKey });
      void queryClient.invalidateQueries({ queryKey: notificationUnreadCountQueryKey });
    },
  });
  const markAllReadMutation = useMutation({
    mutationFn: markAllNotificationsRead,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: notificationsQueryKey });
      void queryClient.invalidateQueries({ queryKey: notificationUnreadCountQueryKey });
    },
  });

  const policy = policyQuery.data;
  const selectedThread = threadQuery.data;
  const memberCandidates = memberCandidatesQuery.data?.members ?? [];
  const groupCandidates = groupCandidatesQuery.data?.groups ?? [];
  const grantedUserIds = new Set(
    policy?.grants
      .filter((grant) => grant.kind === "user")
      .map((grant) => grant.userId)
      .filter((userId): userId is string => userId !== null) ?? [],
  );
  const grantedGroupIds = new Set(
    policy?.grants
      .filter((grant) => grant.kind === "group")
      .map((grant) => grant.groupId)
      .filter((groupId): groupId is string => groupId !== null) ?? [],
  );
  const selectableMemberCandidates = memberCandidates.filter(
    (candidate) => !grantedUserIds.has(candidate.userId),
  );
  const selectableGroupCandidates = groupCandidates.filter(
    (candidate) => !grantedGroupIds.has(candidate.groupId),
  );
  const memberNames = new Map(
    memberCandidates.map((candidate) => [candidate.userId, candidate.loginIdentifier]),
  );
  const groupNames = new Map(
    groupCandidates.map((candidate) => [candidate.groupId, candidate.groupName]),
  );

  // 所有 ACL 变更都提交完整 grant 集合，服务端一次事务替换，避免局部写入产生中间权限状态。
  const updateAccessPolicy = (
    mode: DocumentAccessMode,
    grants: DocumentAccessGrantInput[],
  ) => accessMutation.mutate({ grants, mode });

  const addGrant = () => {
    if (!policy || grantSubjectId === "") {
      return;
    }
    const duplicate = grantKind === "user"
      ? grantedUserIds.has(grantSubjectId)
      : grantedGroupIds.has(grantSubjectId);
    if (duplicate) {
      return;
    }
    const input: DocumentAccessGrantInput = grantKind === "user"
      ? { kind: "user", role: grantRole, userId: grantSubjectId }
      : { groupId: grantSubjectId, kind: "group", role: grantRole };
    updateAccessPolicy(policy.mode, [...policy.grants.map(grantInput), input]);
    setGrantSubjectId("");
  };

  if (identity === null) {
    return null;
  }

  return (
    <aside className="hidden h-full min-h-0 w-96 shrink-0 flex-col border-l bg-muted/20 xl:flex" data-collaboration-panel>
      <header className="flex items-center justify-between border-b px-3 py-2">
        <div className="flex items-center gap-2 text-sm font-medium">
          <MessageSquareTextIcon aria-hidden="true" className="size-4 text-primary" />
          协作
          {unreadQuery.data && unreadQuery.data.unreadCount > 0 ? <Badge variant="default">{unreadQuery.data.unreadCount}</Badge> : null}
        </div>
        <span className="text-[11px] text-muted-foreground">{identity.documentId}</span>
      </header>
      <nav aria-label="文档协作" className="grid grid-cols-4 border-b bg-background/70 p-1">
        {COLLABORATION_TABS.map((item) => (
          <button
            aria-selected={tab === item}
            className={`rounded-md px-1 py-1.5 text-xs ${tab === item ? "bg-accent text-accent-foreground" : "text-muted-foreground hover:bg-muted"}`}
            key={item}
            onClick={() => setTab(item)}
            role="tab"
            type="button"
          >
            {tabLabel(item)}
          </button>
        ))}
      </nav>
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {tab === "comments" ? (
          <div className="space-y-3">
            <Textarea onChange={(event) => setDraft(event.target.value)} placeholder="写下评论…" value={draft} />
            {mentionCandidatesQuery.data && mentionCandidatesQuery.data.candidates.length > 0 ? (
              <select
                aria-label="选择提及成员"
                className="min-h-8 w-full rounded-md border bg-background px-2 text-xs"
                multiple
                onChange={(event) => setMentionedUserIds(Array.from(event.target.selectedOptions, (option) => option.value))}
                value={mentionedUserIds}
              >
                {mentionCandidatesQuery.data.candidates.map((candidate) => (
                  <option key={candidate.userId} value={candidate.userId}>{`@${candidate.loginIdentifier}`}</option>
                ))}
              </select>
            ) : null}
            <Button className="w-full" disabled={!draft.trim() || createThreadMutation.isPending} onClick={() => createThreadMutation.mutate()} size="sm">
              <SendIcon aria-hidden="true" /> 发布评论
            </Button>
            <div className="space-y-2">
              {threads.map((thread) => (
                <button className={`w-full rounded-md border p-2 text-left text-xs ${thread.threadId === activeThreadId ? "border-primary bg-accent/60" : "bg-background hover:bg-muted"}`} key={thread.threadId} onClick={() => setSelectedThreadId(thread.threadId)} type="button">
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate text-muted-foreground">{thread.anchorBlockId ?? "文档锚点"}</span>
                    <span className={collaborationStatusVariants({ status: thread.status === "resolved" ? "resolved" : "open" })}>{thread.status === "resolved" ? "已解决" : "开放"}</span>
                  </div>
                  <span className="mt-1 block text-[11px] text-muted-foreground">{new Date(thread.createdAt).toLocaleString()}</span>
                </button>
              ))}
              {threads.length === 0 ? <p className="py-8 text-center text-xs text-muted-foreground">当前文档还没有评论。</p> : null}
            </div>
            {selectedThread ? (
              <div className="space-y-2 border-t pt-3">
                {selectedThread.entries.map((entry) => (
                  <div className="rounded-md bg-background p-2 text-xs" key={entry.entryId}>
                    <div className="mb-1 flex items-center justify-between text-[11px] text-muted-foreground"><span>{entry.authorUserId}</span><span>{new Date(entry.createdAt).toLocaleString()}</span></div>
                    <p className={entry.deletedAt ? "text-muted-foreground" : "whitespace-pre-wrap"}>{entry.deletedAt ? "评论已删除" : entry.body}</p>
                  </div>
                ))}
                <Textarea onChange={(event) => setReplyDraft(event.target.value)} placeholder="回复线程…" value={replyDraft} />
                <div className="flex gap-2">
                  <Button disabled={!replyDraft.trim() || replyMutation.isPending} onClick={() => replyMutation.mutate()} size="sm"><SendIcon aria-hidden="true" /> 回复</Button>
                  <Button disabled={statusMutation.isPending} onClick={() => statusMutation.mutate(selectedThread.thread.status === "resolved" ? "open" : "resolved")} size="sm" variant="outline">
                    {selectedThread.thread.status === "resolved" ? <RotateCcwIcon aria-hidden="true" /> : <CheckIcon aria-hidden="true" />}
                    {selectedThread.thread.status === "resolved" ? "重新打开" : "解决"}
                  </Button>
                </div>
              </div>
            ) : null}
          </div>
        ) : null}
        {tab === "history" ? (
          <div className="space-y-2">
            {historyQuery.data?.versions.map((version) => (
              <div className="rounded-md border bg-background p-2" key={version.versionId}>
                <button className="w-full text-left" onClick={() => setSelectedVersionId(version.versionId)} type="button">
                  <div className="flex items-center justify-between gap-2 text-xs"><span className="truncate">{version.summary}</span><Clock3Icon aria-hidden="true" className="size-3.5 text-muted-foreground" /></div>
                  <span className="mt-1 block text-[11px] text-muted-foreground">{new Date(version.createdAt).toLocaleString()}</span>
                </button>
                <Button className="mt-2 w-full" disabled={restoreMutation.isPending} onClick={() => restoreMutation.mutate(version.versionId)} size="sm" variant="outline"><RotateCcwIcon aria-hidden="true" />恢复为新版本</Button>
              </div>
            ))}
            {diffQuery.data ? <pre className="max-h-48 overflow-auto rounded-md bg-muted p-2 text-[11px] whitespace-pre-wrap">{diffQuery.data.changes[0]?.after ?? "无差异"}</pre> : null}
            {historyQuery.data?.versions.length === 0 ? <p className="py-8 text-center text-xs text-muted-foreground">暂无历史版本。</p> : null}
          </div>
        ) : null}
        {tab === "notifications" ? (
          <div className="space-y-2">
            <Button className="w-full" disabled={markAllReadMutation.isPending} onClick={() => markAllReadMutation.mutate()} size="sm" variant="outline"><CheckIcon aria-hidden="true" />全部标记已读</Button>
            {notificationsQuery.data?.notifications.map((notification) => (
              <button className={`w-full rounded-md border p-2 text-left text-xs ${notification.readAt ? "bg-background" : "border-primary/40 bg-accent/40"}`} key={notification.notificationId} onClick={() => {
                markReadMutation.mutate(notification.notificationId);
                onNavigate?.(notification.document);
              }} type="button">
                <div className="flex items-center gap-2"><BellIcon aria-hidden="true" className="size-3.5 text-primary" /><span>{notification.kind}</span></div>
                <span className="mt-1 block text-[11px] text-muted-foreground">{new Date(notification.createdAt).toLocaleString()}</span>
              </button>
            ))}
            {notificationsQuery.data?.notifications.length === 0 ? <p className="py-8 text-center text-xs text-muted-foreground">暂无通知。</p> : null}
          </div>
        ) : null}
        {tab === "access" ? (
          <div className="space-y-3">
            <div className="flex items-center gap-2 text-sm font-medium"><LockKeyholeIcon aria-hidden="true" className="size-4 text-primary" />文档访问</div>
            <Select aria-label="文档访问模式" className="h-8 w-full" disabled={accessMutation.isPending} onChange={(event) => updateAccessPolicy(event.target.value as DocumentAccessMode, policy?.grants.map(grantInput) ?? [])} value={policy?.mode ?? "inherit"}>
              <option value="inherit">继承空间权限</option>
              <option value="restricted">受限访问</option>
            </Select>
            <p className="text-xs text-muted-foreground">{policy?.mode === "restricted" ? `已配置 ${policy.grants.length} 个授权` : "普通成员沿用当前空间角色"}</p>
            <div className="grid grid-cols-1 gap-2 rounded-md border bg-background p-2 sm:grid-cols-[auto_minmax(0,1fr)_auto_auto]">
              <Select aria-label="授权主体类型" disabled={accessMutation.isPending} onChange={(event) => { setGrantKind(event.target.value as "user" | "group"); setGrantSubjectId(""); }} value={grantKind}>
                <option value="user">用户</option>
                <option value="group">用户组</option>
              </Select>
              <Select aria-label="授权主体" disabled={accessMutation.isPending || (grantKind === "user" ? selectableMemberCandidates.length === 0 : selectableGroupCandidates.length === 0)} onChange={(event) => setGrantSubjectId(event.target.value)} value={grantSubjectId}>
                <option value="">选择授权主体</option>
                {grantKind === "user"
                  ? selectableMemberCandidates.map((candidate) => <option key={candidate.userId} value={candidate.userId}>{candidate.loginIdentifier}</option>)
                  : selectableGroupCandidates.map((candidate) => <option key={candidate.groupId} value={candidate.groupId}>{candidate.groupName}</option>)}
              </Select>
              <Select aria-label="授权角色" disabled={accessMutation.isPending} onChange={(event) => setGrantRole(event.target.value as DocumentAccessRole)} value={grantRole}>
                <option value="viewer">阅读者</option>
                <option value="commenter">评论者</option>
                <option value="editor">编辑者</option>
              </Select>
              <Button aria-label="添加文档授权" disabled={accessMutation.isPending || grantSubjectId === ""} onClick={addGrant} size="icon" type="button"><PlusIcon aria-hidden="true" /></Button>
            </div>
            {policy?.grants.map((grant) => {
              const subject = grant.kind === "user"
                ? memberNames.get(grant.userId ?? "") ?? grant.userId
                : groupNames.get(grant.groupId ?? "") ?? grant.groupId;
              return (
                <div className="flex items-center gap-2 rounded-md border bg-background px-2 py-1.5 text-xs" key={grant.grantId}>
                  <span className="min-w-0 flex-1 truncate">{grant.kind === "user" ? "用户" : "用户组"} · {subject}</span>
                  <Select aria-label={`${subject} 的文档角色`} className="h-7 w-24 text-xs" disabled={accessMutation.isPending} onChange={(event) => updateAccessPolicy(policy.mode, policy.grants.map((item) => item.grantId === grant.grantId ? { ...grantInput(item), role: event.target.value as DocumentAccessRole } : grantInput(item)))} value={grant.role}>
                    <option value="viewer">{accessRoleLabel("viewer")}</option>
                    <option value="commenter">{accessRoleLabel("commenter")}</option>
                    <option value="editor">{accessRoleLabel("editor")}</option>
                  </Select>
                  <Button aria-label={`删除 ${subject} 的文档授权`} disabled={accessMutation.isPending} onClick={() => updateAccessPolicy(policy.mode, policy.grants.filter((item) => item.grantId !== grant.grantId).map(grantInput))} size="icon-sm" type="button" variant="ghost"><Trash2Icon aria-hidden="true" /></Button>
                </div>
              );
            })}
            {accessMutation.error ? <p className="text-xs text-destructive">权限更新失败，请刷新后重试。</p> : null}
          </div>
        ) : null}
      </div>
    </aside>
  );
}
