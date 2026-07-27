import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, describe, expect, test, vi } from "vitest";

import { ResetPasswordPage } from "@/auth/ResetPasswordPage.tsx";

const TOKEN = "A".repeat(42) + "E";
const PASSWORD = "correct horse battery staple";

function renderPage(entry = `/reset-password?token=${TOKEN}`) {
  const queryClient = new QueryClient({
    defaultOptions: { mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[entry]}>
        <Routes>
          <Route path="/reset-password" element={<ResetPasswordPage />} />
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

describe("ResetPasswordPage", () => {
  test("requires matching passwords before sending the reset request", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);
    renderPage();

    fireEvent.change(await screen.findByLabelText("新密码"), {
      target: { value: PASSWORD },
    });
    fireEvent.change(screen.getByLabelText("确认新密码"), {
      target: { value: `${PASSWORD}!` },
    });
    fireEvent.click(screen.getByRole("button", { name: "设置新密码" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("两次输入的密码不一致");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("clears the session and returns to login after a successful reset", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async () => new Response(null, { status: 204 })),
    );
    renderPage();

    fireEvent.change(await screen.findByLabelText("新密码"), {
      target: { value: PASSWORD },
    });
    fireEvent.change(screen.getByLabelText("确认新密码"), {
      target: { value: PASSWORD },
    });
    fireEvent.click(screen.getByRole("button", { name: "设置新密码" }));

    expect(await screen.findByRole("heading", { name: "登录" })).toBeVisible();
  });

  test("does not send a request for a malformed link", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);
    renderPage("/reset-password?token=invalid");

    expect(screen.getByRole("alert")).toHaveTextContent("这个重置链接已失效");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
