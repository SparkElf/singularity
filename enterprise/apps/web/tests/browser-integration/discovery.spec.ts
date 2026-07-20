import { expect, test, type Page, type TestInfo } from "@playwright/test";

import {
  collectBrowserDiagnostics,
  expectBrowserHealthy,
  isExpectedIconNetworkChange,
} from "./support/diagnostics.ts";
import { fulfillJson } from "./support/http.ts";
import { contentBlock } from "./support/protyle.ts";

const ORGANIZATION_ID = "11111111-1111-4111-8111-111111111111";
const SPACE_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const NOTEBOOK_ID = "20260719000000-noteb01";
const DOCUMENT_A = "20260719000100-docum01";
const DOCUMENT_B = "20260719000101-docum02";
const BLOCK_A = "20260719000200-block01";
const BLOCK_B = "20260719000201-block02";
const CSRF_TOKEN = "A".repeat(43);
const MAX_REQUEST_DURATION_MS = 5_000;
const GATEWAY_BASE_PATH = `/api/v1/organizations/${ORGANIZATION_ID}/spaces/${SPACE_ID}`;

interface ObservedRequest {
  readonly body: unknown;
  readonly documentId: string;
  readonly notebookId: string;
}

interface ObservedDocumentRequest extends ObservedRequest {
  readonly path: string;
}

interface DiscoveryBoundary {
  readonly graph: ObservedRequest[];
  readonly document: ObservedDocumentRequest[];
  readonly search: Array<{ readonly body: unknown }>;
  readonly spaceGraph: Array<{ readonly body: unknown }>;
}

function requireDesktop(testInfo: TestInfo): void {
  test.skip(
    testInfo.project.name !== "desktop",
    "Discovery browser contract uses the desktop Protyle host; responsive shell contracts run elsewhere.",
  );
}

function documentResponse(documentId: string, requestedId = documentId): object {
  const isFirst = documentId === DOCUMENT_A;
  const blockId = isFirst ? BLOCK_A : BLOCK_B;
  const text = isFirst ? "第一文档内容" : "第二文档内容";
  const tag = isFirst ? '<span data-type="tag">nebula</span>' : "";
  return {
    code: 0,
    data: {
      blockCount: 1,
      content: `<div data-node-id="${blockId}" data-type="NodeParagraph" class="p" updated="20260719000000"><div contenteditable="true" spellcheck="false">${text} ${tag}</div><div class="protyle-attr" contenteditable="false">&#8203;</div></div>`,
      eof: false,
      id: requestedId,
      isBacklinkExpand: false,
      isSyncing: false,
      mode: 0,
      name: isFirst ? "第一文档" : "第二文档",
      notebook: NOTEBOOK_ID,
      parent2ID: "",
      parentDocument: false,
      parentID: "",
      path: `/${documentId}.sy`,
      rootID: documentId,
      scroll: {},
      type: requestedId === documentId ? "NodeDocument" : "NodeParagraph",
    },
    msg: "",
  };
}

function requestHeaders(request: { headers(): Record<string, string> }): {
  readonly documentId: string;
  readonly notebookId: string;
} {
  const headers = request.headers();
  return {
    documentId: headers["x-singularity-document-id"] ?? "",
    notebookId: headers["x-singularity-notebook-id"] ?? "",
  };
}

async function installBoundary(page: Page): Promise<DiscoveryBoundary> {
  const boundary: DiscoveryBoundary = {
    document: [],
    graph: [],
    search: [],
    spaceGraph: [],
  };

  await page.routeWebSocket(/\/kernel\/ws(?:\?|$)/, () => undefined);
  await page.route("**/api/v1/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;

    if (path === "/api/v1/spaces") {
      await fulfillJson(route, {
        spaces: [{
          organizationId: ORGANIZATION_ID,
          organizationName: "银河研究院",
          role: "editor",
          spaceId: SPACE_ID,
          spaceName: "Discovery 空间",
        }],
      });
      return;
    }
    if (path === "/api/v1/enterprise-management-access") {
      await fulfillJson(route, { organizations: [] });
      return;
    }
    if (path === "/api/v1/auth/csrf") {
      await fulfillJson(route, { csrfToken: CSRF_TOKEN });
      return;
    }
    if (path === `${GATEWAY_BASE_PATH}/runtime`) {
      await fulfillJson(route, {
        kernelState: "ready",
        organizationId: ORGANIZATION_ID,
        role: "editor",
        spaceId: SPACE_ID,
      });
      return;
    }
    if (path === `${GATEWAY_BASE_PATH}/content-directory/notebooks`) {
      await fulfillJson(route, {
        notebooks: [{
          icon: "",
          locked: false,
          name: "Discovery 笔记本",
          notebookId: NOTEBOOK_ID,
          supportsGraph: true,
        }],
      });
      return;
    }
    if (path === `${GATEWAY_BASE_PATH}/content-directory/notebooks/${NOTEBOOK_ID}/documents`) {
      await fulfillJson(route, {
        documents: [
          {
            documentId: DOCUMENT_A,
            hasChildren: false,
            icon: "",
            notebookId: NOTEBOOK_ID,
            title: "第一文档",
          },
          {
            documentId: DOCUMENT_B,
            hasChildren: false,
            icon: "",
            notebookId: NOTEBOOK_ID,
            title: "第二文档",
          },
        ],
        locked: false,
        nextOffset: null,
      });
      return;
    }

    const discoverySearchPath = `${GATEWAY_BASE_PATH}/discovery/search`;
    if (path === discoverySearchPath) {
      boundary.search.push({
        body: request.postDataJSON(),
      });
      await fulfillJson(route, {
        blocks: [{
          content: "空间搜索命中第二文档",
          documentId: DOCUMENT_B,
          id: BLOCK_B,
          notebookId: NOTEBOOK_ID,
        }],
        matchedBlockCount: 1,
        pageCount: 1,
      });
      return;
    }
    const discoveryGraphPath = `${GATEWAY_BASE_PATH}/discovery/graph`;
    if (path === discoveryGraphPath) {
      boundary.spaceGraph.push({ body: request.postDataJSON() });
      await fulfillJson(route, {
        links: [],
        nodes: [{
          documentId: DOCUMENT_A,
          id: BLOCK_A,
          label: "空间节点",
          notebookId: NOTEBOOK_ID,
        }],
      });
      return;
    }

    const kernelPrefix = `${GATEWAY_BASE_PATH}/kernel`;
    if (!path.startsWith(`${kernelPrefix}/api/`)) {
      await route.abort("failed");
      return;
    }
    const kernelPath = path.slice(kernelPrefix.length);
    const identity = requestHeaders(request);
    const body = request.postDataJSON() as Record<string, unknown>;
    const recordDocumentRequest = () => {
      boundary.document.push({
        body,
        documentId: identity.documentId,
        notebookId: identity.notebookId,
        path: kernelPath,
      });
    };
    if (kernelPath === "/api/filetree/getDoc") {
      const requestedId = typeof body.id === "string" ? body.id : identity.documentId;
      await fulfillJson(route, documentResponse(identity.documentId, requestedId));
      return;
    }
    if (kernelPath === "/api/block/getDocInfo") {
      await fulfillJson(route, {
        code: 0,
        data: {
          attrViews: [],
          ial: { id: identity.documentId, title: "", updated: "20260719000000" },
          icon: "",
          id: identity.documentId,
          name: identity.documentId === DOCUMENT_A ? "第一文档" : "第二文档",
          refCount: 0,
          refIDs: [],
          rootID: identity.documentId,
          subFileCount: 0,
        },
        msg: "",
      });
      return;
    }
    if (kernelPath === "/api/block/getBlockBreadcrumb") {
      await fulfillJson(route, {
        code: 0,
        data: [{
          blockId: identity.documentId,
          documentId: identity.documentId,
          name: identity.documentId === DOCUMENT_A ? "第一文档" : "第二文档",
          notebookId: identity.notebookId,
          subType: "",
          type: "NodeDocument",
        }],
        msg: "",
      });
      return;
    }
    if (kernelPath === "/api/transactions/undoState") {
      await fulfillJson(route, {
        code: 0,
        data: { canRedo: false, canUndo: false },
        msg: "",
      });
      return;
    }
    if ([
      "/api/block/getBlocksWordCount",
      "/api/block/getContentWordCount",
      "/api/block/getTreeStat",
    ].includes(kernelPath)) {
      await fulfillJson(route, {
        code: 0,
        data: { stat: { blockCount: 1, imageCount: 0, linkCount: 0, refCount: 0, runeCount: 0, wordCount: 0 } },
        msg: "",
      });
      return;
    }
    if (kernelPath === "/api/transactions") {
      await fulfillJson(route, { code: 0, data: body.transactions ?? [], msg: "" });
      return;
    }
    if (kernelPath === "/api/graph/getLocalGraph") {
      boundary.graph.push({
        body,
        documentId: identity.documentId,
        notebookId: identity.notebookId,
      });
      await fulfillJson(route, {
        code: 0,
        data: {
          links: [],
          nodes: [
            {
              documentId: DOCUMENT_A,
              id: BLOCK_A,
              label: "第一文档",
              notebookId: NOTEBOOK_ID,
            },
            { documentId: null, id: "tag:#标签", label: "#标签", notebookId: null },
          ],
        },
        msg: "",
      });
      return;
    }
    if (kernelPath === "/api/search/fullTextSearchBlock") {
      recordDocumentRequest();
      await fulfillJson(route, {
        code: 0,
        data: {
          blocks: [{
            content: "文档内命中",
            documentId: DOCUMENT_A,
            id: BLOCK_A,
            notebookId: NOTEBOOK_ID,
          }],
          matchedBlockCount: 1,
          pageCount: 1,
        },
        msg: "",
      });
      return;
    }
    if (kernelPath === "/api/outline/getDocOutline") {
      recordDocumentRequest();
      await fulfillJson(route, {
        code: 0,
        data: [{ children: [], id: BLOCK_A, name: "大纲节点" }],
        msg: "",
      });
      return;
    }
    if (kernelPath === "/api/ref/getBacklink2") {
      recordDocumentRequest();
      await fulfillJson(route, {
        code: 0,
        data: {
          backlinks: [{ documentId: DOCUMENT_B, notebookId: NOTEBOOK_ID, title: "反链文档" }],
          backmentions: [],
        },
        msg: "",
      });
      return;
    }
    if (kernelPath === "/api/history/searchHistory") {
      recordDocumentRequest();
      await fulfillJson(route, {
        code: 0,
        data: { histories: ["2026-07-19 15:00:00"], pageCount: 1, totalCount: 1 },
        msg: "",
      });
      return;
    }
    await route.abort("failed");
  });

  return boundary;
}

test.describe("React discovery work panels", () => {
  test("keeps space search, space graph and document graph identities explicit", async ({ page }, testInfo) => {
    requireDesktop(testInfo);
    const diagnostics = collectBrowserDiagnostics(page);
    const boundary = await installBoundary(page);

    await page.goto(`/organizations/${ORGANIZATION_ID}/spaces/${SPACE_ID}`);
    const editor = page.getByTestId("protyle-host");
    await expect(editor).toContainText("第一文档内容");

    await page.getByRole("button", { name: "搜索当前空间" }).click();
    const searchPanel = page.locator('[data-discovery-kind="space-search"]');
    await expect(searchPanel).toBeVisible();
    const searchInput = searchPanel.getByRole("searchbox");
    await expect(searchInput).toHaveValue("");
    await searchInput.fill("quantum");
    await searchPanel.getByRole("button", { name: "执行搜索" }).click();
    await expect(searchPanel.getByRole("button", { name: /空间搜索命中/ })).toBeVisible();
    await expect.poll(() => boundary.search.at(-1)?.body).toEqual({
      method: "preferred",
      query: "quantum",
    });
    boundary.search.forEach((request) => {
      expect(Object.keys(request.body as Record<string, unknown>).sort()).toEqual([
        "method",
        "query",
      ]);
    });

    await searchPanel.getByRole("button", { name: /空间搜索命中/ }).click();
    await expect(editor).toContainText("第二文档内容");
    await expect(contentBlock(editor, BLOCK_A)).toHaveCount(0);

    await searchPanel.getByRole("button", { name: "关闭面板" }).click();
    await page.getByRole("button", { name: "打开空间关系图" }).click();
    const spaceGraphPanel = page.locator('[data-discovery-kind="space-graph"]');
    await expect(spaceGraphPanel).toBeVisible();
    await expect(spaceGraphPanel.getByRole("button", { name: "空间节点" })).toBeVisible();
    expect(boundary.spaceGraph).toEqual([{ body: { query: "" } }]);
    await spaceGraphPanel.getByRole("button", { name: "关闭面板" }).click();
    await editor.locator(".protyle-wysiwyg").click();
    await page.keyboard.press("Control+Alt+g");
    const graphPanel = page.locator('[data-discovery-kind="document-graph"]');
    await expect(graphPanel).toBeVisible();
    await expect(graphPanel.getByRole("button", { name: "第一文档" })).toBeVisible();
    const tagNode = graphPanel.getByTitle("#标签");
    await expect(tagNode).toBeVisible();
    await expect(tagNode.locator("..").locator("button")).toHaveCount(0);
    expect(boundary.graph.at(-1)).toMatchObject({
      documentId: DOCUMENT_B,
      notebookId: NOTEBOOK_ID,
    });

    await graphPanel.getByRole("button", { name: "第一文档" }).click();
    await expect(editor).toContainText("第一文档内容");
    expect(boundary.graph.at(-1)?.body).toMatchObject({
      conf: { type: { paragraph: true, tag: true } },
      id: DOCUMENT_B,
    });
    await expect.poll(() => [...diagnostics.pendingRequests].every((request) => {
      const path = new URL(request.url()).pathname;
      return path.includes("/kernel/api/filetree/getDoc") ||
        path.includes("/kernel/api/block/getBlockBreadcrumb");
    })).toBe(true);
    expectBrowserHealthy(diagnostics, MAX_REQUEST_DURATION_MS, {
      unexpectedConsoleMessages: diagnostics.consoleMessages.filter(
        (message) => !isExpectedIconNetworkChange(message),
      ),
      // 文档切换时主动取消的旧内容、统计和面包屑请求属于迟到响应隔离合同，不是失败请求。
      unexpectedRequestFailures: diagnostics.requestFailures.filter((request) => {
        const failure = request.failure();
        const url = new URL(request.url());
        const isCancelledDocumentRequest = url.pathname.includes("/kernel/api/filetree/getDoc") ||
          url.pathname.includes("/kernel/api/block/getContentWordCount") ||
          url.pathname.includes("/kernel/api/block/getBlockBreadcrumb");
        return failure?.errorText !== "net::ERR_ABORTED" || !isCancelledDocumentRequest;
      }),
      // 并行浏览器运行时，已取消的旧文档请求可能没有及时发出终态事件；仅放行这两个请求。
      expectedPendingRequests: [...diagnostics.pendingRequests].filter((request) => {
        const url = new URL(request.url());
        return url.pathname.includes("/kernel/api/filetree/getDoc") ||
          url.pathname.includes("/kernel/api/block/getBlockBreadcrumb");
      }),
    });
  });

  test("opens document search, outline, backlinks and history from the current editor identity", async ({ page }, testInfo) => {
    requireDesktop(testInfo);
    const diagnostics = collectBrowserDiagnostics(page);
    const boundary = await installBoundary(page);

    await page.goto(`/organizations/${ORGANIZATION_ID}/spaces/${SPACE_ID}`);
    const editor = page.getByTestId("protyle-host");
    await expect(editor).toContainText("第一文档内容");
    const titleIcon = page.locator(".protyle-title__icon");

    await titleIcon.click();
    await page.locator('[data-protyle-menu] [data-id="search"]').click();
    const searchPanel = page.locator('[data-discovery-kind="document-search"]');
    await expect(searchPanel).toBeVisible();
    await searchPanel.getByRole("searchbox").fill("focused");
    await searchPanel.getByRole("button", { name: "执行搜索" }).click();
    await expect(searchPanel.getByRole("button", { name: /文档内命中/ })).toBeVisible();

    await titleIcon.click();
    await page.locator('[data-protyle-menu] [data-id="outline"]').click();
    const outlinePanel = page.locator('[data-discovery-kind="outline"]');
    await expect(outlinePanel.getByRole("button", { name: "大纲节点" })).toBeVisible();

    await titleIcon.click();
    await page.locator('[data-protyle-menu] [data-id="backlinks"]').click();
    const backlinksPanel = page.locator('[data-discovery-kind="backlinks"]');
    await expect(backlinksPanel.getByRole("button", { name: "反链文档" })).toBeVisible();

    await titleIcon.click();
    await page.locator('[data-protyle-menu] [data-id="fileHistory"]').click();
    const historyPanel = page.locator('[data-discovery-kind="document-history"]');
    await expect(historyPanel).toContainText("2026-07-19 15:00:00");

    expect(boundary.document.map(({ path, body, documentId, notebookId }) => ({
      body,
      documentId,
      notebookId,
      path,
    }))).toEqual([
      {
        body: { query: "focused" },
        documentId: DOCUMENT_A,
        notebookId: NOTEBOOK_ID,
        path: "/api/search/fullTextSearchBlock",
      },
      {
        body: { id: DOCUMENT_A, preview: false },
        documentId: DOCUMENT_A,
        notebookId: NOTEBOOK_ID,
        path: "/api/outline/getDocOutline",
      },
      {
        body: { id: DOCUMENT_A, k: "", mSort: "3", mk: "", sort: "3" },
        documentId: DOCUMENT_A,
        notebookId: NOTEBOOK_ID,
        path: "/api/ref/getBacklink2",
      },
      {
        body: { op: "all", page: 1, query: DOCUMENT_A, type: 3 },
        documentId: DOCUMENT_A,
        notebookId: NOTEBOOK_ID,
        path: "/api/history/searchHistory",
      },
    ]);
    expectBrowserHealthy(diagnostics, MAX_REQUEST_DURATION_MS);
  });
});
