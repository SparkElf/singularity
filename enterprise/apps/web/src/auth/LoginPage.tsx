import { loginRequestSchema, oidcStartRequestSchema } from "@singularity/contracts";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Building2Icon, OrbitIcon, RefreshCwIcon } from "lucide-react";
import { useLocation, useNavigate } from "react-router";

import {
  ApiProblemError,
  NetworkFailureError,
  isApiProblem,
} from "@/api/http.ts";
import { getOidcProviders, login, startOidc } from "@/auth/api.ts";
import { useCsrfStore } from "@/auth/csrf-store.ts";
import { SPACES_PATH, parseReturnTo } from "@/auth/return-to.ts";
import { clearClientSession } from "@/auth/session-state.ts";
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@/components/ui/alert.tsx";
import { Button } from "@/components/ui/button.tsx";
import {
  Field,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field.tsx";
import { Input } from "@/components/ui/input.tsx";
import { Separator } from "@/components/ui/separator.tsx";
import { Skeleton } from "@/components/ui/skeleton.tsx";
import { Spinner } from "@/components/ui/spinner.tsx";

interface LoginState {
  error: unknown;
  pending: boolean;
}

interface LoginCooldown {
  remainingSeconds: number;
  until: number;
}

const IDLE_LOGIN_STATE: LoginState = { error: null, pending: false };

function loginErrorMessage(error: unknown, cooldownSeconds: number): string {
  if (isApiProblem(error, "unauthenticated")) {
    return "账号或密码错误。";
  }

  if (isApiProblem(error, "rate-limited")) {
    return cooldownSeconds > 0
      ? `尝试次数过多，请在 ${cooldownSeconds} 秒后重试。`
      : "尝试次数过多，现在可以重试。";
  }

  if (error instanceof ApiProblemError) {
    return "登录信息未被接受，请检查后重试。";
  }

  if (error instanceof NetworkFailureError) {
    return "无法连接到服务，请稍后重试。";
  }

  return "登录失败，请稍后重试。";
}

export function LoginPage() {
  const location = useLocation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const setCsrfToken = useCsrfStore((state) => state.setCsrfToken);
  const [validationError, setValidationError] = useState(false);
  const [loginState, setLoginState] = useState<LoginState>(IDLE_LOGIN_STATE);
  const [cooldown, setCooldown] = useState<LoginCooldown | null>(null);
  const activeController = useRef<AbortController | null>(null);
  const attemptGeneration = useRef(0);
  const mounted = useRef(true);
  const cooldownSeconds = cooldown?.remainingSeconds ?? 0;
  const oidcProvidersQuery = useQuery({
    enabled: false,
    queryKey: ["oidc-login-providers"],
    queryFn: ({ signal }) => getOidcProviders(signal),
  });
  const oidcMutation = useMutation({
    mutationFn: (request: Parameters<typeof startOidc>[0]) =>
      startOidc(request),
    onSuccess: ({ authorizationUrl }) => {
      window.location.assign(authorizationUrl);
    },
  });
  const refetchOidcProviders = oidcProvidersQuery.refetch;

  useLayoutEffect(() => {
    clearClientSession(queryClient);
  }, [queryClient]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      attemptGeneration.current += 1;
      activeController.current?.abort();
      activeController.current = null;
    };
  }, []);

  useEffect(() => {
    void refetchOidcProviders();
  }, [refetchOidcProviders]);

  useEffect(() => {
    if (!cooldown) {
      return;
    }

    const timeout = window.setTimeout(() => {
      const remainingSeconds = Math.max(
        0,
        Math.ceil((cooldown.until - Date.now()) / 1_000),
      );
      setCooldown(
        remainingSeconds > 0
          ? { remainingSeconds, until: cooldown.until }
          : null,
      );
    }, Math.max(1, Math.min(1_000, cooldown.until - Date.now())));
    return () => window.clearTimeout(timeout);
  }, [cooldown]);

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    activeController.current?.abort();
    activeController.current = null;
    const generation = attemptGeneration.current + 1;
    attemptGeneration.current = generation;

    if (cooldownSeconds > 0) {
      return;
    }

    const formData = new FormData(event.currentTarget);
    const request = loginRequestSchema.safeParse({
      loginIdentifier: formData.get("loginIdentifier"),
      password: formData.get("password"),
    });

    if (!request.success) {
      setLoginState(IDLE_LOGIN_STATE);
      setValidationError(true);
      return;
    }

    const controller = new AbortController();
    activeController.current = controller;
    setValidationError(false);
    setLoginState({ error: null, pending: true });

    try {
      const { csrfToken } = await login(request.data, controller.signal);
      if (
        !mounted.current ||
        controller.signal.aborted ||
        generation !== attemptGeneration.current
      ) {
        return;
      }

      queryClient.removeQueries();
      setCsrfToken(csrfToken);
      const returnTo = parseReturnTo(location.search, window.location.origin);
      void navigate(returnTo ?? SPACES_PATH, { replace: true });
    } catch (error) {
      if (
        !mounted.current ||
        controller.signal.aborted ||
        generation !== attemptGeneration.current
      ) {
        return;
      }

      if (isApiProblem(error, "rate-limited")) {
        const retryAfterSeconds = error.retryAfterSeconds as number;
        setCooldown({
          remainingSeconds: retryAfterSeconds,
          until: Date.now() + retryAfterSeconds * 1_000,
        });
      }
      setLoginState({ error, pending: false });
    } finally {
      if (generation === attemptGeneration.current) {
        activeController.current = null;
      }
    }
  };

  const hasError = validationError || loginState.error !== null;
  const oidcProviders = oidcProvidersQuery.data?.providers ?? [];

  return (
    <main
      data-singularity-ui
      className="flex min-h-dvh items-center justify-center bg-muted/40 p-6 max-sm:bg-background max-sm:p-4"
    >
      <section className="w-full max-w-[400px] rounded-md border bg-card p-6 max-sm:border-0 max-sm:p-2">
        <div className="mb-6 flex min-w-0 items-center gap-2">
          <OrbitIcon aria-hidden="true" className="size-5 shrink-0" />
          <span className="truncate text-sm font-semibold">奇点</span>
        </div>

        <div className="mb-6 flex flex-col gap-1">
          <h1 className="text-xl font-semibold">登录奇点</h1>
          <p className="text-sm text-muted-foreground">进入你的企业知识空间</p>
        </div>

        <form
          className="flex flex-col gap-5"
          onInput={() => {
            setValidationError(false);
            if (cooldownSeconds === 0) {
              setLoginState((current) =>
                current.pending ? current : IDLE_LOGIN_STATE,
              );
            }
          }}
          onSubmit={(event) => void handleSubmit(event)}
        >
          <FieldGroup>
            <Field data-invalid={hasError || undefined}>
              <FieldLabel htmlFor="login-identifier">账号</FieldLabel>
              <Input
                autoComplete="username"
                className="h-9 max-sm:h-10"
                id="login-identifier"
                name="loginIdentifier"
                required
                aria-invalid={hasError || undefined}
              />
            </Field>
            <Field data-invalid={hasError || undefined}>
              <FieldLabel htmlFor="login-password">密码</FieldLabel>
              <Input
                autoComplete="current-password"
                className="h-9 max-sm:h-10"
                id="login-password"
                name="password"
                required
                type="password"
                aria-invalid={hasError || undefined}
              />
            </Field>
          </FieldGroup>

          <div className="min-h-16">
            {validationError || loginState.error !== null ? (
              <Alert variant="destructive">
                <AlertTitle>无法登录</AlertTitle>
                <AlertDescription>
                  {validationError
                    ? "请输入有效的账号和密码。"
                    : loginErrorMessage(loginState.error, cooldownSeconds)}
                </AlertDescription>
              </Alert>
            ) : null}
          </div>

          <Button
            className="w-full"
            disabled={cooldownSeconds > 0}
            type="submit"
          >
            {loginState.pending ? (
              <Spinner data-icon="inline-start" aria-label="正在登录" />
            ) : null}
            登录
          </Button>
        </form>

        <div className="my-5 flex items-center gap-3">
          <Separator className="flex-1" />
          <span className="text-xs text-muted-foreground">单点登录</span>
          <Separator className="flex-1" />
        </div>

        <div className="flex min-h-10 flex-col gap-2">
          {oidcProvidersQuery.isPending ? (
            <>
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
            </>
          ) : null}

          {oidcProvidersQuery.isError ? (
            <Alert variant="destructive">
              <AlertTitle>无法加载单点登录</AlertTitle>
              <AlertDescription className="flex items-center justify-between gap-2">
                <span>请检查网络连接后重试。</span>
                <Button
                  aria-label="重新加载单点登录"
                  onClick={() => void refetchOidcProviders()}
                  size="icon-sm"
                  variant="ghost"
                >
                  <RefreshCwIcon aria-hidden="true" />
                </Button>
              </AlertDescription>
            </Alert>
          ) : null}

          {oidcProvidersQuery.isSuccess && oidcProviders.length === 0 ? (
            <p className="py-2 text-center text-sm text-muted-foreground">
              当前没有可用的单点登录 Provider
            </p>
          ) : null}

          {oidcProviders.map((provider) => {
            const pending =
              oidcMutation.isPending &&
              oidcMutation.variables?.providerId === provider.providerId;
            return (
              <Button
                disabled={oidcMutation.isPending}
                key={provider.providerId}
                onClick={() => {
                  const returnTo =
                    parseReturnTo(location.search, window.location.origin) ??
                    SPACES_PATH;
                  const request = oidcStartRequestSchema.safeParse({
                    providerId: provider.providerId,
                    returnTo,
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

          {oidcMutation.isError ? (
            <Alert variant="destructive">
              <AlertTitle>无法开始单点登录</AlertTitle>
              <AlertDescription>
                {oidcMutation.error instanceof NetworkFailureError
                  ? "无法连接到服务，请稍后重试。"
                  : "Provider 未接受登录请求，请重试。"}
              </AlertDescription>
            </Alert>
          ) : null}
        </div>
      </section>
    </main>
  );
}
