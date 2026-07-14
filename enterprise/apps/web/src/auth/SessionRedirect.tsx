import { useEffect } from "react";
import { useNavigate } from "react-router";

import { loginPath } from "@/auth/return-to.ts";
import { Spinner } from "@/components/ui/spinner.tsx";

export function SessionRedirect({ returnTo }: { returnTo: string }) {
  const navigate = useNavigate();

  useEffect(() => {
    void navigate(loginPath(returnTo), { replace: true });
  }, [navigate, returnTo]);

  return (
    <main
      data-singularity-ui
      className="flex min-h-dvh items-center justify-center p-6"
    >
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Spinner aria-label="正在前往登录页" />
        <span>登录状态已失效</span>
      </div>
    </main>
  );
}
