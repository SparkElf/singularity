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
import { TooltipProvider } from "@/components/ui/tooltip.tsx";
import { SpaceAccessPage } from "@/enterprise/SpaceAccessPage.tsx";

const ORGANIZATION_ID = "11111111-1111-4111-8111-111111111111";
const SPACE_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const MEMBER_ID = "22222222-2222-4222-8222-222222222222";
const GROUP_ID = "33333333-3333-4333-8333-333333333333";
const CSRF_TOKEN = "A".repeat(42) + "E";
const REQUEST_ID = "99999999-9999-4999-8999-999999999999";
const SPACE_BASE_PATH =
  `/api/v1/organizations/${ORGANIZATION_ID}/spaces/${SPACE_ID}`;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json" },
    status,
  });
}

function noContentResponse(): Response {
  return new Response(null, { status: 204 });
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}

function createTestQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      mutations: { retry: false },
      queries: { retry: false, staleTime: 0 },
    },
  });
}

function renderSpaceAccessPage(
  queryClient = createTestQueryClient(),
): QueryClient {
  render(
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <MemoryRouter
          initialEntries={[
            `/organizations/${ORGANIZATION_ID}/settings/spaces/${SPACE_ID}/access`,
          ]}
        >
          <Routes>
            <Route
              path="/organizations/:organizationId/settings/spaces/:spaceId/access"
              element={<SpaceAccessPage />}
            />
            <Route path="/login" element={<h1>登录奇点</h1>} />
          </Routes>
        </MemoryRouter>
      </TooltipProvider>
    </QueryClientProvider>,
  );
  return queryClient;
}

afterEach(() => {
  cleanup();
  useCsrfStore.getState().clearCsrfToken();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("SpaceAccessPage delegated administration", () => {
  it("uses space-scoped candidates to grant member and group access", async () => {
    const requestedPaths: string[] = [];
    const mutationRequests: Array<{
      body: Record<string, unknown>;
      csrf: string | null;
      path: string;
    }> = [];
    let directMemberAdded = false;
    let groupGrantAdded = false;
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>((input, init) => {
        const path = new URL(
          input instanceof Request ? input.url : String(input),
          window.location.origin,
        ).pathname;
        requestedPaths.push(path);
        if (
          path === `${SPACE_BASE_PATH}/members/${MEMBER_ID}` &&
          init?.method === "PUT"
        ) {
          mutationRequests.push({
            body: JSON.parse(String(init.body)) as Record<string, unknown>,
            csrf: new Headers(init.headers).get("X-CSRF-Token"),
            path,
          });
          directMemberAdded = true;
          return Promise.resolve(noContentResponse());
        }
        if (
          path === `${SPACE_BASE_PATH}/groups/${GROUP_ID}` &&
          init?.method === "PUT"
        ) {
          mutationRequests.push({
            body: JSON.parse(String(init.body)) as Record<string, unknown>,
            csrf: new Headers(init.headers).get("X-CSRF-Token"),
            path,
          });
          groupGrantAdded = true;
          return Promise.resolve(noContentResponse());
        }
        switch (path) {
          case `${SPACE_BASE_PATH}/members`:
            return Promise.resolve(
              jsonResponse({
                members: directMemberAdded
                  ? [
                      {
                        loginIdentifier: "reader@example.test",
                        role: "viewer",
                        status: "active",
                        userId: MEMBER_ID,
                      },
                    ]
                  : [],
              }),
            );
          case `${SPACE_BASE_PATH}/groups`:
            return Promise.resolve(
              jsonResponse({
                grants: groupGrantAdded
                  ? [
                      {
                        groupId: GROUP_ID,
                        groupName: "资料阅读组",
                        groupStatus: "active",
                        role: "viewer",
                      },
                    ]
                  : [],
              }),
            );
          case `${SPACE_BASE_PATH}/member-candidates`:
            return Promise.resolve(
              jsonResponse({
                members: [
                  {
                    loginIdentifier: "reader@example.test",
                    userId: MEMBER_ID,
                  },
                ],
              }),
            );
          case `${SPACE_BASE_PATH}/group-candidates`:
            return Promise.resolve(
              jsonResponse({
                groups: [
                  {
                    groupId: GROUP_ID,
                    groupName: "资料阅读组",
                    groupStatus: "active",
                  },
                ],
              }),
            );
          default:
            throw new Error(`Unexpected request: ${path}`);
        }
      }),
    );
    useCsrfStore.getState().setCsrfToken(CSRF_TOKEN);

    renderSpaceAccessPage();

    expect(
      await screen.findByRole("option", { name: "reader@example.test" }),
    ).toBeInTheDocument();
    expect(
      await screen.findByRole("option", { name: "资料阅读组" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "添加成员" }),
    ).toBeEnabled();
    expect(
      screen.getByRole("button", { name: "添加授权" }),
    ).toBeEnabled();

    fireEvent.change(screen.getByLabelText("组织成员"), {
      target: { value: MEMBER_ID },
    });
    fireEvent.click(screen.getByRole("button", { name: "添加成员" }));
    await waitFor(() => {
      expect(mutationRequests).toEqual([
        {
          body: { role: "viewer" },
          csrf: CSRF_TOKEN,
          path: `${SPACE_BASE_PATH}/members/${MEMBER_ID}`,
        },
      ]);
    });
    await waitFor(() => {
      expect(
        screen.queryByRole("option", { name: "reader@example.test" }),
      ).not.toBeInTheDocument();
    });

    fireEvent.change(screen.getByLabelText("用户组"), {
      target: { value: GROUP_ID },
    });
    fireEvent.click(screen.getByRole("button", { name: "添加授权" }));
    await waitFor(() => {
      expect(mutationRequests).toEqual([
        {
          body: { role: "viewer" },
          csrf: CSRF_TOKEN,
          path: `${SPACE_BASE_PATH}/members/${MEMBER_ID}`,
        },
        {
          body: { role: "viewer" },
          csrf: CSRF_TOKEN,
          path: `${SPACE_BASE_PATH}/groups/${GROUP_ID}`,
        },
      ]);
    });
    await waitFor(() => {
      expect(
        screen.queryByRole("option", { name: "资料阅读组" }),
      ).not.toBeInTheDocument();
    });
    expect(requestedPaths).toEqual(
      expect.arrayContaining([
        `${SPACE_BASE_PATH}/member-candidates`,
        `${SPACE_BASE_PATH}/group-candidates`,
      ]),
    );
    expect(requestedPaths).not.toContain(
      `/api/v1/organizations/${ORGANIZATION_ID}/members`,
    );
    expect(requestedPaths).not.toContain(
      `/api/v1/organizations/${ORGANIZATION_ID}/groups`,
    );
  });

  it("prioritizes a late unauthenticated query and clears the client session", async () => {
    const candidateResponse = deferred<Response>();
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>((input) => {
        const path = new URL(
          input instanceof Request ? input.url : String(input),
          window.location.origin,
        ).pathname;
        switch (path) {
          case `${SPACE_BASE_PATH}/members`:
            return Promise.resolve(jsonResponse({ members: [] }));
          case `${SPACE_BASE_PATH}/groups`:
            return Promise.resolve(jsonResponse({
              code: "conflict",
              requestId: "88888888-8888-4888-8888-888888888888",
              status: 409,
            }, 409));
          case `${SPACE_BASE_PATH}/member-candidates`:
            return candidateResponse.promise;
          case `${SPACE_BASE_PATH}/group-candidates`:
            return Promise.resolve(jsonResponse({ groups: [] }));
          default:
            throw new Error(`Unexpected request: ${path}`);
        }
      }),
    );
    useCsrfStore.getState().setCsrfToken(CSRF_TOKEN);
    const queryClient = createTestQueryClient();
    queryClient.setQueryData(["sensitive"], { title: "private" });

    renderSpaceAccessPage(queryClient);

    expect(
      await screen.findByRole("heading", { name: "无法加载数据" }),
    ).toBeVisible();
    candidateResponse.resolve(jsonResponse({
      code: "unauthenticated",
      requestId: REQUEST_ID,
      status: 401,
    }, 401));
    expect(await screen.findByRole("heading", { name: "登录奇点" })).toBeVisible();
    expect(useCsrfStore.getState().csrfToken).toBeNull();
    expect(queryClient.getQueryData(["sensitive"])).toBeUndefined();
  });
});
