import { loginRequestSchema } from "@singularity/contracts";
import { useLayoutEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { OrbitIcon } from "lucide-react";
import { useLocation, useNavigate } from "react-router";

import {
  ApiProblemError,
  NetworkFailureError,
  isApiProblem,
} from "@/api/http.ts";
import { login } from "@/auth/api.ts";
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
import { Spinner } from "@/components/ui/spinner.tsx";

function loginErrorMessage(error: unknown): string {
  if (isApiProblem(error, "unauthenticated")) {
    return "账号或密码错误。";
  }

  if (isApiProblem(error, "rate-limited")) {
    return "尝试次数过多，请稍后再试。";
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

  useLayoutEffect(() => {
    clearClientSession(queryClient);
  }, [queryClient]);

  const mutation = useMutation({
    mutationFn: (request: Parameters<typeof login>[0]) => login(request),
    onSuccess: ({ csrfToken }) => {
      queryClient.removeQueries();
      setCsrfToken(csrfToken);
      const returnTo = parseReturnTo(location.search, window.location.origin);
      void navigate(returnTo ?? SPACES_PATH, { replace: true });
    },
  });

  const handleSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    const request = loginRequestSchema.safeParse({
      loginIdentifier: formData.get("loginIdentifier"),
      password: formData.get("password"),
    });

    if (!request.success) {
      mutation.reset();
      setValidationError(true);
      return;
    }

    setValidationError(false);
    mutation.mutate(request.data);
  };

  const hasError = validationError || mutation.isError;

  return (
    <main
      data-singularity-ui
      className="flex min-h-dvh items-center justify-center bg-muted/40 p-6 max-sm:bg-background max-sm:p-4"
    >
      <section className="w-full max-w-[360px] rounded-md border bg-card p-6 max-sm:border-0 max-sm:p-2">
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
            mutation.reset();
          }}
          onSubmit={handleSubmit}
        >
          <FieldGroup>
            <Field data-invalid={hasError || undefined}>
              <FieldLabel htmlFor="login-identifier">账号</FieldLabel>
              <Input
                autoComplete="username"
                className="h-9 max-sm:h-10"
                disabled={mutation.isPending}
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
                disabled={mutation.isPending}
                id="login-password"
                name="password"
                required
                type="password"
                aria-invalid={hasError || undefined}
              />
            </Field>
          </FieldGroup>

          <div className="min-h-16">
            {validationError || mutation.isError ? (
              <Alert variant="destructive">
                <AlertTitle>无法登录</AlertTitle>
                <AlertDescription>
                  {validationError
                    ? "请输入有效的账号和密码。"
                    : loginErrorMessage(mutation.error)}
                </AlertDescription>
              </Alert>
            ) : null}
          </div>

          <Button
            className="w-full max-sm:h-10"
            disabled={mutation.isPending}
            type="submit"
          >
            {mutation.isPending ? (
              <Spinner data-icon="inline-start" aria-label="正在登录" />
            ) : null}
            登录
          </Button>
        </form>
      </section>
    </main>
  );
}
