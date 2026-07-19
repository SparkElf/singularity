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
const CSRF_TOKEN = "A".repeat(43);
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
  loginIdentifier: "reader@example.test",
  role: "member" as const,
  status: "active" as const,
  userId: MEMBER_ID,
};

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

function createTestQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      mutations: { retry: false },
      queries: { retry: false, staleTime: 0 },
    },
  });
}

function renderGroupsPage(): void {
  render(
    <QueryClientProvider client={createTestQueryClient()}>
      <TooltipProvider>
        <MemoryRouter
          initialEntries={[`/organizations/${ORGANIZATION_ID}/settings/groups`]}
        >
          <Routes>
            <Route
              path="/organizations/:organizationId/settings/groups"
              element={<GroupsPage />}
            />
          </Routes>
        </MemoryRouter>
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  useCsrfStore.getState().clearCsrfToken();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("GroupsPage management workflows", () => {
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
});
