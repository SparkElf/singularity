import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useCsrfStore } from "@/auth/csrf-store.ts";
import { useLogout } from "@/auth/use-logout.ts";

const CSRF_TOKEN = "A".repeat(42) + "E";
const NEW_CSRF_TOKEN = "B".repeat(42) + "I";
const REQUEST_ID = "99999999-9999-4999-8999-999999999999";
const SENSITIVE_QUERY_KEY = ["authorized-space", "sensitive"] as const;

function LogoutButton({
  captureSessionTermination,
}: {
    captureSessionTermination?: (() => () => Promise<void>) | undefined;
}) {
  const logoutMutation = useLogout(captureSessionTermination);
  return (
    <button
      data-status={logoutMutation.status}
      onClick={() => logoutMutation.mutate()}
      type="button"
    >
      退出登录
    </button>
  );
}

function renderLogout(
  queryClient: QueryClient,
  captureSessionTermination?: () => () => Promise<void>,
): void {
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={["/spaces"]}>
        <Routes>
          <Route
            path="/spaces"
            element={
              <LogoutButton
                captureSessionTermination={captureSessionTermination}
              />
            }
          />
          <Route path="/login" element={<h1>登录奇点</h1>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function deferredResponse(): {
  promise: Promise<Response>;
  resolve(response: Response): void;
} {
  let resolve!: (response: Response) => void;
  const promise = new Promise<Response>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
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

  it("terminates the current session when CSRF recovery is unauthenticated", async () => {
    const queryClient = new QueryClient({
      defaultOptions: {
        mutations: { retry: false },
        queries: { retry: false },
      },
    });
    const terminateSession = vi.fn(async () => undefined);
    const captureSessionTermination = vi.fn(() => terminateSession);
    queryClient.setQueryData(SENSITIVE_QUERY_KEY, { documentTitle: "Private" });
    useCsrfStore.setState({ csrfToken: null });
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async (input) => {
        expect(new URL(String(input), window.location.origin).pathname).toBe(
          "/api/v1/auth/csrf",
        );
        return new Response(
          JSON.stringify({
            code: "unauthenticated",
            requestId: REQUEST_ID,
            status: 401,
          }),
          {
            headers: { "Content-Type": "application/json" },
            status: 401,
          },
        );
      }),
    );
    renderLogout(queryClient, captureSessionTermination);

    fireEvent.click(screen.getByRole("button", { name: "退出登录" }));

    expect(await screen.findByRole("heading", { name: "登录奇点" })).toBeVisible();
    expect(captureSessionTermination).toHaveBeenCalledTimes(1);
    expect(terminateSession).toHaveBeenCalledTimes(1);
    expect(queryClient.getQueryData(SENSITIVE_QUERY_KEY)).toBeUndefined();
    expect(useCsrfStore.getState().csrfToken).toBeNull();
  });

  it("recovers a missing CSRF token before terminating the same session", async () => {
    const queryClient = new QueryClient({
      defaultOptions: {
        mutations: { retry: false },
        queries: { retry: false },
      },
    });
    const terminateSession = vi.fn(async () => undefined);
    const captureSessionTermination = vi.fn(() => terminateSession);
    const paths: string[] = [];
    queryClient.setQueryData(SENSITIVE_QUERY_KEY, { documentTitle: "Private" });
    useCsrfStore.setState({ csrfToken: null });
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async (input, init) => {
        const path = new URL(String(input), window.location.origin).pathname;
        paths.push(path);
        if (path === "/api/v1/auth/csrf") {
          return new Response(JSON.stringify({ csrfToken: CSRF_TOKEN }), {
            headers: { "Content-Type": "application/json" },
            status: 200,
          });
        }
        if (path === "/api/v1/auth/logout") {
          expect(new Headers(init?.headers).get("X-CSRF-Token")).toBe(CSRF_TOKEN);
          return new Response(null, { status: 204 });
        }
        throw new Error(`Unexpected request: ${path}`);
      }),
    );
    renderLogout(queryClient, captureSessionTermination);

    fireEvent.click(screen.getByRole("button", { name: "退出登录" }));

    expect(await screen.findByRole("heading", { name: "登录奇点" })).toBeVisible();
    expect(paths).toEqual(["/api/v1/auth/csrf", "/api/v1/auth/logout"]);
    expect(captureSessionTermination).toHaveBeenCalledTimes(1);
    expect(terminateSession).toHaveBeenCalledTimes(1);
    expect(queryClient.getQueryData(SENSITIVE_QUERY_KEY)).toBeUndefined();
    expect(useCsrfStore.getState().csrfToken).toBeNull();
  });

  it("does not let an old logout result clear a newer login", async () => {
    const queryClient = new QueryClient({
      defaultOptions: {
        mutations: { retry: false },
        queries: { retry: false },
      },
    });
    const response = deferredResponse();
    const terminateSession = vi.fn(async () => undefined);
    const captureSessionTermination = vi.fn(() => terminateSession);
    const fetchMock = vi.fn<typeof fetch>(() => response.promise);
    vi.stubGlobal("fetch", fetchMock);
    useCsrfStore.getState().setCsrfToken(CSRF_TOKEN);
    queryClient.setQueryData(SENSITIVE_QUERY_KEY, { documentTitle: "Old" });
    renderLogout(queryClient, captureSessionTermination);

    fireEvent.click(screen.getByRole("button", { name: "退出登录" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(captureSessionTermination).toHaveBeenCalledTimes(1);
    useCsrfStore.getState().setCsrfToken(NEW_CSRF_TOKEN);
    queryClient.setQueryData(SENSITIVE_QUERY_KEY, { documentTitle: "New" });
    response.resolve(new Response(null, { status: 204 }));

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "退出登录" })).toHaveAttribute(
        "data-status",
        "success",
      );
      expect(useCsrfStore.getState().csrfToken).toBe(NEW_CSRF_TOKEN);
      expect(queryClient.getQueryData(SENSITIVE_QUERY_KEY)).toEqual({
        documentTitle: "New",
      });
    });
    expect(terminateSession).not.toHaveBeenCalled();
    expect(screen.queryByRole("heading", { name: "登录奇点" })).toBeNull();
  });

  it("waits for route-owned terminal disposal before clearing and navigating", async () => {
    const queryClient = new QueryClient({
      defaultOptions: {
        mutations: { retry: false },
        queries: { retry: false },
      },
    });
    let completeDisposal!: () => void;
    const disposal = new Promise<void>((resolve) => {
      completeDisposal = resolve;
    });
    const terminateSession = vi.fn(() => disposal);
    const captureSessionTermination = vi.fn(() => terminateSession);
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async () => new Response(null, { status: 204 })),
    );
    useCsrfStore.getState().setCsrfToken(CSRF_TOKEN);
    queryClient.setQueryData(SENSITIVE_QUERY_KEY, { documentTitle: "Private" });
    renderLogout(queryClient, captureSessionTermination);

    fireEvent.click(screen.getByRole("button", { name: "退出登录" }));
    await waitFor(() => expect(terminateSession).toHaveBeenCalledTimes(1));
    expect(captureSessionTermination).toHaveBeenCalledTimes(1);
    expect(queryClient.getQueryData(SENSITIVE_QUERY_KEY)).toEqual({
      documentTitle: "Private",
    });
    expect(useCsrfStore.getState().csrfToken).toBe(CSRF_TOKEN);
    expect(screen.queryByRole("heading", { name: "登录奇点" })).toBeNull();

    completeDisposal();
    expect(await screen.findByRole("heading", { name: "登录奇点" })).toBeVisible();
    expect(queryClient.getQueryData(SENSITIVE_QUERY_KEY)).toBeUndefined();
    expect(useCsrfStore.getState().csrfToken).toBeNull();
  });

  it("keeps the session when terminal disposal fails and records the original stack", async () => {
    const queryClient = new QueryClient({
      defaultOptions: {
        mutations: { retry: false },
        queries: { retry: false },
      },
    });
    const failure = new Error("terminal-dispose-stack-sentinel");
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async () => new Response(null, { status: 204 })),
    );
    useCsrfStore.getState().setCsrfToken(CSRF_TOKEN);
    queryClient.setQueryData(SENSITIVE_QUERY_KEY, { documentTitle: "Private" });
    const terminateSession = vi.fn(async () => {
      throw failure;
    });
    const captureSessionTermination = vi.fn(() => terminateSession);
    renderLogout(queryClient, captureSessionTermination);

    fireEvent.click(screen.getByRole("button", { name: "退出登录" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "退出登录" })).toHaveAttribute(
        "data-status",
        "error",
      ),
    );

    expect(queryClient.getQueryData(SENSITIVE_QUERY_KEY)).toEqual({
      documentTitle: "Private",
    });
    expect(useCsrfStore.getState().csrfToken).toBe(CSRF_TOKEN);
    expect(screen.queryByRole("heading", { name: "登录奇点" })).toBeNull();
    expect(failure.stack).toContain("terminal-dispose-stack-sentinel");
    expect(consoleError).toHaveBeenCalledWith(
      "[auth.logout]",
      { phase: "terminal-dispose", result: "failed" },
      failure,
    );
    expect(captureSessionTermination).toHaveBeenCalledTimes(1);
    expect(terminateSession).toHaveBeenCalledTimes(1);
  });
});
