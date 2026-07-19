import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useCsrfStore } from "@/auth/csrf-store.ts";
import { useLogout } from "@/auth/use-logout.ts";

const CSRF_TOKEN = "A".repeat(43);
const REQUEST_ID = "99999999-9999-4999-8999-999999999999";
const SENSITIVE_QUERY_KEY = ["authorized-space", "sensitive"] as const;

function LogoutButton() {
  const logoutMutation = useLogout();
  return (
    <button onClick={() => logoutMutation.mutate()} type="button">
      退出登录
    </button>
  );
}

function renderLogout(queryClient: QueryClient): void {
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={["/spaces"]}>
        <Routes>
          <Route path="/spaces" element={<LogoutButton />} />
          <Route path="/login" element={<h1>登录奇点</h1>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  useCsrfStore.setState({ csrfToken: null });
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("useLogout session cleanup", () => {
  it.each([
    { label: "successful logout", response: () => new Response(null, { status: 204 }) },
    {
      label: "already unauthenticated logout",
      response: () =>
        new Response(
          JSON.stringify({
            code: "unauthenticated",
            requestId: REQUEST_ID,
            status: 401,
          }),
          {
            headers: { "Content-Type": "application/json" },
            status: 401,
          },
        ),
    },
  ])("clears all client session state before redirecting after $label", async ({ response }) => {
    const queryClient = new QueryClient({
      defaultOptions: {
        mutations: { retry: false },
        queries: { retry: false },
      },
    });
    queryClient.setQueryData(SENSITIVE_QUERY_KEY, { documentTitle: "Private" });
    useCsrfStore.getState().setCsrfToken(CSRF_TOKEN);
    const fetchMock = vi.fn<typeof fetch>((input, init) => {
      expect(new URL(String(input), window.location.origin).pathname).toBe(
        "/api/v1/auth/logout",
      );
      expect(init?.method).toBe("POST");
      expect(new Headers(init?.headers).get("X-CSRF-Token")).toBe(CSRF_TOKEN);
      return Promise.resolve(response());
    });
    vi.stubGlobal("fetch", fetchMock);

    renderLogout(queryClient);
    fireEvent.click(screen.getByRole("button", { name: "退出登录" }));

    expect(await screen.findByRole("heading", { name: "登录奇点" })).toBeVisible();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(queryClient.getQueryData(SENSITIVE_QUERY_KEY)).toBeUndefined();
    expect(useCsrfStore.getState().csrfToken).toBeNull();
  });
});
