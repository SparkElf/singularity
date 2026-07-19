import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type {
  OrganizationInvitationSummary,
  OrganizationManagementCapability,
  OrganizationMemberSummary,
} from "@singularity/contracts";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { MemoryRouter, Outlet, Route, Routes } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useCsrfStore } from "@/auth/csrf-store.ts";
import { TooltipProvider } from "@/components/ui/tooltip.tsx";
import { MembersPage } from "@/enterprise/MembersPage.tsx";

const ORGANIZATION_ID = "11111111-1111-4111-8111-111111111111";
const MEMBERS_PATH = `/api/v1/organizations/${ORGANIZATION_ID}/members`;
const INVITATIONS_PATH =
  `/api/v1/organizations/${ORGANIZATION_ID}/invitations`;
const OWNER_ID = "22222222-2222-4222-8222-222222222222";
const ADMIN_ID = "33333333-3333-4333-8333-333333333333";
const MEMBER_ID = "44444444-4444-4444-8444-444444444444";
const INVITATION_ID = "55555555-5555-4555-8555-555555555555";
const INVITATION_TOKEN = "I".repeat(43);
const CSRF_TOKEN = "A".repeat(43);
const OWNERSHIP_PATH = `/api/v1/organizations/${ORGANIZATION_ID}/ownership`;
const MEMBER_PATH = `${MEMBERS_PATH}/${MEMBER_ID}`;
const MEMBER_SESSIONS_PATH = `${MEMBER_PATH}/sessions`;

const member = {
  loginIdentifier: "member@example.test",
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

function renderMembersPage(
  organizationCapabilities: OrganizationManagementCapability[] = [
    "members",
    "groups",
    "spaces",
    "oidc",
    "audit",
  ],
): void {
  render(
    <QueryClientProvider client={createTestQueryClient()}>
      <TooltipProvider>
        <MemoryRouter
          initialEntries={[`/organizations/${ORGANIZATION_ID}/settings/members`]}
        >
          <Routes>
            <Route
              path="/organizations/:organizationId/settings"
              element={
                <Outlet
                  context={{
                    organizationCapabilities,
                    organizationId: ORGANIZATION_ID,
                    organizationName: "银河研究院",
                    spaces: [],
                  }}
                />
              }
            >
              <Route path="members" element={<MembersPage />} />
            </Route>
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

describe("MembersPage capability projection", () => {
  it("hides owner-only member actions for a regular organization admin", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>((input) => {
        const path = requestPath(input);
        if (path === MEMBERS_PATH) {
          return Promise.resolve(
            jsonResponse({
              members: [
                {
                  loginIdentifier: "owner@example.test",
                  role: "owner",
                  status: "active",
                  userId: OWNER_ID,
                },
                {
                  loginIdentifier: "admin@example.test",
                  role: "admin",
                  status: "active",
                  userId: ADMIN_ID,
                },
                {
                  loginIdentifier: "member@example.test",
                  role: "member",
                  status: "active",
                  userId: MEMBER_ID,
                },
              ],
            }),
          );
        }
        if (path === INVITATIONS_PATH) {
          return Promise.resolve(jsonResponse({ invitations: [] }));
        }
        throw new Error(`Unexpected request: ${path}`);
      }),
    );

    renderMembersPage();

    const adminRow = (await screen.findByText("admin@example.test")).closest("tr");
    const ownerRow = screen.getByText("owner@example.test").closest("tr");
    const memberRow = screen.getByText("member@example.test").closest("tr");
    expect(adminRow).not.toBeNull();
    expect(ownerRow).not.toBeNull();
    expect(memberRow).not.toBeNull();
    expect(
      screen.queryByLabelText("admin@example.test 的组织角色"),
    ).not.toBeInTheDocument();
    expect(
      within(adminRow!).queryByRole("button", { name: "撤销会话" }),
    ).not.toBeInTheDocument();
    expect(
      within(ownerRow!).queryByRole("button", { name: "撤销会话" }),
    ).not.toBeInTheDocument();
    expect(
      within(memberRow!).getByRole("button", { name: "撤销会话" }),
    ).toBeVisible();
    expect(screen.getByLabelText("member@example.test 的组织角色")).toBeVisible();
    expect(screen.getByLabelText("角色")).toHaveValue("member");
    expect(
      screen.queryByRole("option", { name: "管理员" }),
    ).not.toBeInTheDocument();
  });
});

describe("MembersPage mutation workflows", () => {
  it("creates an invitation and exposes the returned acceptance link", async () => {
    const invitation: OrganizationInvitationSummary = {
      expiresAt: "2099-07-20T00:00:00.000Z",
      invitationId: INVITATION_ID,
      loginIdentifier: "invitee@example.test",
      organizationId: ORGANIZATION_ID,
      role: "member",
    };
    const createdRequests: Array<Record<string, unknown>> = [];
    let invitations: OrganizationInvitationSummary[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>((input, init) => {
        const path = requestPath(input);
        if (path === MEMBERS_PATH) {
          return Promise.resolve(jsonResponse({ members: [member] }));
        }
        if (path === INVITATIONS_PATH && init?.method === "POST") {
          createdRequests.push(
            JSON.parse(String(init.body)) as Record<string, unknown>,
          );
          invitations = [invitation];
          return Promise.resolve(
            jsonResponse({ ...invitation, invitationToken: INVITATION_TOKEN }),
          );
        }
        if (path === INVITATIONS_PATH) {
          return Promise.resolve(jsonResponse({ invitations }));
        }
        throw new Error(`Unexpected request: ${path}`);
      }),
    );
    useCsrfStore.getState().setCsrfToken(CSRF_TOKEN);

    renderMembersPage();

    expect(await screen.findByText("暂无成员邀请")).toBeVisible();
    fireEvent.change(screen.getByLabelText("账号"), {
      target: { value: "  invitee@example.test  " },
    });
    fireEvent.click(screen.getByRole("button", { name: "创建邀请" }));

    await waitFor(() => {
      expect(createdRequests).toEqual([
        {
          expiresInHours: 72,
          loginIdentifier: "invitee@example.test",
          role: "member",
        },
      ]);
    });
    expect(await screen.findByText("邀请已创建")).toBeVisible();
    expect(screen.getByText(/\/invitations\/accept\?token=/)).toBeVisible();
  });

  it("updates a member status through the member row", async () => {
    let currentMember: OrganizationMemberSummary = { ...member };
    const updateRequests: Array<Record<string, unknown>> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>((input, init) => {
        const path = requestPath(input);
        if (path === MEMBERS_PATH) {
          return Promise.resolve(jsonResponse({ members: [currentMember] }));
        }
        if (path === INVITATIONS_PATH) {
          return Promise.resolve(jsonResponse({ invitations: [] }));
        }
        if (path === MEMBER_PATH && init?.method === "PATCH") {
          const request = JSON.parse(String(init.body)) as {
            role?: "admin" | "member";
            status?: "active" | "inactive";
          };
          updateRequests.push(request);
          currentMember = {
            ...currentMember,
            ...(request.role === undefined ? {} : { role: request.role }),
            ...(request.status === undefined ? {} : { status: request.status }),
          };
          return Promise.resolve(jsonResponse(currentMember));
        }
        throw new Error(`Unexpected request: ${path}`);
      }),
    );
    useCsrfStore.getState().setCsrfToken(CSRF_TOKEN);

    renderMembersPage();

    const status = await screen.findByLabelText("member@example.test 的状态");
    fireEvent.change(status, { target: { value: "inactive" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() => {
      expect(updateRequests).toEqual([
        { role: "member", status: "inactive" },
      ]);
    });
    await waitFor(() => {
      expect(screen.getByLabelText("member@example.test 的状态")).toHaveValue(
        "inactive",
      );
    });
  });

  it("revokes all sessions for a member after confirmation", async () => {
    const sessionRequests: Array<{ csrf: string | null; path: string }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>((input, init) => {
        const path = requestPath(input);
        if (path === MEMBERS_PATH) {
          return Promise.resolve(jsonResponse({ members: [member] }));
        }
        if (path === INVITATIONS_PATH) {
          return Promise.resolve(jsonResponse({ invitations: [] }));
        }
        if (path === MEMBER_SESSIONS_PATH && init?.method === "POST") {
          sessionRequests.push({
            csrf: new Headers(init.headers).get("X-CSRF-Token"),
            path,
          });
          return Promise.resolve(noContentResponse());
        }
        throw new Error(`Unexpected request: ${path}`);
      }),
    );
    useCsrfStore.getState().setCsrfToken(CSRF_TOKEN);

    renderMembersPage();

    const row = (await screen.findByText(member.loginIdentifier)).closest("tr");
    expect(row).not.toBeNull();
    fireEvent.click(within(row!).getByRole("button", { name: "撤销会话" }));
    const dialog = await screen.findByRole("alertdialog");
    fireEvent.click(
      within(dialog).getByRole("button", { name: "撤销全部会话" }),
    );

    expect(await screen.findByText("成员会话已撤销")).toBeVisible();
    expect(sessionRequests).toEqual([
      { csrf: CSRF_TOKEN, path: MEMBER_SESSIONS_PATH },
    ]);
  });

  it("transfers ownership only after the owner confirms the target", async () => {
    let currentMembers: OrganizationMemberSummary[] = [
      {
        loginIdentifier: "owner@example.test",
        role: "owner" as const,
        status: "active" as const,
        userId: OWNER_ID,
      },
      member,
    ];
    const ownershipRequests: Array<{
      body: Record<string, unknown>;
      csrf: string | null;
    }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>((input, init) => {
        const path = requestPath(input);
        if (path === MEMBERS_PATH) {
          return Promise.resolve(jsonResponse({ members: currentMembers }));
        }
        if (path === INVITATIONS_PATH) {
          return Promise.resolve(jsonResponse({ invitations: [] }));
        }
        if (path === OWNERSHIP_PATH && init?.method === "POST") {
          ownershipRequests.push({
            body: JSON.parse(String(init.body)) as Record<string, unknown>,
            csrf: new Headers(init.headers).get("X-CSRF-Token"),
          });
          currentMembers = currentMembers.map((currentMember) => ({
            ...currentMember,
            role: currentMember.userId === MEMBER_ID ? "owner" : "admin",
          }));
          return Promise.resolve(noContentResponse());
        }
        throw new Error(`Unexpected request: ${path}`);
      }),
    );
    useCsrfStore.getState().setCsrfToken(CSRF_TOKEN);

    renderMembersPage([
      "members",
      "groups",
      "spaces",
      "oidc",
      "audit",
      "ownership",
    ]);

    const row = (await screen.findByText(member.loginIdentifier)).closest("tr");
    expect(row).not.toBeNull();
    fireEvent.click(
      within(row!).getByRole("button", { name: "转移所有权" }),
    );
    const dialog = await screen.findByRole("alertdialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "转移所有权" }));

    await waitFor(() => {
      expect(ownershipRequests).toEqual([
        {
          body: { newOwnerUserId: MEMBER_ID },
          csrf: CSRF_TOKEN,
        },
      ]);
    });
    await waitFor(() => {
      expect(
        within(screen.getByText(member.loginIdentifier).closest("tr")!).queryByRole(
          "button",
          { name: "转移所有权" },
        ),
      ).not.toBeInTheDocument();
    });
  });
});
