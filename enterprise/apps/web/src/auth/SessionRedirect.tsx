import { useLayoutEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router";

import { loginPath } from "@/auth/return-to.ts";
import { clearClientSession } from "@/auth/session-state.ts";
import { Spinner } from "@/components/ui/spinner.tsx";

export function SessionRedirect({ returnTo }: { returnTo: string }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  useLayoutEffect(() => {
    clearClientSession(queryClient);
    void navigate(loginPath(returnTo), { replace: true });
  }, [navigate, queryClient, returnTo]);

  return (
    <div
      data-singularity-ui
      className="flex min-h-dvh items-center justify-center p-6"
    >
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Spinner aria-label="正在前往登录页" />
        <span>登录状态已失效</span>
      </div>
    </div>
  );
}
