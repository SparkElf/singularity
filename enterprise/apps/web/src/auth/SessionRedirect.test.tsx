import "@testing-library/jest-dom/vitest";
import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, describe, expect, it } from "vitest";

import { ApiProblemError } from "@/api/http.ts";
import { SessionRedirect } from "@/auth/SessionRedirect.tsx";
import { useCsrfStore } from "@/auth/csrf-store.ts";
import { MutationFailure, PageFailure } from "@/enterprise/components.tsx";

const CSRF_TOKEN = "A".repeat(43);
const REQUEST_ID = "99999999-9999-4999-8999-999999999999";
const SENSITIVE_QUERY_KEY = ["authorized-space", "sensitive"] as const;
const PROTECTED_TARGET = "/organizations/11111111-1111-4111-8111-111111111111/settings/members?status=active#member-list";
const protectedFailureCases: ReadonlyArray<{
  createFailure: (error: ApiProblemError) => ReactNode;
  name: string;
}> = [
  {
    createFailure: (error) => <PageFailure error={error} />,
    name: "protected query",
  },
  {
    createFailure: (error) => <MutationFailure error={error} />,
    name: "protected mutation",
  },
];

function renderProtectedRoute(element: ReactNode) {
  const queryClient = new QueryClient({
    defaultOptions: {
      mutations: { retry: false },
      queries: { retry: false },
    },
  });
  queryClient.setQueryData(SENSITIVE_QUERY_KEY, { documentTitle: "Private" });
  useCsrfStore.getState().setCsrfToken(CSRF_TOKEN);
  const router = createMemoryRouter(
    [
      {
        element,
        path: "/organizations/:organizationId/settings/members",
      },
      { element: <h1>登录奇点</h1>, path: "/login" },
    ],
    { initialEntries: [PROTECTED_TARGET] },
  );

  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );

  return { queryClient, router };
}

afterEach(() => {
  cleanup();
  useCsrfStore.getState().clearCsrfToken();
});

describe("SessionRedirect unauthenticated cleanup", () => {
  it("clears all client session state before replacing the protected route", async () => {
    const { queryClient, router } = renderProtectedRoute(
      <SessionRedirect returnTo={PROTECTED_TARGET} />,
    );

    expect(await screen.findByRole("heading", { name: "登录奇点" })).toBeVisible();
    expect(queryClient.getQueryData(SENSITIVE_QUERY_KEY)).toBeUndefined();
    expect(useCsrfStore.getState().csrfToken).toBeNull();
    expect(router.state.historyAction).toBe("REPLACE");
    expect(router.state.location.pathname).toBe("/login");
    expect(new URLSearchParams(router.state.location.search).get("returnTo"))
      .toBe(PROTECTED_TARGET);
  });

  it.each(protectedFailureCases)(
    "routes a $name 401 through the session cleanup boundary",
    async ({ createFailure }) => {
      const error = new ApiProblemError(
        { code: "unauthenticated", requestId: REQUEST_ID, status: 401 },
        null,
      );
      const { queryClient, router } = renderProtectedRoute(createFailure(error));

      expect(await screen.findByRole("heading", { name: "登录奇点" })).toBeVisible();
      expect(queryClient.getQueryData(SENSITIVE_QUERY_KEY)).toBeUndefined();
      expect(useCsrfStore.getState().csrfToken).toBeNull();
      expect(router.state.historyAction).toBe("REPLACE");
      expect(new URLSearchParams(router.state.location.search).get("returnTo"))
        .toBe(PROTECTED_TARGET);
    },
  );
});
