import { emailSchema } from "@singularity/contracts";
import { useEffect, useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Link } from "react-router";

import { ApiProblemError, NetworkFailureError, isApiProblem } from "@/api/http.ts";
import { requestPasswordReset } from "@/auth/api.ts";

function requestErrorMessage(error: unknown): string {
  if (isApiProblem(error, "service-unavailable")) {
    return "密码找回服务尚未配置，请联系管理员。";
  }
  if (error instanceof NetworkFailureError) {
    return "无法连接到服务，请稍后重试。";
  }
  if (error instanceof ApiProblemError) {
    return "无法提交找回请求，请检查邮箱后重试。";
  }
  return "无法提交找回请求，请稍后重试。";
}

export function ForgotPasswordPage() {
  const mounted = useRef(true);
  const activeController = useRef<AbortController | null>(null);
  const [validationError, setValidationError] = useState(false);
  const mutation = useMutation({
    mutationFn: async (email: string) => {
      activeController.current?.abort();
      const controller = new AbortController();
      activeController.current = controller;
      try {
        return await requestPasswordReset({ email }, controller.signal);
      } finally {
        if (activeController.current === controller) {
          activeController.current = null;
        }
      }
    },
  });

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      activeController.current?.abort();
      activeController.current = null;
    };
  }, []);

  const handleSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    // 页面只负责展示 schema 的统一错误；邮箱归一化和格式边界由公共合同拥有。
    event.preventDefault();
    const email = emailSchema.safeParse(new FormData(event.currentTarget).get("email"));
    if (!email.success) {
      setValidationError(true);
      mutation.reset();
      return;
    }
    setValidationError(false);
    mutation.mutate(email.data);
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
          找回密码
        </h1>
        {mutation.isSuccess ? (
          <div className="b3-form__space--small" role="status">
            如果该邮箱已注册，你会收到一封密码重置邮件；请检查收件箱和垃圾邮件。
          </div>
        ) : (
          <form className="b3-form__space--small" onSubmit={handleSubmit}>
            <div className="b3-form__icon">
              <svg className="b3-form__icon-icon" aria-hidden="true"><use href="#iconAccount" /></svg>
              <input
                autoComplete="email"
                className="b3-text-field fn__block b3-form__icon-input"
                id="password-reset-email"
                name="email"
                placeholder="邮箱"
                required
                type="email"
                aria-label="邮箱"
                onChange={() => {
                  setValidationError(false);
                  mutation.reset();
                }}
              />
            </div>
            <div className="fn__hr--b" />
            {validationError || mutation.error !== null ? (
              <p className="ft__error" role="alert">
                {validationError ? "请输入有效的邮箱。" : requestErrorMessage(mutation.error)}
              </p>
            ) : null}
            <button
              aria-busy={mutation.isPending}
              className="b3-button fn__block"
              disabled={mutation.isPending}
              type="submit"
            >
              {mutation.isPending ? "提交中…" : "发送重置邮件"}
            </button>
          </form>
        )}
        <div className="fn__hr--b" />
        <div className="ft__center">
          <Link className="b3-button b3-button--cancel" to="/login">返回登录</Link>
        </div>
      </section>
    </main>
  );
}
