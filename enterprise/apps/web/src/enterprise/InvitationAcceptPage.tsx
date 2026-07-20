import { useEffect, useRef, useState } from "react";
import {
  acceptLocalOrganizationInvitationRequestSchema,
  invitationTokenSchema,
  oidcStartRequestSchema,
} from "@singularity/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Building2Icon,
  CheckIcon,
  KeyRoundIcon,
  OrbitIcon,
  UserCheckIcon,
} from "lucide-react";
import { Link, useLocation, useNavigate, useSearchParams } from "react-router";

import { isApiProblem } from "@/api/http.ts";
import {
  acceptLocalOrganizationInvitation,
  acceptOrganizationInvitation,
  getOrFetchCsrfToken,
  getOidcProviders,
  startOidc,
} from "@/auth/api.ts";
import { useCsrfStore } from "@/auth/csrf-store.ts";
import { SPACES_PATH, locationTarget, loginPath } from "@/auth/return-to.ts";
import { clearClientSession } from "@/auth/session-state.ts";
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@/components/ui/alert.tsx";
import { Button } from "@/components/ui/button.tsx";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty.tsx";
import { Input } from "@/components/ui/input.tsx";
import { Separator } from "@/components/ui/separator.tsx";
import { Skeleton } from "@/components/ui/skeleton.tsx";
import { Spinner } from "@/components/ui/spinner.tsx";
import { errorMessage } from "@/enterprise/components.tsx";

interface AccountAction {
  readonly controller: AbortController;
  readonly generation: number;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

export function InvitationAcceptPage() {
  const location = useLocation();
  const navigate = useNavigate();
  const [searchParameters] = useSearchParams();
  const queryClient = useQueryClient();
  const setCsrfToken = useCsrfStore((state) => state.setCsrfToken);
  const [passwordError, setPasswordError] = useState(false);
  const [accepted, setAccepted] = useState(false);
  const accountActionRef = useRef<AccountAction | null>(null);
  const accountGenerationRef = useRef(0);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      accountGenerationRef.current += 1;
      accountActionRef.current?.controller.abort();
      accountActionRef.current = null;
    };
  }, []);
  const beginAccountAction = (): AccountAction => {
    accountActionRef.current?.controller.abort();
    const action = {
      controller: new AbortController(),
      generation: accountGenerationRef.current + 1,
    };
    accountGenerationRef.current = action.generation;
    accountActionRef.current = action;
    return action;
  };
  const isCurrentAccountAction = (action: AccountAction): boolean =>
    mountedRef.current &&
    !action.controller.signal.aborted &&
    accountActionRef.current === action &&
    accountGenerationRef.current === action.generation;
  const token = invitationTokenSchema.safeParse(searchParameters.get("token"));
  const providersQuery = useQuery({
    enabled: token.success,
    queryKey: ["oidc-login-providers"],
    queryFn: ({ signal }) => getOidcProviders(signal),
  });
  const finish = (csrfToken?: string) => {
    // 只有仍属于当前会话代次的动作才能进入成功态并切换空间列表。
    setAccepted(true);
    queryClient.clear();
    if (csrfToken !== undefined) {
      setCsrfToken(csrfToken);
    }
    void navigate(SPACES_PATH, { replace: true });
  };
  const currentAccountMutation = useMutation({
    mutationFn: async (invitationToken: string) => {
      const action = beginAccountAction();
      const csrfToken = await getOrFetchCsrfToken(action.controller.signal);
      const revision = useCsrfStore.getState().csrfRevision;
      try {
        await acceptOrganizationInvitation(
          { invitationToken },
          csrfToken,
          action.controller.signal,
        );
      } catch (error) {
        if (
          isCurrentAccountAction(action) &&
          isApiProblem(error, "unauthenticated") &&
          useCsrfStore.getState().csrfRevision === revision
        ) {
          clearClientSession(queryClient);
        }
        throw error;
      }
      return { action, revision };
    },
    onSuccess: ({ action, revision }) => {
      if (
        isCurrentAccountAction(action) &&
        useCsrfStore.getState().csrfRevision === revision
      ) {
        finish();
      }
    },
  });
  const localAccountMutation = useMutation({
    mutationFn: async (
      request: Parameters<typeof acceptLocalOrganizationInvitation>[0],
    ) => {
      const action = beginAccountAction();
      const revision = useCsrfStore.getState().csrfRevision;
      const result = await acceptLocalOrganizationInvitation(
        request,
        action.controller.signal,
      );
      return { action, result, revision };
    },
    onSuccess: ({ action, result, revision }) => {
      if (
        isCurrentAccountAction(action) &&
        useCsrfStore.getState().csrfRevision === revision
      ) {
        finish(result.csrfToken);
      }
    },
  });
  const oidcMutation = useMutation({
    mutationFn: async (request: Parameters<typeof startOidc>[0]) => {
      const action = beginAccountAction();
      const revision = useCsrfStore.getState().csrfRevision;
      const result = await startOidc(request, action.controller.signal);
      return { action, result, revision };
    },
    onSuccess: ({ action, result, revision }) => {
      if (
        isCurrentAccountAction(action) &&
        useCsrfStore.getState().csrfRevision === revision
      ) {
        window.location.assign(result.authorizationUrl);
      }
    },
  });

  if (!token.success) {
    return (
      <main data-singularity-ui className="flex min-h-dvh items-center justify-center p-4">
        <Empty className="min-h-72 w-full max-w-lg rounded-md border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <KeyRoundIcon aria-hidden="true" />
            </EmptyMedia>
            <EmptyTitle>
              <h1>邀请令牌无效</h1>
            </EmptyTitle>
            <EmptyDescription>请使用完整的成员邀请链接。</EmptyDescription>
          </EmptyHeader>
        </Empty>
      </main>
    );
  }

  const invitationToken = token.data;
  const providers = providersQuery.data?.providers ?? [];
  const accountErrors = [
    currentAccountMutation.error,
    localAccountMutation.error,
    oidcMutation.error,
  ];
  const accountError =
    accountErrors.find((error) => isApiProblem(error, "unauthenticated")) ??
    accountErrors.find(
      (error) => error !== null && !isAbortError(error),
    ) ??
    null;
  const accountActionPending =
    currentAccountMutation.isPending ||
    localAccountMutation.isPending ||
    oidcMutation.isPending;
  return (
    <main
      data-singularity-ui
      className="flex min-h-dvh items-center justify-center bg-muted/40 p-6 max-sm:bg-background max-sm:p-4"
    >
      <section className="w-full max-w-[440px] rounded-md border bg-card p-6 max-sm:border-0 max-sm:p-2">
        <div className="mb-6 flex min-w-0 items-center gap-2">
          <OrbitIcon aria-hidden="true" className="size-5 shrink-0" />
          <span className="truncate text-sm font-semibold">奇点</span>
        </div>
        <div className="mb-5 flex flex-col gap-1">
          <h1 className="text-xl font-semibold">接受组织邀请</h1>
          <p className="text-sm text-muted-foreground">选择账号登录方式</p>
        </div>

        {accepted ? (
          <Alert>
            <CheckIcon aria-hidden="true" />
            <AlertTitle>邀请已接受</AlertTitle>
            <AlertDescription>正在进入知识空间。</AlertDescription>
          </Alert>
        ) : null}

        {accountError !== null ? (
          <Alert className="mb-4" variant="destructive">
            <AlertTitle>无法接受邀请</AlertTitle>
            <AlertDescription>
              {errorMessage(accountError)}
            </AlertDescription>
          </Alert>
        ) : null}

        <Button
          className="w-full"
          disabled={accountActionPending}
          onClick={() => currentAccountMutation.mutate(invitationToken)}
          variant="outline"
        >
          {currentAccountMutation.isPending ? (
            <Spinner data-icon="inline-start" aria-label="正在接受邀请" />
          ) : (
            <UserCheckIcon data-icon="inline-start" />
          )}
          使用当前账号
        </Button>
        {isApiProblem(currentAccountMutation.error, "unauthenticated") ? (
          <Button asChild className="mt-2 w-full" variant="link">
            <Link to={loginPath(locationTarget(location))}>登录已有账号</Link>
          </Button>
        ) : null}

        <div className="my-5 flex items-center gap-3">
          <Separator className="flex-1" />
          <span className="text-xs text-muted-foreground">创建本地账号</span>
          <Separator className="flex-1" />
        </div>

        <form
          className="flex flex-col gap-3"
          onInput={() => setPasswordError(false)}
          onSubmit={(event) => {
            event.preventDefault();
            const form = event.currentTarget;
            const formData = new FormData(form);
            const password = formData.get("password");
            const confirmation = formData.get("passwordConfirmation");
            const request = acceptLocalOrganizationInvitationRequestSchema.safeParse({
              invitationToken,
              password,
            });
            if (!request.success || password !== confirmation) {
              setPasswordError(true);
              return;
            }
            localAccountMutation.mutate(request.data);
          }}
        >
          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium">密码</span>
            <Input
              aria-invalid={passwordError || undefined}
              autoComplete="new-password"
              name="password"
              required
              type="password"
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium">确认密码</span>
            <Input
              aria-invalid={passwordError || undefined}
              autoComplete="new-password"
              name="passwordConfirmation"
              required
              type="password"
            />
          </label>
          {passwordError ? (
            <p className="text-sm text-destructive" role="alert">
              密码至少 12 个字符，且两次输入必须一致。
            </p>
          ) : null}
          <Button disabled={accountActionPending} type="submit">
            {localAccountMutation.isPending ? (
              <Spinner data-icon="inline-start" aria-label="正在创建账号" />
            ) : (
              <UserCheckIcon data-icon="inline-start" />
            )}
            创建并接受邀请
          </Button>
        </form>

        <div className="my-5 flex items-center gap-3">
          <Separator className="flex-1" />
          <span className="text-xs text-muted-foreground">单点登录</span>
          <Separator className="flex-1" />
        </div>

        <div className="flex min-h-10 flex-col gap-2">
          {providersQuery.isPending ? <Skeleton className="h-10 w-full" /> : null}
          {providersQuery.isError ? (
            <Alert variant="destructive">
              <AlertTitle>无法加载单点登录</AlertTitle>
              <AlertDescription>请检查网络连接后重试。</AlertDescription>
            </Alert>
          ) : null}
          {providersQuery.isSuccess && providers.length === 0 ? (
            <p className="py-2 text-center text-sm text-muted-foreground">
              当前没有可用的单点登录 Provider
            </p>
          ) : null}
          {providers.map((provider) => {
            const pending =
              oidcMutation.isPending &&
              oidcMutation.variables?.providerId === provider.providerId;
            return (
              <Button
                disabled={accountActionPending}
                key={provider.providerId}
                onClick={() => {
                  const request = oidcStartRequestSchema.safeParse({
                    invitationToken,
                    providerId: provider.providerId,
                    returnTo: SPACES_PATH,
                  });
                  if (request.success) {
                    oidcMutation.mutate(request.data);
                  }
                }}
                variant="outline"
              >
                {pending ? (
                  <Spinner data-icon="inline-start" aria-label="正在前往单点登录" />
                ) : (
                  <Building2Icon data-icon="inline-start" />
                )}
                {provider.name}
              </Button>
            );
          })}
        </div>
      </section>
    </main>
  );
}
