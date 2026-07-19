import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
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
import { BackupsPage } from "@/enterprise/BackupsPage.tsx";

const ORGANIZATION_ID = "11111111-1111-4111-8111-111111111111";
const SOURCE_SPACE_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TARGET_SPACE_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const BACKUP_ID = "22222222-2222-4222-8222-222222222222";
const RESTORE_ID = "33333333-3333-4333-8333-333333333333";
const CSRF_TOKEN = "A".repeat(43);
const BACKUPS_PATH = `/api/v1/organizations/${ORGANIZATION_ID}/spaces/${SOURCE_SPACE_ID}/backups`;
const RESTORES_PATH = `/api/v1/organizations/${ORGANIZATION_ID}/spaces/${SOURCE_SPACE_ID}/restores`;
const ACTIVATION_PATH = `/api/v1/organizations/${ORGANIZATION_ID}/spaces/${TARGET_SPACE_ID}/restores/${RESTORE_ID}/activation`;

const backup = {
  backupId: BACKUP_ID,
  completedAt: "2026-07-19T00:00:00.000Z",
  createdAt: "2026-07-19T00:00:00.000Z",
  formatVersion: 1,
  kernelVersion: "3.7.2",
  organizationId: ORGANIZATION_ID,
  sha256: "a".repeat(64),
  sizeBytes: "128",
  sourceSpaceId: SOURCE_SPACE_ID,
  status: "succeeded" as const,
};

function restore(status: "activated" | "ready-for-activation") {
  return {
    activatedAt:
      status === "activated" ? "2026-07-19T00:01:00.000Z" : null,
    backupId: BACKUP_ID,
    createdAt: "2026-07-19T00:00:30.000Z",
    organizationId: ORGANIZATION_ID,
    restoreId: RESTORE_ID,
    sourceSpaceId: SOURCE_SPACE_ID,
    status,
    targetSpaceId: TARGET_SPACE_ID,
  };
}

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

function renderBackupsPage(): void {
  const queryClient = new QueryClient({
    defaultOptions: {
      mutations: { retry: false },
      queries: { retry: false, staleTime: 0 },
    },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <MemoryRouter
          initialEntries={[
            `/organizations/${ORGANIZATION_ID}/settings/spaces/${SOURCE_SPACE_ID}/backups`,
          ]}
        >
          <Routes>
            <Route
              path="/organizations/:organizationId/settings/spaces/:spaceId/backups"
              element={<BackupsPage />}
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

describe("BackupsPage restore discovery", () => {
  it("keeps restore creation closed until the authoritative restore collection arrives", async () => {
    let resolveRestores!: (response: Response) => void;
    const restoresResponse = new Promise<Response>((resolve) => {
      resolveRestores = resolve;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>((input) => {
        const path = requestPath(input);
        if (path === BACKUPS_PATH) {
          return Promise.resolve(jsonResponse({ backups: [backup] }));
        }
        if (path === RESTORES_PATH) {
          return restoresResponse;
        }
        throw new Error(`Unexpected request: ${path}`);
      }),
    );

    renderBackupsPage();

    expect(await screen.findByText("可恢复")).toBeVisible();
    expect(screen.getByText("正在确认恢复任务")).toBeVisible();
    expect(screen.queryByRole("button", { name: "开始恢复" })).not.toBeInTheDocument();
    await act(async () => {
      resolveRestores(jsonResponse({ restores: [] }));
      await restoresResponse;
    });
    expect(await screen.findByRole("button", { name: "开始恢复" })).toBeVisible();
  });

  it("discovers and activates a pending restore without a restore identifier in the URL", async () => {
    let restoreStatus: "activated" | "ready-for-activation" =
      "ready-for-activation";
    let restoreReads = 0;
    const activationRequests: Array<{ csrf: string | null; path: string }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>((input, init) => {
        const path = requestPath(input);
        if (path === BACKUPS_PATH) {
          return Promise.resolve(jsonResponse({ backups: [backup] }));
        }
        if (path === RESTORES_PATH) {
          restoreReads += 1;
          return Promise.resolve(
            jsonResponse({ restores: [restore(restoreStatus)] }),
          );
        }
        if (path === ACTIVATION_PATH && init?.method === "POST") {
          const headers = new Headers(init.headers);
          activationRequests.push({
            csrf: headers.get("x-csrf-token"),
            path,
          });
          restoreStatus = "activated";
          return Promise.resolve(jsonResponse(restore(restoreStatus)));
        }
        throw new Error(`Unexpected request: ${path}`);
      }),
    );
    useCsrfStore.getState().setCsrfToken(CSRF_TOKEN);

    renderBackupsPage();

    expect(await screen.findByText("等待激活")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "激活空间" }));
    const dialog = await screen.findByRole("alertdialog");
    fireEvent.click(
      within(dialog).getByRole("button", { name: "激活空间" }),
    );

    expect(await screen.findByText("已激活")).toBeVisible();
    await waitFor(() => expect(restoreReads).toBeGreaterThanOrEqual(2));
    expect(activationRequests).toEqual([
      { csrf: CSRF_TOKEN, path: ACTIVATION_PATH },
    ]);
    expect(screen.queryByRole("button", { name: "激活空间" })).not.toBeInTheDocument();
  });
});
