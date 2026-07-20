import {
  expect,
  test,
  type Locator,
  type Page,
  type TestInfo,
  type WebSocketRoute,
} from "@playwright/test";

import {
  collectBrowserDiagnostics,
  expectBrowserHealthy,
} from "./support/diagnostics.ts";
import { fulfillJson } from "./support/http.ts";

const ORGANIZATION_ID = "11111111-1111-4111-8111-111111111111";
const SPACE_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const NOTEBOOK_A = "20260719000000-noteb01";
const NOTEBOOK_B = "20260719000001-noteb02";
const DOCUMENT_A = "20260719000100-docum01";
const DOCUMENT_B = "20260719000101-docum02";
const DOCUMENT_C = "20260719000102-docum03";
const BLOCK_A = "20260719000200-block01";
const BLOCK_B = "20260719000201-block02";
const BLOCK_C = "20260719000202-block03";
const HEADING_A = "20260719000203-headin01";
const AV_BLOCK = "20260719000300-avblk01";
const AV_ID = "20990719000301-av00001";
const AV_VIEW_ID = "20990719000302-avview01";
const AV_COLUMN_ID = "20990719000303-avcol01";
const AV_ROW_ID = "20990719000304-avrow01";
const AV_CELL_ID = "20990719000305-avcell01";
const CSRF_TOKEN = "A".repeat(43);
const MAX_REQUEST_DURATION_MS = 5_000;
const GATEWAY_BASE_PATH = `/api/v1/organizations/${ORGANIZATION_ID}/spaces/${SPACE_ID}`;
const HTTP_CANONICAL_RENAME_TITLE = "HTTP 规范标题";
const HTTP_CANONICAL_RENAME_REF_TEXT = "HTTP 规范引用文本";
const PUSH_CANONICAL_RENAME_TITLE = "推送规范标题";
const PUSH_CANONICAL_RENAME_REF_TEXT = "推送规范引用文本";

interface DocumentFixture {
  readonly blockId: string;
  readonly documentId: string;
  readonly title: string;
  readonly text: string;
}

interface KernelRequest {
  readonly body: unknown;
  readonly documentId: string;
  readonly kernelPath: string;
  readonly notebookId: string;
}

interface ObservedSocket {
  readonly documentId: string;
  readonly notebookId: string;
  readonly route: WebSocketRoute;
}

interface ComplexContentBoundary {
  readonly avRequests: KernelRequest[];
  readonly discoveryRequests: KernelRequest[];
  readonly kernelRequests: KernelRequest[];
  readonly sockets: ObservedSocket[];
  readonly transactionRequests: KernelRequest[];
  readonly unexpectedRequests: string[];
  readonly setDocumentTitle: (documentId: string, title: string) => void;
}

interface InstallBoundaryOptions {
  readonly skipInitialAttributeViewRender?: boolean;
}

function workspacePath(): string {
  return `/organizations/${ORGANIZATION_ID}/spaces/${SPACE_ID}`;
}

function paragraphBlock(blockId: string, content: string): string {
  return `<div data-node-id="${blockId}" data-type="NodeParagraph" class="p" updated="20260719000000"><div contenteditable="true" spellcheck="false">${content}</div><div class="protyle-attr" contenteditable="false">&#8203;</div></div>`;
}

function attributeViewBlock(rendered: boolean): string {
  return `<div class="av" data-node-id="${AV_BLOCK}" data-av-id="${AV_ID}" data-type="NodeAttributeView" data-av-type="table"${rendered ? ` data-render="true"` : ""}><div spellcheck="true"></div><div class="protyle-attr" contenteditable="false">&#8203;</div></div>`;
}

function headingBlock(): string {
  return `<div data-node-id="${HEADING_A}" data-type="NodeHeading" data-subtype="h2" class="h2" fold="1" updated="20260719000000"><div contenteditable="true" spellcheck="false">折叠标题</div><div class="protyle-attr" contenteditable="false">&#8203;</div></div>`;
}

function documentContent(document: DocumentFixture, rendered: boolean): string {
  if (document.documentId === DOCUMENT_A) {
    return [
      paragraphBlock(
        BLOCK_A,
        `${document.text} <span data-type="block-ref" data-id="${BLOCK_B}" data-notebook-id="${NOTEBOOK_A}" data-document-id="${DOCUMENT_B}" data-subtype="s">块目标</span> <span data-type="block-ref" data-id="${DOCUMENT_C}" data-notebook-id="${NOTEBOOK_B}" data-document-id="${DOCUMENT_C}" data-subtype="d">文档目标</span>`,
      ),
      headingBlock(),
      attributeViewBlock(rendered),
    ].join("");
  }
  return paragraphBlock(document.blockId, document.text);
}

function documents(): readonly DocumentFixture[] {
  return [
    {
      blockId: BLOCK_A,
      documentId: DOCUMENT_A,
      text: "复杂内容起点 可替换文本",
      title: "复杂内容起点",
    },
    {
      blockId: BLOCK_B,
      documentId: DOCUMENT_B,
      text: "同库目标文档",
      title: "同库目标文档",
    },
    {
      blockId: BLOCK_C,
      documentId: DOCUMENT_C,
      text: "跨库目标文档",
      title: "跨库目标文档",
    },
  ];
}

function documentResponse(
  document: DocumentFixture,
  notebookId: string,
  rendered: boolean,
  requestedId: string,
): object {
  const isRoot = requestedId === document.documentId;
  return {
    code: 0,
    data: {
      blockCount: 2,
      content: documentContent(document, rendered),
      eof: false,
      id: requestedId,
      isBacklinkExpand: false,
      isSyncing: false,
      mode: 0,
      notebook: notebookId,
      parent2ID: "",
      parentDocument: false,
      parentID: isRoot ? "" : document.documentId,
      path: `/${document.documentId}.sy`,
      rootID: document.documentId,
      scroll: {},
      type: isRoot ? "NodeDocument" : "NodeParagraph",
    },
    msg: "",
  };
}

function attributeViewResponse(): object {
  const column = {
    calc: { operator: "" },
    created: { includeTime: false },
    date: { autoFillNow: false, fillSpecificTime: false },
    desc: "",
    hidden: false,
    icon: "",
    id: AV_COLUMN_ID,
    name: "内容",
    numberFormat: "",
    options: [],
    pin: false,
    relation: {},
    template: "",
    type: "text",
    updated: { includeTime: false },
    width: "200px",
    wrap: false,
  };
  const view = {
    desc: "",
    filters: [],
    group: { field: "" },
    groupFolded: false,
    groupHidden: 0,
    groups: [],
    groupKey: column,
    groupValue: { type: "text", text: { content: "" } },
    hideAttrViewName: false,
    icon: "",
    id: AV_VIEW_ID,
    name: "表格",
    pageSize: 50,
    showIcon: true,
    sorts: [],
    type: "table",
    wrapField: false,
  };
  return {
    code: 0,
    data: {
      id: AV_ID,
      isMirror: false,
      name: "复杂内容数据表",
      view: {
        ...view,
        columns: [column],
        rowCount: 1,
        rows: [{
          cells: [{
            bgColor: "",
            color: "",
            id: AV_CELL_ID,
            value: {
              id: AV_CELL_ID,
              keyID: AV_COLUMN_ID,
              text: { content: "初始单元格" },
              type: "text",
            },
            valueType: "text",
          }],
          id: AV_ROW_ID,
        }],
      },
      viewID: AV_VIEW_ID,
      viewType: "table",
      views: [view],
    },
    msg: "",
  };
}

function discoveryResponse(kernelPath: string): object {
  if (kernelPath === "/api/ref/getBacklink2") {
    return { code: 0, data: { backlinks: [], backmentions: [] }, msg: "" };
  }
  if (kernelPath === "/api/outline/getDocOutline") {
    return { code: 0, data: [], msg: "" };
  }
  return {
    code: 0,
    data: {
      links: [],
      nodes: [{
        documentId: DOCUMENT_B,
        id: BLOCK_B,
        label: "同库目标文档",
        notebookId: NOTEBOOK_A,
      }],
    },
    msg: "",
  };
}

function requireDesktop(testInfo: TestInfo): void {
  test.skip(
    testInfo.project.name !== "desktop",
    "复杂内容需要真实桌面 Protyle DOM；移动布局由独立响应式合同覆盖。",
  );
}

async function installGatewayBoundary(
  page: Page,
  options: InstallBoundaryOptions = {},
): Promise<ComplexContentBoundary> {
  const fixtureDocuments = documents();
  const documentTitles = new Map(
    fixtureDocuments.map((document) => [document.documentId, document.title] as const),
  );
  const documentById = new Map(
    fixtureDocuments.map((document) => [document.documentId, document] as const),
  );
  const boundary: ComplexContentBoundary = {
    avRequests: [],
    discoveryRequests: [],
    kernelRequests: [],
    sockets: [],
    transactionRequests: [],
    unexpectedRequests: [],
    setDocumentTitle: (documentId, title) => {
      documentTitles.set(documentId, title);
    },
  };
  const skipInitialAttributeViewRender = options.skipInitialAttributeViewRender ?? true;

  await page.routeWebSocket(/\/kernel\/ws(?:\?|$)/, (route) => {
    const url = new URL(route.url());
    boundary.sockets.push({
      documentId: url.searchParams.get("documentId") ?? "",
      notebookId: url.searchParams.get("notebookId") ?? "",
      route,
    });
  });

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
          spaceName: "复杂内容空间",
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
        notebooks: [
          { icon: "", locked: false, name: "主内容库", notebookId: NOTEBOOK_A, supportsGraph: true },
          { icon: "", locked: false, name: "隔离内容库", notebookId: NOTEBOOK_B, supportsGraph: true },
        ],
      });
      return;
    }
    if (path === `${GATEWAY_BASE_PATH}/content-directory/notebooks/${NOTEBOOK_A}/documents`) {
      await fulfillJson(route, {
        documents: fixtureDocuments
          .filter((document) => document.documentId !== DOCUMENT_C)
          .map((document) => ({
            documentId: document.documentId,
            hasChildren: false,
            icon: "",
            notebookId: NOTEBOOK_A,
            title: documentTitles.get(document.documentId) ?? document.title,
          })),
        locked: false,
        nextOffset: null,
      });
      return;
    }
    if (path === `${GATEWAY_BASE_PATH}/content-directory/notebooks/${NOTEBOOK_B}/documents`) {
      await fulfillJson(route, {
        documents: [{
          documentId: DOCUMENT_C,
          hasChildren: false,
          icon: "",
          notebookId: NOTEBOOK_B,
          title: documentTitles.get(DOCUMENT_C) ?? "跨库目标文档",
        }],
        locked: false,
        nextOffset: null,
      });
      return;
    }

    const kernelPrefix = `${GATEWAY_BASE_PATH}/kernel/api`;
    if (!path.startsWith(`${kernelPrefix}/api/`)) {
      boundary.unexpectedRequests.push(`${request.method()} ${path}`);
      await route.abort("failed");
      return;
    }
    const headers = request.headers();
    const kernelPath = path.slice(kernelPrefix.length);
    const body: Record<string, unknown> = request.method() === "POST"
      ? request.postDataJSON() as Record<string, unknown>
      : {};
    const observed: KernelRequest = {
      body,
      documentId: headers["x-singularity-document-id"] ?? "",
      kernelPath,
      notebookId: headers["x-singularity-notebook-id"] ?? "",
    };
    boundary.kernelRequests.push(observed);

    if (kernelPath === "/api/filetree/getDoc") {
      const requestedId = typeof (body as { id?: unknown }).id === "string"
        ? (body as { id: string }).id
        : "";
      const document = documentById.get(observed.documentId);
      if (!document) {
        boundary.unexpectedRequests.push(`${kernelPath}:${requestedId}`);
        await route.abort("failed");
        return;
      }
      await fulfillJson(route, documentResponse(
        document,
        observed.notebookId,
        skipInitialAttributeViewRender,
        requestedId,
      ));
      return;
    }
    if (kernelPath === "/api/block/getDocInfo") {
      await fulfillJson(route, { code: 0, data: { ial: {} }, msg: "" });
      return;
    }
    if (kernelPath === "/api/block/getBlockBreadcrumb") {
      await fulfillJson(route, {
        code: 0,
        data: [{
          blockId: observed.documentId,
          documentId: observed.documentId,
          name: documentById.get(observed.documentId)?.title ?? "",
          notebookId: observed.notebookId,
          subType: "",
          type: "NodeDocument",
        }],
        msg: "",
      });
      return;
    }
    if (kernelPath === "/api/block/checkBlockFold") {
      const id = typeof (body as { id?: unknown }).id === "string"
        ? (body as { id: string }).id
        : "";
      await fulfillJson(route, {
        code: 0,
        data: { isFolded: false, isRoot: id === observed.documentId },
        msg: "",
      });
      return;
    }
    if (kernelPath === "/api/block/getRefText") {
      await fulfillJson(route, { code: 0, data: "动态文档引用", msg: "" });
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
    if (kernelPath === "/api/transactions") {
      boundary.transactionRequests.push(observed);
      await fulfillJson(route, { code: 0, data: (body as { transactions?: unknown }).transactions ?? [], msg: "" });
      return;
    }
    if (kernelPath === "/api/filetree/renameDoc") {
      await fulfillJson(route, {
        code: 0,
        data: {
          documentId: observed.documentId,
          empty: false,
          notebookId: observed.notebookId,
          refText: HTTP_CANONICAL_RENAME_REF_TEXT,
          title: HTTP_CANONICAL_RENAME_TITLE,
        },
        msg: "",
      });
      return;
    }
    if (kernelPath === "/api/av/renderAttributeView") {
      boundary.avRequests.push(observed);
      await fulfillJson(route, attributeViewResponse());
      return;
    }
    if (kernelPath === "/api/outline/getDocOutline" || kernelPath === "/api/ref/getBacklink2" || kernelPath === "/api/graph/getLocalGraph") {
      boundary.discoveryRequests.push(observed);
      await fulfillJson(route, discoveryResponse(kernelPath));
      return;
    }

    boundary.unexpectedRequests.push(kernelPath);
    await route.abort("failed");
  });

  return boundary;
}

async function openDocument(page: Page): Promise<Locator> {
  await page.goto(workspacePath());
  const editor = page.getByTestId("protyle-host");
  await expect(editor.locator(`[data-node-id="${BLOCK_A}"]`)).toContainText("复杂内容起点");
  return editor;
}

function socketFor(
  boundary: ComplexContentBoundary,
  notebookId: string,
  documentId: string,
): ObservedSocket | undefined {
  return boundary.sockets.find(
    (socket) => socket.notebookId === notebookId && socket.documentId === documentId,
  );
}

function lastRequest(
  requests: readonly KernelRequest[],
  kernelPath: string,
): KernelRequest {
  const request = [...requests].reverse().find((item) => item.kernelPath === kernelPath);
  if (!request) {
    throw new Error(`Missing observed request ${kernelPath}`);
  }
  return request;
}

test.describe("Protyle complex-content identity integration", () => {
  test("keeps three identities when creating a reference from internal clipboard HTML", async ({ page }, testInfo) => {
    requireDesktop(testInfo);
    const diagnostics = collectBrowserDiagnostics(page);
    const boundary = await installGatewayBoundary(page);
    const editor = await openDocument(page);
    const editable = editor.locator(`[data-node-id="${BLOCK_A}"] [contenteditable="true"]`);
    const source = editor.locator(`[data-node-id="${BLOCK_A}"] [data-type~="block-ref"]`).first();
    await expect(source).toHaveAttribute("data-notebook-id", NOTEBOOK_A);
    await expect(source).toHaveAttribute("data-document-id", DOCUMENT_B);
    await expect(source).toHaveAttribute("data-id", BLOCK_B);

    await editable.evaluate((element, target) => {
      const range = document.createRange();
      range.selectNodeContents(element);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      const clipboardData = new DataTransfer();
      clipboardData.setData(
        "text/siyuan",
        `<span data-type="block-ref" data-id="${target.blockId}" data-notebook-id="${target.notebookId}" data-document-id="${target.documentId}" data-subtype="s">跨库引用</span>`,
      );
      clipboardData.setData("text/plain", "跨库引用");
      element.dispatchEvent(new ClipboardEvent("paste", {
        bubbles: true,
        cancelable: true,
        clipboardData,
      }));
    }, { blockId: BLOCK_C, documentId: DOCUMENT_C, notebookId: NOTEBOOK_B });

    const pasted = editor.locator(`[data-node-id="${BLOCK_A}"] [data-type~="block-ref"]`).filter({ hasText: "跨库引用" });
    await expect(pasted).toHaveAttribute("data-id", BLOCK_C);
    await expect(pasted).toHaveAttribute("data-notebook-id", NOTEBOOK_B);
    await expect(pasted).toHaveAttribute("data-document-id", DOCUMENT_C);
    await expect.poll(() => boundary.transactionRequests.length).toBeGreaterThan(0);
    const transaction = lastRequest(boundary.transactionRequests, "/api/transactions");
    expect(transaction.notebookId).toBe(NOTEBOOK_A);
    expect(transaction.documentId).toBe(DOCUMENT_A);
    expect(JSON.stringify(transaction.body)).toContain(BLOCK_C);
    expect(JSON.stringify(transaction.body)).toContain(NOTEBOOK_B);
    expect(JSON.stringify(transaction.body)).toContain(DOCUMENT_C);
    expect(JSON.stringify(transaction.body)).not.toContain("undefined");

    expect(boundary.unexpectedRequests).toEqual([]);
    expectBrowserHealthy(diagnostics, MAX_REQUEST_DURATION_MS);
  });

  test("click navigation and Alt-comma navigation use the reference target identity", async ({ page }, testInfo) => {
    requireDesktop(testInfo);
    const diagnostics = collectBrowserDiagnostics(page);
    const boundary = await installGatewayBoundary(page);
    const editor = await openDocument(page);
    const sameNotebookRef = editor.locator(`[data-node-id="${BLOCK_A}"] [data-type~="block-ref"]`).first();
    await sameNotebookRef.click();
    await expect.poll(() => boundary.kernelRequests.filter((request) => request.kernelPath === "/api/block/checkBlockFold").length).toBeGreaterThan(0);
    const clickFold = lastRequest(boundary.kernelRequests, "/api/block/checkBlockFold");
    expect(clickFold.notebookId).toBe(NOTEBOOK_A);
    expect(clickFold.documentId).toBe(DOCUMENT_B);
    expect(clickFold.body).toEqual({ id: BLOCK_B });
    await expect(page.getByTestId("protyle-host").locator(`[data-node-id="${BLOCK_B}"]`)).toContainText("同库目标文档");

    const secondEditor = await openDocument(page);
    const crossNotebookRef = secondEditor.locator(`[data-node-id="${BLOCK_A}"] [data-type~="block-ref"]`).nth(1);
    await crossNotebookRef.evaluate((element) => {
      const range = document.createRange();
      range.selectNodeContents(element);
      range.collapse(false);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      element.closest<HTMLElement>("[contenteditable=true]")?.focus();
    });
    await page.keyboard.press("Alt+,");
    await expect.poll(() => boundary.kernelRequests.filter((request) => request.kernelPath === "/api/block/checkBlockFold" && request.documentId === DOCUMENT_C).length).toBeGreaterThan(0);
    const shortcutFold = [...boundary.kernelRequests].reverse().find((request) => request.kernelPath === "/api/block/checkBlockFold" && request.documentId === DOCUMENT_C)!;
    expect(shortcutFold.notebookId).toBe(NOTEBOOK_B);
    expect(shortcutFold.body).toEqual({ id: DOCUMENT_C });
    await expect(page.getByTestId("protyle-host").locator(`[data-node-id="${BLOCK_C}"]`)).toContainText("跨库目标文档");

    expect(boundary.unexpectedRequests).toEqual([]);
    expectBrowserHealthy(diagnostics, MAX_REQUEST_DURATION_MS);
  });

  test("Core menus and shortcuts open document panels with explicit identity", async ({ page }, testInfo) => {
    requireDesktop(testInfo);
    const diagnostics = collectBrowserDiagnostics(page);
    const boundary = await installGatewayBoundary(page);
    const editor = await openDocument(page);
    const reference = editor.locator(`[data-node-id="${BLOCK_A}"] [data-type~="block-ref"]`).first();

    await reference.click({ button: "right" });
    const backlinks = page.locator("[data-protyle-menu] [data-id=\"backlinks\"]");
    await expect(backlinks).toBeVisible();
    await backlinks.click();
    await expect.poll(() => boundary.discoveryRequests.filter((request) => request.kernelPath === "/api/ref/getBacklink2").length).toBe(1);
    const backlinkRequest = lastRequest(boundary.discoveryRequests, "/api/ref/getBacklink2");
    expect(backlinkRequest.notebookId).toBe(NOTEBOOK_A);
    expect(backlinkRequest.documentId).toBe(DOCUMENT_B);
    expect(backlinkRequest.body).toMatchObject({ id: DOCUMENT_B });

    await reference.click({ button: "right" });
    const graph = page.locator("[data-protyle-menu] [data-id=\"graphView\"]");
    await expect(graph).toBeVisible();
    await graph.click();
    await expect.poll(() => boundary.discoveryRequests.filter((request) => request.kernelPath === "/api/graph/getLocalGraph").length).toBe(1);
    const graphRequest = lastRequest(boundary.discoveryRequests, "/api/graph/getLocalGraph");
    expect(graphRequest.notebookId).toBe(NOTEBOOK_A);
    expect(graphRequest.documentId).toBe(DOCUMENT_B);
    expect(graphRequest.body).toMatchObject({ id: DOCUMENT_B });

    const focusReference = async (target: Locator) => {
      await target.evaluate((element) => {
        const range = document.createRange();
        range.selectNodeContents(element);
        range.collapse(false);
        const selection = window.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(range);
        element.closest<HTMLElement>("[contenteditable=true]")?.focus();
      });
    };
    const crossNotebookReference = editor.locator(`[data-node-id="${BLOCK_A}"] [data-type~="block-ref"]`).nth(1);
    await focusReference(crossNotebookReference);
    await page.keyboard.press("Control+Alt+B");
    await expect.poll(() => boundary.discoveryRequests.filter((request) => request.kernelPath === "/api/ref/getBacklink2").length).toBe(2);
    const shortcutBacklinkRequest = lastRequest(boundary.discoveryRequests, "/api/ref/getBacklink2");
    expect(shortcutBacklinkRequest.notebookId).toBe(NOTEBOOK_B);
    expect(shortcutBacklinkRequest.documentId).toBe(DOCUMENT_C);

    await focusReference(crossNotebookReference);
    await page.keyboard.press("Control+Alt+G");
    await expect.poll(() => boundary.discoveryRequests.filter((request) => request.kernelPath === "/api/graph/getLocalGraph").length).toBe(2);
    const shortcutGraphRequest = lastRequest(boundary.discoveryRequests, "/api/graph/getLocalGraph");
    expect(shortcutGraphRequest.notebookId).toBe(NOTEBOOK_B);
    expect(shortcutGraphRequest.documentId).toBe(DOCUMENT_C);

    await focusReference(crossNotebookReference);
    await page.keyboard.press("Control+Alt+O");
    await expect.poll(() => boundary.discoveryRequests.filter((request) => request.kernelPath === "/api/outline/getDocOutline").length).toBe(1);
    const shortcutOutlineRequest = lastRequest(boundary.discoveryRequests, "/api/outline/getDocOutline");
    expect(shortcutOutlineRequest.notebookId).toBe(NOTEBOOK_A);
    expect(shortcutOutlineRequest.documentId).toBe(DOCUMENT_A);

    expect(boundary.unexpectedRequests).toEqual([]);
    expectBrowserHealthy(diagnostics, MAX_REQUEST_DURATION_MS);
  });

  test("renders an attribute view and commits a cell transaction with content identity", async ({ page }, testInfo) => {
    requireDesktop(testInfo);
    const diagnostics = collectBrowserDiagnostics(page);
    const boundary = await installGatewayBoundary(page, { skipInitialAttributeViewRender: false });
    const editor = await openDocument(page);
    await expect.poll(() => boundary.avRequests.length).toBeGreaterThan(0);
    const renderRequest = lastRequest(boundary.avRequests, "/api/av/renderAttributeView");
    expect(renderRequest.notebookId).toBe(NOTEBOOK_A);
    expect(renderRequest.documentId).toBe(DOCUMENT_A);
    expect(renderRequest.body).toMatchObject({ id: AV_ID, notebook: NOTEBOOK_A });

    const cell = editor.locator(`.av[data-av-id="${AV_ID}"] .av__row[data-id="${AV_ROW_ID}"] .av__cell[data-col-id="${AV_COLUMN_ID}"]`);
    await expect(cell).toContainText("初始单元格");
    await cell.click();
    const cellEditor = page.locator(".av__mask textarea");
    await expect(cellEditor).toBeVisible();
    await cellEditor.fill("单元格已更新");
    await cellEditor.press("Enter");
    await expect.poll(() => boundary.transactionRequests.length).toBeGreaterThan(0);
    const transaction = lastRequest(boundary.transactionRequests, "/api/transactions");
    expect(transaction.notebookId).toBe(NOTEBOOK_A);
    expect(transaction.documentId).toBe(DOCUMENT_A);
    expect(JSON.stringify(transaction.body)).toContain("updateAttrViewCell");
    expect(JSON.stringify(transaction.body)).toContain("单元格已更新");

    expect(boundary.unexpectedRequests).toEqual([]);
    expectBrowserHealthy(diagnostics, MAX_REQUEST_DURATION_MS);
  });

  test("applies the canonical rename response and matching document push", async ({ page }, testInfo) => {
    requireDesktop(testInfo);
    const diagnostics = collectBrowserDiagnostics(page);
    const boundary = await installGatewayBoundary(page);
    const editor = await openDocument(page);
    const socket = socketFor(boundary, NOTEBOOK_A, DOCUMENT_A);
    expect(socket).toBeDefined();
    const title = editor.locator(".protyle-title__input");

    await title.fill("客户端标题");
    await title.blur();
    await expect.poll(() => boundary.kernelRequests.filter(
      (request) => request.kernelPath === "/api/filetree/renameDoc",
    ).length).toBe(1);
    const renameRequest = lastRequest(boundary.kernelRequests, "/api/filetree/renameDoc");
    expect(renameRequest.notebookId).toBe(NOTEBOOK_A);
    expect(renameRequest.documentId).toBe(DOCUMENT_A);
    expect(renameRequest.body).toMatchObject({
      notebook: NOTEBOOK_A,
      path: `/${DOCUMENT_A}.sy`,
      title: "客户端标题",
    });
    await expect(title).toHaveText(HTTP_CANONICAL_RENAME_TITLE);

    socket!.route.send(JSON.stringify({
      cmd: "rename",
      code: 0,
      data: {
        documentId: DOCUMENT_A,
        empty: false,
        notebookId: NOTEBOOK_B,
        refText: "错误身份引用文本",
        title: "错误身份标题",
      },
      msg: "",
    }));
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
    await expect(title).toHaveText(HTTP_CANONICAL_RENAME_TITLE);

    boundary.setDocumentTitle(DOCUMENT_A, PUSH_CANONICAL_RENAME_TITLE);
    socket!.route.send(JSON.stringify({
      cmd: "rename",
      code: 0,
      data: {
        documentId: DOCUMENT_A,
        empty: false,
        notebookId: NOTEBOOK_A,
        refText: PUSH_CANONICAL_RENAME_REF_TEXT,
        title: PUSH_CANONICAL_RENAME_TITLE,
      },
      msg: "",
    }));
    await expect(title).toHaveText(PUSH_CANONICAL_RENAME_TITLE);
    const selectedDirectoryDocument = page.getByRole("button", {
      exact: true,
      name: PUSH_CANONICAL_RENAME_TITLE,
    });
    await expect(selectedDirectoryDocument).toHaveAttribute("aria-current", "page");

    expect(boundary.unexpectedRequests).toEqual([]);
    expectBrowserHealthy(diagnostics, MAX_REQUEST_DURATION_MS);
  });

  test("routes dynamic reference text and counts by rendered document identity", async ({ page }, testInfo) => {
    requireDesktop(testInfo);
    const diagnostics = collectBrowserDiagnostics(page);
    const boundary = await installGatewayBoundary(page);
    const editor = await openDocument(page);
    const socket = socketFor(boundary, NOTEBOOK_A, DOCUMENT_A);
    expect(socket).toBeDefined();
    const dynamicReference = editor.locator(`[data-node-id="${BLOCK_A}"] [data-id="${DOCUMENT_C}"]`);
    const block = editor.locator(`[data-node-id="${BLOCK_A}"]`);
    const blockCount = block.locator(":scope > .protyle-attr .protyle-attr--refcount");
    const titleCount = editor.locator(".protyle-title .protyle-attr--refcount");

    socket!.route.send(JSON.stringify({
      cmd: "setRefDynamicText",
      code: 0,
      data: {
        blockID: BLOCK_A,
        defBlockID: DOCUMENT_C,
        documentId: DOCUMENT_A,
        notebookId: NOTEBOOK_B,
        refText: "错误内容库动态文本",
      },
      msg: "",
    }));
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
    await expect(dynamicReference).toHaveText("文档目标");

    socket!.route.send(JSON.stringify({
      cmd: "setRefDynamicText",
      code: 0,
      data: {
        blockID: BLOCK_A,
        defBlockID: DOCUMENT_C,
        documentId: DOCUMENT_A,
        notebookId: NOTEBOOK_A,
        refText: "动态引用已更新",
      },
      msg: "",
    }));
    await expect(dynamicReference).toHaveText("动态引用已更新");

    socket!.route.send(JSON.stringify({
      cmd: "setDefRefCount",
      code: 0,
      data: {
        blockID: BLOCK_A,
        defIDs: [DOCUMENT_C],
        documentId: DOCUMENT_B,
        notebookId: NOTEBOOK_A,
        refCount: 9,
        rootRefCount: 8,
      },
      msg: "",
    }));
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
    await expect(block).not.toHaveAttribute("refcount");
    await expect(blockCount).toHaveCount(0);
    await expect(titleCount).toHaveCount(0);

    socket!.route.send(JSON.stringify({
      cmd: "setDefRefCount",
      code: 0,
      data: {
        blockID: BLOCK_A,
        defIDs: [DOCUMENT_C],
        documentId: DOCUMENT_A,
        notebookId: NOTEBOOK_A,
        refCount: 2,
        rootRefCount: 1,
      },
      msg: "",
    }));
    await expect(block).toHaveAttribute("refcount", "2");
    await expect(blockCount).toHaveText("2");
    await expect(titleCount).toHaveText("1");

    expect(boundary.unexpectedRequests).toEqual([]);
    expectBrowserHealthy(diagnostics, MAX_REQUEST_DURATION_MS);
  });

  test("filters heading and loading lifecycle pushes by exact document identity", async ({ page }, testInfo) => {
    requireDesktop(testInfo);
    const diagnostics = collectBrowserDiagnostics(page);
    const boundary = await installGatewayBoundary(page);
    const editor = await openDocument(page);
    const socket = socketFor(boundary, NOTEBOOK_A, DOCUMENT_A);
    expect(socket).toBeDefined();
    const heading = editor.locator(`[data-node-id="${HEADING_A}"]`);
    const initialTransactions = boundary.transactionRequests.length;

    socket!.route.send(JSON.stringify({
      cmd: "unfoldHeading",
      code: 0,
      data: {
        currentNodeID: BLOCK_A,
        documentId: DOCUMENT_A,
        id: HEADING_A,
        notebookId: NOTEBOOK_B,
      },
      msg: "",
    }));
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
    await expect(heading).toHaveAttribute("fold", "1");
    expect(boundary.transactionRequests).toHaveLength(initialTransactions);

    socket!.route.send(JSON.stringify({
      cmd: "unfoldHeading",
      code: 0,
      data: {
        currentNodeID: BLOCK_A,
        documentId: DOCUMENT_A,
        id: HEADING_A,
        notebookId: NOTEBOOK_A,
      },
      msg: "",
    }));
    await expect(heading).not.toHaveAttribute("fold");
    await expect.poll(() => boundary.transactionRequests.length).toBeGreaterThan(initialTransactions);

    socket!.route.send(JSON.stringify({
      cmd: "addLoading",
      code: 0,
      data: { documentId: DOCUMENT_A, notebookId: NOTEBOOK_B },
      msg: "错误身份加载",
    }));
    socket!.route.send(JSON.stringify({
      cmd: "addLoading",
      code: 0,
      data: { documentId: DOCUMENT_A, notebookId: NOTEBOOK_A },
      msg: "正确身份加载",
    }));
    await expect(editor.locator(".wysiwygLoading").filter({ hasText: "正确身份加载" })).toHaveCount(1);
    await expect(editor.locator(".wysiwygLoading")).toHaveCount(1);

    expect(boundary.unexpectedRequests).toEqual([]);
    expectBrowserHealthy(diagnostics, MAX_REQUEST_DURATION_MS);
  });

  test("closes only the workspace document targeted by removeDoc", async ({ page }, testInfo) => {
    requireDesktop(testInfo);
    const diagnostics = collectBrowserDiagnostics(page);
    const boundary = await installGatewayBoundary(page);
    const editor = await openDocument(page);
    const socket = socketFor(boundary, NOTEBOOK_A, DOCUMENT_A);
    expect(socket).toBeDefined();

    socket!.route.send(JSON.stringify({
      cmd: "removeDoc",
      code: 0,
      data: { documentId: DOCUMENT_A, notebookId: NOTEBOOK_B },
      msg: "",
    }));
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
    await expect(editor.locator(`[data-node-id="${BLOCK_A}"]`)).toBeVisible();

    socket!.route.send(JSON.stringify({
      cmd: "removeDoc",
      code: 0,
      data: { documentId: DOCUMENT_A, notebookId: NOTEBOOK_A },
      msg: "",
    }));
    await expect(page.getByText("选择文档", { exact: true })).toBeVisible();
    await expect(page.getByTestId("protyle-host")).toHaveCount(0);

    expect(boundary.unexpectedRequests).toEqual([]);
    expectBrowserHealthy(diagnostics, MAX_REQUEST_DURATION_MS);
  });

  test("moves a document only when notebook, document, and source path all match", async ({ page }, testInfo) => {
    requireDesktop(testInfo);
    const diagnostics = collectBrowserDiagnostics(page);
    const boundary = await installGatewayBoundary(page);
    const editor = await openDocument(page);
    const socket = socketFor(boundary, NOTEBOOK_A, DOCUMENT_A);
    expect(socket).toBeDefined();
    const initialDocumentRequests = boundary.kernelRequests.filter(
      (request) => request.kernelPath === "/api/filetree/getDoc",
    ).length;

    for (const data of [
      {
        documentId: DOCUMENT_A,
        fromNotebook: NOTEBOOK_B,
        fromPath: `/${DOCUMENT_A}.sy`,
        newPath: "/wrong-notebook.sy",
        toNotebook: NOTEBOOK_B,
        toPath: "/wrong-notebook.sy",
      },
      {
        documentId: DOCUMENT_B,
        fromNotebook: NOTEBOOK_A,
        fromPath: `/${DOCUMENT_A}.sy`,
        newPath: "/wrong-document.sy",
        toNotebook: NOTEBOOK_B,
        toPath: "/wrong-document.sy",
      },
      {
        documentId: DOCUMENT_A,
        fromNotebook: NOTEBOOK_A,
        fromPath: "/wrong-source-path.sy",
        newPath: "/wrong-source-path.sy",
        toNotebook: NOTEBOOK_B,
        toPath: "/wrong-source-path.sy",
      },
    ]) {
      socket!.route.send(JSON.stringify({ cmd: "moveDoc", code: 0, data, msg: "" }));
    }
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
    expect(boundary.kernelRequests.filter(
      (request) => request.kernelPath === "/api/filetree/getDoc",
    )).toHaveLength(initialDocumentRequests);
    await expect(editor.locator(`[data-node-id="${BLOCK_A}"]`)).toBeVisible();

    socket!.route.send(JSON.stringify({
      cmd: "moveDoc",
      code: 0,
      data: {
        documentId: DOCUMENT_A,
        fromNotebook: NOTEBOOK_A,
        fromPath: `/${DOCUMENT_A}.sy`,
        newPath: `/moved/${DOCUMENT_A}.sy`,
        toNotebook: NOTEBOOK_B,
        toPath: `/moved/${DOCUMENT_A}.sy`,
      },
      msg: "",
    }));
    await expect.poll(() => boundary.kernelRequests.filter(
      (request) => request.kernelPath === "/api/filetree/getDoc" &&
        request.notebookId === NOTEBOOK_B && request.documentId === DOCUMENT_A,
    ).length).toBe(1);
    await expect(page.getByTestId("protyle-host").locator(`[data-node-id="${BLOCK_A}"]`)).toBeVisible();

    expect(boundary.unexpectedRequests).toEqual([]);
    expectBrowserHealthy(diagnostics, MAX_REQUEST_DURATION_MS);
  });

  test("filters AV refresh by its explicit notebook identity", async ({ page }, testInfo) => {
    requireDesktop(testInfo);
    const diagnostics = collectBrowserDiagnostics(page);
    const boundary = await installGatewayBoundary(page, { skipInitialAttributeViewRender: true });
    const editor = await openDocument(page);
    const socket = socketFor(boundary, NOTEBOOK_A, DOCUMENT_A);
    expect(socket).toBeDefined();
    const av = editor.locator(`.av[data-av-id="${AV_ID}"]`);
    await expect(av).toHaveAttribute("data-render", "true");
    const initialAVRequests = boundary.avRequests.length;

    socket!.route.send(JSON.stringify({
      cmd: "refreshAttributeView",
      code: 0,
      data: { boxID: NOTEBOOK_B, id: AV_ID },
      msg: "",
    }));
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
    expect(boundary.avRequests).toHaveLength(initialAVRequests);
    await expect(av).toHaveAttribute("data-render", "true");

    socket!.route.send(JSON.stringify({
      cmd: "refreshAttributeView",
      code: 0,
      data: { boxID: NOTEBOOK_A, id: AV_ID },
      msg: "",
    }));
    await expect.poll(() => boundary.avRequests.length).toBeGreaterThan(initialAVRequests);
    const refreshRequest = lastRequest(boundary.avRequests, "/api/av/renderAttributeView");
    expect(refreshRequest.notebookId).toBe(NOTEBOOK_A);
    expect(refreshRequest.documentId).toBe(DOCUMENT_A);

    expect(boundary.unexpectedRequests).toEqual([]);
    expectBrowserHealthy(diagnostics, MAX_REQUEST_DURATION_MS);
  });

  test("updates document references only for the renamed notebook and document", async ({ page }, testInfo) => {
    requireDesktop(testInfo);
    const diagnostics = collectBrowserDiagnostics(page);
    const boundary = await installGatewayBoundary(page);
    const editor = await openDocument(page);
    const socket = socketFor(boundary, NOTEBOOK_A, DOCUMENT_A);
    expect(socket).toBeDefined();

    const crossNotebookRef = editor.locator(`[data-node-id="${BLOCK_A}"] [data-type~="block-ref"]`).nth(1);
    socket!.route.send(JSON.stringify({
      cmd: "rename",
      code: 0,
      data: {
        notebookId: NOTEBOOK_A,
        documentId: DOCUMENT_C,
        empty: false,
        refText: "错误内容库重命名",
        title: "错误内容库重命名",
      },
      msg: "",
    }));
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
    await expect(crossNotebookRef).toHaveText("文档目标");

    socket!.route.send(JSON.stringify({
      cmd: "rename",
      code: 0,
      data: {
        notebookId: NOTEBOOK_B,
        documentId: DOCUMENT_C,
        empty: false,
        refText: "跨库目标已重命名",
        title: "跨库目标已重命名",
      },
      msg: "",
    }));
    await expect(crossNotebookRef).toHaveText("跨库目标已重命名");

    expect(boundary.unexpectedRequests).toEqual([]);
    expectBrowserHealthy(diagnostics, MAX_REQUEST_DURATION_MS);
  });

  test("reloads only the document named by both identity fields", async ({ page }, testInfo) => {
    requireDesktop(testInfo);
    const diagnostics = collectBrowserDiagnostics(page);
    const boundary = await installGatewayBoundary(page);
    await openDocument(page);
    const socket = socketFor(boundary, NOTEBOOK_A, DOCUMENT_A);
    expect(socket).toBeDefined();

    const initialDocumentRequests = boundary.kernelRequests.filter(
      (request) => request.kernelPath === "/api/filetree/getDoc",
    ).length;
    socket!.route.send(JSON.stringify({
      cmd: "reload",
      code: 0,
      data: { notebook: "", notebookId: NOTEBOOK_B, documentId: DOCUMENT_A },
      msg: "",
    }));
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
    expect(boundary.kernelRequests.filter(
      (request) => request.kernelPath === "/api/filetree/getDoc",
    )).toHaveLength(initialDocumentRequests);

    socket!.route.send(JSON.stringify({
      cmd: "reload",
      code: 0,
      data: { notebook: "", notebookId: NOTEBOOK_A, documentId: DOCUMENT_B },
      msg: "",
    }));
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
    expect(boundary.kernelRequests.filter(
      (request) => request.kernelPath === "/api/filetree/getDoc",
    )).toHaveLength(initialDocumentRequests);

    socket!.route.send(JSON.stringify({
      cmd: "reload",
      code: 0,
      data: { notebook: "", notebookId: NOTEBOOK_A, documentId: DOCUMENT_A },
      msg: "",
    }));
    await expect.poll(() => boundary.kernelRequests.filter(
      (request) => request.kernelPath === "/api/filetree/getDoc",
    ).length).toBeGreaterThan(initialDocumentRequests);

    expect(boundary.unexpectedRequests).toEqual([]);
    expectBrowserHealthy(diagnostics, MAX_REQUEST_DURATION_MS);
  });

  test("applies transactions only to their explicit content target", async ({ page }, testInfo) => {
    requireDesktop(testInfo);
    const diagnostics = collectBrowserDiagnostics(page);
    const boundary = await installGatewayBoundary(page);
    const editor = await openDocument(page);
    const socket = socketFor(boundary, NOTEBOOK_A, DOCUMENT_A);
    expect(socket).toBeDefined();

    const beforeWrongTransaction = await editor.locator(`[data-node-id="${BLOCK_A}"] [contenteditable="true"]`).textContent();
    socket!.route.send(JSON.stringify({
      cmd: "transactions",
      code: 0,
      context: { rootIDs: [DOCUMENT_A], undoState: {} },
      data: [{
        contentTargets: [{ documentId: DOCUMENT_A, notebookId: NOTEBOOK_B }],
        doOperations: [{ action: "update", data: paragraphBlock(BLOCK_A, "错误内容库不应覆盖"), id: BLOCK_A }],
        notebook: "",
      }],
      msg: "",
      sid: "wrong-notebook",
    }));
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
    await expect(editor.locator(`[data-node-id="${BLOCK_A}"] [contenteditable="true"]`)).toHaveText(beforeWrongTransaction ?? "");

    socket!.route.send(JSON.stringify({
      cmd: "transactions",
      code: 0,
      context: { rootIDs: [DOCUMENT_B], undoState: {} },
      data: [{
        contentTargets: [{ documentId: DOCUMENT_B, notebookId: NOTEBOOK_A }],
        doOperations: [{ action: "update", data: paragraphBlock(BLOCK_A, "错误文档不应覆盖"), id: BLOCK_A }],
        notebook: "",
      }],
      msg: "",
      sid: "wrong-document",
    }));
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
    await expect(editor.locator(`[data-node-id="${BLOCK_A}"] [contenteditable="true"]`)).toHaveText(beforeWrongTransaction ?? "");

    socket!.route.send(JSON.stringify({
      cmd: "transactions",
      code: 0,
      context: { rootIDs: [DOCUMENT_A], undoState: {} },
      data: [{
        contentTargets: [{ documentId: DOCUMENT_A, notebookId: NOTEBOOK_A }],
        doOperations: [{ action: "update", data: paragraphBlock(BLOCK_A, "同库服务推送"), id: BLOCK_A }],
        notebook: "",
      }],
      msg: "",
      sid: "current-notebook",
    }));
    await expect(editor.locator(`[data-node-id="${BLOCK_A}"] [contenteditable="true"]`)).toContainText("同库服务推送");

    expect(boundary.unexpectedRequests).toEqual([]);
    expectBrowserHealthy(diagnostics, MAX_REQUEST_DURATION_MS);
  });
});
