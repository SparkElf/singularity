import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  createShareChallengeRequestSchema,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  shareTokenSchema,
  type SharedAssetDescriptor,
  type SharedDocumentPayload,
} from "@singularity/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertCircleIcon,
  CheckCircle2Icon,
  KeyRoundIcon,
  LinkIcon,
  RefreshCwIcon,
  SearchXIcon,
  ShieldAlertIcon,
} from "lucide-react";
import { useParams } from "react-router";

import { ApiProblemError, isApiProblem } from "@/api/http.ts";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty.tsx";
import { Badge } from "@/components/ui/badge.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Input } from "@/components/ui/input.tsx";
import { Spinner } from "@/components/ui/spinner.tsx";
import {
  createPublicShareChallenge,
  getPublicShare,
  publicShareAssetPath,
  publicShareQueryKey,
} from "@/shares/api.ts";

const BLOCKED_ELEMENTS = new Set([
  "base",
  "button",
  "canvas",
  "embed",
  "frame",
  "frameset",
  "form",
  "head",
  "html",
  "iframe",
  "input",
  "link",
  "math",
  "meta",
  "object",
  "portal",
  "script",
  "select",
  "style",
  "svg",
  "textarea",
  "template",
  "title",
]);

const ALLOWED_ATTRIBUTES = new Set([
  "alt",
  "checked",
  "class",
  "colspan",
  "controls",
  "datetime",
  "height",
  "loading",
  "loop",
  "muted",
  "name",
  "open",
  "poster",
  "rel",
  "role",
  "rowspan",
  "start",
  "title",
  "type",
  "width",
]);

const CUSTOM_ASSET_PREFIX = "singularity-share-asset:";
const SAFE_EXTERNAL_PROTOCOLS = new Set(["http:", "https:", "mailto:"]);

function assetIdFromUrl(value: string, shareToken: string): string | null {
  if (value.startsWith(CUSTOM_ASSET_PREFIX)) {
    const assetId = value.slice(CUSTOM_ASSET_PREFIX.length);
    return /^[a-f0-9]{64}$/.test(assetId) ? assetId : null;
  }
  const assetPathPrefix = publicShareAssetPath(shareToken, "");
  if (!value.startsWith(assetPathPrefix)) {
    return null;
  }
  const assetId = value.slice(assetPathPrefix.length);
  return /^[a-f0-9]{64}$/.test(assetId) ? assetId : null;
}

function isSafeExternalUrl(value: string): boolean {
  if (value.startsWith("#")) {
    return true;
  }
  try {
    const url = new URL(value, window.location.origin);
    if (!SAFE_EXTERNAL_PROTOCOLS.has(url.protocol)) {
      return false;
    }
    if (url.protocol === "mailto:") {
      return true;
    }
    return (
      url.origin !== window.location.origin &&
      url.username.length === 0 &&
      url.password.length === 0
    );
  } catch {
    return false;
  }
}

function sanitizeSharedElement(
  element: Element,
  shareToken: string,
  assets: ReadonlyMap<string, SharedAssetDescriptor>,
): void {
  const tagName = element.tagName.toLowerCase();
  if (BLOCKED_ELEMENTS.has(tagName)) {
    element.remove();
    return;
  }

  for (const attribute of [...element.attributes]) {
    const name = attribute.name.toLowerCase();
    const value = attribute.value.trim();
    if (
      name.startsWith("on") ||
      name === "style" ||
      name === "srcset" ||
      name === "target"
    ) {
      element.removeAttribute(attribute.name);
      continue;
    }
    if (name === "href" || name === "src" || name === "poster") {
      const assetId = assetIdFromUrl(value, shareToken);
      if (assetId !== null) {
        const descriptor = assets.get(assetId);
        if (descriptor === undefined) {
          element.removeAttribute(attribute.name);
          continue;
        }
        if (descriptor.disposition === "attachment" && name !== "href") {
          element.removeAttribute(attribute.name);
          continue;
        }
        element.setAttribute(
          attribute.name,
          publicShareAssetPath(shareToken, assetId),
        );
        if (name === "href" && descriptor.disposition === "attachment") {
          element.setAttribute("download", descriptor.fileName);
        }
        continue;
      }
      if (name === "href" && isSafeExternalUrl(value)) {
        element.setAttribute("rel", "noreferrer noopener");
        continue;
      }
      element.removeAttribute(attribute.name);
      continue;
    }
    if (
      !ALLOWED_ATTRIBUTES.has(name) &&
      !name.startsWith("aria-")
    ) {
      element.removeAttribute(attribute.name);
    }
  }

  for (const child of [...element.children]) {
    sanitizeSharedElement(child, shareToken, assets);
  }
}

function sanitizeSharedHtml(
  html: string,
  shareToken: string,
  descriptors: readonly SharedAssetDescriptor[],
): string {
  const template = document.createElement("template");
  template.innerHTML = html;
  const assets = new Map(
    descriptors.map((descriptor) => [descriptor.assetId, descriptor]),
  );
  for (const child of [...template.content.children]) {
    sanitizeSharedElement(child, shareToken, assets);
  }
  return template.innerHTML;
}

function ShareState({
  action,
  description,
  icon: Icon,
  title,
}: {
  action?: ReactNode;
  description: string;
  icon: typeof AlertCircleIcon;
  title: string;
}) {
  return (
    <main
      data-singularity-ui
      className="flex min-h-dvh items-center justify-center bg-background p-4"
    >
      <Empty className="w-full max-w-lg rounded-md border">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <Icon aria-hidden="true" />
          </EmptyMedia>
          <EmptyTitle>
            <h1>{title}</h1>
          </EmptyTitle>
          <EmptyDescription>{description}</EmptyDescription>
        </EmptyHeader>
        {action ? <EmptyContent>{action}</EmptyContent> : null}
      </Empty>
    </main>
  );
}

function challengeErrorMessage(
  error: unknown,
  cooldownSeconds: number,
): string | null {
  if (!(error instanceof ApiProblemError)) {
    return error === null || error === undefined
      ? null
      : "分享验证未完成，请稍后重试。";
  }
  switch (error.problem.code) {
    case "unauthenticated":
      return "密码不正确，或访问挑战已经失效。";
    case "rate-limited":
      return cooldownSeconds > 0
        ? "请求过于频繁，请 " + cooldownSeconds + " 秒后重试。"
        : "请求过于频繁，请稍后重试。";
    case "not-found":
      return "分享不存在或已经失效。";
    case "service-unavailable":
      return "分享服务当前不可用，请稍后重试。";
    default:
      return "分享验证未完成，请检查输入后重试。";
  }
}

function ChallengeForm({
  error,
  onSubmit,
  pending,
  cooldownSeconds,
}: {
  error: unknown;
  onSubmit: (password: string) => void;
  pending: boolean;
  cooldownSeconds: number;
}) {
  const [password, setPassword] = useState("");
  const [validationError, setValidationError] = useState(false);
  const errorText = challengeErrorMessage(error, cooldownSeconds);
  const disabled = pending || cooldownSeconds > 0;

  return (
    <main
      data-singularity-ui
      className="flex min-h-dvh items-center justify-center bg-background p-4"
    >
      <section className="w-full max-w-md rounded-md border bg-card p-5 shadow-sm">
        <div className="flex items-start gap-3">
          <ShieldAlertIcon
            aria-hidden="true"
            className="mt-0.5 size-5 shrink-0 text-muted-foreground"
          />
          <div className="min-w-0">
            <h1 className="text-lg font-semibold">此分享需要密码</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              输入分享密码后才能读取当前文档。
            </p>
          </div>
        </div>
        <form
          className="mt-5 flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            const request = createShareChallengeRequestSchema.safeParse({
              password,
            });
            if (!request.success) {
              setValidationError(true);
              return;
            }
            setValidationError(false);
            onSubmit(request.data.password);
          }}
        >
          <label
            className="flex flex-col gap-1 text-sm"
            htmlFor="share-password"
          >
            <span className="font-medium">分享密码</span>
            <Input
              aria-describedby="share-password-help"
              aria-invalid={validationError || undefined}
              autoComplete="off"
              disabled={disabled}
              id="share-password"
              maxLength={PASSWORD_MAX_LENGTH}
              minLength={PASSWORD_MIN_LENGTH}
              onChange={(event) => {
                setPassword(event.currentTarget.value);
                setValidationError(false);
              }}
              required
              type="password"
              value={password}
            />
          </label>
          <p className="text-xs text-muted-foreground" id="share-password-help">
            密码长度为 {PASSWORD_MIN_LENGTH} 至 {PASSWORD_MAX_LENGTH} 个字符。
          </p>
          {validationError ? (
            <p className="text-sm text-destructive" role="alert">
              请输入有效的分享密码。
            </p>
          ) : null}
          {errorText ? (
            <p className="text-sm text-destructive" role="alert">
              {errorText}
            </p>
          ) : null}
          <Button disabled={disabled} type="submit">
            {pending ? (
              <Spinner
                aria-label="正在验证分享密码"
                data-icon="inline-start"
              />
            ) : (
              <KeyRoundIcon
                aria-hidden="true"
                data-icon="inline-start"
              />
            )}
            {cooldownSeconds > 0
              ? cooldownSeconds + " 秒后重试"
              : "验证并打开"}
          </Button>
        </form>
      </section>
    </main>
  );
}

function SharedDocument({
  payload,
  shareToken,
}: {
  payload: SharedDocumentPayload;
  shareToken: string;
}) {
  const html = useMemo(
    () => sanitizeSharedHtml(payload.html, shareToken, payload.assets),
    [payload.assets, payload.html, shareToken],
  );

  useEffect(() => {
    const previousTitle = document.title;
    document.title =
      payload.title === "" ? "分享 · 奇点" : payload.title + " · 奇点";
    return () => {
      document.title = previousTitle;
    };
  }, [payload.title]);

  return (
    <main data-singularity-ui className="min-h-dvh bg-background">
      <header className="border-b bg-card px-4 py-5 sm:px-8">
        <div className="mx-auto flex max-w-4xl items-center gap-2 text-xs text-muted-foreground">
          <LinkIcon aria-hidden="true" className="size-3.5" />
          <span>奇点只读分享</span>
          <Badge className="ml-auto" variant="outline">
            只读
          </Badge>
        </div>
        <div className="mx-auto mt-3 max-w-4xl">
          <h1 className="break-words text-2xl font-semibold sm:text-3xl">
            {payload.title || "无标题文档"}
          </h1>
          <p className="mt-2 text-xs text-muted-foreground">
            文档内容会随原空间更新；此页面不提供编辑权限。
          </p>
        </div>
      </header>
      <article
        className="mx-auto max-w-4xl overflow-x-auto px-4 py-8 text-[15px] leading-7 sm:px-8 [&_a]:text-primary [&_a]:underline [&_a]:underline-offset-2 [&_blockquote]:border-l-2 [&_blockquote]:border-border [&_blockquote]:pl-4 [&_code]:rounded-sm [&_code]:bg-muted [&_code]:px-1 [&_code]:py-0.5 [&_h1]:mt-7 [&_h1]:text-2xl [&_h1]:font-semibold [&_h2]:mt-6 [&_h2]:text-xl [&_h2]:font-semibold [&_h3]:mt-5 [&_h3]:text-lg [&_h3]:font-semibold [&_img]:max-h-[70vh] [&_img]:max-w-full [&_img]:object-contain [&_li]:ml-6 [&_li]:list-disc [&_ol]:my-3 [&_p]:my-3 [&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:bg-muted [&_pre]:p-3 [&_table]:w-full [&_table]:border-collapse [&_td]:border [&_td]:p-2 [&_th]:border [&_th]:bg-muted [&_th]:p-2 [&_ul]:my-3"
        dangerouslySetInnerHTML={{ __html: html }}
      />
      <footer className="border-t px-4 py-4 text-center text-xs text-muted-foreground sm:px-8">
        <span className="inline-flex items-center gap-1.5">
          <CheckCircle2Icon aria-hidden="true" className="size-3.5" />
          分享内容已通过只读访问校验
        </span>
      </footer>
    </main>
  );
}

function PublicSharePageContent({ routeToken }: { routeToken: string }) {
  const tokenResult = shareTokenSchema.safeParse(routeToken);
  const shareToken = tokenResult.success ? tokenResult.data : null;
  const queryClient = useQueryClient();
  const [cooldownSeconds, setCooldownSeconds] = useState(0);
  const shareQuery = useQuery({
    gcTime: 0,
    enabled: shareToken !== null,
    queryKey: publicShareQueryKey(shareToken ?? ""),
    queryFn: ({ signal }) => getPublicShare(shareToken as string, signal),
    refetchOnMount: "always",
    staleTime: 0,
  });
  const challengeMutation = useMutation({
    mutationFn: (password: string) =>
      createPublicShareChallenge(shareToken as string, { password }),
    onError: (error) => {
      if (error instanceof ApiProblemError && error.retryAfterSeconds !== null) {
        setCooldownSeconds(error.retryAfterSeconds);
      }
    },
    onSuccess: async () => {
      setCooldownSeconds(0);
      await queryClient.invalidateQueries({
        queryKey: publicShareQueryKey(shareToken as string),
      });
    },
  });

  useEffect(() => {
    if (cooldownSeconds <= 0) {
      return;
    }
    const timer = window.setInterval(() => {
      setCooldownSeconds((current) => (current <= 1 ? 0 : current - 1));
    }, 1_000);
    return () => window.clearInterval(timer);
  }, [cooldownSeconds]);

  if (shareToken === null) {
    return (
      <ShareState
        description="分享地址格式不正确，请向分享创建者索取新的链接。"
        icon={SearchXIcon}
        title="分享地址无效"
      />
    );
  }

  if (shareQuery.isPending || shareQuery.isFetching) {
    return (
      <ShareState
        description="正在验证分享状态并读取文档。"
        icon={RefreshCwIcon}
        title="正在打开分享"
      />
    );
  }

  if (isApiProblem(shareQuery.error, "unauthenticated")) {
    return (
      <ChallengeForm
        cooldownSeconds={cooldownSeconds}
        error={challengeMutation.error}
        onSubmit={(password) => challengeMutation.mutate(password)}
        pending={challengeMutation.isPending}
      />
    );
  }

  if (isApiProblem(shareQuery.error, "not-found")) {
    return (
      <ShareState
        description="链接可能已过期、已撤销，或原文档已不再属于该空间。"
        icon={SearchXIcon}
        title="分享不存在或已失效"
      />
    );
  }

  if (shareQuery.error) {
    return (
      <ShareState
        action={
          <Button
            disabled={shareQuery.isFetching}
            onClick={() => void shareQuery.refetch()}
            variant="outline"
          >
            <RefreshCwIcon data-icon="inline-start" />
            重新加载
          </Button>
        }
        description="分享服务暂时不可用，请稍后重试。"
        icon={AlertCircleIcon}
        title="无法打开分享"
      />
    );
  }

  return <SharedDocument payload={shareQuery.data} shareToken={shareToken} />;
}

export function PublicSharePage() {
  const { shareToken = "" } = useParams();

  return <PublicSharePageContent key={shareToken} routeToken={shareToken} />;
}
