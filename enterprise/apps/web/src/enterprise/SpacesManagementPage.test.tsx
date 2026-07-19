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
import { SpacesManagementPage } from "@/enterprise/SpacesManagementPage.tsx";

const ORGANIZATION_ID = "11111111-1111-4111-8111-111111111111";
const SPACE_ID = "22222222-2222-4222-8222-222222222222";
const CSRF_TOKEN = "A".repeat(43);
const SPACES_PATH = `/api/v1/organizations/${ORGANIZATION_ID}/spaces`;
const SPACE_PATH = `${SPACES_PATH}/${SPACE_ID}`;

const space = {
  organizationId: ORGANIZATION_ID,
  spaceId: SPACE_ID,
  spaceName: "项目资料",
  status: "active" as const,
};

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json" },
    status: 200,
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

function renderSpacesManagementPage(): void {
  render(
    <QueryClientProvider client={createTestQueryClient()}>
      <TooltipProvider>
        <MemoryRouter
          initialEntries={[`/organizations/${ORGANIZATION_ID}/settings/spaces`]}
        >
          <Routes>
            <Route
              path="/organizations/:organizationId/settings/spaces"
              element={<SpacesManagementPage />}
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

describe("SpacesManagementPage lifecycle workflows", () => {
  it("creates a normalized space and refreshes the managed list", async () => {
    let spaces: typeof space[] = [];
    const createdRequests: Array<Record<string, unknown>> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>((input, init) => {
        const path = requestPath(input);
        if (path === SPACES_PATH && init?.method === "POST") {
          createdRequests.push(
            JSON.parse(String(init.body)) as Record<string, unknown>,
          );
          spaces = [space];
          return Promise.resolve(jsonResponse(space));
        }
        if (path === SPACES_PATH) {
          return Promise.resolve(jsonResponse({ spaces }));
        }
        throw new Error(`Unexpected request: ${path}`);
      }),
    );
    useCsrfStore.getState().setCsrfToken(CSRF_TOKEN);

    renderSpacesManagementPage();

    expect(await screen.findByText("暂无空间")).toBeVisible();
    fireEvent.change(screen.getByLabelText("空间名称"), {
      target: { value: "  项目资料  " },
    });
    fireEvent.click(screen.getByRole("button", { name: "创建空间" }));

    await waitFor(() => {
      expect(createdRequests).toEqual([{ name: "项目资料" }]);
    });
    expect(await screen.findByDisplayValue("项目资料")).toBeVisible();
  });

  it("renames and archives a space through the lifecycle form", async () => {
    let currentSpace: {
      organizationId: string;
      spaceId: string;
      spaceName: string;
      status: "active" | "archived";
    } = { ...space };
    const updateRequests: Array<Record<string, unknown>> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>((input, init) => {
        const path = requestPath(input);
        if (path === SPACE_PATH && init?.method === "PATCH") {
          const request = JSON.parse(String(init.body)) as {
            name?: string;
            status?: "active" | "archived";
          };
          updateRequests.push(request);
          currentSpace = {
            ...currentSpace,
            ...(request.name === undefined ? {} : { spaceName: request.name }),
            ...(request.status === undefined ? {} : { status: request.status }),
          };
          return Promise.resolve(jsonResponse(currentSpace));
        }
        if (path === SPACES_PATH) {
          return Promise.resolve(jsonResponse({ spaces: [currentSpace] }));
        }
        throw new Error(`Unexpected request: ${path}`);
      }),
    );
    useCsrfStore.getState().setCsrfToken(CSRF_TOKEN);

    renderSpacesManagementPage();

    const status = await screen.findByLabelText("空间状态");
    const row = status.closest("tr");
    expect(row).not.toBeNull();
    expect(status).toHaveValue("active");
    fireEvent.change(within(row!).getByLabelText("空间名称"), {
      target: { value: "  归档项目资料  " },
    });
    fireEvent.change(status, { target: { value: "archived" } });
    fireEvent.click(within(row!).getByRole("button", { name: "保存" }));

    await waitFor(() => {
      expect(updateRequests).toEqual([
        { name: "归档项目资料", status: "archived" },
      ]);
    });
    await waitFor(() => {
      expect(screen.getByLabelText("空间状态")).toHaveValue("archived");
    });
    expect(screen.getByDisplayValue("归档项目资料")).toBeVisible();
  });
});
