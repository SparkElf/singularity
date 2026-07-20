import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router";

import { isApiProblem } from "@/api/http.ts";
import { getOrFetchCsrfToken, logout } from "@/auth/api.ts";
import { useCsrfStore } from "@/auth/csrf-store.ts";
import { LOGIN_PATH } from "@/auth/return-to.ts";
import { clearClientSession } from "@/auth/session-state.ts";

export function useLogout(
  captureSessionTermination?: () => () => Promise<void>,
) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  /** 只在发起退出时捕获的 Session 代次仍然有效时，按顺序销毁内容、清缓存并导航。 */
  const finish = async (
    revision: number,
    terminateSession: (() => Promise<void>) | undefined,
  ) => {
    if (useCsrfStore.getState().csrfRevision !== revision) {
      return;
    }
    if (terminateSession !== undefined) {
      try {
        await terminateSession();
      } catch (error) {
        console.error(
          "[auth.logout]",
          { phase: "terminal-dispose", result: "failed" },
          error,
        );
        throw error;
      }
    }
    if (useCsrfStore.getState().csrfRevision !== revision) {
      return;
    }
    clearClientSession(queryClient);
    void navigate(LOGIN_PATH, { replace: true });
  };

  return useMutation({
    /** 绑定 CSRF 请求、服务端退出响应和当前内容 Session，拒绝迟到结果污染新登录。 */
    mutationFn: async () => {
      const initialState = useCsrfStore.getState();
      const terminateSession = captureSessionTermination?.();
      let revision = initialState.csrfRevision;
      try {
        const csrfToken = await getOrFetchCsrfToken();
        const expectedRevision =
          initialState.csrfToken === null ? revision + 1 : revision;
        const currentState = useCsrfStore.getState();
        if (
          currentState.csrfRevision !== expectedRevision ||
          currentState.csrfToken !== csrfToken
        ) {
          return;
        }
        revision = expectedRevision;
        await logout(csrfToken);
      } catch (error) {
        if (
          isApiProblem(error, "unauthenticated") &&
          useCsrfStore.getState().csrfRevision === revision
        ) {
          await finish(revision, terminateSession);
        }
        throw error;
      }
      if (useCsrfStore.getState().csrfRevision === revision) {
        await finish(revision, terminateSession);
      }
    },
  });
}
