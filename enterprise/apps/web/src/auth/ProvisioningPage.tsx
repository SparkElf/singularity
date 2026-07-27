import {
  registerRequestSchema,
  type RegisterRequest,
} from "@singularity/contracts";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "react-router";
import { NetworkFailureError, isApiProblem } from "@/api/http.ts";
import { getSetupStatus, register } from "@/auth/api.ts";
import { useCsrfStore } from "@/auth/csrf-store.ts";
import { clearClientSession } from "@/auth/session-state.ts";

export type ProvisioningMode = "register" | "setup";

// 将注册边界错误翻译为用户可以立即采取行动的提示，不把安装实现状态暴露到公开注册路径。
function failureMessage(error: unknown): string {
  if (error instanceof NetworkFailureError) {
    return "无法连接到服务，请稍后重试。";
  }
  if (isApiProblem(error, "conflict")) {
    return "这个账号已被注册，请换一个账号。";
  }
  if (isApiProblem(error, "validation-failed")) {
    return "请检查表单内容后重试。";
  }
  return "无法完成注册，请稍后重试。";
}

export function ProvisioningPage({ mode }: { mode: ProvisioningMode }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const setCsrfToken = useCsrfStore((state) => state.setCsrfToken);
  const mounted = useRef(true);
  const activeController = useRef<AbortController | null>(null);
  const [validationError, setValidationError] = useState<string | null>(null);
  const statusQuery = useQuery({
    enabled: mode === "setup",
    queryKey: ["auth-setup-status"],
    queryFn: ({ signal }) => getSetupStatus(signal),
    staleTime: 0,
  });
  const mutation = useMutation({
    mutationFn: async (request: RegisterRequest) => {
      activeController.current?.abort();
      const controller = new AbortController();
      activeController.current = controller;
      try {
        return register(request, controller.signal);
      } finally {
        if (activeController.current === controller) {
          activeController.current = null;
        }
      }
    },
    onSuccess: (result) => {
      if (!mounted.current) {
        return;
      }
      clearClientSession(queryClient);
      setCsrfToken(result.csrfToken);
      void navigate("/spaces", { replace: true });
    },
  });

  // 用户开始修改任一字段后清除上一轮失败结果，避免旧错误遮挡当前输入状态。
  const clearFormError = () => {
    setValidationError(null);
    if (mutation.error !== null) {
      mutation.reset();
    }
  };

  useLayoutEffect(() => {
    clearClientSession(queryClient);
  }, [queryClient]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      activeController.current?.abort();
      activeController.current = null;
    };
  }, []);

  const handleSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    // 表单先在客户端按当前模式收敛为唯一请求合同，再交给服务端做最终边界校验。
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const password = form.get("password");
    const confirmation = form.get("passwordConfirmation");
    if (password !== confirmation) {
      setValidationError("两次输入的密码不一致。");
      return;
    }
    const parsed = registerRequestSchema.safeParse({
      loginIdentifier: form.get("loginIdentifier"),
      password,
    });
    if (!parsed.success) {
      setValidationError("请填写有效的账号和密码。");
      return;
    }
    setValidationError(null);
    mutation.mutate(parsed.data);
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
          {mode === "setup" ? "首次部署说明" : "创建奇点账号"}
        </h1>
        {mode === "setup" && statusQuery.isPending ? (
          <div className="b3-form__space--small" role="status">
            正在读取系统状态…
          </div>
        ) : null}
        {mode === "setup" && statusQuery.isError ? (
          <div className="b3-form__space--small ft__error" role="alert">
            <p>无法读取系统状态，请检查服务连接后重试。</p>
            <button
              className="b3-button b3-button--cancel"
              onClick={() => void statusQuery.refetch()}
              type="button"
            >
              重试
            </button>
          </div>
        ) : null}
        {mode === "setup" ? (
          statusQuery.isSuccess ? (
            <div className="b3-form__space--small">
              <p className="ft__on-surface">
                {statusQuery.data.initialized
                  ? <>系统已完成首次初始化，请使用固定账号 <code className="fn__code">admin</code> 登录。初始密码只在首次启动时显示一次。</>
                  : <>系统尚未完成首次部署，完成后会生成固定账号 <code className="fn__code">admin</code> 和一次性初始密码。</>}
              </p>
            </div>
          ) : null
        ) : (
          <form
            className="b3-form__space--small"
            onSubmit={handleSubmit}
          >
            <div className="b3-form__icon">
              <svg className="b3-form__icon-icon" aria-hidden="true"><use href="#iconAccount" /></svg>
              <input
                autoComplete="username"
                className="b3-text-field fn__block b3-form__icon-input"
                id="provisioning-login-identifier"
                name="loginIdentifier"
                placeholder="用户名/邮箱"
                required
                aria-label="账号"
                onChange={clearFormError}
              />
            </div>
            <div className="fn__hr--b" />
            <div className="b3-form__icon">
              <svg className="b3-form__icon-icon" aria-hidden="true"><use href="#iconLock" /></svg>
              <input
                autoComplete="new-password"
                className="b3-text-field b3-form__icon-input fn__block"
                id="provisioning-password"
                name="password"
                placeholder="密码"
                required
                type="password"
                aria-label="密码"
                onChange={clearFormError}
              />
            </div>
            <div className="fn__hr--b" />
            <div className="b3-form__icon">
              <svg className="b3-form__icon-icon" aria-hidden="true"><use href="#iconLock" /></svg>
              <input
                autoComplete="new-password"
                className="b3-text-field b3-form__icon-input fn__block"
                id="provisioning-password-confirmation"
                name="passwordConfirmation"
                placeholder="确认密码"
                required
                type="password"
                aria-label="确认密码"
                onChange={clearFormError}
              />
            </div>
            <div className="fn__hr--b" />
            {validationError !== null || mutation.error !== null ? (
              <p className="ft__error" role="alert">
                {validationError ?? failureMessage(mutation.error)}
              </p>
            ) : null}
            <button
              aria-busy={mutation.isPending}
              className="b3-button fn__block"
              disabled={mutation.isPending}
              type="submit"
            >
              {mutation.isPending ? "注册中…" : "注册新账号"}
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
