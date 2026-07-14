import { useMutation } from "@tanstack/react-query";
import { useNavigate } from "react-router";

import { isApiProblem } from "@/api/http.ts";
import { getCsrfToken, logout } from "@/auth/api.ts";
import { useCsrfStore } from "@/auth/csrf-store.ts";
import { LOGIN_PATH } from "@/auth/return-to.ts";

export function useLogout() {
  const navigate = useNavigate();

  const finish = () => {
    void navigate(LOGIN_PATH, { replace: true });
  };

  return useMutation({
    mutationFn: async () => {
      let csrfToken = useCsrfStore.getState().csrfToken;
      if (!csrfToken) {
        const response = await getCsrfToken();
        csrfToken = response.csrfToken;
        useCsrfStore.getState().setCsrfToken(csrfToken);
      }

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
