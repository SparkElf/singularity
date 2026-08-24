import { loginRequestSchema } from "@singularity/contracts";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Link, useLocation, useNavigate } from "react-router";

import {
  ApiProblemError,
  NetworkFailureError,
  isApiProblem,
} from "@/api/http.ts";
import { login } from "@/auth/api.ts";
import { useCsrfStore } from "@/auth/csrf-store.ts";
import { SPACES_PATH, parseReturnTo } from "@/auth/return-to.ts";
import { clearClientSession } from "@/auth/session-state.ts";

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
  const [agreeLogin, setAgreeLogin] = useState(false);
  const [cooldown, setCooldown] = useState<LoginCooldown | null>(null);
  const activeController = useRef<AbortController | null>(null);
  const attemptGeneration = useRef(0);
  const mounted = useRef(true);
  const cooldownSeconds = cooldown?.remainingSeconds ?? 0;

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
      const result = await login(request.data, controller.signal);
      if (
        !mounted.current ||
        controller.signal.aborted ||
        generation !== attemptGeneration.current
      ) {
        return;
      }

      queryClient.removeQueries();
      setCsrfToken(result.csrfToken);
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
        <form
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
            <svg className="b3-form__icon-icon" aria-hidden="true">
              <use href="#iconAccount" />
            </svg>
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
            <svg className="b3-form__icon-icon" aria-hidden="true">
              <use href="#iconLock" />
            </svg>
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
            <Link className="b3-button b3-button--cancel" to="/forgot-password">
              忘记密码
            </Link>
            <span className="fn__space">·</span>
            <Link className="b3-button b3-button--cancel" to="/register">
              注册新账号
            </Link>
          </div>
        </form>
      </section>
    </main>
  );
}
