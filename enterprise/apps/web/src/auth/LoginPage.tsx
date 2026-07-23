import { loginRequestSchema, oidcStartRequestSchema } from "@singularity/contracts";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Building2Icon, OrbitIcon, RefreshCwIcon } from "lucide-react";
import { useLocation, useNavigate } from "react-router";

import {
  ApiProblemError,
  NetworkFailureError,
  isApiProblem,
} from "@/api/http.ts";
import { getOidcProviders, login, startOidc, verifyMfaChallenge } from "@/auth/api.ts";
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

interface OidcState {
  error: unknown;
  pendingProviderId: string | null;
}

interface MfaChallengeState {
  readonly challengeToken: string;
  readonly expiresAt: string;
}

interface MfaVerificationState {
  readonly error: unknown;
  readonly pending: boolean;
}

const IDLE_LOGIN_STATE: LoginState = { error: null, pending: false };
const IDLE_OIDC_STATE: OidcState = {
  error: null,
  pendingProviderId: null,
};
const IDLE_MFA_STATE: MfaVerificationState = { error: null, pending: false };

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
  const [oidcState, setOidcState] = useState<OidcState>(IDLE_OIDC_STATE);
  const [mfaChallenge, setMfaChallenge] = useState<MfaChallengeState | null>(null);
  const [mfaCode, setMfaCode] = useState("");
  const [mfaState, setMfaState] = useState<MfaVerificationState>(IDLE_MFA_STATE);
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
    setOidcState(IDLE_OIDC_STATE);

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
      const loginResult = await login(request.data, controller.signal);
      if (
        !mounted.current ||
        controller.signal.aborted ||
        generation !== attemptGeneration.current
      ) {
        return;
      }

      if ("challengeToken" in loginResult) {
        setMfaChallenge(loginResult);
        setMfaCode("");
        setMfaState(IDLE_MFA_STATE);
        setLoginState(IDLE_LOGIN_STATE);
      } else {
        queryClient.removeQueries();
        setCsrfToken(loginResult.csrfToken);
        const returnTo = parseReturnTo(location.search, window.location.origin);
        void navigate(returnTo ?? SPACES_PATH, { replace: true });
      }
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

  // MFA challenge 只允许一次成功消费；验证通过后复用普通登录的会话落地和返回地址逻辑。
  const handleMfaSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (mfaChallenge === null || !/^\d{6}$/.test(mfaCode)) {
      setMfaState({ error: new Error("请输入 6 位验证码"), pending: false });
      return;
    }
    activeController.current?.abort();
    const controller = new AbortController();
    const generation = attemptGeneration.current + 1;
    attemptGeneration.current = generation;
    activeController.current = controller;
    setMfaState({ error: null, pending: true });
    try {
      const result = await verifyMfaChallenge(
        { challengeToken: mfaChallenge.challengeToken, code: mfaCode },
        controller.signal,
      );
      if (!mounted.current || controller.signal.aborted || generation !== attemptGeneration.current) {
        return;
      }
      queryClient.removeQueries();
      setCsrfToken(result.csrfToken);
      const returnTo = parseReturnTo(location.search, window.location.origin);
      void navigate(returnTo ?? SPACES_PATH, { replace: true });
    } catch (error) {
      if (mounted.current && !controller.signal.aborted && generation === attemptGeneration.current) {
        console.error("[auth.mfa.challenge]", { error, result: "verification-failed" });
        setMfaState({ error, pending: false });
      }
    } finally {
      if (generation === attemptGeneration.current) {
        activeController.current = null;
      }
    }
  };

  const handleOidcStart = async (
    request: Parameters<typeof startOidc>[0],
  ): Promise<void> => {
    activeController.current?.abort();
    const controller = new AbortController();
    const generation = attemptGeneration.current + 1;
    attemptGeneration.current = generation;
    activeController.current = controller;
    setValidationError(false);
    setLoginState(IDLE_LOGIN_STATE);
    setOidcState({ error: null, pendingProviderId: request.providerId });

    let authorizationUrl: string;
    try {
      ({ authorizationUrl } = await startOidc(request, controller.signal));
    } catch (error) {
      if (
        mounted.current &&
        !controller.signal.aborted &&
        generation === attemptGeneration.current
      ) {
        activeController.current = null;
        setOidcState({ error, pendingProviderId: null });
      }
      return;
    }

    if (
      !mounted.current ||
      controller.signal.aborted ||
      generation !== attemptGeneration.current
    ) {
      return;
    }
    activeController.current = null;
    window.location.assign(authorizationUrl);
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

        {mfaChallenge === null ? <form
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
        </form> : <form className="flex flex-col gap-5" onSubmit={(event) => void handleMfaSubmit(event)}>
          <Alert>
            <AlertTitle>需要二次验证</AlertTitle>
            <AlertDescription>请输入验证器生成的 6 位验证码。挑战有效期至 <time dateTime={mfaChallenge.expiresAt}>{new Date(mfaChallenge.expiresAt).toLocaleTimeString()}</time>。</AlertDescription>
          </Alert>
          <Field data-invalid={mfaState.error !== null || undefined}>
            <FieldLabel htmlFor="mfa-login-code">验证码</FieldLabel>
            <Input
              autoComplete="one-time-code"
              id="mfa-login-code"
              inputMode="numeric"
              maxLength={6}
              onChange={(event) => {
                setMfaCode(event.currentTarget.value.replace(/\D/g, "").slice(0, 6));
                setMfaState((current) => current.error === null ? current : IDLE_MFA_STATE);
              }}
              value={mfaCode}
            />
          </Field>
          {mfaState.error !== null ? <Alert variant="destructive"><AlertTitle>验证失败</AlertTitle><AlertDescription>验证码无效或已过期，请重新登录。</AlertDescription></Alert> : null}
          <div className="flex gap-2">
            <Button className="flex-1" disabled={mfaState.pending || mfaCode.length !== 6} type="submit">
              {mfaState.pending ? <Spinner data-icon="inline-start" aria-label="正在验证" /> : null}
              验证并登录
            </Button>
            <Button onClick={() => { setMfaChallenge(null); setMfaCode(""); setMfaState(IDLE_MFA_STATE); }} type="button" variant="outline">返回</Button>
          </div>
        </form>}

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
            const pending = oidcState.pendingProviderId === provider.providerId;
            return (
              <Button
                disabled={oidcState.pendingProviderId !== null}
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
                    void handleOidcStart(request.data);
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

          {oidcState.error !== null ? (
            <Alert variant="destructive">
              <AlertTitle>无法开始单点登录</AlertTitle>
              <AlertDescription>
                {oidcState.error instanceof NetworkFailureError
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
