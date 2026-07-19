import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useCsrfStore } from "@/auth/csrf-store.ts";
import { InvitationAcceptPage } from "@/enterprise/InvitationAcceptPage.tsx";

const INVITATION_TOKEN = "I".repeat(43);
const CSRF_TOKEN = "A".repeat(43);
const PASSWORD = "correct horse battery staple";
const CSRF_PATH = "/api/v1/auth/csrf";
const PROVIDERS_PATH = "/api/v1/auth/oidc/providers";
const ACCEPT_PATH = "/api/v1/auth/invitations/accept";
const ACCEPT_LOCAL_PATH = "/api/v1/auth/invitations/accept-local";
const OIDC_START_PATH = "/api/v1/auth/oidc/start";
const PROVIDER_ID = "33333333-3333-4333-8333-333333333333";

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json" },
    status: 200,
  });
}

function noContentResponse(): Response {
  return new Response(null, { status: 204 });
}

function requestPath(input: RequestInfo | URL): string {
  const value = input instanceof Request ? input.url : String(input);
  return new URL(value, window.location.origin).pathname;
}

function renderInvitationAcceptPage(): void {
  const queryClient = new QueryClient({
    defaultOptions: {
      mutations: { retry: false },
      queries: { retry: false, staleTime: 0 },
    },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter
        initialEntries={[
          `/invitations/accept?token=${encodeURIComponent(INVITATION_TOKEN)}`,
        ]}
      >
        <Routes>
          <Route
            path="/invitations/accept"
            element={<InvitationAcceptPage />}
          />
          <Route path="/spaces" element={<h1>知识空间入口</h1>} />
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

describe("InvitationAcceptPage account workflows", () => {
  it("accepts the invitation with a newly created local account", async () => {
    const acceptedRequests: Array<Record<string, unknown>> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>((input, init) => {
        const path = requestPath(input);
        if (path === PROVIDERS_PATH) {
          return Promise.resolve(jsonResponse({ providers: [] }));
        }
        if (path === ACCEPT_LOCAL_PATH && init?.method === "POST") {
          acceptedRequests.push(
            JSON.parse(String(init.body)) as Record<string, unknown>,
          );
          return Promise.resolve(jsonResponse({ csrfToken: CSRF_TOKEN }));
        }
        throw new Error(`Unexpected request: ${path}`);
      }),
    );

    renderInvitationAcceptPage();

    fireEvent.change(screen.getByLabelText("密码"), {
      target: { value: PASSWORD },
    });
    fireEvent.change(screen.getByLabelText("确认密码"), {
      target: { value: PASSWORD },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "创建并接受邀请" }),
    );

    expect(
      await screen.findByRole("heading", { name: "知识空间入口" }),
    ).toBeVisible();
    expect(acceptedRequests).toEqual([
      { invitationToken: INVITATION_TOKEN, password: PASSWORD },
    ]);
    expect(useCsrfStore.getState().csrfToken).toBe(CSRF_TOKEN);
  });

  it("obtains CSRF protection before accepting with the current account", async () => {
    const acceptedRequests: Array<{
      body: Record<string, unknown>;
      csrf: string | null;
    }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>((input, init) => {
        const path = requestPath(input);
        if (path === PROVIDERS_PATH) {
          return Promise.resolve(jsonResponse({ providers: [] }));
        }
        if (path === CSRF_PATH) {
          return Promise.resolve(jsonResponse({ csrfToken: CSRF_TOKEN }));
        }
        if (path === ACCEPT_PATH && init?.method === "POST") {
          acceptedRequests.push({
            body: JSON.parse(String(init.body)) as Record<string, unknown>,
            csrf: new Headers(init.headers).get("X-CSRF-Token"),
          });
          return Promise.resolve(noContentResponse());
        }
        throw new Error(`Unexpected request: ${path}`);
      }),
    );

    renderInvitationAcceptPage();

    fireEvent.click(screen.getByRole("button", { name: "使用当前账号" }));

    expect(
      await screen.findByRole("heading", { name: "知识空间入口" }),
    ).toBeVisible();
    await waitFor(() => {
      expect(acceptedRequests).toEqual([
        {
          body: { invitationToken: INVITATION_TOKEN },
          csrf: CSRF_TOKEN,
        },
      ]);
    });
    expect(useCsrfStore.getState().csrfToken).toBe(CSRF_TOKEN);
  });

  it("passes the invitation identity into the selected OIDC flow", async () => {
    const startRequests: Array<Record<string, unknown>> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>((input, init) => {
        const path = requestPath(input);
        if (path === PROVIDERS_PATH) {
          return Promise.resolve(
            jsonResponse({
              providers: [{ name: "Corporate SSO", providerId: PROVIDER_ID }],
            }),
          );
        }
        if (path === OIDC_START_PATH && init?.method === "POST") {
          startRequests.push(
            JSON.parse(String(init.body)) as Record<string, unknown>,
          );
          return Promise.resolve(
            new Response(
              JSON.stringify({
                code: "service-unavailable",
                requestId: "99999999-9999-4999-8999-999999999999",
                status: 503,
              }),
              {
                headers: { "Content-Type": "application/json" },
                status: 503,
              },
            ),
          );
        }
        throw new Error(`Unexpected request: ${path}`);
      }),
    );

    renderInvitationAcceptPage();
    fireEvent.click(
      await screen.findByRole("button", { name: "Corporate SSO" }),
    );

    expect(
      await screen.findByText(/依赖服务当前不可用，请稍后重试。/),
    ).toBeVisible();
    expect(startRequests).toEqual([
      {
        invitationToken: INVITATION_TOKEN,
        providerId: PROVIDER_ID,
        returnTo: "/spaces",
      },
    ]);
  });

  it("clears stale client session state when the current account is unauthenticated", async () => {
    useCsrfStore.getState().setCsrfToken(CSRF_TOKEN);
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>((input, init) => {
        const path = requestPath(input);
        if (path === PROVIDERS_PATH) {
          return Promise.resolve(jsonResponse({ providers: [] }));
        }
        if (path === ACCEPT_PATH && init?.method === "POST") {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                code: "unauthenticated",
                requestId: "99999999-9999-4999-8999-999999999999",
                status: 401,
              }),
              {
                headers: { "Content-Type": "application/json" },
                status: 401,
              },
            ),
          );
        }
        throw new Error(`Unexpected request: ${path}`);
      }),
    );

    renderInvitationAcceptPage();
    fireEvent.click(screen.getByRole("button", { name: "使用当前账号" }));

    expect(
      await screen.findByText("登录状态已失效。 请求编号：99999999-9999-4999-8999-999999999999"),
    ).toBeVisible();
    expect(useCsrfStore.getState().csrfToken).toBeNull();
  });
});
