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
import { afterEach, describe, expect, test, vi } from "vitest";

import { TooltipProvider } from "@/components/ui/tooltip.tsx";
import { ObservabilityPage } from "@/enterprise/ObservabilityPage.tsx";

const ORGANIZATION_ID = "11111111-1111-4111-8111-111111111111";
const SPACE_ID = "22222222-2222-4222-8222-222222222222";
const SAMPLED_AT = "2026-07-19T00:00:00.000Z";
const OBSERVABILITY_PATH =
  `/api/v1/organizations/${ORGANIZATION_ID}/spaces/${SPACE_ID}/observability`;

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

function renderObservabilityPage(): void {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 0 } },
  });
  render(
    <QueryClientProvider client={client}>
      <TooltipProvider>
        <MemoryRouter
          initialEntries={[
            `/organizations/${ORGANIZATION_ID}/settings/spaces/${SPACE_ID}/observability`,
          ]}
        >
          <Routes>
            <Route
              path="/organizations/:organizationId/settings/spaces/:spaceId/observability"
              element={<ObservabilityPage />}
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

describe("ObservabilityPage", () => {
  test("renders fresh persisted health and capacity values", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(() =>
        Promise.resolve(
          jsonResponse({
            capacity: {
              assetBytes: "2048",
              dataBytes: "1024",
              fileCount: "3",
              sampleDurationMilliseconds: 8,
              sampledAt: SAMPLED_AT,
              status: "fresh",
            },
            health: {
              kernelVersion: "3.7.2",
              sampledAt: SAMPLED_AT,
              status: "ready",
            },
            organizationId: ORGANIZATION_ID,
            spaceId: SPACE_ID,
          }),
        ),
      ),
    );

    renderObservabilityPage();

    expect(await screen.findByText("就绪")).toBeVisible();
    expect(screen.getByText("最新")).toBeVisible();
    expect(screen.getByText("3.7.2")).toBeVisible();
    expect(screen.getByText("1.0 KiB")).toBeVisible();
    expect(screen.getByText("2.0 KiB")).toBeVisible();
  });

  test("distinguishes stale persisted samples", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(() =>
        Promise.resolve(
          jsonResponse({
            capacity: {
              assetBytes: "20",
              dataBytes: "100",
              fileCount: "4",
              sampleDurationMilliseconds: 12,
              sampledAt: SAMPLED_AT,
              status: "stale",
            },
            health: {
              kernelVersion: "3.7.2",
              sampledAt: SAMPLED_AT,
              status: "stale",
            },
            organizationId: ORGANIZATION_ID,
            spaceId: SPACE_ID,
          }),
        ),
      ),
    );

    renderObservabilityPage();

    expect(await screen.findByText("样本已过期")).toBeVisible();
    expect(screen.getByText("已过期")).toBeVisible();
  });

  test("shows failed sample times and refreshes the current routed space", async () => {
    const requests: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>((input) => {
        requests.push(requestPath(input));
        return Promise.resolve(
          jsonResponse({
            capacity: {
              reason: "sample-failed",
              sampledAt: SAMPLED_AT,
              status: "unavailable",
            },
            health: {
              reason: "kernel-unavailable",
              sampledAt: SAMPLED_AT,
              status: "unavailable",
            },
            organizationId: ORGANIZATION_ID,
            spaceId: SPACE_ID,
          }),
        );
      }),
    );

    renderObservabilityPage();

    expect(await screen.findByText("最近一次采样失败")).toBeVisible();
    expect(screen.getByText("Kernel 当前不可用")).toBeVisible();
    expect(screen.getAllByText(/最近采样：/)).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: "刷新健康与容量" }));

    await waitFor(() => expect(requests).toHaveLength(2));
    expect(requests).toEqual([OBSERVABILITY_PATH, OBSERVABILITY_PATH]);
  });
});
