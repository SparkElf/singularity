import "@testing-library/jest-dom/vitest";
import type {
  ProtyleController,
  ProtyleMenuSurface,
  ProtyleTransport,
} from "@singularity/protyle-browser";
import {
  createEmptyProtylePluginPort,
  createProtyleEditorRegistry,
  createProtyleMenuPort,
  createProtyleOverlayPort,
  createProtyleSession,
  type ProtyleSession,
} from "@singularity/protyle-browser";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DiscoveryPanel } from "@/spaces/DiscoveryPanel.tsx";
import type { SpaceProtyleRuntime } from "@/spaces/space-session.ts";
import { useDiscoveryStore } from "@/spaces/discovery-state.ts";

const ORGANIZATION_ID = "11111111-1111-4111-8111-111111111111";
const SPACE_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const NOTEBOOK_ID = "20260719000000-noteb01";
const DOCUMENT_ID = "20260719000100-docum01";
const DOCUMENT_B = "20260719000101-docum02";
const BLOCK_ID = "20260719000200-block01";
const BLOCK_B = "20260719000201-block02";
const CSRF_TOKEN = "A".repeat(43);

const sessions = new Set<ProtyleSession<SpaceProtyleRuntime>>();

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json" },
    status,
  });
}

function menuSurface(): ProtyleMenuSurface {
  return {
    addItem: () => undefined,
    append: () => undefined,
    close: () => undefined,
    data: undefined,
    element: document.createElement("div"),
    fullscreen: () => undefined,
    popup: () => undefined,
    removeCB: undefined,
    resetPosition: () => undefined,
    showSubMenu: () => undefined,
  };
}

function createTestSession(
  request: ProtyleTransport<unknown>["request"] = async () => {
    throw new Error("Gateway transport is outside the current Discovery contract");
  },
): ProtyleSession<SpaceProtyleRuntime> {
  const upload: ProtyleTransport<unknown>["upload"] = async () => {
    throw new Error("Gateway upload is outside the space-search contract");
  };
  const transport = {
    dispose: () => undefined,
    freeze: () => undefined,
    request,
    resumeSubmission: () => undefined,
    subscribe: () => ({ disconnect: () => undefined }),
    upload,
  } satisfies SpaceProtyleRuntime["transport"];
  const session = createProtyleSession({
    retrySubmission: () => Promise.resolve(),
    runtime: {
      editors: createProtyleEditorRegistry<ProtyleController>(),
      host: { dispatch: () => undefined },
      menu: createProtyleMenuPort(menuSurface, () => undefined),
      overlays: createProtyleOverlayPort<HTMLElement>(() => undefined),
      plugins: createEmptyProtylePluginPort<unknown, unknown, ProtyleController>(),
      resources: {
        resolveAsset: () => "",
        resolveEmoji: () => "",
        resolveExport: () => "",
      },
      transport,
    },
    spaceId: SPACE_ID,
  });
  sessions.add(session);
  return session;
}

afterEach(async () => {
  cleanup();
  useDiscoveryStore.setState({ panel: null, requestRevision: 0 });
  for (const session of sessions) {
    await session.dispose();
  }
  sessions.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("DiscoveryPanel", () => {
  it("uses the public space contract and navigates with response-owned identity", async () => {
    const requests: Array<{ readonly body: unknown; readonly path: string }> = [];
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(
        input instanceof Request ? input.url : String(input),
        window.location.origin,
      );
      if (url.pathname === "/api/v1/auth/csrf") {
        return jsonResponse({ csrfToken: CSRF_TOKEN });
      }
      requests.push({
        body: init?.body === undefined ? null : JSON.parse(String(init.body)),
        path: url.pathname,
      });
      return jsonResponse({
        blocks: [{
          content: "空间搜索命中",
          documentId: DOCUMENT_ID,
          id: BLOCK_ID,
          notebookId: NOTEBOOK_ID,
        }],
        matchedBlockCount: 1,
        pageCount: 1,
      });
    }));

    useDiscoveryStore.getState().openSpaceSearch({
      method: "preferred",
      query: "nebula",
      queryMode: "replace",
      spaceId: SPACE_ID,
    });
    const onNavigate = vi.fn();
    render(
      <DiscoveryPanel
        onNavigate={onNavigate}
        organizationId={ORGANIZATION_ID}
        session={createTestSession()}
        spaceId={SPACE_ID}
      />,
    );

    const result = await screen.findByRole("button", { name: /空间搜索命中/ });
    expect(requests).toEqual([{
      body: { method: "preferred", query: "nebula" },
      path: `/api/v1/organizations/${ORGANIZATION_ID}/spaces/${SPACE_ID}/discovery/search`,
    }]);
    expect(requests[0]?.body).not.toHaveProperty("notebookId");
    expect(requests[0]?.body).not.toHaveProperty("documentId");

    result.click();
    expect(onNavigate).toHaveBeenCalledWith({
      blockId: BLOCK_ID,
      documentId: DOCUMENT_ID,
      notebookId: NOTEBOOK_ID,
    });
  });

  it("does not render an identity-less graph node as a navigation command", async () => {
    useDiscoveryStore.getState().open({
      documentId: DOCUMENT_ID,
      kind: "document-graph",
      notebookId: NOTEBOOK_ID,
      query: "",
      spaceId: SPACE_ID,
    });
    const graphRequest = vi.fn<ProtyleTransport<unknown>["request"]>()
      .mockResolvedValue({
        code: 0,
        data: {
          links: [],
          nodes: [
            {
              documentId: DOCUMENT_ID,
              id: BLOCK_ID,
              label: "可导航文档",
              notebookId: NOTEBOOK_ID,
            },
            {
              documentId: null,
              id: "#标签",
              label: "#标签",
              notebookId: null,
            },
          ],
        },
      });
    const session = createTestSession(graphRequest);
    const onNavigate = vi.fn();

    render(
      <DiscoveryPanel
        onNavigate={onNavigate}
        organizationId={ORGANIZATION_ID}
        session={session}
        spaceId={SPACE_ID}
      />,
    );

    const documentNode = await screen.findByRole("button", { name: "可导航文档" });
    expect(screen.getByText("#标签")).toBeVisible();
    documentNode.click();
    expect(onNavigate).toHaveBeenCalledWith({
      blockId: BLOCK_ID,
      documentId: DOCUMENT_ID,
      notebookId: NOTEBOOK_ID,
    });
    expect(screen.getByText("#标签").closest("button")).toBeNull();
  });

  it("searches one document through a single identity-bound Gateway request", async () => {
    useDiscoveryStore.getState().open({
      documentId: DOCUMENT_ID,
      kind: "document-search",
      notebookId: NOTEBOOK_ID,
      query: "focused",
      spaceId: SPACE_ID,
    });
    const documentRequest = vi.fn<ProtyleTransport<unknown>["request"]>()
      .mockResolvedValue({
        code: 0,
        data: {
          blocks: [{
            content: "文档内命中",
            documentId: DOCUMENT_ID,
            id: BLOCK_ID,
            notebookId: NOTEBOOK_ID,
          }],
          matchedBlockCount: 1,
          pageCount: 1,
        },
      });

    render(
      <DiscoveryPanel
        onNavigate={vi.fn()}
        organizationId={ORGANIZATION_ID}
        session={createTestSession(documentRequest)}
        spaceId={SPACE_ID}
      />,
    );

    expect(await screen.findByText("文档内命中")).toBeVisible();
    expect(documentRequest).toHaveBeenCalledOnce();
    expect(documentRequest).toHaveBeenCalledWith(
      "/api/search/fullTextSearchBlock",
      { query: "focused" },
      {
        identity: {
          documentId: DOCUMENT_ID,
          notebookId: NOTEBOOK_ID,
        },
        intent: "read",
        signal: expect.any(AbortSignal),
      },
    );
  });

  it("loads the document outline through its declared content identity", async () => {
    useDiscoveryStore.getState().open({
      documentId: DOCUMENT_ID,
      kind: "outline",
      notebookId: NOTEBOOK_ID,
      preview: false,
      spaceId: SPACE_ID,
    });
    const outlineRequest = vi.fn<ProtyleTransport<unknown>["request"]>()
      .mockResolvedValue({
        code: 0,
        data: [{ children: [], hPath: "第一文档 / 大纲", id: BLOCK_ID, name: "大纲" }],
      });

    render(
      <DiscoveryPanel
        onNavigate={vi.fn()}
        organizationId={ORGANIZATION_ID}
        session={createTestSession(outlineRequest)}
        spaceId={SPACE_ID}
      />,
    );

    expect(await screen.findByRole("button", { name: "大纲" })).toBeVisible();
    expect(outlineRequest).toHaveBeenCalledWith(
      "/api/outline/getDocOutline",
      { id: DOCUMENT_ID, preview: false },
      {
        identity: { documentId: DOCUMENT_ID, notebookId: NOTEBOOK_ID },
        intent: "read",
        signal: expect.any(AbortSignal),
      },
    );
  });

  it("loads backlinks and backmentions as canonical navigation projections", async () => {
    useDiscoveryStore.getState().open({
      documentId: DOCUMENT_ID,
      kind: "backlinks",
      notebookId: NOTEBOOK_ID,
      spaceId: SPACE_ID,
    });
    const backlinksRequest = vi.fn<ProtyleTransport<unknown>["request"]>()
      .mockResolvedValue({
        code: 0,
        data: {
          backlinks: [{ documentId: DOCUMENT_B, notebookId: NOTEBOOK_ID, title: "反链文档" }],
          backmentions: [],
        },
      });
    const onNavigate = vi.fn();

    render(
      <DiscoveryPanel
        onNavigate={onNavigate}
        organizationId={ORGANIZATION_ID}
        session={createTestSession(backlinksRequest)}
        spaceId={SPACE_ID}
      />,
    );

    const backlink = await screen.findByRole("button", { name: "反链文档" });
    backlink.click();
    expect(onNavigate).toHaveBeenCalledWith({
      blockId: DOCUMENT_B,
      documentId: DOCUMENT_B,
      notebookId: NOTEBOOK_ID,
    });
    expect(backlinksRequest).toHaveBeenCalledWith(
      "/api/ref/getBacklink2",
      { id: DOCUMENT_ID, k: "", mSort: "3", mk: "", sort: "3" },
      {
        identity: { documentId: DOCUMENT_ID, notebookId: NOTEBOOK_ID },
        intent: "read",
        signal: expect.any(AbortSignal),
      },
    );
  });

  it("loads paged document history without widening the query identity", async () => {
    useDiscoveryStore.getState().open({
      documentId: DOCUMENT_ID,
      kind: "document-history",
      notebookId: NOTEBOOK_ID,
      page: 1,
      spaceId: SPACE_ID,
    });
    const historyRequest = vi.fn<ProtyleTransport<unknown>["request"]>()
      .mockResolvedValue({
        code: 0,
        data: {
          histories: ["2026-07-19 15:00:00"],
          pageCount: 2,
          totalCount: 3,
        },
      });

    render(
      <DiscoveryPanel
        onNavigate={vi.fn()}
        organizationId={ORGANIZATION_ID}
        session={createTestSession(historyRequest)}
        spaceId={SPACE_ID}
      />,
    );

    expect(await screen.findByText("2026-07-19 15:00:00")).toBeVisible();
    expect(historyRequest).toHaveBeenCalledWith(
      "/api/history/searchHistory",
      { op: "all", page: 1, query: DOCUMENT_ID, type: 3 },
      {
        identity: { documentId: DOCUMENT_ID, notebookId: NOTEBOOK_ID },
        intent: "read",
        signal: expect.any(AbortSignal),
      },
    );
  });

  it("ignores a late response after the document identity changes", async () => {
    const pending = new Map<string, (value: unknown) => void>();
    const documentRequest = vi.fn<ProtyleTransport<unknown>["request"]>(
      (_path, _body, options) => new Promise((resolve) => {
        pending.set(options.identity.documentId, resolve);
      }),
    );
    useDiscoveryStore.getState().open({
      documentId: DOCUMENT_ID,
      kind: "document-search",
      notebookId: NOTEBOOK_ID,
      query: "first",
      spaceId: SPACE_ID,
    });
    render(
      <DiscoveryPanel
        onNavigate={vi.fn()}
        organizationId={ORGANIZATION_ID}
        session={createTestSession(documentRequest)}
        spaceId={SPACE_ID}
      />,
    );
    await waitFor(() => expect(documentRequest).toHaveBeenCalledTimes(1));

    act(() => {
      useDiscoveryStore.getState().open({
        documentId: DOCUMENT_B,
        kind: "document-search",
        notebookId: NOTEBOOK_ID,
        query: "second",
        spaceId: SPACE_ID,
      });
    });
    await waitFor(() => expect(documentRequest).toHaveBeenCalledTimes(2));

    await act(async () => {
      pending.get(DOCUMENT_ID)?.({
        code: 0,
        data: {
          blocks: [{
            content: "迟到的第一文档结果",
            documentId: DOCUMENT_ID,
            id: BLOCK_ID,
            notebookId: NOTEBOOK_ID,
          }],
          matchedBlockCount: 1,
          pageCount: 1,
        },
      });
    });
    await waitFor(() => expect(screen.queryByText("迟到的第一文档结果")).not.toBeInTheDocument());

    await act(async () => {
      pending.get(DOCUMENT_B)?.({
        code: 0,
        data: {
          blocks: [{
            content: "第二文档结果",
            documentId: DOCUMENT_B,
            id: BLOCK_B,
            notebookId: NOTEBOOK_ID,
          }],
          matchedBlockCount: 1,
          pageCount: 1,
        },
      });
    });
    expect(await screen.findByText("第二文档结果")).toBeVisible();
  });
});
