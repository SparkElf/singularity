import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useCsrfStore } from "@/auth/csrf-store.ts";
import { TooltipProvider } from "@/components/ui/tooltip.tsx";
import { GroupsPage } from "@/enterprise/GroupsPage.tsx";

const ORGANIZATION_ID = "11111111-1111-4111-8111-111111111111";
const GROUP_ID = "22222222-2222-4222-8222-222222222222";
const MEMBER_ID = "33333333-3333-4333-8333-333333333333";
const DISABLED_MEMBER_ID = "44444444-4444-4444-8444-444444444444";
const CSRF_TOKEN = "A".repeat(42) + "E";
const GROUPS_PATH = `/api/v1/organizations/${ORGANIZATION_ID}/groups`;
const MEMBERS_PATH = `/api/v1/organizations/${ORGANIZATION_ID}/members`;
const GROUP_MEMBERS_PATH = `${GROUPS_PATH}/${GROUP_ID}/members`;
const GROUP_MEMBER_PATH = `${GROUP_MEMBERS_PATH}/${MEMBER_ID}`;

const group = {
  groupId: GROUP_ID,
  memberCount: 0,
  name: "资料组",
  organizationId: ORGANIZATION_ID,
  status: "active" as const,
};

const member = {
  accountStatus: "active" as const,
  loginIdentifier: "reader@example.test",
  role: "member" as const,
  status: "active" as const,
  userId: MEMBER_ID,
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json" },
    status,
  });
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}

function noContentResponse(): Response {
  return new Response(null, { status: 204 });
}

function requestPath(input: RequestInfo | URL): string {
  const value = input instanceof Request ? input.url : String(input);
  return new URL(value, window.location.origin).pathname;
}

function createTestQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      mutations: { retry: false },
      queries: { retry: false, staleTime: 0 },
    },
  });
}

function renderGroupsPage(
  queryClient = createTestQueryClient(),
): QueryClient {
  render(
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <MemoryRouter
          initialEntries={[`/organizations/${ORGANIZATION_ID}/settings/groups`]}
        >
          <Routes>
            <Route
              path="/organizations/:organizationId/settings/groups"
              element={<GroupsPage />}
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

describe("GroupsPage management workflows", () => {
  it("prioritizes a later unauthenticated query over an earlier ordinary error", async () => {
    const membersResponse = deferred<Response>();
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>((input) => {
        const path = requestPath(input);
        if (path === GROUPS_PATH) {
          return Promise.resolve(
            jsonResponse(
              {
                code: "conflict",
                requestId: "55555555-5555-4555-8555-555555555555",
                status: 409,
              },
              409,
            ),
          );
        }
        if (path === MEMBERS_PATH) {
          return membersResponse.promise;
        }
        throw new Error(`Unexpected request: ${path}`);
      }),
    );
    useCsrfStore.getState().setCsrfToken(CSRF_TOKEN);
    const queryClient = createTestQueryClient();
    queryClient.setQueryData(["sensitive"], { title: "private" });

    renderGroupsPage(queryClient);

    expect(
      await screen.findByRole("heading", { name: "无法加载数据" }),
    ).toBeVisible();
    membersResponse.resolve(
      jsonResponse(
        {
          code: "unauthenticated",
          requestId: "66666666-6666-4666-8666-666666666666",
          status: 401,
        },
        401,
      ),
    );

    expect(
      await screen.findByRole("heading", { name: "登录奇点" }),
    ).toBeVisible();
    expect(useCsrfStore.getState().csrfToken).toBeNull();
    expect(queryClient.getQueryData(["sensitive"])).toBeUndefined();
  });

  it("creates, renames, and disables a user group", async () => {
    let groups: Array<{
      groupId: string;
      memberCount: number;
      name: string;
      organizationId: string;
      status: "active" | "disabled";
    }> = [];
    const createdRequests: Array<Record<string, unknown>> = [];
    const updatedRequests: Array<Record<string, unknown>> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>((input, init) => {
        const path = requestPath(input);
        if (path === GROUPS_PATH && init?.method === "POST") {
          createdRequests.push(
            JSON.parse(String(init.body)) as Record<string, unknown>,
          );
          groups = [group];
          return Promise.resolve(jsonResponse(group));
        }
        if (path === `${GROUPS_PATH}/${GROUP_ID}` && init?.method === "PATCH") {
          const request = JSON.parse(String(init.body)) as {
            name: string;
            status: "active" | "disabled";
          };
          updatedRequests.push(request);
          groups = [{ ...group, name: request.name, status: request.status }];
          return Promise.resolve(jsonResponse(groups[0]));
        }
        if (path === GROUPS_PATH) {
          return Promise.resolve(jsonResponse({ groups }));
        }
        if (path === MEMBERS_PATH) {
          return Promise.resolve(jsonResponse({ members: [] }));
        }
        throw new Error(`Unexpected request: ${path}`);
      }),
    );
    useCsrfStore.getState().setCsrfToken(CSRF_TOKEN);

    renderGroupsPage();

    expect(await screen.findByText("暂无用户组")).toBeVisible();
    fireEvent.change(screen.getByLabelText("组名"), {
      target: { value: "  资料组  " },
    });
    fireEvent.click(screen.getByRole("button", { name: "创建用户组" }));

    await waitFor(() => {
      expect(createdRequests).toEqual([{ name: "资料组" }]);
    });
    expect(await screen.findByDisplayValue("资料组")).toBeVisible();

    fireEvent.change(screen.getByLabelText("用户组名称"), {
      target: { value: "资料归档组" },
    });
    fireEvent.change(screen.getByLabelText("用户组状态"), {
      target: { value: "disabled" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() => {
      expect(updatedRequests).toEqual([
        { name: "资料归档组", status: "disabled" },
      ]);
    });
    expect(await screen.findByDisplayValue("资料归档组")).toBeVisible();
    expect(screen.getByLabelText("用户组状态")).toHaveValue("disabled");
  });

  it("adds and removes an active organization member", async () => {
    let memberAdded = false;
    const membershipRequests: Array<{
      csrf: string | null;
      method: string | undefined;
      path: string;
    }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>((input, init) => {
        const path = requestPath(input);
        if (path === GROUPS_PATH) {
          return Promise.resolve(
            jsonResponse({
              groups: [
                { ...group, memberCount: memberAdded ? 1 : 0 },
              ],
            }),
          );
        }
        if (path === MEMBERS_PATH) {
          return Promise.resolve(jsonResponse({ members: [member] }));
        }
        if (path === GROUP_MEMBERS_PATH) {
          return Promise.resolve(
            jsonResponse({
              members: memberAdded
                ? [
                    {
                      loginIdentifier: member.loginIdentifier,
                      userId: member.userId,
                    },
                  ]
                : [],
            }),
          );
        }
        if (path === GROUP_MEMBER_PATH && init?.method === "PUT") {
          membershipRequests.push({
            csrf: new Headers(init.headers).get("X-CSRF-Token"),
            method: init.method,
            path,
          });
          memberAdded = true;
          return Promise.resolve(noContentResponse());
        }
        if (path === GROUP_MEMBER_PATH && init?.method === "DELETE") {
          membershipRequests.push({
            csrf: new Headers(init.headers).get("X-CSRF-Token"),
            method: init.method,
            path,
          });
          memberAdded = false;
          return Promise.resolve(noContentResponse());
        }
        throw new Error(`Unexpected request: ${path}`);
      }),
    );
    useCsrfStore.getState().setCsrfToken(CSRF_TOKEN);

    renderGroupsPage();

    fireEvent.click(
      await screen.findByRole("button", { name: "管理成员" }),
    );
    expect(
      await screen.findByRole("option", { name: member.loginIdentifier }),
    ).toBeVisible();
    fireEvent.change(screen.getByLabelText("组织成员"), {
      target: { value: MEMBER_ID },
    });
    fireEvent.click(screen.getByRole("button", { name: "添加" }));

    await waitFor(() => {
      expect(membershipRequests).toEqual([
        { csrf: CSRF_TOKEN, method: "PUT", path: GROUP_MEMBER_PATH },
      ]);
    });
    expect(await screen.findByText(MEMBER_ID)).toBeVisible();

    fireEvent.click(
      screen.getByRole("button", { name: `移出 ${member.loginIdentifier}` }),
    );
    const dialog = await screen.findByRole("alertdialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "移出用户组" }));

    await waitFor(() => {
      expect(membershipRequests).toEqual([
        { csrf: CSRF_TOKEN, method: "PUT", path: GROUP_MEMBER_PATH },
        { csrf: CSRF_TOKEN, method: "DELETE", path: GROUP_MEMBER_PATH },
      ]);
    });
    await waitFor(() => {
      expect(screen.queryByText(MEMBER_ID)).not.toBeInTheDocument();
    });
  });

  it("excludes disabled accounts from group membership candidates", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>((input) => {
        const path = requestPath(input);
        if (path === GROUPS_PATH) {
          return Promise.resolve(jsonResponse({ groups: [group] }));
        }
        if (path === MEMBERS_PATH) {
          return Promise.resolve(
            jsonResponse({
              members: [
                member,
                {
                  accountStatus: "disabled",
                  loginIdentifier: "disabled@example.test",
                  role: "member",
                  status: "active",
                  userId: DISABLED_MEMBER_ID,
                },
              ],
            }),
          );
        }
        if (path === GROUP_MEMBERS_PATH) {
          return Promise.resolve(jsonResponse({ members: [] }));
        }
        throw new Error(`Unexpected request: ${path}`);
      }),
    );

    renderGroupsPage();

    fireEvent.click(
      await screen.findByRole("button", { name: "管理成员" }),
    );
    expect(
      await screen.findByRole("option", { name: member.loginIdentifier }),
    ).toBeVisible();
    expect(
      screen.queryByRole("option", { name: "disabled@example.test" }),
    ).not.toBeInTheDocument();
  });
});
