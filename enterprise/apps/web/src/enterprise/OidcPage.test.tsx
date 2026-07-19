import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import { TooltipProvider } from "@/components/ui/tooltip.tsx";
import { OidcPage } from "@/enterprise/OidcPage.tsx";

const ORGANIZATION_ID = "11111111-1111-4111-8111-111111111111";
const PROVIDER_ID = "22222222-2222-4222-8222-222222222222";
const PROVIDERS_PATH = `/api/v1/organizations/${ORGANIZATION_ID}/oidc-providers`;

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    headers: { "Content-Type": "application/json" },
    status,
  });
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

function renderOidcPage(): void {
  render(
    <QueryClientProvider client={createTestQueryClient()}>
      <TooltipProvider>
        <MemoryRouter
          initialEntries={[`/organizations/${ORGANIZATION_ID}/settings/oidc`]}
        >
          <Routes>
            <Route
              path="/organizations/:organizationId/settings/oidc"
              element={<OidcPage />}
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

describe("OidcPage provider forms", () => {
  it("shows an update schema error instead of silently dropping the submission", async () => {
    const fetchMock = vi.fn<typeof fetch>((input, init) => {
      const path = requestPath(input);
      if (path === PROVIDERS_PATH && init?.method === undefined) {
        return Promise.resolve(
          jsonResponse({
            providers: [
              {
                clientId: "singularity-enterprise",
                issuer: "https://identity.example.test/corporate",
                name: "Corporate SSO",
                organizationId: ORGANIZATION_ID,
                providerId: PROVIDER_ID,
                status: "active",
              },
            ],
          }),
        );
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    renderOidcPage();
    const name = await screen.findByLabelText("Provider 名称");
    fireEvent.change(name, { target: { value: " " } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    expect(
      await screen.findByText("Provider 配置不符合公开合同，请检查各字段。"),
    ).toBeVisible();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
