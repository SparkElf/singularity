import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  BotIcon,
  CheckCircle2Icon,
  ExternalLinkIcon,
  FileCheck2Icon,
  LockKeyholeIcon,
  PencilIcon,
  RefreshCwIcon,
  ShieldAlertIcon,
} from "lucide-react";
import type {
  DocumentIdentity,
  GovernanceClassification,
  GovernanceLifecycleStatus,
} from "@singularity/contracts";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Input } from "@/components/ui/input.tsx";
import { Select } from "@/components/ui/select.tsx";
import { Spinner } from "@/components/ui/spinner.tsx";
import { Textarea } from "@/components/ui/textarea.tsx";
import { MutationFailure, SectionHeading } from "@/enterprise/components.tsx";
import {
  askDocumentAi,
  documentEmbedsQueryKey,
  documentGovernanceQueryKey,
  getDocumentApprovals,
  getDocumentEmbeds,
  getDocumentGovernance,
  setDocumentClassification,
  setDocumentLegalHold,
  transitionDocumentGovernance,
  upsertDocumentEmbed,
} from "@/enterprise/api.ts";

const lifecycleLabels: Record<GovernanceLifecycleStatus, string> = {
  draft: "草稿",
  "in-review": "审核中",
  approved: "已批准",
  published: "已发布",
  archived: "已归档",
  rejected: "已退回",
};

const classificationLabels: Record<GovernanceClassification, string> = {
  public: "公开",
  internal: "内部",
  confidential: "机密",
  restricted: "受限",
};

const transitionActions: Partial<Record<GovernanceLifecycleStatus, Array<{ action: "submit" | "approve" | "reject" | "publish" | "archive" | "restore" | "verify"; label: string }>>> = {
  draft: [{ action: "submit", label: "提交审核" }],
  "in-review": [{ action: "approve", label: "批准" }, { action: "reject", label: "退回" }],
  approved: [{ action: "publish", label: "发布" }, { action: "reject", label: "退回" }],
  published: [{ action: "archive", label: "归档" }],
  archived: [{ action: "restore", label: "恢复" }],
  rejected: [{ action: "submit", label: "重新提交" }],
};

interface DocumentGovernancePanelProps {
  readonly identity: DocumentIdentity;
  /** 引用跳转必须由当前空间会话执行，面板不自行推断目标空间。 */
  readonly onNavigateCitation?: (target: DocumentIdentity) => void;
}

// 将四段身份压缩为查询和异步回调的作用域标识，迟到结果只能回写同一文档。
function documentIdentityKey(identity: DocumentIdentity): string {
  return `${identity.organizationId}:${identity.spaceId}:${identity.notebookId}:${identity.documentId}`;
}

// 只允许显式 HTTPS 预览地址进入沙箱 iframe；其余嵌入仍显示可审计的 JSON 元数据。
function resolveEmbedPreviewUrl(payload: Record<string, unknown>): string | null {
  const candidate = payload.previewUrl ?? payload.url;
  if (typeof candidate !== "string" || candidate.trim().length === 0) {
    return null;
  }
  try {
    const url = new URL(candidate);
    return url.protocol === "https:" ? url.toString() : null;
  } catch (error) {
    console.error("[governance.embed.preview-url]", error);
    return null;
  }
}

type TransitionInput = {
  readonly action: "submit" | "approve" | "reject" | "publish" | "archive" | "restore" | "verify";
  readonly comment?: string;
  readonly identity: DocumentIdentity;
  readonly versionToken?: string;
};

// 文档面板只使用调用方传入的四段身份，治理动作由服务端 ACL 和状态机最终裁决。
export function DocumentGovernancePanel({ identity, onNavigateCitation }: DocumentGovernancePanelProps) {
  const queryClient = useQueryClient();
  const identityKey = documentIdentityKey(identity);
  const activeIdentityKey = useRef(identityKey);

  const governanceQuery = useQuery({
    queryKey: documentGovernanceQueryKey(identity),
    queryFn: ({ signal }) => getDocumentGovernance(identity, signal),
  });
  const approvalsQuery = useQuery({
    enabled: governanceQuery.isSuccess,
    queryKey: [...documentGovernanceQueryKey(identity), "approvals"],
    queryFn: ({ signal }) => getDocumentApprovals(identity, signal),
  });
  const embedsQuery = useQuery({
    enabled: governanceQuery.isSuccess,
    queryKey: documentEmbedsQueryKey(identity),
    queryFn: ({ signal }) => getDocumentEmbeds(identity, signal),
  });

  const [comment, setComment] = useState("");
  const [versionToken, setVersionToken] = useState("");
  const [classification, setClassification] = useState<GovernanceClassification | null>(null);
  const [embedKind, setEmbedKind] = useState<"drawio" | "excalidraw">("drawio");
  const [embedPayload, setEmbedPayload] = useState("{}");
  const [aiQuery, setAiQuery] = useState("");
  const [aiAnswer, setAiAnswer] = useState<Awaited<ReturnType<typeof askDocumentAi>> | null>(null);
  const [embedPreviewState, setEmbedPreviewState] = useState<Record<string, "failed">>({});

  const transitionMutation = useMutation({
    mutationFn: (input: TransitionInput) => transitionDocumentGovernance(input.identity, {
      action: input.action,
      ...(input.comment === undefined ? {} : { comment: input.comment }),
      ...(input.versionToken === undefined ? {} : { versionToken: input.versionToken }),
    }),
    onSuccess: (next, input) => {
      if (activeIdentityKey.current !== documentIdentityKey(input.identity)) return;
      setComment("");
      queryClient.setQueryData(documentGovernanceQueryKey(input.identity), next);
      void queryClient.invalidateQueries({ queryKey: [...documentGovernanceQueryKey(input.identity), "approvals"] });
    },
  });
  const classificationMutation = useMutation({
    mutationFn: (input: { classification: GovernanceClassification; identity: DocumentIdentity }) => setDocumentClassification(input.identity, { classification: input.classification }),
    onSuccess: (next, input) => {
      if (activeIdentityKey.current === documentIdentityKey(input.identity)) queryClient.setQueryData(documentGovernanceQueryKey(input.identity), next);
    },
  });
  const legalHoldMutation = useMutation({
    mutationFn: (input: { enabled: boolean; identity: DocumentIdentity }) => setDocumentLegalHold(input.identity, { enabled: input.enabled }),
    onSuccess: (next, input) => {
      if (activeIdentityKey.current === documentIdentityKey(input.identity)) queryClient.setQueryData(documentGovernanceQueryKey(input.identity), next);
    },
  });
  const embedMutation = useMutation({
    mutationFn: (input: { embedKind: "drawio" | "excalidraw"; embedPayload: string; identity: DocumentIdentity }) => {
      let payload: Record<string, unknown>;
      try {
        const parsed: unknown = JSON.parse(input.embedPayload);
        if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("嵌入数据必须是 JSON 对象");
        payload = parsed as Record<string, unknown>;
      } catch (error) {
        const failure = error instanceof Error ? error : new Error("嵌入数据格式错误", { cause: error });
        console.error("[governance.embed.payload]", failure);
        throw failure;
      }
      return upsertDocumentEmbed(input.identity, { kind: input.embedKind, payload });
    },
    onSuccess: (_next, input) => {
      if (activeIdentityKey.current !== documentIdentityKey(input.identity)) return;
      setEmbedPreviewState({});
      void queryClient.invalidateQueries({ queryKey: documentEmbedsQueryKey(input.identity) });
    },
  });
  const aiMutation = useMutation({
    mutationFn: (input: { conversationId?: string; identity: DocumentIdentity; query: string }) => askDocumentAi(input.identity, {
      query: input.query,
      ...(input.conversationId === undefined ? {} : { conversationId: input.conversationId }),
    }),
    onSuccess: (answer, input) => {
      if (activeIdentityKey.current === documentIdentityKey(input.identity)) setAiAnswer(answer);
    },
  });

  useEffect(() => {
    activeIdentityKey.current = identityKey;
  }, [identityKey]);

  if (governanceQuery.isPending) return <aside className="flex w-80 shrink-0 items-center justify-center border-l bg-muted/20"><Spinner aria-label="正在加载文档治理" /></aside>;
  if (governanceQuery.error) return <aside className="w-80 shrink-0 border-l p-3"><MutationFailure error={governanceQuery.error} /></aside>;
  const governance = governanceQuery.data;
  if (!governance) return null;
  const actions = transitionActions[governance.lifecycle] ?? [];
  const runTransition = (action: TransitionInput["action"]) => transitionMutation.mutate({ action, identity, ...(comment.trim().length === 0 ? {} : { comment: comment.trim() }), ...(versionToken.trim().length === 0 ? {} : { versionToken: versionToken.trim() }) });
  const runClassification = () => { if (classification !== null) classificationMutation.mutate({ classification, identity }); };
  const runEmbed = () => embedMutation.mutate({ embedKind, embedPayload, identity });
  const runAi = () => aiMutation.mutate({ identity, query: aiQuery.trim(), ...(aiAnswer?.conversationId === undefined ? {} : { conversationId: aiAnswer.conversationId }) });

  return (
    <aside className="flex w-80 shrink-0 flex-col overflow-y-auto border-l bg-muted/20" data-document-governance-panel>
      <header className="flex items-center justify-between border-b px-3 py-2">
        <div className="flex min-w-0 items-center gap-2"><FileCheck2Icon aria-hidden="true" className="size-4 shrink-0" /><span className="truncate text-sm font-semibold">文档治理</span></div>
        <Button aria-label="刷新文档治理" onClick={() => { void governanceQuery.refetch(); void approvalsQuery.refetch(); void embedsQuery.refetch(); }} size="icon-sm" variant="ghost"><RefreshCwIcon aria-hidden="true" /></Button>
      </header>
      <section className="border-b p-3">
        <div className="flex flex-wrap gap-2"><span className="rounded-full border px-2 py-0.5 text-xs">{lifecycleLabels[governance.lifecycle]}</span><span className="rounded-full border px-2 py-0.5 text-xs">{governance.verification === "verified" ? "已验证" : governance.verification === "expired" ? "已过期" : "需复核"}</span></div>
        <dl className="mt-3 space-y-1 text-xs"><div className="flex justify-between gap-2"><dt className="text-muted-foreground">密级</dt><dd>{classificationLabels[governance.classification]}</dd></div><div className="flex justify-between gap-2"><dt className="text-muted-foreground">负责人</dt><dd>{governance.ownerUserId ?? "未指定"}</dd></div><div className="flex justify-between gap-2"><dt className="text-muted-foreground">法律保留</dt><dd>{governance.legalHold ? "已开启" : "未开启"}</dd></div></dl>
      </section>
      <section className="border-b p-3">
        <SectionHeading title="状态操作" />
        <div className="mt-3 space-y-2"><Input aria-label="当前版本" onChange={(event) => setVersionToken(event.currentTarget.value)} placeholder="当前版本标识" value={versionToken} /><Textarea aria-label="治理意见" onChange={(event) => setComment(event.currentTarget.value)} placeholder="审批或状态变更意见" value={comment} /><div className="flex flex-wrap gap-2">{actions.map((item) => <Button disabled={transitionMutation.isPending} key={item.action} onClick={() => runTransition(item.action)} size="sm" variant={item.action === "reject" ? "destructive" : "outline"}>{item.label}</Button>)}<Button disabled={transitionMutation.isPending} onClick={() => runTransition("verify")} size="sm" variant="outline"><CheckCircle2Icon data-icon="inline-start" />标记已验证</Button></div></div>
        <MutationFailure error={transitionMutation.error} />
      </section>
      <section className="border-b p-3">
        <SectionHeading title="密级与法律保留" />
        <div className="mt-3 space-y-2"><Select aria-label="文档密级" onChange={(event) => setClassification(event.currentTarget.value as GovernanceClassification)} value={classification ?? governance.classification}>{Object.entries(classificationLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</Select><Button disabled={classificationMutation.isPending || classification === null} onClick={runClassification} size="sm" variant="outline"><ShieldAlertIcon data-icon="inline-start" />保存密级</Button><Button disabled={legalHoldMutation.isPending} onClick={() => legalHoldMutation.mutate({ enabled: !governance.legalHold, identity })} size="sm" variant="outline"><LockKeyholeIcon data-icon="inline-start" />{governance.legalHold ? "解除法律保留" : "开启法律保留"}</Button></div>
        <MutationFailure error={classificationMutation.error ?? legalHoldMutation.error} />
      </section>
      <section className="border-b p-3">
        <SectionHeading title="审批记录" />
        {approvalsQuery.isPending ? <Spinner aria-label="正在加载审批记录" /> : <div className="mt-2 space-y-2">{approvalsQuery.data?.approvals.map((approval) => <div className="rounded-md border bg-background p-2 text-xs" key={approval.requestId}><div className="flex justify-between"><span>{approval.status === "pending" ? "待处理" : approval.status === "approved" ? "已通过" : "已退回"}</span><span className="text-muted-foreground">{approval.versionToken}</span></div>{approval.decisionComment ? <p className="mt-1 text-muted-foreground">{approval.decisionComment}</p> : null}</div>)}</div>}
      </section>
      <section className="border-b p-3">
        <SectionHeading title="Draw.io / Excalidraw" />
        <div className="mt-3 space-y-2"><Select aria-label="嵌入类型" onChange={(event) => setEmbedKind(event.currentTarget.value as typeof embedKind)} value={embedKind}><option value="drawio">Draw.io</option><option value="excalidraw">Excalidraw</option></Select><Textarea aria-label="嵌入数据" onChange={(event) => setEmbedPayload(event.currentTarget.value)} value={embedPayload} /><p className="text-xs text-muted-foreground">预览地址必须使用 HTTPS；预览在隔离沙箱中加载，失败不会影响正文。</p><Button disabled={embedMutation.isPending} onClick={runEmbed} size="sm" variant="outline"><PencilIcon data-icon="inline-start" />保存嵌入</Button>{embedsQuery.data?.embeds.map((embed) => { const previewUrl = resolveEmbedPreviewUrl(embed.payload); const previewState = embedPreviewState[embed.embedId]; return <div className="space-y-2 rounded-md border bg-background p-2 text-xs" key={embed.embedId}><div className="flex items-center justify-between gap-2"><span>{embed.kind} · v{embed.version}</span><span className="text-muted-foreground">{embed.status}</span></div>{previewUrl === null ? <p className="text-muted-foreground">暂无可用预览，当前仅显示嵌入元数据。</p> : previewState === "failed" ? <Alert variant="destructive"><AlertTitle>嵌入预览不可用</AlertTitle><AlertDescription>正文仍可正常读取，可修正地址后重新保存。</AlertDescription></Alert> : <div className="overflow-hidden rounded border bg-muted/20"><iframe className="h-32 w-full border-0" loading="lazy" onError={() => setEmbedPreviewState((current) => ({ ...current, [embed.embedId]: "failed" }))} referrerPolicy="no-referrer" sandbox="allow-scripts" src={previewUrl} title={`${embed.kind} 嵌入预览`} /></div>}<details><summary className="cursor-pointer text-muted-foreground">查看嵌入版本数据</summary><pre className="mt-2 max-h-32 overflow-auto whitespace-pre-wrap break-words">{JSON.stringify(embed.payload, null, 2)}</pre></details></div>; })}</div>
        <MutationFailure error={embedMutation.error} />
      </section>
      <section className="p-3">
        <SectionHeading title="授权 AI Chat" />
        <div className="mt-3 space-y-2"><Textarea aria-label="AI 问题" onChange={(event) => setAiQuery(event.currentTarget.value)} placeholder="针对当前文档提问" value={aiQuery} /><Button disabled={aiMutation.isPending || aiQuery.trim().length === 0} onClick={runAi} size="sm"><BotIcon data-icon="inline-start" />提问</Button>{aiAnswer ? <Alert><AlertTitle>{aiAnswer.answer}</AlertTitle><AlertDescription><div className="space-y-2">{aiAnswer.citations.map((citation) => { const sameSpace = citation.document.organizationId === identity.organizationId && citation.document.spaceId === identity.spaceId; return <div className="rounded border bg-background p-2" key={`${citation.document.organizationId}:${citation.document.spaceId}:${citation.document.notebookId}:${citation.document.documentId}`}><p>{citation.excerpt}</p><div className="mt-1 flex items-center justify-between gap-2"><span className="text-xs text-muted-foreground">引用：{citation.document.documentId}</span>{sameSpace && onNavigateCitation ? <Button aria-label={`打开引用 ${citation.document.documentId}`} onClick={() => onNavigateCitation(citation.document)} size="xs" variant="ghost"><ExternalLinkIcon data-icon="inline-start" />打开引用</Button> : null}</div></div>; })}</div></AlertDescription></Alert> : null}</div>
        <MutationFailure error={aiMutation.error} />
      </section>
    </aside>
  );
}
