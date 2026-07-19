import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import { TooltipProvider } from "@/components/ui/tooltip.tsx";
import { SpaceAccessPage } from "@/enterprise/SpaceAccessPage.tsx";

const ORGANIZATION_ID = "11111111-1111-4111-8111-111111111111";
const SPACE_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const MEMBER_ID = "22222222-2222-4222-8222-222222222222";
const GROUP_ID = "33333333-3333-4333-8333-333333333333";
const SPACE_BASE_PATH =
  `/api/v1/organizations/${ORGANIZATION_ID}/spaces/${SPACE_ID}`;

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

function renderSpaceAccessPage(): void {
  render(
    <QueryClientProvider client={createTestQueryClient()}>
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

describe("SpaceAccessPage delegated administration", () => {
  it("loads space-scoped candidates without organization-management reads", async () => {
    const requestedPaths: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>((input) => {
        const path = new URL(
          input instanceof Request ? input.url : String(input),
          window.location.origin,
        ).pathname;
        requestedPaths.push(path);
        switch (path) {
          case `${SPACE_BASE_PATH}/members`:
            return Promise.resolve(jsonResponse({ members: [] }));
          case `${SPACE_BASE_PATH}/groups`:
            return Promise.resolve(jsonResponse({ grants: [] }));
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

    renderSpaceAccessPage();

    expect(
      await screen.findByRole("option", { name: "reader@example.test" }),
    ).toBeInTheDocument();
    expect(
      await screen.findByRole("option", { name: "资料阅读组" }),
    ).toBeInTheDocument();
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
});
