import type { QueryClient } from "@tanstack/react-query";

import { useCsrfStore } from "@/auth/csrf-store.ts";

export function clearClientSession(queryClient: QueryClient): void {
  useCsrfStore.getState().clearCsrfToken();
  queryClient.clear();
}
