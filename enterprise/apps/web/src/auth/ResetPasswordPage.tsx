import {
  passwordResetConfirmRequestSchema,
} from "@singularity/contracts";
import { useEffect, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link, useLocation, useNavigate } from "react-router";

import { ApiProblemError, NetworkFailureError, isApiProblem } from "@/api/http.ts";
import { confirmPasswordReset } from "@/auth/api.ts";
import { clearClientSession } from "@/auth/session-state.ts";

function resetErrorMessage(error: unknown): string {
  if (isApiProblem(error, "validation-failed")) {
    return "这个重置链接已失效，请重新申请。";
  }
  if (error instanceof NetworkFailureError) {
    return "无法连接到服务，请稍后重试。";
  }
  if (error instanceof ApiProblemError) {
    return "无法重置密码，请重新申请链接。";
  }
  return "无法重置密码，请稍后重试。";
}

export function ResetPasswordPage() {
  const location = useLocation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const mounted = useRef(true);
  const activeController = useRef<AbortController | null>(null);
  const token = new URLSearchParams(location.search).get("token") ?? "";
  const [validationError, setValidationError] = useState<string | null>(null);
  const mutation = useMutation({
    mutationFn: async (password: string) => {
      activeController.current?.abort();
      const controller = new AbortController();
      activeController.current = controller;
      try {
        return await confirmPasswordReset({ password, token }, controller.signal);
      } finally {
        if (activeController.current === controller) {
          activeController.current = null;
        }
      }
    },
    onSuccess: () => {
      if (!mounted.current) {
        return;
      }
      clearClientSession(queryClient);
      void navigate("/login", { replace: true });
    },
  });

  useEffect(() => {
    // 令牌只在当前渲染周期交给提交函数，立即从浏览器历史和地址栏移除，减少复制与 referrer 泄露面。
    if (token.length > 0) {
      window.history.replaceState(null, "", location.pathname);
    }
  }, [location.pathname, token]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      activeController.current?.abort();
      activeController.current = null;
    };
  }, []);

  const handleSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    // 先在当前页面确认两次密码一致，再把 token 和新密码交给 API 合同。
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const password = form.get("password");
    const confirmation = form.get("passwordConfirmation");
    if (password !== confirmation) {
      setValidationError("两次输入的密码不一致。");
      return;
    }
    const parsed = passwordResetConfirmRequestSchema.safeParse({ password, token });
    if (!parsed.success) {
      setValidationError("请设置 12 至 128 个字符的新密码。");
      return;
    }
    setValidationError(null);
    mutation.mutate(parsed.data.password);
  };

  const tokenValid = passwordResetConfirmRequestSchema.shape.token.safeParse(token).success;
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
          重置密码
        </h1>
        {!tokenValid ? (
          <p className="ft__error" role="alert">这个重置链接已失效，请重新申请。</p>
        ) : (
          <form className="b3-form__space--small" onSubmit={handleSubmit}>
            <div className="b3-form__icon">
              <svg className="b3-form__icon-icon" aria-hidden="true"><use href="#iconLock" /></svg>
              <input
                autoComplete="new-password"
                className="b3-text-field fn__block b3-form__icon-input"
                id="password-reset-password"
                name="password"
                placeholder="新密码"
                required
                type="password"
                aria-label="新密码"
                onChange={() => {
                  setValidationError(null);
                  mutation.reset();
                }}
              />
            </div>
            <div className="fn__hr--b" />
            <div className="b3-form__icon">
              <svg className="b3-form__icon-icon" aria-hidden="true"><use href="#iconLock" /></svg>
              <input
                autoComplete="new-password"
                className="b3-text-field fn__block b3-form__icon-input"
                id="password-reset-confirmation"
                name="passwordConfirmation"
                placeholder="确认新密码"
                required
                type="password"
                aria-label="确认新密码"
                onChange={() => {
                  setValidationError(null);
                  mutation.reset();
                }}
              />
            </div>
            <div className="fn__hr--b" />
            {validationError !== null || mutation.error !== null ? (
              <p className="ft__error" role="alert">
                {validationError ?? resetErrorMessage(mutation.error)}
              </p>
            ) : null}
            <button
              aria-busy={mutation.isPending}
              className="b3-button fn__block"
              disabled={mutation.isPending}
              type="submit"
            >
              {mutation.isPending ? "保存中…" : "设置新密码"}
            </button>
          </form>
        )}
        <div className="fn__hr--b" />
        <div className="ft__center">
          {!tokenValid || mutation.error !== null ? (
            <Link className="b3-button b3-button--cancel" to="/forgot-password">重新申请</Link>
          ) : null}
          <Link className="b3-button b3-button--cancel" to="/login">返回登录</Link>
        </div>
      </section>
    </main>
  );
}
