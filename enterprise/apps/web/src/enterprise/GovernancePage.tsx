import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CheckCircle2Icon,
  CopyIcon,
  KeyRoundIcon,
  LinkIcon,
  PlusIcon,
  RefreshCwIcon,
  SaveIcon,
  SearchIcon,
  ShieldCheckIcon,
  UserRoundIcon,
} from "lucide-react";
import { useNavigate, useOutletContext, useParams } from "react-router";
import type { GovernancePolicyResponse, OrganizationManagementAccess } from "@singularity/contracts";

import { Button } from "@/components/ui/button.tsx";
import { Input } from "@/components/ui/input.tsx";
import { Label } from "@/components/ui/label.tsx";
import { Select } from "@/components/ui/select.tsx";
import { Spinner } from "@/components/ui/spinner.tsx";
import { Textarea } from "@/components/ui/textarea.tsx";
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@/components/ui/alert.tsx";
import {
  PageFailure,
  PageHeader,
  SectionHeading,
  MutationFailure,
} from "@/enterprise/components.tsx";
import {
  createEnterpriseApiKey,
  createDocumentFromGovernanceTemplate,
  createGovernanceTemplate,
  createSamlProvider,
  createScimToken,
  enrollMfaFactor,
  enterpriseApiKeysQueryKey,
  getEnterpriseApiKeys,
  getGovernanceDashboard,
  getGovernancePolicy,
  getGovernanceTemplates,
  getMfaFactors,
  getPersonalSpace,
  getSamlProviders,
  getScimTokens,
  governanceDashboardQueryKey,
  governancePolicyQueryKey,
  governanceSearchQueryKey,
  governanceTemplatesQueryKey,
  mfaFactorsQueryKey,
  publishGovernanceTemplate,
  revokeEnterpriseApiKey,
  revokeScimToken,
  samlProvidersQueryKey,
  scimTokensQueryKey,
  searchAuthorizedSpaces,
  setSamlProviderStatus,
  updateGovernancePolicy,
  verifyMfaFactor,
} from "@/enterprise/api.ts";
import { useGovernanceStore } from "@/enterprise/governance-state.ts";
import { contentDirectoryNotebooksQueryKey, getContentDirectoryNotebooks } from "@/spaces/content-directory-api.ts";
import { spaceDocumentNavigationState, spacePagePath } from "@/spaces/space-route.ts";

const classificationLabels = {
  public: "公开",
  internal: "内部",
  confidential: "机密",
  restricted: "受限",
} as const;

// 复制一次性凭据并保留原始异常，便于浏览器权限或剪贴板策略问题可诊断。
async function copySecret(value: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(value);
  } catch (error) {
    const failure = error instanceof Error ? error : new Error("复制凭据失败", { cause: error });
    console.error("[governance.secret.copy]", failure);
  }
}

function CopySecret({ value }: { value: string }) {
  return (
    <div className="flex min-w-0 items-center gap-2 rounded-md border bg-muted p-2">
      <code className="min-w-0 flex-1 break-all text-xs">{value}</code>
      <Button aria-label="复制凭据" onClick={() => void copySecret(value)} size="icon-sm" variant="ghost">
        <CopyIcon aria-hidden="true" />
      </Button>
    </div>
  );
}

// 读取并保存当前组织下指定空间的治理策略，策略写入由服务端权限和状态机裁决。
function OverviewView({ organizationId, access }: { organizationId: string; access: OrganizationManagementAccess }) {
  const queryClient = useQueryClient();
  const [spaceId, setSpaceId] = useState(access.spaces[0]?.spaceId ?? "");
  const [draft, setDraft] = useState<Pick<GovernancePolicyResponse, "governanceEnabled" | "watermarkEnabled" | "verificationIntervalDays" | "retentionDays"> | null>(null);
  const dashboardQuery = useQuery({ queryKey: governanceDashboardQueryKey(organizationId), queryFn: ({ signal }) => getGovernanceDashboard(organizationId, signal) });
  const policyQuery = useQuery({ enabled: spaceId.length > 0, queryKey: governancePolicyQueryKey(organizationId, spaceId), queryFn: ({ signal }) => getGovernancePolicy(organizationId, spaceId, signal) });
  const policy = policyQuery.data;
  const form = draft ?? (policy === undefined ? null : { governanceEnabled: policy.governanceEnabled, watermarkEnabled: policy.watermarkEnabled, verificationIntervalDays: policy.verificationIntervalDays, retentionDays: policy.retentionDays });
  const saveMutation = useMutation({
    mutationFn: async () => {
      if (policy === undefined || form === null) throw new Error("治理策略尚未加载");
      return updateGovernancePolicy(organizationId, spaceId, { archiveAfterDays: policy.archiveAfterDays, defaultClassification: policy.defaultClassification, governanceEnabled: form.governanceEnabled, retentionDays: form.retentionDays, verificationGraceDays: policy.verificationGraceDays, verificationIntervalDays: form.verificationIntervalDays, watermarkEnabled: form.watermarkEnabled });
    },
    onSuccess: (next) => { setDraft(null); queryClient.setQueryData(governancePolicyQueryKey(organizationId, spaceId), next); void queryClient.invalidateQueries({ queryKey: governanceDashboardQueryKey(organizationId) }); },
  });
  if (dashboardQuery.error || policyQuery.error) return <PageFailure error={dashboardQuery.error ?? policyQuery.error} onRetry={() => { void dashboardQuery.refetch(); void policyQuery.refetch(); }} />;
  return (
    <div className="flex flex-col">
      {dashboardQuery.isPending ? <div className="flex min-h-40 items-center justify-center"><Spinner aria-label="正在加载治理数据" /></div> : dashboardQuery.data ? <section className="grid grid-cols-2 gap-px border-b bg-border md:grid-cols-5">{[["待审批", dashboardQuery.data.approvalsPending], ["需复核", dashboardQuery.data.documentsNeedingReview], ["已过期", dashboardQuery.data.documentsExpired], ["法律保留", dashboardQuery.data.legalHolds], ["失败任务", dashboardQuery.data.tasksFailed]].map(([label, value]) => <div className="bg-background px-4 py-3" key={label}><p className="text-xs text-muted-foreground">{label}</p><p className="mt-1 text-xl font-semibold">{value}</p></div>)}</section> : null}
      <section className="border-b">
        <SectionHeading title="空间策略" />
        <div className="grid gap-4 px-4 py-4 md:grid-cols-[minmax(220px,320px)_1fr]">
          <div className="space-y-2"><Label htmlFor="governance-space">空间</Label><Select id="governance-space" onChange={(event) => { setSpaceId(event.currentTarget.value); setDraft(null); }} value={spaceId}>{access.spaces.map((space) => <option key={space.spaceId} value={space.spaceId}>{space.spaceName}</option>)}</Select><p className="text-xs text-muted-foreground">{access.spaces.find((space) => space.spaceId === spaceId)?.spaceName ?? "请选择空间"}</p></div>
          {policyQuery.isPending || form === null ? <div className="flex items-center"><Spinner aria-label="正在加载空间策略" /></div> : <div className="grid gap-4 sm:grid-cols-2"><label className="flex items-center gap-2 text-sm"><input checked={form.governanceEnabled} onChange={(event) => setDraft({ ...form, governanceEnabled: event.currentTarget.checked })} type="checkbox" />启用治理</label><label className="flex items-center gap-2 text-sm"><input checked={form.watermarkEnabled} onChange={(event) => setDraft({ ...form, watermarkEnabled: event.currentTarget.checked })} type="checkbox" />导出水印</label><label className="space-y-1 text-sm"><span className="text-muted-foreground">验证周期（天）</span><Input min={1} onChange={(event) => setDraft({ ...form, verificationIntervalDays: Number(event.currentTarget.value) })} type="number" value={form.verificationIntervalDays} /></label><label className="space-y-1 text-sm"><span className="text-muted-foreground">保留周期（天）</span><Input min={1} onChange={(event) => setDraft({ ...form, retentionDays: Number(event.currentTarget.value) })} type="number" value={form.retentionDays} /></label><div className="sm:col-span-2"><Button disabled={saveMutation.isPending || draft === null} onClick={() => saveMutation.mutate()}><SaveIcon data-icon="inline-start" />保存策略</Button></div></div>}
        </div>
      </section>
      <div className="flex items-center gap-2 px-4 py-3 text-xs text-muted-foreground"><ShieldCheckIcon aria-hidden="true" className="size-4" />策略由服务端权限和治理状态机执行</div>
      <MutationFailure error={saveMutation.error} />
    </div>
  );
}

// 管理治理模板目录；模板只提供创建初始结构的元数据，不承载正文事实。
function TemplatesView({ organizationId, access }: { organizationId: string; access: OrganizationManagementAccess }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [spaceId, setSpaceId] = useState(access.spaces[0]?.spaceId ?? "");
  const templatesQuery = useQuery({ enabled: spaceId.length > 0, queryKey: governanceTemplatesQueryKey(organizationId, spaceId), queryFn: ({ signal }) => getGovernanceTemplates(organizationId, spaceId, signal) });
  const notebooksQuery = useQuery({ enabled: spaceId.length > 0, queryKey: contentDirectoryNotebooksQueryKey({ organizationId, spaceId }), queryFn: ({ signal }) => getContentDirectoryNotebooks({ organizationId, spaceId }, signal) });
  const [form, setForm] = useState({ name: "", description: "", classification: "internal" as keyof typeof classificationLabels, interval: "180", initialContent: "" });
  const [applyForm, setApplyForm] = useState({ templateId: "", notebookId: "", parentDocumentId: "", title: "" });
  const createMutation = useMutation({ mutationFn: () => createGovernanceTemplate(organizationId, spaceId, { defaultClassification: form.classification, description: form.description, initialContent: { markdown: form.initialContent }, name: form.name, verificationIntervalDays: Number(form.interval) }), onSuccess: () => { setForm({ name: "", description: "", classification: "internal", interval: "180", initialContent: "" }); void queryClient.invalidateQueries({ queryKey: governanceTemplatesQueryKey(organizationId, spaceId) }); } });
  const publishMutation = useMutation({ mutationFn: (templateId: string) => publishGovernanceTemplate(organizationId, spaceId, templateId), onSuccess: () => void queryClient.invalidateQueries({ queryKey: governanceTemplatesQueryKey(organizationId, spaceId) }) });
  // 应用模板前必须显式选择目标笔记本，避免把首个响应误当作当前内容库。
  const applyMutation = useMutation({ mutationFn: () => createDocumentFromGovernanceTemplate(organizationId, spaceId, applyForm.templateId, { notebookId: applyForm.notebookId, ...(applyForm.parentDocumentId.length === 0 ? {} : { parentDocumentId: applyForm.parentDocumentId }), title: applyForm.title }), onSuccess: (identity) => { void navigate(spacePagePath(identity), { state: spaceDocumentNavigationState({ documentId: identity.documentId, notebookId: identity.notebookId }) }); } });
  if (templatesQuery.error) return <PageFailure error={templatesQuery.error} onRetry={() => void templatesQuery.refetch()} />;
  const publishedTemplates = templatesQuery.data?.templates.filter((template) => template.status === "published") ?? [];
  return <div className="flex flex-col gap-4 p-4"><div className="flex items-end gap-3"><div className="w-full max-w-sm space-y-2"><Label htmlFor="template-space">空间</Label><Select id="template-space" onChange={(event) => { setSpaceId(event.currentTarget.value); setApplyForm({ templateId: "", notebookId: "", parentDocumentId: "", title: "" }); }} value={spaceId}>{access.spaces.map((space) => <option key={space.spaceId} value={space.spaceId}>{space.spaceName}</option>)}</Select></div></div><section className="border"><SectionHeading title="新建模板" /><form className="grid gap-3 p-4 sm:grid-cols-2" onSubmit={(event) => { event.preventDefault(); createMutation.mutate(); }}><label className="space-y-1"><span className="text-sm text-muted-foreground">名称</span><Input onChange={(event) => setForm({ ...form, name: event.currentTarget.value })} required value={form.name} /></label><label className="space-y-1"><span className="text-sm text-muted-foreground">默认密级</span><Select onChange={(event) => setForm({ ...form, classification: event.currentTarget.value as typeof form.classification })} value={form.classification}>{Object.entries(classificationLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</Select></label><label className="space-y-1 sm:col-span-2"><span className="text-sm text-muted-foreground">描述</span><Input onChange={(event) => setForm({ ...form, description: event.currentTarget.value })} value={form.description} /></label><label className="space-y-1"><span className="text-sm text-muted-foreground">验证周期（天）</span><Input min={1} onChange={(event) => setForm({ ...form, interval: event.currentTarget.value })} type="number" value={form.interval} /></label><label className="space-y-1 sm:col-span-2"><span className="text-sm text-muted-foreground">初始 Markdown</span><Textarea className="min-h-32 font-mono text-sm" onChange={(event) => setForm({ ...form, initialContent: event.currentTarget.value })} placeholder="# 文档标题\n\n在这里填写模板正文" value={form.initialContent} /></label><div className="sm:col-span-2"><Button disabled={createMutation.isPending || spaceId.length === 0} type="submit"><PlusIcon data-icon="inline-start" />创建模板</Button></div></form><MutationFailure error={createMutation.error} /></section>{applyForm.templateId.length > 0 ? <section className="border"><SectionHeading title="应用已发布模板" /><form className="grid gap-3 p-4 sm:grid-cols-2" onSubmit={(event) => { event.preventDefault(); applyMutation.mutate(); }}><label className="space-y-1"><span className="text-sm text-muted-foreground">模板</span><Select onChange={(event) => { const template = publishedTemplates.find((item) => item.templateId === event.currentTarget.value); setApplyForm({ ...applyForm, templateId: event.currentTarget.value, title: template?.name ?? applyForm.title }); }} value={applyForm.templateId}><option value="">选择模板</option>{publishedTemplates.map((template) => <option key={template.templateId} value={template.templateId}>{template.name}</option>)}</Select></label><label className="space-y-1"><span className="text-sm text-muted-foreground">目标笔记本</span><Select onChange={(event) => setApplyForm({ ...applyForm, notebookId: event.currentTarget.value })} value={applyForm.notebookId}><option value="">选择笔记本</option>{notebooksQuery.data?.notebooks.map((notebook) => <option disabled={notebook.locked} key={notebook.notebookId} value={notebook.notebookId}>{notebook.name}{notebook.locked ? "（已锁定）" : ""}</option>)}</Select></label><label className="space-y-1 sm:col-span-2"><span className="text-sm text-muted-foreground">文档标题</span><Input onChange={(event) => setApplyForm({ ...applyForm, title: event.currentTarget.value })} required value={applyForm.title} /></label><label className="space-y-1 sm:col-span-2"><span className="text-sm text-muted-foreground">父文档 ID（可选）</span><Input onChange={(event) => setApplyForm({ ...applyForm, parentDocumentId: event.currentTarget.value })} value={applyForm.parentDocumentId} /></label><div className="sm:col-span-2"><Button disabled={applyMutation.isPending || applyForm.templateId.length === 0 || applyForm.notebookId.length === 0 || applyForm.title.trim().length === 0} type="submit"><PlusIcon data-icon="inline-start" />创建文档</Button></div></form><MutationFailure error={applyMutation.error ?? notebooksQuery.error} /></section> : null}<section className="border"><SectionHeading count={templatesQuery.data?.templates.length ?? 0} title="模板目录" />{templatesQuery.isPending ? <div className="p-4"><Spinner aria-label="正在加载模板" /></div> : <div className="divide-y">{templatesQuery.data?.templates.map((template) => <div className="flex flex-wrap items-center gap-3 px-4 py-3" key={template.templateId}><div className="min-w-0 flex-1"><p className="font-medium">{template.name}</p><p className="text-xs text-muted-foreground">{template.description ?? "无描述"} · {classificationLabels[template.defaultClassification]}</p></div><span className="text-xs text-muted-foreground">{template.status === "published" ? "已发布" : "草稿"}</span>{template.status === "draft" ? <Button disabled={publishMutation.isPending} onClick={() => publishMutation.mutate(template.templateId)} size="sm" variant="outline"><CheckCircle2Icon data-icon="inline-start" />发布</Button> : <Button onClick={() => setApplyForm({ templateId: template.templateId, notebookId: "", parentDocumentId: "", title: template.name })} size="sm" variant="outline"><PlusIcon data-icon="inline-start" />应用模板</Button>}</div>)}</div>}<MutationFailure error={publishMutation.error} /></section></div>;
}

// 管理当前登录用户的 MFA 和组织级机器身份凭据，秘密只在对应创建结果区域显示。
function IdentityView({ organizationId }: { organizationId: string }) {
  const queryClient = useQueryClient();
  const mfaQuery = useQuery({ queryKey: mfaFactorsQueryKey, queryFn: ({ signal }) => getMfaFactors(signal) });
  const keysQuery = useQuery({ queryKey: enterpriseApiKeysQueryKey(organizationId), queryFn: ({ signal }) => getEnterpriseApiKeys(organizationId, signal) });
  const samlQuery = useQuery({ queryKey: samlProvidersQueryKey(organizationId), queryFn: ({ signal }) => getSamlProviders(organizationId, signal) });
  const scimQuery = useQuery({ queryKey: scimTokensQueryKey(organizationId), queryFn: ({ signal }) => getScimTokens(organizationId, signal) });
  const [mfa, setMfa] = useState({ label: "", secret: "", code: "" });
  const [apiKey, setApiKey] = useState({ name: "", scopes: "governance.read", expiresAt: "" });
  const [saml, setSaml] = useState({ name: "", entityId: "", ssoUrl: "", certificatePem: "" });
  const [scimExpiry, setScimExpiry] = useState("");
  const [createdSecret, setCreatedSecret] = useState<{ kind: "api-key" | "scim-token"; value: string } | null>(null);
  const enrollMutation = useMutation({ mutationFn: () => enrollMfaFactor(mfa), onSuccess: () => setMfa({ ...mfa, code: "" }) });
  const verifyMutation = useMutation({ mutationFn: () => verifyMfaFactor({ code: mfa.code, label: mfa.label }), onSuccess: () => { setMfa({ label: "", secret: "", code: "" }); void queryClient.invalidateQueries({ queryKey: mfaFactorsQueryKey }); } });
  const keyMutation = useMutation({ mutationFn: () => createEnterpriseApiKey(organizationId, { name: apiKey.name, scopes: apiKey.scopes.split(",").map((scope) => scope.trim()).filter(Boolean), ...(apiKey.expiresAt.length === 0 ? {} : { expiresAt: new Date(apiKey.expiresAt).toISOString() }) }), onSuccess: (result) => { setCreatedSecret(result.secret === undefined ? null : { kind: "api-key", value: result.secret }); void queryClient.invalidateQueries({ queryKey: enterpriseApiKeysQueryKey(organizationId) }); } });
  const revokeKeyMutation = useMutation({ mutationFn: (apiKeyId: string) => revokeEnterpriseApiKey(organizationId, apiKeyId), onSuccess: () => void queryClient.invalidateQueries({ queryKey: enterpriseApiKeysQueryKey(organizationId) }) });
  const samlMutation = useMutation({ mutationFn: () => createSamlProvider(organizationId, saml), onSuccess: () => { setSaml({ name: "", entityId: "", ssoUrl: "", certificatePem: "" }); void queryClient.invalidateQueries({ queryKey: samlProvidersQueryKey(organizationId) }); } });
  const samlStatusMutation = useMutation({ mutationFn: (input: { providerId: string; status: "active" | "disabled" }) => setSamlProviderStatus(organizationId, input.providerId, input.status), onSuccess: () => void queryClient.invalidateQueries({ queryKey: samlProvidersQueryKey(organizationId) }) });
  const scimMutation = useMutation({ mutationFn: () => createScimToken(organizationId, scimExpiry.length === 0 ? undefined : new Date(scimExpiry).toISOString()), onSuccess: (result) => { setCreatedSecret({ kind: "scim-token", value: result.secret }); void queryClient.invalidateQueries({ queryKey: scimTokensQueryKey(organizationId) }); } });
  const revokeScimMutation = useMutation({ mutationFn: (tokenId: string) => revokeScimToken(organizationId, tokenId), onSuccess: () => void queryClient.invalidateQueries({ queryKey: scimTokensQueryKey(organizationId) }) });
  const loadError = mfaQuery.error ?? keysQuery.error ?? samlQuery.error ?? scimQuery.error;
  if (loadError) return <PageFailure error={loadError} onRetry={() => { void mfaQuery.refetch(); void keysQuery.refetch(); void samlQuery.refetch(); void scimQuery.refetch(); }} />;
  return <div className="grid gap-4 p-4 xl:grid-cols-2"><section className="border"><SectionHeading title="多因素认证" /><div className="space-y-3 p-4"><div className="divide-y border">{mfaQuery.data?.factors.map((factor) => <div className="flex items-center gap-3 px-3 py-2 text-sm" key={factor.factorId}><ShieldCheckIcon className="size-4" /><span className="flex-1">{factor.label}</span><span className="text-xs text-muted-foreground">{factor.enabled ? "已启用" : "待验证"}</span></div>)}</div><div className="grid gap-2 sm:grid-cols-2"><Input aria-label="MFA 名称" onChange={(event) => setMfa({ ...mfa, label: event.currentTarget.value })} placeholder="设备名称" value={mfa.label} /><Input aria-label="TOTP 秘钥" onChange={(event) => setMfa({ ...mfa, secret: event.currentTarget.value })} placeholder="TOTP 秘钥" value={mfa.secret} /></div><div className="flex flex-wrap gap-2"><Button disabled={enrollMutation.isPending || mfa.label.length === 0 || mfa.secret.length === 0} onClick={() => enrollMutation.mutate()}><PlusIcon data-icon="inline-start" />绑定因子</Button>{mfa.label.length > 0 ? <><Input aria-label="MFA 验证码" className="max-w-36" inputMode="numeric" onChange={(event) => setMfa({ ...mfa, code: event.currentTarget.value })} placeholder="6 位验证码" value={mfa.code} /><Button disabled={verifyMutation.isPending || mfa.code.length !== 6} onClick={() => verifyMutation.mutate()} variant="outline"><CheckCircle2Icon data-icon="inline-start" />验证启用</Button></> : null}</div><MutationFailure error={enrollMutation.error ?? verifyMutation.error} /></div></section><section className="border"><SectionHeading title="API Key" /><div className="space-y-3 p-4"><div className="grid gap-2 sm:grid-cols-2"><Input aria-label="Key 名称" onChange={(event) => setApiKey({ ...apiKey, name: event.currentTarget.value })} placeholder="用途名称" value={apiKey.name} /><Input aria-label="Key 权限" onChange={(event) => setApiKey({ ...apiKey, scopes: event.currentTarget.value })} placeholder="权限，以逗号分隔" value={apiKey.scopes} /></div><Input aria-label="Key 过期时间" onChange={(event) => setApiKey({ ...apiKey, expiresAt: event.currentTarget.value })} type="datetime-local" value={apiKey.expiresAt} /><Button disabled={keyMutation.isPending || apiKey.name.length === 0} onClick={() => keyMutation.mutate()}><KeyRoundIcon data-icon="inline-start" />创建 Key</Button>{createdSecret?.kind === "api-key" ? <Alert><AlertTitle>凭据只显示一次</AlertTitle><AlertDescription><CopySecret value={createdSecret.value} /></AlertDescription></Alert> : null}<div className="divide-y border">{keysQuery.data?.keys.map((key) => <div className="flex flex-wrap items-center gap-2 px-3 py-2 text-sm" key={key.apiKeyId}><span className="flex-1">{key.name} <code className="text-xs text-muted-foreground">{key.keyPrefix}</code></span><span className="text-xs text-muted-foreground">{key.revokedAt ? "已撤销" : "有效"}</span>{key.revokedAt ? null : <Button disabled={revokeKeyMutation.isPending} onClick={() => revokeKeyMutation.mutate(key.apiKeyId)} size="sm" variant="destructive">撤销</Button>}</div>)}</div><MutationFailure error={keyMutation.error ?? revokeKeyMutation.error} /></div></section><section className="border"><SectionHeading title="SAML 单点登录" /><div className="space-y-3 p-4"><div className="grid gap-2 sm:grid-cols-2"><Input aria-label="SAML 名称" onChange={(event) => setSaml({ ...saml, name: event.currentTarget.value })} placeholder="连接名称" value={saml.name} /><Input aria-label="SAML Entity ID" onChange={(event) => setSaml({ ...saml, entityId: event.currentTarget.value })} placeholder="Entity ID" value={saml.entityId} /><Input aria-label="SAML SSO 地址" onChange={(event) => setSaml({ ...saml, ssoUrl: event.currentTarget.value })} placeholder="HTTPS SSO 地址" type="url" value={saml.ssoUrl} /><Textarea aria-label="SAML 证书" onChange={(event) => setSaml({ ...saml, certificatePem: event.currentTarget.value })} placeholder="X.509 证书" value={saml.certificatePem} /></div><Button disabled={samlMutation.isPending || Object.values(saml).some((value) => value.length === 0)} onClick={() => samlMutation.mutate()}><LinkIcon data-icon="inline-start" />保存 SAML</Button><div className="divide-y border">{samlQuery.data?.providers.map((provider) => <div className="flex flex-wrap items-center gap-2 px-3 py-2 text-sm" key={provider.providerId}><span className="flex-1">{provider.name}<span className="ml-2 text-xs text-muted-foreground">{provider.certificateConfigured ? "证书已配置" : "证书缺失"}</span></span><Select aria-label={`${provider.name} 状态`} onChange={(event) => samlStatusMutation.mutate({ providerId: provider.providerId, status: event.currentTarget.value as "active" | "disabled" })} value={provider.status}><option value="active">启用</option><option value="disabled">停用</option></Select></div>)}</div><MutationFailure error={samlMutation.error ?? samlStatusMutation.error} /></div></section><section className="border"><SectionHeading title="SCIM 生命周期同步" /><div className="space-y-3 p-4"><Input aria-label="SCIM 过期时间" onChange={(event) => setScimExpiry(event.currentTarget.value)} type="datetime-local" value={scimExpiry} /><Button disabled={scimMutation.isPending} onClick={() => scimMutation.mutate()}><UserRoundIcon data-icon="inline-start" />创建同步令牌</Button><div className="divide-y border">{scimQuery.data?.tokens.map((token) => <div className="flex flex-wrap items-center gap-2 px-3 py-2 text-sm" key={token.tokenId}><span className="flex-1"><code className="text-xs">{token.tokenPrefix}</code></span><span className="text-xs text-muted-foreground">{token.revokedAt ? "已撤销" : "有效"}</span>{token.revokedAt ? null : <Button disabled={revokeScimMutation.isPending} onClick={() => revokeScimMutation.mutate(token.tokenId)} size="sm" variant="destructive">撤销</Button>}</div>)}</div>{createdSecret?.kind === "scim-token" ? <Alert><AlertTitle>同步令牌只显示一次</AlertTitle><AlertDescription><CopySecret value={createdSecret.value} /></AlertDescription></Alert> : null}<MutationFailure error={scimMutation.error ?? revokeScimMutation.error} /></div></section></div>;
}

// 在当前组织授权空间内搜索并创建个人空间；搜索结果由带作用域的查询键管理，迟到响应不会写入新作用域。
function DiscoveryView({ organizationId, access }: { organizationId: string; access: OrganizationManagementAccess }) {
  const navigate = useNavigate();
  const { organizationId: storeOrganizationId, query, selectedSpaceIds: storeSelectedSpaceIds, setQuery, setSelectedSpaceIds } = useGovernanceStore();
  const [personalSpace, setPersonalSpace] = useState<string | null>(null);
  const scopedQuery = storeOrganizationId === organizationId ? query : "";
  const allowedSpaceIds = useMemo(() => access.spaces.map((space) => space.spaceId), [access.spaces]);
  const currentSpaces = useMemo(() => {
    const scopedSelectedSpaceIds = storeOrganizationId === organizationId ? storeSelectedSpaceIds : [];
    const selected = scopedSelectedSpaceIds.filter((spaceId) => allowedSpaceIds.includes(spaceId));
    return selected.length > 0 ? selected : allowedSpaceIds;
  }, [allowedSpaceIds, organizationId, storeOrganizationId, storeSelectedSpaceIds]);
  const personalMutation = useMutation({ mutationFn: () => getPersonalSpace(organizationId), onSuccess: (result) => { setPersonalSpace(result.spaceId); void navigate(spacePagePath(result)); } });
  const searchQuery = useQuery({ enabled: false, queryKey: governanceSearchQueryKey(organizationId, scopedQuery.trim(), currentSpaces), queryFn: ({ signal }) => searchAuthorizedSpaces(organizationId, { query: scopedQuery.trim(), spaceIds: currentSpaces }, signal) });
  return <div className="space-y-4 p-4"><section className="border"><SectionHeading title="个人空间" /><div className="flex flex-wrap items-center gap-3 p-4"><Button disabled={personalMutation.isPending} onClick={() => personalMutation.mutate()}><PlusIcon data-icon="inline-start" />打开个人空间</Button>{personalSpace ? <span className="text-sm text-muted-foreground">个人空间已准备好：{personalSpace}</span> : null}</div><MutationFailure error={personalMutation.error} /></section><section className="border"><SectionHeading title="跨空间搜索" /><div className="space-y-3 p-4"><Input aria-label="跨空间搜索" onChange={(event) => setQuery(event.currentTarget.value)} placeholder="搜索已授权空间" value={scopedQuery} /><div className="flex flex-wrap gap-2">{access.spaces.map((space) => <label className="flex items-center gap-2 text-sm" key={space.spaceId}><input checked={currentSpaces.includes(space.spaceId)} onChange={(event) => setSelectedSpaceIds(event.currentTarget.checked ? [...currentSpaces, space.spaceId] : currentSpaces.filter((id) => id !== space.spaceId))} type="checkbox" />{space.spaceName}</label>)}</div><Button disabled={searchQuery.isFetching || scopedQuery.trim().length === 0 || currentSpaces.length === 0} onClick={() => void searchQuery.refetch()}><SearchIcon data-icon="inline-start" />搜索授权内容</Button>{searchQuery.data ? <div className="divide-y border">{searchQuery.data.results.map((result) => <button className="block w-full space-y-1 px-3 py-3 text-left hover:bg-muted/40" key={`${result.document.spaceId}:${result.document.notebookId}:${result.document.documentId}`} onClick={() => void navigate(spacePagePath({ organizationId: result.document.organizationId, spaceId: result.document.spaceId }), { state: spaceDocumentNavigationState({ documentId: result.document.documentId, notebookId: result.document.notebookId }) })} type="button"><p className="font-medium">{result.title}</p><p className="text-xs text-muted-foreground">{result.excerpt}</p><span className="text-xs text-muted-foreground">{classificationLabels[result.classification]} · {result.document.spaceId}</span></button>)}</div> : null}<MutationFailure error={searchQuery.error} /></div></section></div>;
}

export function GovernancePage() {
  const { organizationId = "" } = useParams();
  const access = useOutletContext<OrganizationManagementAccess>();
  const queryClient = useQueryClient();
  const { activeView, setActiveView, setOrganizationScope } = useGovernanceStore();
  useEffect(() => { if (organizationId.length > 0) setOrganizationScope(organizationId); }, [organizationId, setOrganizationScope]);
  const tabs = [{ id: "overview" as const, label: "总览" }, { id: "templates" as const, label: "模板" }, { id: "identity" as const, label: "身份安全" }, { id: "discovery" as const, label: "发现与个人空间" }];
  return <div className="flex min-h-0 flex-col"><PageHeader actions={<Button aria-label="刷新治理数据" onClick={() => { void queryClient.invalidateQueries({ queryKey: ["enterprise", organizationId] }); void queryClient.invalidateQueries({ queryKey: mfaFactorsQueryKey }); }} size="icon-sm" variant="outline"><RefreshCwIcon aria-hidden="true" /></Button>} description="统一管理治理策略、企业身份和授权内容发现" title="知识治理" /><nav aria-label="治理视图" className="flex gap-1 overflow-x-auto border-b px-3 py-2">{tabs.map((tab) => <Button aria-current={activeView === tab.id ? "page" : undefined} key={tab.id} onClick={() => setActiveView(tab.id)} size="sm" variant={activeView === tab.id ? "secondary" : "ghost"}>{tab.label}</Button>)}</nav><div className="min-h-0 flex-1 overflow-auto">{activeView === "overview" ? <OverviewView access={access} key={`${organizationId}:overview`} organizationId={organizationId} /> : activeView === "templates" ? <TemplatesView access={access} key={`${organizationId}:templates`} organizationId={organizationId} /> : activeView === "identity" ? <IdentityView key={`${organizationId}:identity`} organizationId={organizationId} /> : <DiscoveryView access={access} key={`${organizationId}:discovery`} organizationId={organizationId} />}</div></div>;
}
