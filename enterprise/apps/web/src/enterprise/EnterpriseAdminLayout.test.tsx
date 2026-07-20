import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import { TooltipProvider } from "@/components/ui/tooltip.tsx";
import { EnterpriseAdminLayout } from "@/enterprise/EnterpriseAdminLayout.tsx";

const ORGANIZATION_ID = "11111111-1111-4111-8111-111111111111";
const SPACE_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const MANAGEMENT_ACCESS_PATH = "/api/v1/enterprise-management-access";

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

function renderLayout(initialEntry: string, managementAccess: unknown): void {
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof fetch>((input) => {
      const path = new URL(
        input instanceof Request ? input.url : String(input),
        window.location.origin,
      ).pathname;
      if (path === MANAGEMENT_ACCESS_PATH) {
        return Promise.resolve(jsonResponse(managementAccess));
      }
      throw new Error(`Unexpected request: ${path}`);
    }),
  );
  render(
    <QueryClientProvider client={createTestQueryClient()}>
      <TooltipProvider>
        <MemoryRouter initialEntries={[initialEntry]}>
          <Routes>
            <Route path="/spaces" element={<h1>Space list</h1>} />
            <Route
              path="/organizations/:organizationId/settings"
              element={<EnterpriseAdminLayout />}
            >
              <Route path="members" element={<h1>Members content</h1>} />
              <Route path="groups" element={<h1>Groups content</h1>} />
              <Route path="spaces" element={<h1>Spaces content</h1>} />
              <Route path="oidc" element={<h1>OIDC content</h1>} />
              <Route path="audit" element={<h1>Organization audit content</h1>} />
              <Route path="spaces/:spaceId/access" element={<h1>Access content</h1>} />
              <Route path="spaces/:spaceId/shares" element={<h1>Shares content</h1>} />
              <Route path="spaces/:spaceId/audit" element={<h1>Space audit content</h1>} />
              <Route path="spaces/:spaceId/backups" element={<h1>Backups content</h1>} />
              <Route
                path="spaces/:spaceId/observability"
                element={<h1>Observability content</h1>}
              />
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

describe("EnterpriseAdminLayout capability navigation", () => {
  it("shows a delegated space administrator only the declared space sections", async () => {
    renderLayout(
      `/organizations/${ORGANIZATION_ID}/settings/spaces/${SPACE_ID}/access`,
      {
        organizations: [
          {
            organizationCapabilities: [],
            organizationId: ORGANIZATION_ID,
            organizationName: "银河研究院",
            spaces: [
              {
                capabilities: ["backups", "access"],
                spaceId: SPACE_ID,
                spaceName: "深空知识空间",
              },
            ],
          },
        ],
      },
    );

    expect(await screen.findByRole("heading", { name: "Access content" })).toBeVisible();
    expect(screen.queryByText("组织管理")).not.toBeInTheDocument();
    expect(screen.getByText("空间管理")).toBeVisible();
    expect(screen.getByRole("link", { name: "访问权限" })).toBeVisible();
    expect(screen.getByRole("link", { name: "备份恢复" })).toBeVisible();
    expect(screen.queryByRole("link", { name: "分享" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "健康容量" })).not.toBeInTheDocument();
  });

  it("returns from managed space settings to the authorized space list", async () => {
    renderLayout(
      `/organizations/${ORGANIZATION_ID}/settings/spaces/${SPACE_ID}/access`,
      {
        organizations: [
          {
            organizationCapabilities: [],
            organizationId: ORGANIZATION_ID,
            organizationName: "银河研究院",
            spaces: [
              {
                capabilities: ["access"],
                spaceId: SPACE_ID,
                spaceName: "深空知识空间",
              },
            ],
          },
        ],
      },
    );

    expect(await screen.findByRole("heading", { name: "Access content" })).toBeVisible();
    const returnLink = screen.getByRole("link", { name: "返回空间列表" });
    expect(returnLink).toHaveAttribute("href", "/spaces");
    fireEvent.click(returnLink);
    expect(await screen.findByRole("heading", { name: "Space list" })).toBeVisible();
  });

  it("uses UI priority instead of server capability order for redirects and space selection", async () => {
    renderLayout(`/organizations/${ORGANIZATION_ID}/settings/members`, {
      organizations: [
        {
          organizationCapabilities: ["audit", "groups"],
          organizationId: ORGANIZATION_ID,
          organizationName: "银河研究院",
          spaces: [
            {
              capabilities: ["observability", "backups"],
              spaceId: SPACE_ID,
              spaceName: "深空知识空间",
            },
          ],
        },
      ],
    });

    expect(await screen.findByRole("heading", { name: "Groups content" })).toBeVisible();
    expect(screen.getByRole("link", { name: "用户组" })).toBeVisible();
    expect(screen.getByRole("link", { name: "组织审计" })).toBeVisible();
    expect(screen.queryByRole("link", { name: "成员与邀请" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "空间" })).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("选择管理空间"), {
      target: { value: SPACE_ID },
    });
    expect(await screen.findByRole("heading", { name: "Backups content" })).toBeVisible();
  });
});
