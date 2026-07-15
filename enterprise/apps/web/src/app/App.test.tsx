import "@testing-library/jest-dom/vitest";
import {
  onlineManager,
  QueryClient,
  QueryClientProvider,
} from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import { App } from "./App.tsx";
import { useCsrfStore } from "@/auth/csrf-store.ts";
import { TooltipProvider } from "@/components/ui/tooltip.tsx";
import {
  authorizedSpacesQueryKey,
  spaceRuntimeQueryKey,
} from "@/spaces/api.ts";

const ORGANIZATION_A = "11111111-1111-4111-8111-111111111111";
const ORGANIZATION_B = "22222222-2222-4222-8222-222222222222";
const SPACE_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SPACE_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const REQUEST_ID = "99999999-9999-4999-8999-999999999999";
const CSRF_TOKEN = "A".repeat(43);

const SPACE_A_SUMMARY = {
  organizationId: ORGANIZATION_A,
  organizationName: "银河研究院",
  spaceId: SPACE_A,
  spaceName: "深空知识空间",
  role: "admin" as const,
};

const SPACE_B_SUMMARY = {
  organizationId: ORGANIZATION_B,
  organizationName: "奇点工程中心",
  spaceId: SPACE_B,
  spaceName: "星际工程手册",
  role: "editor" as const,
};

function spacePath(organizationId: string, spaceId: string): string {
  return `/organizations/${organizationId}/spaces/${spaceId}`;
}

function runtimePath(organizationId: string, spaceId: string): string {
  return `/api/v1/organizations/${organizationId}/spaces/${spaceId}/runtime`;
}

function jsonResponse(body: unknown, status = 200, headers?: HeadersInit) {
  return new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json", ...headers },
    status,
  });
}

function problem(code: "not-found" | "rate-limited" | "unauthenticated", status: number) {
  return { code, requestId: REQUEST_ID, status };
}

function requestPath(input: RequestInfo | URL): string {
  if (input instanceof Request) {
    return new URL(input.url, window.location.origin).pathname;
  }

  return new URL(String(input), window.location.origin).pathname;
}

function requestBodyText(body: BodyInit | null | undefined): string {
  if (typeof body !== "string") {
    throw new TypeError("Expected a JSON string request body");
  }
  return body;
}

function mockFetch(
  handler: (...arguments_: Parameters<typeof fetch>) => Response | Promise<Response>,
) {
  return vi.fn<typeof fetch>((...arguments_) =>
    Promise.resolve().then(() => handler(...arguments_)),
  );
}

function createTestQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: 0 },
      mutations: { retry: false },
    },
  });
}

function renderApp(
  initialEntry: string,
  queryClient = createTestQueryClient(),
) {

  const result = render(
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <MemoryRouter initialEntries={[initialEntry]}>
          <App />
        </MemoryRouter>
      </TooltipProvider>
    </QueryClientProvider>,
  );

  return { ...result, queryClient };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}

afterEach(() => {
  cleanup();
  onlineManager.setOnline(true);
  vi.useRealTimers();
  useCsrfStore.setState({ csrfToken: null });
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("S1 identity and space routes", () => {
  it("logs in and returns to a valid same-origin deep link with the server role", async () => {
    const deepLink = spacePath(ORGANIZATION_A, SPACE_A);
    const fetchMock = mockFetch((input, init) => {
      const path = requestPath(input);
      if (path === "/api/v1/auth/login") {
        expect(init?.method).toBe("POST");
        expect(JSON.parse(requestBodyText(init?.body))).toEqual({
          loginIdentifier: "owner@example.com",
          password: "correct horse battery staple",
        });
        return jsonResponse({ csrfToken: CSRF_TOKEN });
      }
      if (path === "/api/v1/spaces") {
        return jsonResponse({ spaces: [SPACE_A_SUMMARY] });
      }
      if (path === runtimePath(ORGANIZATION_A, SPACE_A)) {
        return jsonResponse({
          organizationId: ORGANIZATION_A,
          spaceId: SPACE_A,
          role: "viewer",
          kernelState: "ready",
        });
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    renderApp(`/login?returnTo=${encodeURIComponent(deepLink)}`);
    fireEvent.change(screen.getByLabelText("账号"), {
      target: { value: " Owner@Example.COM " },
    });
    fireEvent.change(screen.getByLabelText("密码"), {
      target: { value: "correct horse battery staple" },
    });
    fireEvent.click(screen.getByRole("button", { name: "登录" }));

    expect(await screen.findByRole("heading", { name: "空间已就绪" })).toBeVisible();
    expect(screen.getByText("阅读者")).toBeVisible();
    expect(screen.getAllByText("深空知识空间")).toHaveLength(2);
    expect(useCsrfStore.getState().csrfToken).toBe(CSRF_TOKEN);
  });

  it("rejects an external returnTo and shows the authorized empty state", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch((input) => {
        const path = requestPath(input);
        if (path === "/api/v1/auth/login") {
          return jsonResponse({ csrfToken: CSRF_TOKEN });
        }
        if (path === "/api/v1/spaces") {
          return jsonResponse({ spaces: [] });
        }
        throw new Error(`Unexpected request: ${path}`);
      }),
    );

    renderApp("/login?returnTo=https%3A%2F%2Fevil.example%2Fspaces");
    fireEvent.change(screen.getByLabelText("账号"), {
      target: { value: "owner@example.com" },
    });
    fireEvent.change(screen.getByLabelText("密码"), {
      target: { value: "correct horse battery staple" },
    });
    fireEvent.click(screen.getByRole("button", { name: "登录" }));

    expect(
      await screen.findByRole("heading", { name: "尚未获得空间访问权限" }),
    ).toBeVisible();
  });

  it("removes the previous identity's authorization cache before the new identity response", async () => {
    const newIdentitySpaces = deferred<Response>();
    vi.stubGlobal(
      "fetch",
      mockFetch((input) => {
        const path = requestPath(input);
        if (path === "/api/v1/auth/login") {
          return jsonResponse({ csrfToken: CSRF_TOKEN });
        }
        if (path === "/api/v1/spaces") {
          return newIdentitySpaces.promise;
        }
        throw new Error(`Unexpected request: ${path}`);
      }),
    );

    const { queryClient } = renderApp("/login");
    queryClient.setQueryData(authorizedSpacesQueryKey, {
      spaces: [SPACE_A_SUMMARY, SPACE_B_SUMMARY],
    });
    useCsrfStore.setState({ csrfToken: "B".repeat(43) });

    fireEvent.change(screen.getByLabelText("账号"), {
      target: { value: "new-owner@example.com" },
    });
    fireEvent.change(screen.getByLabelText("密码"), {
      target: { value: "correct horse battery staple" },
    });
    fireEvent.click(screen.getByRole("button", { name: "登录" }));

    expect(await screen.findByLabelText("正在加载空间")).toBeVisible();
    expect(screen.queryByText("深空知识空间")).not.toBeInTheDocument();
    expect(screen.queryByText("星际工程手册")).not.toBeInTheDocument();
    expect(queryClient.getQueryData(authorizedSpacesQueryKey)).toBeUndefined();
    expect(useCsrfStore.getState().csrfToken).toBe(CSRF_TOKEN);

    await act(async () => {
      newIdentitySpaces.resolve(jsonResponse({ spaces: [] }));
      await newIdentitySpaces.promise;
    });
    expect(
      await screen.findByRole("heading", {
        name: "尚未获得空间访问权限",
      }),
    ).toBeVisible();
  });

  it("cancels the previous login attempt and ignores its late success", async () => {
    const firstLogin = deferred<Response>();
    let firstSignal: AbortSignal | null | undefined;
    let loginAttempts = 0;
    const submittedPasswords: string[] = [];
    vi.stubGlobal(
      "fetch",
      mockFetch((input, init) => {
        const path = requestPath(input);
        if (path === "/api/v1/auth/login") {
          loginAttempts += 1;
          submittedPasswords.push(
            (JSON.parse(requestBodyText(init?.body)) as { password: string })
              .password,
          );
          if (loginAttempts === 1) {
            firstSignal = init?.signal;
            return firstLogin.promise;
          }
          return jsonResponse({ csrfToken: CSRF_TOKEN });
        }
        if (path === "/api/v1/spaces") {
          return jsonResponse({ spaces: [] });
        }
        throw new Error(`Unexpected request: ${path}`);
      }),
    );

    const { queryClient } = renderApp("/login");
    fireEvent.change(screen.getByLabelText("账号"), {
      target: { value: "owner@example.com" },
    });
    fireEvent.change(screen.getByLabelText("密码"), {
      target: { value: "correct horse battery staple" },
    });
    const submit = screen.getByRole("button", { name: "登录" });
    fireEvent.click(submit);
    await waitFor(() => expect(firstSignal).toBeDefined());
    expect(submit).toBeEnabled();
    fireEvent.change(screen.getByLabelText("密码"), {
      target: { value: "replacement password value" },
    });

    const form = submit.closest("form");
    expect(form).not.toBeNull();
    fireEvent.submit(form!);

    expect(
      await screen.findByRole("heading", {
        name: "尚未获得空间访问权限",
      }),
    ).toBeVisible();
    expect(firstSignal?.aborted).toBe(true);
    expect(useCsrfStore.getState().csrfToken).toBe(CSRF_TOKEN);
    expect(submittedPasswords).toEqual([
      "correct horse battery staple",
      "replacement password value",
    ]);
    queryClient.setQueryData(["current-identity"], { active: true });

    await act(async () => {
      firstLogin.resolve(jsonResponse({ csrfToken: "B".repeat(43) }));
      await firstLogin.promise;
    });

    expect(useCsrfStore.getState().csrfToken).toBe(CSRF_TOKEN);
    expect(queryClient.getQueryData(["current-identity"])).toEqual({
      active: true,
    });
  });

  it("invalid resubmission cancels an earlier login and rejects its late success", async () => {
    const firstLogin = deferred<Response>();
    let firstSignal: AbortSignal | null | undefined;
    const fetchMock = mockFetch((input, init) => {
      const path = requestPath(input);
      if (path === "/api/v1/auth/login") {
        firstSignal = init?.signal;
        return firstLogin.promise;
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const { queryClient } = renderApp("/login");
    fireEvent.change(screen.getByLabelText("账号"), {
      target: { value: "owner@example.com" },
    });
    const password = screen.getByLabelText("密码");
    fireEvent.change(password, {
      target: { value: "correct horse battery staple" },
    });
    const submit = screen.getByRole("button", { name: "登录" });
    fireEvent.click(submit);
    await waitFor(() => expect(firstSignal).toBeDefined());

    fireEvent.change(password, { target: { value: "short" } });
    const form = submit.closest("form");
    expect(form).not.toBeNull();
    fireEvent.submit(form!);

    expect(await screen.findByText("请输入有效的账号和密码。")).toBeVisible();
    expect(firstSignal?.aborted).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    queryClient.setQueryData(["current-page"], { active: true });

    await act(async () => {
      firstLogin.resolve(jsonResponse({ csrfToken: CSRF_TOKEN }));
      await firstLogin.promise;
    });

    expect(screen.getByRole("heading", { name: "登录奇点" })).toBeVisible();
    expect(useCsrfStore.getState().csrfToken).toBeNull();
    expect(queryClient.getQueryData(["current-page"])).toEqual({
      active: true,
    });
  });

  it("aborts an in-flight login when the page unmounts", async () => {
    const loginResponse = deferred<Response>();
    let loginSignal: AbortSignal | null | undefined;
    vi.stubGlobal(
      "fetch",
      mockFetch((input, init) => {
        const path = requestPath(input);
        if (path === "/api/v1/auth/login") {
          loginSignal = init?.signal;
          return loginResponse.promise;
        }
        throw new Error(`Unexpected request: ${path}`);
      }),
    );

    const { queryClient, unmount } = renderApp("/login");
    fireEvent.change(screen.getByLabelText("账号"), {
      target: { value: "owner@example.com" },
    });
    fireEvent.change(screen.getByLabelText("密码"), {
      target: { value: "correct horse battery staple" },
    });
    fireEvent.click(screen.getByRole("button", { name: "登录" }));
    await waitFor(() => expect(loginSignal).toBeDefined());
    queryClient.setQueryData(["current-page"], { active: true });

    unmount();
    expect(loginSignal?.aborted).toBe(true);
    await act(async () => {
      loginResponse.resolve(jsonResponse({ csrfToken: CSRF_TOKEN }));
      await loginResponse.promise;
    });

    expect(useCsrfStore.getState().csrfToken).toBeNull();
    expect(queryClient.getQueryData(["current-page"])).toEqual({
      active: true,
    });
  });

  it("keeps invalid credential failures generic", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch(() => jsonResponse(problem("unauthenticated", 401), 401)),
    );

    renderApp("/login");
    const identifier = screen.getByLabelText("账号");
    const password = screen.getByLabelText("密码");
    fireEvent.change(identifier, { target: { value: "owner@example.com" } });
    fireEvent.change(password, {
      target: { value: "wrong password value" },
    });
    fireEvent.click(screen.getByRole("button", { name: "登录" }));
    expect(await screen.findByText("账号或密码错误。")).toBeVisible();
  });

  it("keeps a rate-limited login disabled until Retry-After expires", async () => {
    vi.useFakeTimers();
    let attempts = 0;
    vi.stubGlobal(
      "fetch",
      mockFetch((input) => {
        const path = requestPath(input);
        if (path === "/api/v1/auth/login") {
          attempts += 1;
          return attempts === 1
            ? jsonResponse(problem("rate-limited", 429), 429, {
                "Retry-After": "2",
              })
            : jsonResponse({ csrfToken: CSRF_TOKEN });
        }
        if (path === "/api/v1/spaces") {
          return jsonResponse({ spaces: [] });
        }
        throw new Error(`Unexpected request: ${path}`);
      }),
    );

    renderApp("/login");
    fireEvent.change(screen.getByLabelText("账号"), {
      target: { value: "owner@example.com" },
    });
    const password = screen.getByLabelText("密码");
    fireEvent.change(password, {
      target: { value: "wrong password value" },
    });
    const submit = screen.getByRole("button", { name: "登录" });
    fireEvent.click(submit);

    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByText("尝试次数过多，请在 2 秒后重试。")).toBeVisible();
    expect(submit).toBeDisabled();

    fireEvent.change(password, {
      target: { value: "correct horse battery staple" },
    });
    expect(screen.getByText("尝试次数过多，请在 2 秒后重试。")).toBeVisible();
    expect(submit).toBeDisabled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(screen.getByText("尝试次数过多，请在 1 秒后重试。")).toBeVisible();
    expect(submit).toBeDisabled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(screen.getByText("尝试次数过多，现在可以重试。")).toBeVisible();
    expect(submit).toBeEnabled();

    fireEvent.click(submit);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByRole("heading", { name: "选择知识空间" })).toBeVisible();
    expect(attempts).toBe(2);
    expect(useCsrfStore.getState().csrfToken).toBe(CSRF_TOKEN);
  });

  it.each([
    ["缺失", undefined],
    ["非正整数", "0"],
  ])("treats a %s Retry-After as a response contract error", async (_label, retryAfter) => {
    vi.stubGlobal(
      "fetch",
      mockFetch(() =>
        jsonResponse(
          problem("rate-limited", 429),
          429,
          retryAfter ? { "Retry-After": retryAfter } : undefined,
        ),
      ),
    );

    renderApp("/login");
    fireEvent.change(screen.getByLabelText("账号"), {
      target: { value: "owner@example.com" },
    });
    fireEvent.change(screen.getByLabelText("密码"), {
      target: { value: "wrong password value" },
    });
    const submit = screen.getByRole("button", { name: "登录" });
    fireEvent.click(submit);

    expect(await screen.findByText("登录失败，请稍后重试。")).toBeVisible();
    expect(submit).toBeEnabled();
  });

  it("renders only the authorized multi-space collection and filters it locally", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch((input) => {
        const path = requestPath(input);
        if (path === "/api/v1/spaces") {
          return jsonResponse({ spaces: [SPACE_A_SUMMARY, SPACE_B_SUMMARY] });
        }
        throw new Error(`Unexpected request: ${path}`);
      }),
    );

    renderApp("/spaces");
    expect(await screen.findByRole("link", { name: /深空知识空间/ })).toBeVisible();
    expect(screen.getByRole("link", { name: /星际工程手册/ })).toBeVisible();

    fireEvent.change(screen.getByLabelText("搜索空间"), {
      target: { value: "工程中心" },
    });
    expect(screen.queryByRole("link", { name: /深空知识空间/ })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: /星际工程手册/ })).toBeVisible();

    fireEvent.change(screen.getByLabelText("搜索空间"), {
      target: { value: "不存在" },
    });
    expect(screen.getByRole("heading", { name: "没有匹配的空间" })).toBeVisible();
  });

  it("does not auto-enter a cached single space while authorization is revalidating", async () => {
    const freshAuthorization = deferred<Response>();
    const requestedPaths: string[] = [];
    vi.stubGlobal(
      "fetch",
      mockFetch((input) => {
        const path = requestPath(input);
        requestedPaths.push(path);
        if (path === "/api/v1/spaces") {
          return freshAuthorization.promise;
        }
        throw new Error(`Unexpected request: ${path}`);
      }),
    );
    const queryClient = createTestQueryClient();
    queryClient.setQueryData(authorizedSpacesQueryKey, {
      spaces: [SPACE_A_SUMMARY],
    });

    renderApp("/spaces", queryClient);
    expect(screen.getByLabelText("正在加载空间")).toBeVisible();
    expect(screen.queryByText("深空知识空间")).not.toBeInTheDocument();
    await waitFor(() =>
      expect(requestedPaths).toEqual(["/api/v1/spaces"]),
    );

    await act(async () => {
      freshAuthorization.resolve(
        jsonResponse({ spaces: [SPACE_A_SUMMARY, SPACE_B_SUMMARY] }),
      );
      await freshAuthorization.promise;
    });

    expect(
      await screen.findByRole("link", { name: /深空知识空间/ }),
    ).toBeVisible();
    expect(screen.getByRole("link", { name: /星际工程手册/ })).toBeVisible();
    expect(requestedPaths).toEqual(["/api/v1/spaces"]);
  });

  it("does not trust cached authorization when the spaces refetch is paused offline", () => {
    const fetchMock = mockFetch(() => {
      throw new Error("Offline queries must remain paused");
    });
    vi.stubGlobal("fetch", fetchMock);
    const queryClient = createTestQueryClient();
    queryClient.setQueryData(authorizedSpacesQueryKey, {
      spaces: [SPACE_A_SUMMARY],
    });
    onlineManager.setOnline(false);

    renderApp("/spaces", queryClient);

    expect(
      screen.getByRole("heading", { name: "无法加载空间" }),
    ).toBeVisible();
    expect(screen.getByText("无法连接到服务，请检查网络后重试。")).toBeVisible();
    expect(screen.queryByText("深空知识空间")).not.toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("hides cached space identity and ready state until both revalidations succeed", async () => {
    const freshAuthorization = deferred<Response>();
    const freshRuntime = deferred<Response>();
    vi.stubGlobal(
      "fetch",
      mockFetch((input) => {
        const path = requestPath(input);
        if (path === "/api/v1/spaces") {
          return freshAuthorization.promise;
        }
        if (path === runtimePath(ORGANIZATION_A, SPACE_A)) {
          return freshRuntime.promise;
        }
        throw new Error(`Unexpected request: ${path}`);
      }),
    );
    const queryClient = createTestQueryClient();
    queryClient.setQueryData(authorizedSpacesQueryKey, {
      spaces: [SPACE_A_SUMMARY],
    });
    queryClient.setQueryData(
      spaceRuntimeQueryKey({
        organizationId: ORGANIZATION_A,
        spaceId: SPACE_A,
      }),
      {
        organizationId: ORGANIZATION_A,
        spaceId: SPACE_A,
        role: "admin",
        kernelState: "ready",
      },
    );

    renderApp(spacePath(ORGANIZATION_A, SPACE_A), queryClient);
    expect(screen.getByRole("heading", { name: "正在加载空间" })).toBeVisible();
    expect(screen.queryByText("深空知识空间")).not.toBeInTheDocument();
    expect(screen.queryByText("管理员")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: "空间已就绪" }),
    ).not.toBeInTheDocument();

    await act(async () => {
      freshAuthorization.resolve(
        jsonResponse({ spaces: [SPACE_A_SUMMARY] }),
      );
      freshRuntime.resolve(
        jsonResponse({
          organizationId: ORGANIZATION_A,
          spaceId: SPACE_A,
          role: "viewer",
          kernelState: "ready",
        }),
      );
      await Promise.all([freshAuthorization.promise, freshRuntime.promise]);
    });

    expect(
      await screen.findByRole("heading", { name: "空间已就绪" }),
    ).toBeVisible();
    expect(screen.getByText("阅读者")).toBeVisible();
    expect(screen.queryByText("管理员")).not.toBeInTheDocument();
  });

  it("does not trust cached workspace authorization or runtime while offline", () => {
    const fetchMock = mockFetch(() => {
      throw new Error("Offline queries must remain paused");
    });
    vi.stubGlobal("fetch", fetchMock);
    const queryClient = createTestQueryClient();
    queryClient.setQueryData(authorizedSpacesQueryKey, {
      spaces: [SPACE_A_SUMMARY],
    });
    queryClient.setQueryData(
      spaceRuntimeQueryKey({
        organizationId: ORGANIZATION_A,
        spaceId: SPACE_A,
      }),
      {
        organizationId: ORGANIZATION_A,
        spaceId: SPACE_A,
        role: "admin",
        kernelState: "ready",
      },
    );
    onlineManager.setOnline(false);

    renderApp(spacePath(ORGANIZATION_A, SPACE_A), queryClient);

    expect(
      screen.getByRole("heading", { name: "无法加载空间" }),
    ).toBeVisible();
    expect(screen.getByText("无法连接到服务，请检查网络后重试。")).toBeVisible();
    expect(screen.queryByText("深空知识空间")).not.toBeInTheDocument();
    expect(screen.queryByText("管理员")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: "空间已就绪" }),
    ).not.toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("shows an explicitly requested list after returning from a single space", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch((input) => {
        const path = requestPath(input);
        if (path === "/api/v1/spaces") {
          return jsonResponse({ spaces: [SPACE_A_SUMMARY] });
        }
        if (path === runtimePath(ORGANIZATION_A, SPACE_A)) {
          return jsonResponse({
            organizationId: ORGANIZATION_A,
            spaceId: SPACE_A,
            role: "admin",
            kernelState: "ready",
          });
        }
        throw new Error(`Unexpected request: ${path}`);
      }),
    );

    renderApp("/spaces");
    expect(
      await screen.findByRole("heading", { name: "空间已就绪" }),
    ).toBeVisible();
    fireEvent.click(screen.getByRole("link", { name: "返回空间列表" }));

    expect(
      await screen.findByRole("heading", { name: "选择知识空间" }),
    ).toBeVisible();
    expect(
      await screen.findByRole("link", { name: /深空知识空间/ }),
    ).toBeVisible();
    expect(
      screen.queryByRole("heading", { name: "空间已就绪" }),
    ).not.toBeInTheDocument();
  });

  it("clears all client session state after a protected query returns 401", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch(() =>
        jsonResponse(problem("unauthenticated", 401), 401),
      ),
    );
    useCsrfStore.setState({ csrfToken: CSRF_TOKEN });
    const { queryClient } = renderApp("/spaces");
    queryClient.setQueryData(["sensitive"], { title: "private" });

    expect(await screen.findByRole("heading", { name: "登录奇点" })).toBeVisible();
    await waitFor(() => {
      expect(queryClient.getQueryCache().getAll()).toHaveLength(0);
      expect(useCsrfStore.getState().csrfToken).toBeNull();
    });
  });

  it("shows an unavailable content service without creating ready UI", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch((input) => {
        const path = requestPath(input);
        if (path === "/api/v1/spaces") {
          return jsonResponse({ spaces: [SPACE_A_SUMMARY] });
        }
        if (path === runtimePath(ORGANIZATION_A, SPACE_A)) {
          return jsonResponse({
            organizationId: ORGANIZATION_A,
            spaceId: SPACE_A,
            role: "admin",
            kernelState: "unavailable",
          });
        }
        throw new Error(`Unexpected request: ${path}`);
      }),
    );

    renderApp(spacePath(ORGANIZATION_A, SPACE_A));
    expect(
      await screen.findByRole("heading", { name: "内容服务暂不可用" }),
    ).toBeVisible();
    expect(
      screen.queryByRole("heading", { name: "空间已就绪" }),
    ).not.toBeInTheDocument();
  });

  it("keeps a browser network failure distinct from service unavailability", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch((input) => {
        const path = requestPath(input);
        if (path === "/api/v1/spaces") {
          return jsonResponse({ spaces: [SPACE_A_SUMMARY] });
        }
        if (path === runtimePath(ORGANIZATION_A, SPACE_A)) {
          return Promise.reject(new TypeError("network unavailable"));
        }
        throw new Error(`Unexpected request: ${path}`);
      }),
    );

    renderApp(spacePath(ORGANIZATION_A, SPACE_A));
    expect(
      await screen.findByRole("heading", { name: "无法加载空间" }),
    ).toBeVisible();
    expect(screen.getByText("无法连接到服务，请检查网络后重试。")).toBeVisible();
    expect(
      screen.queryByRole("heading", { name: "内容服务暂不可用" }),
    ).not.toBeInTheDocument();
  });

  it("hides a revoked space immediately and revalidates the authorization list", async () => {
    let authorizationRequests = 0;
    vi.stubGlobal(
      "fetch",
      mockFetch((input) => {
        const path = requestPath(input);
        if (path === "/api/v1/spaces") {
          authorizationRequests += 1;
          return jsonResponse({
            spaces:
              authorizationRequests === 1
                ? [SPACE_A_SUMMARY, SPACE_B_SUMMARY]
                : [SPACE_B_SUMMARY],
          });
        }
        if (path === runtimePath(ORGANIZATION_A, SPACE_A)) {
          return jsonResponse(problem("not-found", 404), 404);
        }
        throw new Error(`Unexpected request: ${path}`);
      }),
    );

    renderApp(spacePath(ORGANIZATION_A, SPACE_A));
    expect(await screen.findByRole("heading", { name: "找不到该空间" })).toBeVisible();
    expect(screen.queryByText("深空知识空间")).not.toBeInTheDocument();
    expect(screen.queryByText("管理员")).not.toBeInTheDocument();
    await waitFor(() => expect(authorizationRequests).toBe(2));
    expect(screen.getByText("星际工程手册")).toBeVisible();
  });

  it("auto-enters one space and polls only while visible with a 30-attempt limit", async () => {
    let visibility: DocumentVisibilityState = "hidden";
    vi.spyOn(document, "visibilityState", "get").mockImplementation(
      () => visibility,
    );
    let runtimeRequests = 0;
    vi.stubGlobal(
      "fetch",
      mockFetch((input) => {
        const path = requestPath(input);
        if (path === "/api/v1/spaces") {
          return jsonResponse({ spaces: [SPACE_A_SUMMARY] });
        }
        if (path === runtimePath(ORGANIZATION_A, SPACE_A)) {
          runtimeRequests += 1;
          return jsonResponse({
            organizationId: ORGANIZATION_A,
            spaceId: SPACE_A,
            role: "admin",
            kernelState: "starting",
          });
        }
        throw new Error(`Unexpected request: ${path}`);
      }),
    );

    renderApp("/spaces");
    expect(await screen.findByRole("heading", { name: "空间正在启动" })).toBeVisible();
    expect(runtimeRequests).toBe(1);

    vi.useFakeTimers();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(runtimeRequests).toBe(1);

    visibility = "visible";
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    for (let attempt = 0; attempt < 30; attempt += 1) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2_000);
      });
    }
    expect(runtimeRequests).toBe(31);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(runtimeRequests).toBe(31);
    expect(screen.getByText("内容服务仍在启动，请稍后重试。")).toBeVisible();
  });

  it("does not let a late response from the previous route replace the current space", async () => {
    const firstRuntime = deferred<Response>();
    vi.stubGlobal(
      "fetch",
      mockFetch((input) => {
        const path = requestPath(input);
        if (path === "/api/v1/spaces") {
          return jsonResponse({ spaces: [SPACE_A_SUMMARY, SPACE_B_SUMMARY] });
        }
        if (path === runtimePath(ORGANIZATION_A, SPACE_A)) {
          return firstRuntime.promise;
        }
        if (path === runtimePath(ORGANIZATION_B, SPACE_B)) {
          return jsonResponse({
            organizationId: ORGANIZATION_B,
            spaceId: SPACE_B,
            role: "editor",
            kernelState: "ready",
          });
        }
        throw new Error(`Unexpected request: ${path}`);
      }),
    );

    renderApp("/spaces");
    fireEvent.click(await screen.findByRole("link", { name: /深空知识空间/ }));
    fireEvent.click(await screen.findByRole("link", { name: "星际工程手册" }));
    expect(await screen.findByRole("heading", { name: "空间已就绪" })).toBeVisible();
    expect(screen.getAllByText("星际工程手册")).toHaveLength(2);

    await act(async () => {
      firstRuntime.resolve(
        jsonResponse({
          organizationId: ORGANIZATION_A,
          spaceId: SPACE_A,
          role: "admin",
          kernelState: "unavailable",
        }),
      );
      await firstRuntime.promise;
    });

    expect(screen.getByRole("heading", { name: "空间已就绪" })).toBeVisible();
    expect(screen.queryByText("内容服务暂不可用")).not.toBeInTheDocument();
    expect(screen.getAllByText("星际工程手册")).toHaveLength(2);
  });
});
