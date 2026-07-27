import { loginRequestSchema, oidcStartRequestSchema } from "@singularity/contracts";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Building2Icon, RefreshCwIcon } from "lucide-react";
import { Link, useLocation, useNavigate } from "react-router";

import {
  ApiProblemError,
  NetworkFailureError,
  isApiProblem,
} from "@/api/http.ts";
import {
  getOidcProviders,
  login,
  startOidc,
  verifyMfaChallenge,
} from "@/auth/api.ts";
import { useCsrfStore } from "@/auth/csrf-store.ts";
import { SPACES_PATH, parseReturnTo } from "@/auth/return-to.ts";
import { clearClientSession } from "@/auth/session-state.ts";
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@/components/ui/alert.tsx";
import { Button } from "@/components/ui/button.tsx";
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
  const [agreeLogin, setAgreeLogin] = useState(false);
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

  // 登录只提交本地身份字段；注册始终开放，不能让安装状态或云端区域参与这条请求合同。
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

  const oidcProviders = oidcProvidersQuery.data?.providers ?? [];
  const showOidcSection =
    oidcProvidersQuery.isPending ||
    oidcProvidersQuery.isError ||
    oidcProviders.length > 0 ||
    oidcState.error !== null;

  return (
    <main data-singularity-ui className="flex min-h-dvh items-center justify-center p-4">
      <section className="config-account--auth">
        <h1
          style={{
            clip: "rect(0 0 0 0)",
            clipPath: "inset(50%)",
            height: 1,
            overflow: "hidden",
            position: "absolute",
            whiteSpace: "nowrap",
            width: 1,
          }}
        >
          登录奇点
        </h1>
        {mfaChallenge === null ? <form
          className="b3-form__space--small"
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
          <div className="b3-form__icon">
            <svg className="b3-form__icon-icon" aria-hidden="true"><use href="#iconAccount" /></svg>
            <input
              autoComplete="username"
              className="b3-text-field fn__block b3-form__icon-input"
              id="userName"
              name="loginIdentifier"
              placeholder="用户名/邮箱"
              required
              aria-label="账号"
            />
          </div>
          <div className="fn__hr--b" />
          <div className="b3-form__icon">
            <svg className="b3-form__icon-icon" aria-hidden="true"><use href="#iconLock" /></svg>
            <input
              autoComplete="current-password"
              className="b3-text-field b3-form__icon-input fn__block"
              id="userPassword"
              name="password"
              placeholder="密码"
              required
              type="password"
              aria-label="密码"
            />
          </div>
          <div className="fn__hr--b" />
          <label className="ft__smaller ft__on-surface fn__flex">
            <input
              checked={agreeLogin}
              id="agreeLogin"
              onChange={(event) => setAgreeLogin(event.currentTarget.checked)}
              type="checkbox"
            />
            <span className="fn__space" />
            <span>我已阅读并同意奇点服务条款</span>
          </label>
          <div className="fn__hr--b" />
          {validationError || loginState.error !== null ? (
            <p className="ft__error" role="alert">
              {validationError
                ? "请输入有效的账号和密码。"
                : loginErrorMessage(loginState.error, cooldownSeconds)}
            </p>
          ) : null}
          <button
            className="b3-button fn__block"
            disabled={!agreeLogin || cooldownSeconds > 0 || loginState.pending}
            type="submit"
            aria-busy={loginState.pending}
          >
            {loginState.pending ? "登录中…" : "登录"}
          </button>
          <div className="fn__hr--b" />
          <div className="ft__center">
            <Link className="b3-button b3-button--cancel" to="/forgot-password">忘记密码</Link>
            <span className="fn__space">·</span>
            <Link className="b3-button b3-button--cancel" to="/register">注册新账号</Link>
          </div>
        </form> : <form className="flex flex-col gap-5" onSubmit={(event) => void handleMfaSubmit(event)}>
          <Alert>
            <AlertTitle>需要二次验证</AlertTitle>
            <AlertDescription>请输入验证器生成的 6 位验证码。挑战有效期至 <time dateTime={mfaChallenge.expiresAt}>{new Date(mfaChallenge.expiresAt).toLocaleTimeString()}</time>。</AlertDescription>
          </Alert>
          <label className="b3-form__icon">
            <svg className="b3-form__icon-icon" aria-hidden="true"><use href="#iconLock" /></svg>
            <input
              className="b3-text-field b3-form__icon-input fn__block"
              autoComplete="one-time-code"
              id="mfa-login-code"
              inputMode="numeric"
              maxLength={6}
              name="code"
              placeholder="二次验证码"
              onChange={(event) => {
                setMfaCode(event.currentTarget.value.replace(/\D/g, "").slice(0, 6));
                setMfaState((current) => current.error === null ? current : IDLE_MFA_STATE);
              }}
              type="text"
              value={mfaCode}
            />
          </label>
          {mfaState.error !== null ? <Alert variant="destructive"><AlertTitle>验证失败</AlertTitle><AlertDescription>验证码无效或已过期，请重新登录。</AlertDescription></Alert> : null}
          <div className="flex gap-2">
            <Button className="flex-1" disabled={mfaState.pending || mfaCode.length !== 6} type="submit">
              {mfaState.pending ? <Spinner data-icon="inline-start" aria-label="正在验证" /> : null}
              验证并登录
            </Button>
            <Button onClick={() => { setMfaChallenge(null); setMfaCode(""); setMfaState(IDLE_MFA_STATE); }} type="button" variant="outline">返回</Button>
          </div>
        </form>}

        {showOidcSection ? (
          <>
            <div className="fn__hr--b" />
            <div className="ft__center ft__smaller ft__on-surface">企业单点登录</div>

            <div className="flex min-h-10 flex-col gap-2" aria-live="polite">
              {oidcProvidersQuery.isPending ? (
                <>
                  <Skeleton className="h-10 w-full" />
                  <Skeleton className="h-10 w-full" />
                </>
              ) : null}

              {oidcProvidersQuery.isError ? (
                <Alert variant="destructive">
                  <AlertTitle>企业单点登录暂不可用</AlertTitle>
                  <AlertDescription className="flex items-center justify-between gap-2">
                    <span>账号密码登录仍可使用，请稍后重试。</span>
                    <Button
                      aria-label="重试企业单点登录"
                      onClick={() => void refetchOidcProviders()}
                      size="icon-sm"
                      variant="ghost"
                    >
                      <RefreshCwIcon aria-hidden="true" />
                    </Button>
                  </AlertDescription>
                </Alert>
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
                      <Spinner data-icon="inline-start" aria-label="正在前往企业单点登录" />
                    ) : (
                      <Building2Icon data-icon="inline-start" />
                    )}
                    {provider.name}
                  </Button>
                );
              })}

              {oidcState.error !== null ? (
                <Alert variant="destructive">
                  <AlertTitle>无法开始企业单点登录</AlertTitle>
                  <AlertDescription>
                    {oidcState.error instanceof NetworkFailureError
                      ? "无法连接到服务，请稍后重试。"
                      : "企业单点登录服务未接受请求，请重试。"}
                  </AlertDescription>
                </Alert>
              ) : null}
            </div>
          </>
        ) : null}

      </section>
    </main>
  );
}
