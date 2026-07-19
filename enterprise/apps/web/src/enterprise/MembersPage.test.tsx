import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, within } from "@testing-library/react";
import { MemoryRouter, Outlet, Route, Routes } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import { TooltipProvider } from "@/components/ui/tooltip.tsx";
import { MembersPage } from "@/enterprise/MembersPage.tsx";

const ORGANIZATION_ID = "11111111-1111-4111-8111-111111111111";
const MEMBERS_PATH = `/api/v1/organizations/${ORGANIZATION_ID}/members`;
const INVITATIONS_PATH =
  `/api/v1/organizations/${ORGANIZATION_ID}/invitations`;
const OWNER_ID = "22222222-2222-4222-8222-222222222222";
const ADMIN_ID = "33333333-3333-4333-8333-333333333333";
const MEMBER_ID = "44444444-4444-4444-8444-444444444444";

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json" },
    status: 200,
  });
}

function createTestQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      mutations: { retry: false },
      queries: { retry: false, staleTime: 0 },
    },
  });
}

function renderMembersPage(): void {
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
                    organizationCapabilities: [
                      "members",
                      "groups",
                      "spaces",
                      "oidc",
                      "audit",
                    ],
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
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("MembersPage capability projection", () => {
  it("hides owner-only member actions for a regular organization admin", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>((input) => {
        const path = new URL(
          input instanceof Request ? input.url : String(input),
          window.location.origin,
        ).pathname;
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
