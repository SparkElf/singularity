import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useCsrfStore } from "@/auth/csrf-store.ts";
import { TooltipProvider } from "@/components/ui/tooltip.tsx";
import { SharesPage } from "@/enterprise/SharesPage.tsx";
import {
  activateContentSelectionScope,
  releaseContentSelectionScope,
  selectContentDocument,
  useContentSelectionStore,
  type ContentSelectionScope,
} from "@/spaces/content-selection.ts";

const ORGANIZATION_ID = "11111111-1111-4111-8111-111111111111";
const SPACE_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const NOTEBOOK_ID = "20260718000000-noteb01";
const DOCUMENT_A_ID = "20260718000100-docum01";
const DOCUMENT_B_ID = "20260718000101-docum02";
const SHARE_ID = "22222222-2222-4222-8222-222222222222";
const SHARE_TOKEN = "A".repeat(43);
const CSRF_TOKEN = "B".repeat(43);
const REQUEST_ID = "99999999-9999-4999-8999-999999999999";
const SHARES_PATH = `/api/v1/organizations/${ORGANIZATION_ID}/spaces/${SPACE_ID}/shares`;
const NOTEBOOKS_PATH = `/api/v1/organizations/${ORGANIZATION_ID}/spaces/${SPACE_ID}/content-directory/notebooks`;
const DOCUMENTS_PATH = `${NOTEBOOKS_PATH}/${NOTEBOOK_ID}/documents?offset=0`;
let externalSelectionScope: ContentSelectionScope | null = null;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json" },
    status,
  });
}

function requestPath(input: RequestInfo | URL): string {
  const value = input instanceof Request ? input.url : String(input);
  const url = new URL(value, window.location.origin);
  return `${url.pathname}${url.search}`;
}

function createTestQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      mutations: { retry: false },
      queries: { retry: false, staleTime: 0 },
    },
  });
}

function renderSharesPage(
  queryClient = createTestQueryClient(),
): QueryClient {
  render(
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <MemoryRouter
          initialEntries={[
            `/organizations/${ORGANIZATION_ID}/settings/spaces/${SPACE_ID}/shares`,
          ]}
        >
          <Routes>
            <Route
              path="/organizations/:organizationId/settings/spaces/:spaceId/shares"
              element={<SharesPage />}
            />
            <Route path="/login" element={<h1>登录奇点</h1>} />
          </Routes>
        </MemoryRouter>
      </TooltipProvider>
    </QueryClientProvider>,
  );
  return queryClient;
}

afterEach(() => {
  cleanup();
  if (externalSelectionScope) {
    releaseContentSelectionScope(externalSelectionScope);
    externalSelectionScope = null;
  }
  useContentSelectionStore.setState({ selection: null });
  useCsrfStore.getState().clearCsrfToken();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("SharesPage document selection", () => {
  it("creates a share from the document selected in the authorized directory", async () => {
    const createdRequests: Record<string, unknown>[] = [];
    vi.stubGlobal("fetch", vi.fn<typeof fetch>((input, init) => {
      const path = requestPath(input);
      if (path === SHARES_PATH && init?.method === "POST") {
        if (typeof init.body !== "string") {
          throw new Error("Expected a JSON string request body");
        }
        createdRequests.push(
          JSON.parse(init.body) as Record<string, unknown>,
        );
        return Promise.resolve(jsonResponse({
          createdAt: "2026-07-18T00:00:00.000Z",
          documentId: DOCUMENT_B_ID,
          expiresAt: "2026-07-25T00:00:00.000Z",
          hasPassword: true,
          notebookId: NOTEBOOK_ID,
          organizationId: ORGANIZATION_ID,
          revokedAt: null,
          shareId: SHARE_ID,
          shareToken: SHARE_TOKEN,
          spaceId: SPACE_ID,
        }));
      }
      if (path === SHARES_PATH) {
        return Promise.resolve(jsonResponse({ shares: [] }));
      }
      if (path === NOTEBOOKS_PATH) {
        return Promise.resolve(jsonResponse({
          notebooks: [
            { icon: "", locked: false, name: "项目资料", notebookId: NOTEBOOK_ID },
          ],
        }));
      }
      if (path === DOCUMENTS_PATH) {
        return Promise.resolve(jsonResponse({
          documents: [
            {
              documentId: DOCUMENT_A_ID,
              hasChildren: false,
              icon: "",
              notebookId: NOTEBOOK_ID,
              title: "方案草稿",
            },
            {
              documentId: DOCUMENT_B_ID,
              hasChildren: false,
              icon: "",
              notebookId: NOTEBOOK_ID,
              title: "发布方案",
            },
          ],
          locked: false,
          nextOffset: null,
        }));
      }
      throw new Error(`Unexpected request: ${path}`);
    }));
    useCsrfStore.getState().setCsrfToken(CSRF_TOKEN);

    renderSharesPage();

    fireEvent.click(await screen.findByRole("button", { name: "发布方案" }));
    expect(await screen.findByText(DOCUMENT_B_ID)).toBeVisible();
    expect(screen.queryByLabelText("笔记本 ID")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("文档 ID")).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("访问密码（可选）"), {
      target: { value: "correct horse battery staple" },
    });
    fireEvent.click(screen.getByRole("button", { name: "创建分享" }));

    await waitFor(() => {
      expect(createdRequests[0]).toMatchObject({
        documentId: DOCUMENT_B_ID,
        notebookId: NOTEBOOK_ID,
        password: "correct horse battery staple",
      });
    });
    expect(Date.parse(String(createdRequests[0]?.expiresAt))).toBeGreaterThan(Date.now());
    expect(await screen.findByText("分享已创建")).toBeVisible();
  });

  it("uses only the selection owned by its current directory scope", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>((input) => {
      const path = requestPath(input);
      if (path === SHARES_PATH) {
        return Promise.resolve(jsonResponse({ shares: [] }));
      }
      if (path === NOTEBOOKS_PATH) {
        return Promise.resolve(jsonResponse({ notebooks: [] }));
      }
      throw new Error(`Unexpected request: ${path}`);
    }));

    renderSharesPage();

    expect(await screen.findByText("暂无笔记本")).toBeVisible();
    act(() => {
      const scope = activateContentSelectionScope({
        organizationId: ORGANIZATION_ID,
        spaceId: SPACE_ID,
      });
      externalSelectionScope = scope;
      selectContentDocument(scope, {
        documentId: DOCUMENT_A_ID,
        notebookId: NOTEBOOK_ID,
      });
    });
    expect(screen.getByRole("button", { name: "创建分享" })).toBeDisabled();
    expect(screen.queryByText(DOCUMENT_A_ID)).not.toBeInTheDocument();
  });

  it("returns to login when the directory reports unauthenticated before selecting a document", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>((input) => {
      const path = requestPath(input);
      if (path === SHARES_PATH) {
        return Promise.resolve(jsonResponse({ shares: [] }));
      }
      if (path === NOTEBOOKS_PATH) {
        return Promise.resolve(jsonResponse({
          code: "unauthenticated",
          requestId: REQUEST_ID,
          status: 401,
        }, 401));
      }
      throw new Error(`Unexpected request: ${path}`);
    }));
    useCsrfStore.getState().setCsrfToken(CSRF_TOKEN);
    const queryClient = createTestQueryClient();
    queryClient.setQueryData(["sensitive"], { title: "private" });

    renderSharesPage(queryClient);

    await waitFor(() => {
      expect(useCsrfStore.getState().csrfToken).toBeNull();
      expect(queryClient.getQueryCache().getAll()).toHaveLength(0);
      expect(useContentSelectionStore.getState().selection).toBeNull();
    });
    expect(await screen.findByRole("heading", { name: "登录奇点" })).toBeVisible();
  });

  it("clears the client session and returns to login when the managed-share API reports unauthenticated", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>((input) => {
      const path = requestPath(input);
      if (path === SHARES_PATH) {
        return Promise.resolve(jsonResponse({
          code: "unauthenticated",
          requestId: REQUEST_ID,
          status: 401,
        }, 401));
      }
      if (path === NOTEBOOKS_PATH) {
        return Promise.resolve(jsonResponse({ notebooks: [] }));
      }
      throw new Error(`Unexpected request: ${path}`);
    }));
    useCsrfStore.getState().setCsrfToken(CSRF_TOKEN);
    const queryClient = createTestQueryClient();
    queryClient.setQueryData(["sensitive"], { title: "private" });

    renderSharesPage(queryClient);

    await waitFor(() => {
      expect(useCsrfStore.getState().csrfToken).toBeNull();
      expect(queryClient.getQueryCache().getAll()).toHaveLength(0);
    });
    expect(await screen.findByRole("heading", { name: "登录奇点" })).toBeVisible();
  });
});
