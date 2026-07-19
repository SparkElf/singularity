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
import { AuditPage } from "@/enterprise/AuditPage.tsx";

const ORGANIZATION_ID = "11111111-1111-4111-8111-111111111111";
const SPACE_ID = "22222222-2222-4222-8222-222222222222";
const ACTOR_ID = "33333333-3333-4333-8333-333333333333";

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json" },
    status: 200,
  });
}

function requestUrl(input: RequestInfo | URL): URL {
  const value = input instanceof Request ? input.url : String(input);
  return new URL(value, window.location.origin);
}

function event(sequence: number, spaceId: string | null = SPACE_ID) {
  const suffix = sequence.toString(16).padStart(12, "0");
  return {
    action: "content.edit" as const,
    actorUserId: ACTOR_ID,
    auditEventId: `00000000-0000-4000-8000-${suffix}`,
    keyVersion: "audit-v1",
    mac: sequence.toString(16).padStart(64, "0"),
    occurredAt: "2026-07-19T00:00:00.000Z",
    organizationId: ORGANIZATION_ID,
    outcome: "succeeded" as const,
    previousMac: sequence === 1 ? null : "b".repeat(64),
    requestId: "44444444-4444-4444-8444-444444444444",
    sequence: String(sequence),
    spaceId,
    targetId: `document-${sequence}`,
    targetType: "document" as const,
  };
}

function queryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: 0 },
    },
  });
}

function renderAuditPage(scope: "organization" | "space"): void {
  const path =
    scope === "organization"
      ? `/organizations/${ORGANIZATION_ID}/settings/audit`
      : `/organizations/${ORGANIZATION_ID}/settings/spaces/${SPACE_ID}/audit`;
  render(
    <QueryClientProvider client={queryClient()}>
      <TooltipProvider>
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route
              path="/organizations/:organizationId/settings/audit"
              element={<AuditPage scope="organization" />}
            />
            <Route
              path="/organizations/:organizationId/settings/spaces/:spaceId/audit"
              element={<AuditPage scope="space" />}
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

describe("AuditPage", () => {
  test("uses the last visible sequence as the next cursor and restores the prior cursor", async () => {
    const requests: URL[] = [];
    const firstPage = Array.from({ length: 51 }, (_, index) =>
      event(101 - index),
    );
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>((input) => {
        const url = requestUrl(input);
        requests.push(url);
        const beforeSequence = url.searchParams.get("beforeSequence");
        if (beforeSequence === "52") {
          return Promise.resolve(
            jsonResponse({ events: [event(51), event(50)] }),
          );
        }
        if (beforeSequence === null) {
          return Promise.resolve(jsonResponse({ events: firstPage }));
        }
        throw new Error(`Unexpected audit cursor: ${beforeSequence}`);
      }),
    );

    renderAuditPage("organization");

    expect(await screen.findByText("101")).toBeVisible();
    expect(screen.getByRole("columnheader", { name: "链信息" })).toBeVisible();
    expect(screen.queryByRole("columnheader", { name: "链校验" })).not.toBeInTheDocument();
    expect(screen.getByText("第 1 页")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "下一页" }));

    expect(await screen.findByText("第 2 页")).toBeVisible();
    expect(requests.map((url) => url.search)).toContain(
      "?limit=51&beforeSequence=52",
    );
    fireEvent.click(screen.getByRole("button", { name: "上一页" }));

    expect(await screen.findByText("第 1 页")).toBeVisible();
    await waitFor(() => {
      expect(
        requests.filter((url) => url.search === "?limit=51").length,
      ).toBeGreaterThanOrEqual(2);
    });
  });

  test("carries both route identities into a space audit request", async () => {
    const requests: URL[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>((input) => {
        const url = requestUrl(input);
        requests.push(url);
        return Promise.resolve(jsonResponse({ events: [event(7)] }));
      }),
    );

    renderAuditPage("space");

    expect(await screen.findByText(SPACE_ID)).toBeVisible();
    expect(requests).toHaveLength(1);
    expect(requests[0]!.pathname).toBe(
      `/api/v1/organizations/${ORGANIZATION_ID}/spaces/${SPACE_ID}/audit-events`,
    );
    expect(requests[0]!.search).toBe("?limit=51");
  });

  test("shows an indeterminate content result as unresolved", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(() =>
        Promise.resolve(
          jsonResponse({ events: [{ ...event(8), outcome: "indeterminate" }] }),
        ),
      ),
    );

    renderAuditPage("organization");

    expect(await screen.findByText("结果未确定")).toBeVisible();
    expect(screen.queryByText("失败")).not.toBeInTheDocument();
  });
});
