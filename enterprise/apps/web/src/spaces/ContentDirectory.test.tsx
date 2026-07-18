import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  type ContentDirectoryAccessLoss,
  ContentDirectory,
  type ContentDirectoryStatus,
} from "@/spaces/ContentDirectory.tsx";
import { useContentSelectionStore } from "@/spaces/content-selection.ts";

const ORGANIZATION_A = "11111111-1111-4111-8111-111111111111";
const ORGANIZATION_B = "22222222-2222-4222-8222-222222222222";
const SPACE_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SPACE_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const LOCKED_NOTEBOOK = "20260718000000-lock001";
const EMPTY_NOTEBOOK = "20260718000001-empty01";
const NOTEBOOK_A = "20260718000002-noteb01";
const NOTEBOOK_B = "20260718000003-noteb02";
const DOCUMENT_A = "20260718000100-docum01";
const DOCUMENT_B = "20260718000101-docum02";
const CHILD_DOCUMENT = "20260718000102-child01";
const REQUEST_ID = "99999999-9999-4999-8999-999999999999";

function notebooksPath(organizationId: string, spaceId: string): string {
  return `/api/v1/organizations/${organizationId}/spaces/${spaceId}/content-directory/notebooks`;
}

function rootDocumentsPath(
  organizationId: string,
  spaceId: string,
  notebookId: string,
  offset = 0,
): string {
  return `${notebooksPath(organizationId, spaceId)}/${notebookId}/documents?offset=${offset}`;
}

function childDocumentsPath(
  organizationId: string,
  spaceId: string,
  notebookId: string,
  documentId: string,
): string {
  return `${rootDocumentsPath(organizationId, spaceId, notebookId).split("?")[0]}/${documentId}/children?offset=0`;
}

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

function problem(status: number) {
  return {
    code: "service-unavailable",
    requestId: REQUEST_ID,
    status,
  };
}

function notebook(notebookId: string, locked = false) {
  return { icon: "", locked, name: notebookId, notebookId };
}

function document(
  notebookId: string,
  documentId: string,
  title: string,
  hasChildren = false,
) {
  return { documentId, hasChildren, icon: "", notebookId, title };
}

function createQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: 0 },
    },
  });
}

function renderDirectory(
  identity: { readonly organizationId: string; readonly spaceId: string },
  queryClient = createQueryClient(),
) {
  const onAccessLost = vi.fn<(category: ContentDirectoryAccessLoss) => void>();
  const onStatusChange = vi.fn<(status: ContentDirectoryStatus) => void>();
  const result = render(
    <QueryClientProvider client={queryClient}>
      <ContentDirectory
        identity={identity}
        onAccessLost={onAccessLost}
        onStatusChange={onStatusChange}
      />
    </QueryClientProvider>,
  );
  return { ...result, onAccessLost, onStatusChange, queryClient };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}

afterEach(() => {
  cleanup();
  useContentSelectionStore.setState({ selection: null });
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("ContentDirectory", () => {
  it("selects the first real document after locked and empty notebooks", async () => {
    const requested: string[] = [];
    vi.stubGlobal("fetch", vi.fn<typeof fetch>((input) => {
      const path = requestPath(input);
      requested.push(path);
      if (path === notebooksPath(ORGANIZATION_A, SPACE_A)) {
        return Promise.resolve(jsonResponse({
          notebooks: [
            notebook(LOCKED_NOTEBOOK, true),
            notebook(EMPTY_NOTEBOOK),
            notebook(NOTEBOOK_A),
          ],
        }));
      }
      if (path === rootDocumentsPath(ORGANIZATION_A, SPACE_A, EMPTY_NOTEBOOK)) {
        return Promise.resolve(jsonResponse({
          documents: [],
          locked: false,
          nextOffset: null,
        }));
      }
      if (path === rootDocumentsPath(ORGANIZATION_A, SPACE_A, NOTEBOOK_A)) {
        return Promise.resolve(jsonResponse({
          documents: [document(NOTEBOOK_A, DOCUMENT_A, "第一份文档")],
          locked: false,
          nextOffset: null,
        }));
      }
      throw new Error(`Unexpected request: ${path}`);
    }));

    const { onStatusChange } = renderDirectory({
      organizationId: ORGANIZATION_A,
      spaceId: SPACE_A,
    });

    await waitFor(() => {
      expect(useContentSelectionStore.getState().selection).toEqual({
        documentId: DOCUMENT_A,
        notebookId: NOTEBOOK_A,
        spaceId: SPACE_A,
      });
    });
    expect(await screen.findByRole("button", { name: "第一份文档" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(requested).not.toContain(
      rootDocumentsPath(ORGANIZATION_A, SPACE_A, LOCKED_NOTEBOOK),
    );
    expect(onStatusChange).toHaveBeenLastCalledWith("ready");
  });

  it("stops on the first root-page failure and only retries after an explicit command", async () => {
    let firstNotebookAttempts = 0;
    let secondNotebookAttempts = 0;
    vi.stubGlobal("fetch", vi.fn<typeof fetch>((input) => {
      const path = requestPath(input);
      if (path === notebooksPath(ORGANIZATION_A, SPACE_A)) {
        return Promise.resolve(jsonResponse({
          notebooks: [notebook(NOTEBOOK_A), notebook(NOTEBOOK_B)],
        }));
      }
      if (path === rootDocumentsPath(ORGANIZATION_A, SPACE_A, NOTEBOOK_A)) {
        firstNotebookAttempts += 1;
        return Promise.resolve(
          firstNotebookAttempts === 1
            ? jsonResponse(problem(503), 503)
            : jsonResponse({
                documents: [document(NOTEBOOK_A, DOCUMENT_A, "恢复文档")],
                locked: false,
                nextOffset: null,
              }),
        );
      }
      if (path === rootDocumentsPath(ORGANIZATION_A, SPACE_A, NOTEBOOK_B)) {
        secondNotebookAttempts += 1;
        return Promise.resolve(jsonResponse({
          documents: [document(NOTEBOOK_B, DOCUMENT_B, "备用文档")],
          locked: false,
          nextOffset: null,
        }));
      }
      throw new Error(`Unexpected request: ${path}`);
    }));

    renderDirectory({ organizationId: ORGANIZATION_A, spaceId: SPACE_A });

    expect(await screen.findByRole("button", { name: "重新加载目录" })).toBeVisible();
    expect(useContentSelectionStore.getState().selection).toBeNull();
    expect(firstNotebookAttempts).toBe(1);
    expect(secondNotebookAttempts).toBe(0);

    fireEvent.click(screen.getByRole("button", { name: "重新加载目录" }));
    await waitFor(() => {
      expect(useContentSelectionStore.getState().selection?.documentId).toBe(
        DOCUMENT_A,
      );
    });
    expect(firstNotebookAttempts).toBe(2);
    expect(secondNotebookAttempts).toBe(0);
  });

  it("rejects a late root page after switching to another space", async () => {
    const firstRoot = deferred<Response>();
    let firstRootSignal: AbortSignal | null | undefined;
    vi.stubGlobal("fetch", vi.fn<typeof fetch>((input, init) => {
      const path = requestPath(input);
      if (path === notebooksPath(ORGANIZATION_A, SPACE_A)) {
        return Promise.resolve(jsonResponse({ notebooks: [notebook(NOTEBOOK_A)] }));
      }
      if (path === rootDocumentsPath(ORGANIZATION_A, SPACE_A, NOTEBOOK_A)) {
        firstRootSignal = init?.signal;
        return firstRoot.promise;
      }
      if (path === notebooksPath(ORGANIZATION_B, SPACE_B)) {
        return Promise.resolve(jsonResponse({ notebooks: [notebook(NOTEBOOK_B)] }));
      }
      if (path === rootDocumentsPath(ORGANIZATION_B, SPACE_B, NOTEBOOK_B)) {
        return Promise.resolve(jsonResponse({
          documents: [document(NOTEBOOK_B, DOCUMENT_B, "当前空间文档")],
          locked: false,
          nextOffset: null,
        }));
      }
      throw new Error(`Unexpected request: ${path}`);
    }));

    const queryClient = createQueryClient();
    const first = renderDirectory(
      { organizationId: ORGANIZATION_A, spaceId: SPACE_A },
      queryClient,
    );
    await waitFor(() => expect(firstRootSignal).toBeDefined());

    first.rerender(
      <QueryClientProvider client={queryClient}>
        <ContentDirectory
          identity={{ organizationId: ORGANIZATION_B, spaceId: SPACE_B }}
          onAccessLost={first.onAccessLost}
          onStatusChange={first.onStatusChange}
        />
      </QueryClientProvider>,
    );

    await waitFor(() => {
      expect(useContentSelectionStore.getState().selection).toEqual({
        documentId: DOCUMENT_B,
        notebookId: NOTEBOOK_B,
        spaceId: SPACE_B,
      });
    });
    await waitFor(() => expect(firstRootSignal?.aborted).toBe(true));

    await act(async () => {
      firstRoot.resolve(jsonResponse({
        documents: [document(NOTEBOOK_A, DOCUMENT_A, "迟到文档")],
        locked: false,
        nextOffset: null,
      }));
      await firstRoot.promise;
    });
    expect(useContentSelectionStore.getState().selection).toEqual({
      documentId: DOCUMENT_B,
      notebookId: NOTEBOOK_B,
      spaceId: SPACE_B,
    });
  });

  it("loads sibling pages under distinct offsets without copying pages into the selection store", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>((input) => {
      const path = requestPath(input);
      if (path === notebooksPath(ORGANIZATION_A, SPACE_A)) {
        return Promise.resolve(jsonResponse({ notebooks: [notebook(NOTEBOOK_A)] }));
      }
      if (path === rootDocumentsPath(ORGANIZATION_A, SPACE_A, NOTEBOOK_A)) {
        return Promise.resolve(jsonResponse({
          documents: [document(NOTEBOOK_A, DOCUMENT_A, "第一页")],
          locked: false,
          nextOffset: 1,
        }));
      }
      if (path === rootDocumentsPath(ORGANIZATION_A, SPACE_A, NOTEBOOK_A, 1)) {
        return Promise.resolve(jsonResponse({
          documents: [document(NOTEBOOK_A, DOCUMENT_B, "第二页")],
          locked: false,
          nextOffset: null,
        }));
      }
      throw new Error(`Unexpected request: ${path}`);
    }));

    renderDirectory({ organizationId: ORGANIZATION_A, spaceId: SPACE_A });
    expect(await screen.findByRole("button", { name: "第一页" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "加载更多" }));
    expect(await screen.findByRole("button", { name: "第二页" })).toBeVisible();
    expect(Object.keys(useContentSelectionStore.getState().selection ?? {}).sort()).toEqual([
      "documentId",
      "notebookId",
      "spaceId",
    ]);
  });

  it("loads children only from the selected document's real parent route", async () => {
    const requested: string[] = [];
    vi.stubGlobal("fetch", vi.fn<typeof fetch>((input) => {
      const path = requestPath(input);
      requested.push(path);
      if (path === notebooksPath(ORGANIZATION_A, SPACE_A)) {
        return Promise.resolve(jsonResponse({ notebooks: [notebook(NOTEBOOK_A)] }));
      }
      if (path === rootDocumentsPath(ORGANIZATION_A, SPACE_A, NOTEBOOK_A)) {
        return Promise.resolve(jsonResponse({
          documents: [document(NOTEBOOK_A, DOCUMENT_A, "父文档", true)],
          locked: false,
          nextOffset: null,
        }));
      }
      if (
        path === childDocumentsPath(
          ORGANIZATION_A,
          SPACE_A,
          NOTEBOOK_A,
          DOCUMENT_A,
        )
      ) {
        return Promise.resolve(jsonResponse({
          documents: [
            document(NOTEBOOK_A, CHILD_DOCUMENT, "子文档"),
          ],
          locked: false,
          nextOffset: null,
        }));
      }
      throw new Error(`Unexpected request: ${path}`);
    }));

    renderDirectory({ organizationId: ORGANIZATION_A, spaceId: SPACE_A });
    expect(await screen.findByRole("button", { name: "父文档" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "展开子文档" }));
    fireEvent.click(await screen.findByRole("button", { name: "子文档" }));

    expect(useContentSelectionStore.getState().selection).toEqual({
      documentId: CHILD_DOCUMENT,
      notebookId: NOTEBOOK_A,
      spaceId: SPACE_A,
    });
    expect(requested).toContain(
      childDocumentsPath(
        ORGANIZATION_A,
        SPACE_A,
        NOTEBOOK_A,
        DOCUMENT_A,
      ),
    );
  });
});
