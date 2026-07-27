import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ProvisioningPage } from "@/auth/ProvisioningPage.tsx";
import { useCsrfStore } from "@/auth/csrf-store.ts";

const CSRF_TOKEN = "A".repeat(42) + "E";
const PASSWORD = "correct horse battery staple";
const REQUEST_ID = "99999999-9999-4999-8999-999999999999";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json" },
    status,
  });
}

function requestPath(input: RequestInfo | URL): string {
  const value = input instanceof Request ? input.url : String(input);
  return new URL(value, window.location.origin).pathname;
}

function renderPage(mode: "register" | "setup") {
  const queryClient = new QueryClient({
    defaultOptions: {
      mutations: { retry: false },
      queries: { retry: false, staleTime: 0 },
    },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[`/${mode}`]}>
        <Routes>
          <Route path={`/${mode}`} element={<ProvisioningPage mode={mode} />} />
          <Route path="/spaces" element={<h1>空间列表</h1>} />
          <Route path="/login" element={<h1>登录</h1>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  useCsrfStore.getState().clearCsrfToken();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("ProvisioningPage", () => {
  it("explains that deployment creates the fixed administrator", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async (_input, init) => {
        expect(init?.method ?? "GET").toBe("GET");
        return jsonResponse({ initialized: false });
      }),
    );

    renderPage("setup");
    expect(await screen.findByText(/系统尚未完成首次部署/)).toBeVisible();
    expect(screen.queryByRole("button", { name: "创建管理员" })).not.toBeInTheDocument();
  });

  it("explains how to sign in after the installation is initialized", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async (_input, init) => {
        expect(init?.method ?? "GET").toBe("GET");
        return jsonResponse({ initialized: true });
      }),
    );

    renderPage("setup");
    expect(await screen.findByText(/系统已完成首次初始化/)).toBeVisible();
    expect(screen.getByText("admin")).toBeVisible();
    expect(screen.queryByLabelText("账号")).not.toBeInTheDocument();
  });

  it("keeps registration available without reading an access switch", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);
    renderPage("register");

    expect(await screen.findByLabelText("账号")).toBeVisible();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.getByRole("link", { name: "返回登录" })).toHaveAttribute(
      "href",
      "/login",
    );
  });

  it("registers a local user without a registration flag", async () => {
    const bodies: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async (input, init) => {
        const path = requestPath(input);
        if (path === "/api/v1/auth/register" && init?.method === "POST") {
          bodies.push(JSON.parse(String(init.body)) as unknown);
          return jsonResponse({ csrfToken: CSRF_TOKEN });
        }
        throw new Error(`Unexpected request: ${path}`);
      }),
    );

    renderPage("register");
    const loginField = await screen.findByLabelText("账号");
    fireEvent.change(loginField, {
      target: { value: "member@example.com" },
    });
    fireEvent.change(screen.getByLabelText("密码"), {
      target: { value: PASSWORD },
    });
    fireEvent.change(screen.getByLabelText("确认密码"), {
      target: { value: PASSWORD },
    });
    fireEvent.click(screen.getByRole("button", { name: "注册新账号" }));

    expect(await screen.findByRole("heading", { name: "空间列表" })).toBeVisible();
    expect(bodies).toEqual([
      {
        loginIdentifier: "member@example.com",
        password: PASSWORD,
      },
    ]);
  });

  it("clears a duplicate-account error when the user edits the form", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async (input, init) => {
        const path = requestPath(input);
        if (path === "/api/v1/auth/register" && init?.method === "POST") {
          return jsonResponse(
            { code: "conflict", requestId: REQUEST_ID, status: 409 },
            409,
          );
        }
        throw new Error(`Unexpected request: ${path}`);
      }),
    );

    renderPage("register");
    fireEvent.change(await screen.findByLabelText("账号"), {
      target: { value: "member@example.com" },
    });
    fireEvent.change(screen.getByLabelText("密码"), {
      target: { value: PASSWORD },
    });
    fireEvent.change(screen.getByLabelText("确认密码"), {
      target: { value: PASSWORD },
    });
    fireEvent.click(screen.getByRole("button", { name: "注册新账号" }));

    expect(await screen.findByText("这个账号已被注册，请换一个账号。"))
      .toBeVisible();
    fireEvent.change(screen.getByLabelText("账号"), {
      target: { value: "another@example.com" },
    });
    expect(screen.queryByText("这个账号已被注册，请换一个账号。"))
      .not.toBeInTheDocument();
  });
});
