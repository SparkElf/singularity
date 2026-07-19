import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router";

import { isApiProblem } from "@/api/http.ts";
import { getOrFetchCsrfToken, logout } from "@/auth/api.ts";
import { LOGIN_PATH } from "@/auth/return-to.ts";
import { clearClientSession } from "@/auth/session-state.ts";

export function useLogout() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const finish = () => {
    clearClientSession(queryClient);
    void navigate(LOGIN_PATH, { replace: true });
  };

  return useMutation({
    mutationFn: async () => {
      const csrfToken = await getOrFetchCsrfToken();
      await logout(csrfToken);
    },
    onError: (error) => {
      if (isApiProblem(error, "unauthenticated")) {
        finish();
      }
    },
    onSuccess: finish,
  });
}
