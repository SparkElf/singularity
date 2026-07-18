import { useCallback, useState } from "react";
import {
  changeDocumentSharePasswordRequestSchema,
  createDocumentShareRequestSchema,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  type ChangeDocumentSharePasswordRequest,
  type ManagedDocumentShare,
} from "@singularity/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CheckIcon,
  ClipboardIcon,
  LinkIcon,
  SaveIcon,
  Trash2Icon,
} from "lucide-react";
import { useParams } from "react-router";

import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@/components/ui/alert.tsx";
import { Badge } from "@/components/ui/badge.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Input } from "@/components/ui/input.tsx";
import { Select } from "@/components/ui/select.tsx";
import { Spinner } from "@/components/ui/spinner.tsx";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table.tsx";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip.tsx";
import {
  ConfirmAction,
  EmptyTableRow,
  LoadingTableRows,
  MutationFailure,
  PageFailure,
  PageHeader,
  SectionHeading,
} from "@/enterprise/components.tsx";
import {
  changeSpaceSharePassword,
  createSpaceShare,
  getSpaceShares,
  revokeSpaceShare,
  spaceSharesQueryKey,
} from "@/enterprise/api.ts";
import { publicSharePagePath } from "@/shares/routes.ts";
import {
  ContentDirectory,
  type ContentDirectoryStatus,
} from "@/spaces/ContentDirectory.tsx";
import { useContentSelectionStore } from "@/spaces/content-selection.ts";

const createDocumentShareOptionsSchema = createDocumentShareRequestSchema.pick({
  expiresAt: true,
  password: true,
});

function formatDate(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function shareStatus(share: ManagedDocumentShare): {
  active: boolean;
  label: string;
  variant: "destructive" | "outline" | "secondary";
} {
  if (share.revokedAt !== null) {
    return { active: false, label: "已撤销", variant: "destructive" };
  }
  if (new Date(share.expiresAt).getTime() <= Date.now()) {
    return { active: false, label: "已过期", variant: "outline" };
  }
  return { active: true, label: "有效", variant: "secondary" };
}

interface SharePasswordFormProps {
  onSubmit: (shareId: string, request: ChangeDocumentSharePasswordRequest) => void;
  pending: boolean;
  share: ManagedDocumentShare;
}

function SharePasswordForm({ onSubmit, pending, share }: SharePasswordFormProps) {
  const [action, setAction] = useState<"remove" | "replace">("replace");
  const [validationError, setValidationError] = useState(false);

  return (
    <form
      className="flex min-w-[340px] items-center justify-end gap-2"
      onInput={() => setValidationError(false)}
      onSubmit={(event) => {
        event.preventDefault();
        const formData = new FormData(event.currentTarget);
        const request = changeDocumentSharePasswordRequestSchema.safeParse({
          password: action === "remove" ? null : formData.get("password"),
        });
        if (!request.success) {
          setValidationError(true);
          return;
        }
        onSubmit(share.shareId, request.data);
      }}
    >
      <label className="sr-only" htmlFor={`share-password-action-${share.shareId}`}>
        分享密码操作
      </label>
      <Select
        id={`share-password-action-${share.shareId}`}
        onChange={(event) => {
          setAction(event.currentTarget.value as typeof action);
          setValidationError(false);
        }}
        value={action}
      >
        <option value="replace">{share.hasPassword ? "替换密码" : "设置密码"}</option>
        <option value="remove">移除密码</option>
      </Select>
      {action === "replace" ? (
        <>
          <label className="sr-only" htmlFor={`share-password-${share.shareId}`}>
            新分享密码
          </label>
          <Input
            aria-invalid={validationError || undefined}
            className="w-44"
            id={`share-password-${share.shareId}`}
            name="password"
            placeholder={`${PASSWORD_MIN_LENGTH} 至 ${PASSWORD_MAX_LENGTH} 个字符`}
            required
            type="password"
          />
        </>
      ) : null}
      <Button disabled={pending} size="sm" type="submit" variant="outline">
        {pending ? (
          <Spinner data-icon="inline-start" aria-label="正在更新分享密码" />
        ) : (
          <SaveIcon data-icon="inline-start" />
        )}
        应用
      </Button>
      {validationError ? (
        <span className="text-xs text-destructive" role="alert">
          密码长度无效
        </span>
      ) : null}
    </form>
  );
}

interface SharesPageContentProps {
  organizationId: string;
  spaceId: string;
}

function SharesPageContent({
  organizationId,
  spaceId,
}: SharesPageContentProps) {
  const queryClient = useQueryClient();
  const [formError, setFormError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState(false);
  const [directoryStatus, setDirectoryStatus] =
    useState<ContentDirectoryStatus>("loading");
  const selection = useContentSelectionStore((state) =>
    state.selection?.spaceId === spaceId ? state.selection : null,
  );
  const sharesQuery = useQuery({
    queryKey: spaceSharesQueryKey(organizationId, spaceId),
    queryFn: ({ signal }) => getSpaceShares(organizationId, spaceId, signal),
  });
  const handleDirectoryAccessLost = useCallback(() => {
    void queryClient.invalidateQueries({
      queryKey: spaceSharesQueryKey(organizationId, spaceId),
    });
  }, [organizationId, queryClient, spaceId]);
  const invalidateShares = async () => {
    await queryClient.invalidateQueries({
      queryKey: spaceSharesQueryKey(organizationId, spaceId),
    });
  };
  const createShareMutation = useMutation({
    mutationFn: (request: Parameters<typeof createSpaceShare>[2]) =>
      createSpaceShare(organizationId, spaceId, request),
    onSuccess: async () => {
      setCopied(false);
      setCopyError(false);
      await invalidateShares();
    },
  });
  const changePasswordMutation = useMutation({
    mutationFn: (input: {
      request: Parameters<typeof changeSpaceSharePassword>[3];
      shareId: string;
    }) =>
      changeSpaceSharePassword(
        organizationId,
        spaceId,
        input.shareId,
        input.request,
      ),
    onSuccess: invalidateShares,
  });
  const revokeShareMutation = useMutation({
    mutationFn: (shareId: string) =>
      revokeSpaceShare(organizationId, spaceId, shareId),
    onSuccess: async (_, shareId) => {
      if (createShareMutation.data?.shareId === shareId) {
        createShareMutation.reset();
      }
      await invalidateShares();
    },
  });

  if (sharesQuery.error) {
    return (
      <PageFailure
        error={sharesQuery.error}
        onRetry={() => void sharesQuery.refetch()}
      />
    );
  }

  const shares = sharesQuery.data?.shares ?? [];
  const createdShareUrl = createShareMutation.data
    ? new URL(
        publicSharePagePath(createShareMutation.data.shareToken),
        window.location.origin,
      ).toString()
    : null;
  const mutationError =
    createShareMutation.error ??
    changePasswordMutation.error ??
    revokeShareMutation.error;

  const copyCreatedShareUrl = async () => {
    if (createdShareUrl === null) {
      return;
    }
    try {
      await navigator.clipboard.writeText(createdShareUrl);
      setCopied(true);
      setCopyError(false);
    } catch {
      setCopied(false);
      setCopyError(true);
    }
  };

  return (
    <div className="flex flex-col">
      <PageHeader description="实时只读文档分享与访问凭证" title="分享" />
      <MutationFailure error={mutationError} />

      <div className="grid min-h-80 grid-cols-[16rem_minmax(0,1fr)] border-b max-md:grid-cols-1">
        <div className="flex h-80 min-h-0 max-md:h-72">
          <ContentDirectory
            identity={{ organizationId, spaceId }}
            onAccessLost={handleDirectoryAccessLost}
            onStatusChange={setDirectoryStatus}
          />
        </div>
        <form
          className="grid content-start grid-cols-[minmax(220px,1fr)_140px_minmax(180px,1fr)_auto] items-end gap-3 bg-muted/25 p-3 max-xl:grid-cols-2 max-sm:grid-cols-1"
          onInput={() => setFormError(null)}
          onSubmit={(event) => {
            event.preventDefault();
            if (selection === null) {
              return;
            }
            const form = event.currentTarget;
            const formData = new FormData(form);
            const expiresInHours = Number(formData.get("expiresInHours"));
            const password = formData.get("password");
            const options = createDocumentShareOptionsSchema.safeParse({
              expiresAt: new Date(
                Date.now() + expiresInHours * 60 * 60 * 1_000,
              ).toISOString(),
              password: password === "" ? null : password,
            });
            if (!options.success) {
              setFormError("请输入有效的有效期和可选密码。");
              return;
            }
            createShareMutation.reset();
            createShareMutation.mutate(
              {
                documentId: selection.documentId,
                expiresAt: options.data.expiresAt,
                notebookId: selection.notebookId,
                password: options.data.password,
              },
              { onSuccess: () => form.reset() },
            );
          }}
        >
          <div className="flex min-w-0 flex-col gap-1 text-sm" aria-live="polite">
            <span className="font-medium">当前文档</span>
            <div className="flex min-h-14 min-w-0 flex-col justify-center rounded-md border bg-background px-3 py-2">
              {selection ? (
                <>
                  <code className="truncate text-xs" title={selection.documentId}>
                    {selection.documentId}
                  </code>
                  <span
                    className="truncate text-xs text-muted-foreground"
                    title={selection.notebookId}
                  >
                    笔记本 {selection.notebookId}
                  </span>
                </>
              ) : (
                <span className="text-sm text-muted-foreground">
                  {directoryStatus === "loading"
                    ? "正在加载文档目录"
                    : directoryStatus === "error"
                      ? "文档目录暂不可用"
                      : "未选择文档"}
                </span>
              )}
            </div>
          </div>
          <label className="flex min-w-0 flex-col gap-1 text-sm">
            <span className="font-medium">有效期</span>
            <Select defaultValue="168" name="expiresInHours">
              <option value="24">24 小时</option>
              <option value="72">3 天</option>
              <option value="168">7 天</option>
              <option value="720">30 天</option>
            </Select>
          </label>
          <label className="flex min-w-0 flex-col gap-1 text-sm">
            <span className="font-medium">访问密码（可选）</span>
            <Input
              name="password"
              placeholder="留空则无需密码"
              type="password"
            />
          </label>
          <Button
            disabled={selection === null || createShareMutation.isPending}
            type="submit"
          >
            {createShareMutation.isPending ? (
              <Spinner data-icon="inline-start" aria-label="正在创建分享" />
            ) : (
              <LinkIcon data-icon="inline-start" />
            )}
            创建分享
          </Button>
          {formError ? (
            <p className="col-span-full text-sm text-destructive" role="alert">
              {formError}
            </p>
          ) : null}
        </form>
      </div>

      {createdShareUrl ? (
        <Alert className="m-3">
          <CheckIcon aria-hidden="true" />
          <AlertTitle>分享已创建</AlertTitle>
          <AlertDescription className="flex min-w-0 items-center gap-2 max-sm:flex-col max-sm:items-stretch">
            <code className="min-w-0 flex-1 truncate rounded-sm bg-muted px-2 py-1">
              {createdShareUrl}
            </code>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  aria-label="复制分享地址"
                  onClick={() => void copyCreatedShareUrl()}
                  size="icon-sm"
                  variant="outline"
                >
                  {copied ? (
                    <CheckIcon aria-hidden="true" />
                  ) : (
                    <ClipboardIcon aria-hidden="true" />
                  )}
                </Button>
              </TooltipTrigger>
              <TooltipContent>{copied ? "已复制" : "复制分享地址"}</TooltipContent>
            </Tooltip>
          </AlertDescription>
          <p className="text-xs text-muted-foreground">访问令牌只在本次创建后显示。</p>
          {copyError ? (
            <p className="text-sm text-destructive" role="alert">
              无法写入剪贴板。
            </p>
          ) : null}
        </Alert>
      ) : null}

      <section>
        <SectionHeading count={shares.length} title="全部分享" />
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>文档</TableHead>
              <TableHead>创建时间</TableHead>
              <TableHead>到期时间</TableHead>
              <TableHead>状态</TableHead>
              <TableHead>密码</TableHead>
              <TableHead className="min-w-[430px] text-right">操作</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {sharesQuery.isPending ? (
              <LoadingTableRows columns={6} />
            ) : shares.length === 0 ? (
              <EmptyTableRow columns={6} label="暂无文档分享" />
            ) : (
              shares.map((share) => {
                const status = shareStatus(share);
                const changingPassword =
                  changePasswordMutation.isPending &&
                  changePasswordMutation.variables?.shareId === share.shareId;
                const revoking =
                  revokeShareMutation.isPending &&
                  revokeShareMutation.variables === share.shareId;
                return (
                  <TableRow key={share.shareId}>
                    <TableCell>
                      <div className="flex min-w-48 flex-col">
                        <code className="text-xs">{share.documentId}</code>
                        <span className="text-xs text-muted-foreground">
                          笔记本 {share.notebookId}
                        </span>
                      </div>
                    </TableCell>
                    <TableCell>{formatDate(share.createdAt)}</TableCell>
                    <TableCell>{formatDate(share.expiresAt)}</TableCell>
                    <TableCell>
                      <Badge variant={status.variant}>{status.label}</Badge>
                    </TableCell>
                    <TableCell>{share.hasPassword ? "已设置" : "无密码"}</TableCell>
                    <TableCell>
                      {status.active ? (
                        <div className="flex items-center justify-end gap-2">
                          <SharePasswordForm
                            onSubmit={(shareId, request) =>
                              changePasswordMutation.mutate({ request, shareId })
                            }
                            pending={changingPassword}
                            share={share}
                          />
                          <ConfirmAction
                            confirmLabel="撤销分享"
                            description="撤销后链接和已有密码挑战将立即失效。"
                            disabled={revoking}
                            onConfirm={() => revokeShareMutation.mutate(share.shareId)}
                            title="撤销这个分享？"
                          >
                            <Button
                              aria-label={`撤销文档 ${share.documentId} 的分享`}
                              disabled={revoking}
                              size="icon-sm"
                              variant="ghost"
                            >
                              {revoking ? (
                                <Spinner aria-label="正在撤销分享" />
                              ) : (
                                <Trash2Icon aria-hidden="true" />
                              )}
                            </Button>
                          </ConfirmAction>
                        </div>
                      ) : (
                        <span className="block text-right text-xs text-muted-foreground">
                          无可用操作
                        </span>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
      </section>
    </div>
  );
}

export function SharesPage() {
  const parameters = useParams();
  const organizationId = parameters.organizationId ?? "";
  const spaceId = parameters.spaceId ?? "";

  return (
    <SharesPageContent
      key={`${organizationId}:${spaceId}`}
      organizationId={organizationId}
      spaceId={spaceId}
    />
  );
}
