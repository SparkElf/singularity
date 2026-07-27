import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, describe, expect, test, vi } from "vitest";

import { ForgotPasswordPage } from "@/auth/ForgotPasswordPage.tsx";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json" },
    status,
  });
}

function renderPage() {
  const queryClient = new QueryClient({
    defaultOptions: { mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={["/forgot-password"]}>
        <Routes>
          <Route path="/forgot-password" element={<ForgotPasswordPage />} />
          <Route path="/login" element={<h1>登录</h1>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("ForgotPasswordPage", () => {
  test("shows a uniform accepted state and sends only the normalized email", async () => {
    const bodies: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async (_input, init) => {
        bodies.push(JSON.parse(String(init?.body)) as unknown);
        return jsonResponse({ accepted: true }, 202);
      }),
    );

    renderPage();
    fireEvent.change(await screen.findByLabelText("邮箱"), {
      target: { value: " Member@Example.com " },
    });
    fireEvent.click(screen.getByRole("button", { name: "发送重置邮件" }));

    expect(await screen.findByRole("status")).toHaveTextContent(
      "如果该邮箱已注册，你会收到一封密码重置邮件",
    );
    expect(bodies).toEqual([{ email: "member@example.com" }]);
  });

  test("shows configuration failure without revealing account information", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async () =>
        jsonResponse(
          {
            code: "service-unavailable",
            requestId: "00000000-0000-4000-8000-000000000001",
            status: 503,
          },
          503,
        ),
      ),
    );

    renderPage();
    fireEvent.change(await screen.findByLabelText("邮箱"), {
      target: { value: "member@example.com" },
    });
    fireEvent.click(screen.getByRole("button", { name: "发送重置邮件" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "密码找回服务尚未配置，请联系管理员",
    );
  });
});
