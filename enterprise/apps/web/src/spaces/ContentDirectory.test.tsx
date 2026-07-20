import "@testing-library/jest-dom/vitest";
import {
  RUNTIME_ACCESS_LOST_HEADER_NAME,
  RUNTIME_ACCESS_LOST_HEADER_VALUE,
} from "@singularity/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  type ContentDirectoryAccessLoss,
  ContentDirectory,
  type ContentDirectoryStatus,
} from "@/spaces/ContentDirectory.tsx";
import { contentDirectoryDocumentsQueryKey } from "@/spaces/content-directory-api.ts";
import {
  activateContentSelectionScope,
  clearContentSelection,
  getContentSelectionForScope,
  releaseContentSelectionScope,
  selectContentDocument,
  useContentSelectionStore,
  type ContentSelectionScope,
} from "@/spaces/content-selection.ts";

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
let activeTestScope: ContentSelectionScope | null = null;

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

function notFoundResponse(runtimeAccessLost = false): Response {
  return new Response(
    JSON.stringify({ code: "not-found", requestId: REQUEST_ID, status: 404 }),
    {
      headers: {
        "Content-Type": "application/problem+json",
        ...(runtimeAccessLost
          ? {
              [RUNTIME_ACCESS_LOST_HEADER_NAME]:
                RUNTIME_ACCESS_LOST_HEADER_VALUE,
            }
          : {}),
      },
      status: 404,
    },
  );
}

function notebook(
  notebookId: string,
  locked = false,
  supportsGraph = true,
) {
  return { icon: "", locked, name: notebookId, notebookId, supportsGraph };
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
  const scope = activateContentSelectionScope(identity);
  activeTestScope = scope;
  const onAccessLost = vi.fn<(event: ContentDirectoryAccessLoss) => void>();
  const onStatusChange = vi.fn<(status: ContentDirectoryStatus) => void>();
  const result = render(
    <QueryClientProvider client={queryClient}>
      <ScopedContentDirectory
        onAccessLost={onAccessLost}
        onStatusChange={onStatusChange}
        scope={scope}
      />
    </QueryClientProvider>,
  );
  return { ...result, onAccessLost, onStatusChange, queryClient, scope };
}

function ScopedContentDirectory({
  onAccessLost,
  onStatusChange,
  scope,
}: {
  readonly onAccessLost: (event: ContentDirectoryAccessLoss) => void;
  readonly onStatusChange: (status: ContentDirectoryStatus) => void;
  readonly scope: ContentSelectionScope;
}) {
  const storeSelection = useContentSelectionStore((state) => state.selection);
  const selection = storeSelection?.spaceId === scope.spaceId
    ? getContentSelectionForScope(scope)
    : null;
  return (
    <ContentDirectory
      identity={scope}
      onAccessLost={onAccessLost}
      onClear={() => clearContentSelection(scope)}
      onSelect={(target) => selectContentDocument(scope, target)}
      onStatusChange={onStatusChange}
      selection={selection}
    />
  );
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
  if (activeTestScope) {
    releaseContentSelectionScope(activeTestScope);
    activeTestScope = null;
  }
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
            notebook(LOCKED_NOTEBOOK, true, false),
            notebook(EMPTY_NOTEBOOK),
            notebook(NOTEBOOK_A, false, false),
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
        supportsGraph: false,
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

  it("does not select or expose a document when every notebook is locked or empty", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>((input) => {
      const path = requestPath(input);
      if (path === notebooksPath(ORGANIZATION_A, SPACE_A)) {
        return Promise.resolve(jsonResponse({
          notebooks: [
            notebook(LOCKED_NOTEBOOK, true, false),
            notebook(EMPTY_NOTEBOOK),
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
      throw new Error(`Unexpected request: ${path}`);
    }));

    const { onStatusChange } = renderDirectory({
      organizationId: ORGANIZATION_A,
      spaceId: SPACE_A,
    });

    await waitFor(() => {
      expect(useContentSelectionStore.getState().selection).toBeNull();
      expect(onStatusChange).toHaveBeenLastCalledWith("empty");
    });
    expect(screen.queryByRole("button", { name: "无标题" })).not.toBeInTheDocument();
    expect(screen.queryByText("内容库已锁定")).not.toBeInTheDocument();
  });

  it("reports forbidden only for a marked runtime access loss", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>((input) => {
      const path = requestPath(input);
      if (path === notebooksPath(ORGANIZATION_A, SPACE_A)) {
        return Promise.resolve(jsonResponse({ notebooks: [notebook(NOTEBOOK_A)] }));
      }
      if (path === rootDocumentsPath(ORGANIZATION_A, SPACE_A, NOTEBOOK_A)) {
        return Promise.resolve(jsonResponse({
          documents: [document(NOTEBOOK_A, DOCUMENT_A, "当前文档", true)],
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
        return Promise.resolve(notFoundResponse(true));
      }
      throw new Error(`Unexpected request: ${path}`);
    }));

    const { onAccessLost } = renderDirectory({
      organizationId: ORGANIZATION_A,
      spaceId: SPACE_A,
    });
    expect(await screen.findByRole("button", { name: "当前文档" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "展开子文档" }));

    await waitFor(() => {
      expect(onAccessLost).toHaveBeenCalledWith({
        category: "forbidden",
        triggeringRequestId: REQUEST_ID,
        type: "runtime-error",
      });
    });
    expect(onAccessLost).toHaveBeenCalledTimes(1);
    expect(useContentSelectionStore.getState().selection).toEqual({
      documentId: DOCUMENT_A,
      notebookId: NOTEBOOK_A,
      spaceId: SPACE_A,
      supportsGraph: true,
    });
  });

  it("keeps an ordinary document 404 local to the directory operation", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>((input) => {
      const path = requestPath(input);
      if (path === notebooksPath(ORGANIZATION_A, SPACE_A)) {
        return Promise.resolve(jsonResponse({ notebooks: [notebook(NOTEBOOK_A)] }));
      }
      if (path === rootDocumentsPath(ORGANIZATION_A, SPACE_A, NOTEBOOK_A)) {
        return Promise.resolve(jsonResponse({
          documents: [document(NOTEBOOK_A, DOCUMENT_A, "当前文档", true)],
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
        return Promise.resolve(notFoundResponse());
      }
      throw new Error(`Unexpected request: ${path}`);
    }));

    const { container, onAccessLost } = renderDirectory({
      organizationId: ORGANIZATION_A,
      spaceId: SPACE_A,
    });
    expect(await screen.findByRole("button", { name: "当前文档" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "展开子文档" }));

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "重新加载该层文档" })).toBeVisible();
      expect(container.querySelector("[data-content-directory-status]")).toHaveAttribute(
        "data-content-directory-status",
        "ready",
      );
    });
    expect(onAccessLost).not.toHaveBeenCalled();
    expect(useContentSelectionStore.getState().selection).toEqual({
      documentId: DOCUMENT_A,
      notebookId: NOTEBOOK_A,
      spaceId: SPACE_A,
      supportsGraph: true,
    });
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

  it("rejects a selection command from the directory generation replaced by refresh", async () => {
    let notebookRequests = 0;
    let rootRequests = 0;
    const refreshedRoot = deferred<Response>();
    vi.stubGlobal("fetch", vi.fn<typeof fetch>((input) => {
      const path = requestPath(input);
      if (path === notebooksPath(ORGANIZATION_A, SPACE_A)) {
        notebookRequests += 1;
        return Promise.resolve(jsonResponse({
          notebooks: [notebook(NOTEBOOK_A, false, notebookRequests === 1)],
        }));
      }
      if (path === rootDocumentsPath(ORGANIZATION_A, SPACE_A, NOTEBOOK_A)) {
        rootRequests += 1;
        return rootRequests === 1
          ? Promise.resolve(jsonResponse({
              documents: [
                document(NOTEBOOK_A, DOCUMENT_A, "旧代次首文档"),
                document(NOTEBOOK_A, DOCUMENT_B, "旧代次第二文档"),
              ],
              locked: false,
              nextOffset: null,
            }))
          : refreshedRoot.promise;
      }
      throw new Error(`Unexpected request: ${path}`);
    }));

    renderDirectory({ organizationId: ORGANIZATION_A, spaceId: SPACE_A });
    const staleDocumentButton = await screen.findByRole("button", {
      name: "旧代次第二文档",
    });

    act(() => {
      screen.getByRole("button", { name: "刷新文档目录" }).click();
      staleDocumentButton.click();
    });

    expect(useContentSelectionStore.getState().selection?.documentId).toBe(
      DOCUMENT_A,
    );
    await act(async () => {
      refreshedRoot.resolve(jsonResponse({
        documents: [document(NOTEBOOK_A, DOCUMENT_B, "刷新后文档")],
        locked: false,
        nextOffset: null,
      }));
      await refreshedRoot.promise;
    });
    await waitFor(() => {
      expect(useContentSelectionStore.getState().selection).toEqual({
        documentId: DOCUMENT_B,
        notebookId: NOTEBOOK_A,
        spaceId: SPACE_A,
        supportsGraph: false,
      });
    });
  });

  it("retains cached nodes, expansion, and selection when refresh fails", async () => {
    let rootRequests = 0;
    vi.stubGlobal("fetch", vi.fn<typeof fetch>((input) => {
      const path = requestPath(input);
      if (path === notebooksPath(ORGANIZATION_A, SPACE_A)) {
        return Promise.resolve(jsonResponse({ notebooks: [notebook(NOTEBOOK_A)] }));
      }
      if (path === rootDocumentsPath(ORGANIZATION_A, SPACE_A, NOTEBOOK_A)) {
        rootRequests += 1;
        return Promise.resolve(
          rootRequests === 1
            ? jsonResponse({
                documents: [
                  document(NOTEBOOK_A, DOCUMENT_A, "保留文档", true),
                ],
                locked: false,
                nextOffset: null,
              })
            : jsonResponse(problem(503), 503),
        );
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
          documents: [document(NOTEBOOK_A, CHILD_DOCUMENT, "保留子文档")],
          locked: false,
          nextOffset: null,
        }));
      }
      throw new Error(`Unexpected request: ${path}`);
    }));

    const { scope } = renderDirectory({
      organizationId: ORGANIZATION_A,
      spaceId: SPACE_A,
    });
    fireEvent.click(await screen.findByRole("button", { name: "展开子文档" }));
    expect(await screen.findByRole("button", { name: "保留子文档" })).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "刷新文档目录" }));
    expect(await screen.findByRole("button", { name: "重新加载目录" })).toBeVisible();
    expect(screen.getByRole("button", { name: "保留文档" })).toBeVisible();
    expect(screen.getByRole("button", { name: "保留子文档" })).toBeVisible();
    expect(useContentSelectionStore.getState().selection?.documentId).toBe(
      DOCUMENT_A,
    );

    act(() => {
      expect(clearContentSelection(scope)).toBe(true);
    });
    fireEvent.click(screen.getByRole("button", { name: "保留子文档" }));
    expect(useContentSelectionStore.getState().selection?.documentId).toBe(
      CHILD_DOCUMENT,
    );
  });

  it("invalidates old child and offset pages only after a successful refresh", async () => {
    let rootRequests = 0;
    vi.stubGlobal("fetch", vi.fn<typeof fetch>((input) => {
      const path = requestPath(input);
      if (path === notebooksPath(ORGANIZATION_A, SPACE_A)) {
        return Promise.resolve(jsonResponse({ notebooks: [notebook(NOTEBOOK_A)] }));
      }
      if (path === rootDocumentsPath(ORGANIZATION_A, SPACE_A, NOTEBOOK_A)) {
        rootRequests += 1;
        return Promise.resolve(jsonResponse({
          documents: [
            rootRequests === 1
              ? document(NOTEBOOK_A, DOCUMENT_A, "旧根文档", true)
              : document(NOTEBOOK_A, DOCUMENT_B, "新根文档"),
          ],
          locked: false,
          nextOffset: rootRequests === 1 ? 1 : null,
        }));
      }
      if (path === rootDocumentsPath(ORGANIZATION_A, SPACE_A, NOTEBOOK_A, 1)) {
        return Promise.resolve(jsonResponse({
          documents: [document(NOTEBOOK_A, DOCUMENT_B, "旧偏移页")],
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
          documents: [document(NOTEBOOK_A, CHILD_DOCUMENT, "旧子层")],
          locked: false,
          nextOffset: null,
        }));
      }
      throw new Error(`Unexpected request: ${path}`);
    }));

    const { queryClient } = renderDirectory({
      organizationId: ORGANIZATION_A,
      spaceId: SPACE_A,
    });
    fireEvent.click(await screen.findByRole("button", { name: "展开子文档" }));
    fireEvent.click(screen.getByRole("button", { name: "加载更多" }));
    expect(await screen.findByRole("button", { name: "旧子层" })).toBeVisible();
    expect(await screen.findByRole("button", { name: "旧偏移页" })).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "刷新文档目录" }));
    expect(await screen.findByRole("button", { name: "新根文档" })).toBeVisible();

    expect(queryClient.getQueryData(contentDirectoryDocumentsQueryKey({
      level: { kind: "children", parentDocumentId: DOCUMENT_A },
      notebookId: NOTEBOOK_A,
      organizationId: ORGANIZATION_A,
      spaceId: SPACE_A,
    }, 0))).toBeUndefined();
    expect(queryClient.getQueryData(contentDirectoryDocumentsQueryKey({
      level: { kind: "root" },
      notebookId: NOTEBOOK_A,
      organizationId: ORGANIZATION_A,
      spaceId: SPACE_A,
    }, 1))).toBeUndefined();
  });

  it("quarantines every locked or disappeared notebook in one generation", async () => {
    let notebookRequests = 0;
    vi.stubGlobal("fetch", vi.fn<typeof fetch>((input) => {
      const path = requestPath(input);
      if (path === notebooksPath(ORGANIZATION_A, SPACE_A)) {
        notebookRequests += 1;
        return Promise.resolve(jsonResponse({
          notebooks: notebookRequests === 1
            ? [notebook(NOTEBOOK_A), notebook(NOTEBOOK_B)]
            : [notebook(NOTEBOOK_A, true, false)],
        }));
      }
      if (path === rootDocumentsPath(ORGANIZATION_A, SPACE_A, NOTEBOOK_A)) {
        return Promise.resolve(jsonResponse({
          documents: [document(NOTEBOOK_A, DOCUMENT_A, "锁前标题 A")],
          locked: false,
          nextOffset: null,
        }));
      }
      if (path === rootDocumentsPath(ORGANIZATION_A, SPACE_A, NOTEBOOK_B)) {
        return Promise.resolve(jsonResponse({
          documents: [document(NOTEBOOK_B, DOCUMENT_B, "锁前标题 B")],
          locked: false,
          nextOffset: null,
        }));
      }
      throw new Error(`Unexpected request: ${path}`);
    }));

    const { queryClient } = renderDirectory({
      organizationId: ORGANIZATION_A,
      spaceId: SPACE_A,
    });
    const staleDocument = await screen.findByRole("button", { name: "锁前标题 A" });
    const notebookExpanders = screen.getAllByRole("button", { name: "展开笔记本" });
    fireEvent.click(notebookExpanders[0]!);
    expect(await screen.findByRole("button", { name: "锁前标题 B" })).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "刷新文档目录" }));
    await waitFor(() => {
      expect(screen.queryByText("锁前标题 A")).not.toBeInTheDocument();
      expect(screen.queryByText("锁前标题 B")).not.toBeInTheDocument();
      expect(useContentSelectionStore.getState().selection).toBeNull();
    });
    expect(queryClient.getQueryData(contentDirectoryDocumentsQueryKey({
      level: { kind: "root" },
      notebookId: NOTEBOOK_A,
      organizationId: ORGANIZATION_A,
      spaceId: SPACE_A,
    }, 0))).toBeUndefined();
    expect(queryClient.getQueryData(contentDirectoryDocumentsQueryKey({
      level: { kind: "root" },
      notebookId: NOTEBOOK_B,
      organizationId: ORGANIZATION_A,
      spaceId: SPACE_A,
    }, 0))).toBeUndefined();

    fireEvent.click(staleDocument);
    expect(useContentSelectionStore.getState().selection).toBeNull();
  });

  it("records the original directory error object and stack", async () => {
    const sentinel = new Error("directory-stack-sentinel");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.stubGlobal("fetch", vi.fn<typeof fetch>((input) => {
      const path = requestPath(input);
      if (path === notebooksPath(ORGANIZATION_A, SPACE_A)) {
        return Promise.resolve(jsonResponse({ notebooks: [notebook(NOTEBOOK_A)] }));
      }
      if (path === rootDocumentsPath(ORGANIZATION_A, SPACE_A, NOTEBOOK_A)) {
        return Promise.reject(sentinel);
      }
      throw new Error(`Unexpected request: ${path}`);
    }));

    renderDirectory({ organizationId: ORGANIZATION_A, spaceId: SPACE_A });
    await screen.findByRole("button", { name: "重新加载目录" });

    expect(sentinel.stack).toContain("directory-stack-sentinel");
    expect(warn).toHaveBeenCalledWith(
      "[content.directory]",
      expect.objectContaining({
        error: expect.objectContaining({ cause: sentinel }) as unknown,
        phase: "bootstrap",
        result: "failed",
      }),
    );
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

    const secondScope = activateContentSelectionScope({
      organizationId: ORGANIZATION_B,
      spaceId: SPACE_B,
    });
    activeTestScope = secondScope;
    first.rerender(
      <QueryClientProvider client={queryClient}>
        <ScopedContentDirectory
          onAccessLost={first.onAccessLost}
          onStatusChange={first.onStatusChange}
          scope={secondScope}
        />
      </QueryClientProvider>,
    );

    await waitFor(() => {
      expect(useContentSelectionStore.getState().selection).toEqual({
        documentId: DOCUMENT_B,
        notebookId: NOTEBOOK_B,
        spaceId: SPACE_B,
        supportsGraph: true,
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
      supportsGraph: true,
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
      "supportsGraph",
    ]);
  });

  it("loads children only from the selected document's real parent route", async () => {
    const requested: string[] = [];
    vi.stubGlobal("fetch", vi.fn<typeof fetch>((input) => {
      const path = requestPath(input);
      requested.push(path);
      if (path === notebooksPath(ORGANIZATION_A, SPACE_A)) {
        return Promise.resolve(jsonResponse({
          notebooks: [notebook(NOTEBOOK_A, false, false)],
        }));
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
      supportsGraph: false,
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
