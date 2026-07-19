import {
  expect,
  test,
  type Page,
  type TestInfo,
  type WebSocketRoute,
} from "@playwright/test";

import {
  collectBrowserDiagnostics,
  expectBrowserHealthy,
} from "./support/diagnostics.ts";
import { fulfillJson } from "./support/http.ts";

const ORGANIZATION_A = "11111111-1111-4111-8111-111111111111";
const ORGANIZATION_B = "22222222-2222-4222-8222-222222222222";
const SPACE_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SPACE_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const NOTEBOOK_A = "20260719000000-noteb01";
const NOTEBOOK_B = "20260719000001-noteb02";
const DOCUMENT_A = "20260719000100-docum01";
const DOCUMENT_B = "20260719000101-docum02";
const DOCUMENT_C = "20260719000102-docum03";
const BLOCK_A = "20260719000200-block01";
const BLOCK_B = "20260719000201-block02";
const BLOCK_C = "20260719000202-block03";
const EMBEDDED_BLOCK = "20260719000203-block04";
const SAME_DOCUMENT_BLOCK = "20260719000204-block05";
const CSRF_TOKEN = "A".repeat(43);
const MAX_REQUEST_DURATION_MS = 5_000;

type SpaceRole = "editor" | "viewer";

interface DocumentFixture {
  readonly blockId: string;
  readonly documentId: string;
  readonly text: string;
  readonly title: string;
}

interface SpaceFixture {
  readonly documents: readonly DocumentFixture[];
  readonly notebookId: string;
  readonly notebookName: string;
  readonly organizationId: string;
  readonly organizationName: string;
  readonly role: SpaceRole;
  readonly spaceId: string;
  readonly spaceName: string;
}

interface ObservedKernelRequest {
  readonly body: unknown;
  readonly documentId: string;
  readonly kernelPath: string;
  readonly notebookId: string;
  readonly spaceId: string;
}

interface ObservedSocket {
  closed: boolean;
  readonly documentId: string;
  readonly notebookId: string;
  readonly route: WebSocketRoute;
  readonly spaceId: string;
}

interface GatewayBoundary {
  readonly events: string[];
  readonly kernelRequests: ObservedKernelRequest[];
  readonly sockets: ObservedSocket[];
  readonly transactionRequests: ObservedKernelRequest[];
  readonly unexpectedRequests: string[];
}

function workspacePath(organizationId = ORGANIZATION_A, spaceId = SPACE_A) {
  return `/organizations/${organizationId}/spaces/${spaceId}`;
}

function gatewayBasePath(fixture: SpaceFixture) {
  return `/api/v1/organizations/${fixture.organizationId}/spaces/${fixture.spaceId}`;
}

function paragraphBlock(blockId: string, text: string, extra = "") {
  return `<div data-node-id="${blockId}" data-type="NodeParagraph" class="p" updated="20260719000000"><div contenteditable="true" spellcheck="false">${text}${extra}</div><div class="protyle-attr" contenteditable="false">&#8203;</div></div>`;
}

function documentResponse(
  fixture: DocumentFixture,
  notebookId: string,
  requestedId: string,
) {
  const embedded = requestedId !== fixture.documentId;
  const blockId = embedded ? requestedId : fixture.blockId;
  const embeddedTrigger = fixture.documentId === DOCUMENT_A && !embedded
    ? `<span data-action="openFloat" data-id="${EMBEDDED_BLOCK}" data-notebook-id="${NOTEBOOK_A}" data-document-id="${DOCUMENT_B}">打开嵌入式文档</span><span data-action="openFloat" data-id="${SAME_DOCUMENT_BLOCK}" data-notebook-id="${NOTEBOOK_A}" data-document-id="${DOCUMENT_A}">打开同文档实例</span>`
    : "";
  return {
    code: 0,
    data: {
      blockCount: 1,
      content: paragraphBlock(
        blockId,
        embedded ? "嵌入式文档内容" : fixture.text,
        embeddedTrigger,
      ),
      eof: false,
      id: requestedId,
      isBacklinkExpand: false,
      isSyncing: false,
      mode: 0,
      notebook: notebookId,
      parent2ID: "",
      parentDocument: false,
      parentID: embedded ? fixture.documentId : "",
      path: `/${fixture.documentId}.sy`,
      rootID: fixture.documentId,
      scroll: {},
      type: embedded ? "NodeParagraph" : "NodeDocument",
    },
    msg: "",
  };
}

function requireDesktop(testInfo: TestInfo) {
  test.skip(
    testInfo.project.name !== "desktop",
    "P3 exercises the visible desktop editor; responsive shell contracts have separate browser integration coverage.",
  );
}

function createSpaceFixtures(role: SpaceRole): readonly SpaceFixture[] {
  return [
    {
      documents: [
        {
          blockId: BLOCK_A,
          documentId: DOCUMENT_A,
          text: "第一文档初始内容",
          title: "第一文档",
        },
        {
          blockId: BLOCK_B,
          documentId: DOCUMENT_B,
          text: "第二文档初始内容",
          title: "第二文档",
        },
      ],
      notebookId: NOTEBOOK_A,
      notebookName: "深空笔记本",
      organizationId: ORGANIZATION_A,
      organizationName: "银河研究院",
      role,
      spaceId: SPACE_A,
      spaceName: "深空知识空间",
    },
    {
      documents: [
        {
          blockId: BLOCK_C,
          documentId: DOCUMENT_C,
          text: "新空间文档内容",
          title: "新空间文档",
        },
      ],
      notebookId: NOTEBOOK_B,
      notebookName: "工程笔记本",
      organizationId: ORGANIZATION_B,
      organizationName: "奇点工程中心",
      role: "editor",
      spaceId: SPACE_B,
      spaceName: "星际工程手册",
    },
  ];
}

async function installGatewayBoundary(
  page: Page,
  role: SpaceRole = "editor",
): Promise<GatewayBoundary> {
  const fixtures = createSpaceFixtures(role);
  const documents = new Map(
    fixtures.flatMap((space) =>
      space.documents.map((document) => [document.documentId, document] as const),
    ),
  );
  const boundary: GatewayBoundary = {
    events: [],
    kernelRequests: [],
    sockets: [],
    transactionRequests: [],
    unexpectedRequests: [],
  };

  await page.routeWebSocket(/\/kernel\/ws(?:\?|$)/, (route) => {
    const url = new URL(route.url());
    const fixture = fixtures.find((candidate) =>
      url.pathname.startsWith(`${gatewayBasePath(candidate)}/kernel/ws`),
    );
    const documentId = url.searchParams.get("documentId") ?? "";
    const notebookId = url.searchParams.get("notebookId") ?? "";
    const socket: ObservedSocket = {
      closed: false,
      documentId,
      notebookId,
      route,
      spaceId: fixture?.spaceId ?? "",
    };
    boundary.sockets.push(socket);
    boundary.events.push(`socket:open:${socket.spaceId}:${documentId}`);
    route.onClose((code, reason) => {
      if (socket.closed) {
        return;
      }
      socket.closed = true;
      boundary.events.push(`socket:close:${socket.spaceId}:${documentId}`);
      void route.close({
        code: code ?? 1000,
        ...(reason === undefined ? {} : { reason }),
      });
    });
  });

  await page.route("**/api/v1/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;

    if (path === "/api/v1/spaces") {
      await fulfillJson(route, {
        spaces: fixtures.map((fixture) => ({
          organizationId: fixture.organizationId,
          organizationName: fixture.organizationName,
          role: fixture.role,
          spaceId: fixture.spaceId,
          spaceName: fixture.spaceName,
        })),
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

    for (const fixture of fixtures) {
      const basePath = gatewayBasePath(fixture);
      if (path === `${basePath}/runtime`) {
        await fulfillJson(route, {
          kernelState: "ready",
          organizationId: fixture.organizationId,
          role: fixture.role,
          spaceId: fixture.spaceId,
        });
        return;
      }
      if (path === `${basePath}/content-directory/notebooks`) {
        await fulfillJson(route, {
          notebooks: [{
            icon: "",
            locked: false,
            name: fixture.notebookName,
            notebookId: fixture.notebookId,
          }],
        });
        return;
      }
      if (
        path ===
        `${basePath}/content-directory/notebooks/${fixture.notebookId}/documents`
      ) {
        await fulfillJson(route, {
          documents: fixture.documents.map((document) => ({
            documentId: document.documentId,
            hasChildren: false,
            icon: "",
            notebookId: fixture.notebookId,
            title: document.title,
          })),
          locked: false,
          nextOffset: null,
        });
        return;
      }

      const kernelPrefix = `${basePath}/kernel/api`;
      if (!path.startsWith(`${kernelPrefix}/api/`)) {
        continue;
      }
      const headers = request.headers();
      const documentId = headers["x-singularity-document-id"] ?? "";
      const notebookId = headers["x-singularity-notebook-id"] ?? "";
      const kernelPath = path.slice(kernelPrefix.length);
      const body = request.postDataJSON() as Record<string, unknown>;
      const observed: ObservedKernelRequest = {
        body,
        documentId,
        kernelPath,
        notebookId,
        spaceId: fixture.spaceId,
      };
      boundary.kernelRequests.push(observed);

      if (kernelPath === "/api/filetree/getDoc") {
        const document = documents.get(documentId);
        const requestedId = typeof body.id === "string" ? body.id : "";
        if (!document || requestedId === "") {
          boundary.unexpectedRequests.push(`${kernelPath}:${documentId}:${requestedId}`);
          await route.abort("failed");
          return;
        }
        boundary.events.push(`content:get:${fixture.spaceId}:${documentId}`);
        await fulfillJson(
          route,
          documentResponse(document, notebookId, requestedId),
        );
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
            blockId: documentId,
            documentId,
            name: documents.get(documentId)?.title ?? "",
            notebookId,
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
      if (kernelPath === "/api/transactions") {
        boundary.transactionRequests.push(observed);
        const transactions = Array.isArray(body.transactions)
          ? body.transactions
          : [];
        await fulfillJson(route, { code: 0, data: transactions, msg: "" });
        return;
      }

      boundary.unexpectedRequests.push(kernelPath);
      await route.abort("failed");
      return;
    }

    boundary.unexpectedRequests.push(`${request.method()} ${path}`);
    await route.abort("failed");
  });

  return boundary;
}

async function openFirstDocument(page: Page) {
  await page.goto(workspacePath());
  const editor = page.getByTestId("protyle-host");
  await expect(editor.locator(`[data-node-id="${BLOCK_A}"]`)).toContainText(
    "第一文档初始内容",
  );
  await expect(editor.locator(".protyle-wysiwyg")).toHaveAttribute(
    "data-readonly",
    /^(?:true|false)$/,
  );
  return editor;
}

function socketFor(
  boundary: GatewayBoundary,
  spaceId: string,
  documentId: string,
) {
  return boundary.sockets.find(
    (socket) =>
      socket.spaceId === spaceId && socket.documentId === documentId,
  );
}

test.describe("real Protyle browser integration", () => {
  test("opens, edits, commits through Gateway, and applies a service push", async ({
    page,
  }, testInfo) => {
    requireDesktop(testInfo);
    const diagnostics = collectBrowserDiagnostics(page);
    const boundary = await installGatewayBoundary(page);
    const editor = await openFirstDocument(page);
    const editable = editor.locator(
      `[data-node-id="${BLOCK_A}"] [contenteditable="true"]`,
    );

    await expect(editable).toHaveAttribute("spellcheck", "false");
    await editable.fill("本地编辑已提交");
    await expect.poll(() => boundary.transactionRequests.length).toBeGreaterThan(0);

    const transaction = boundary.transactionRequests.at(-1)!;
    expect(transaction.spaceId).toBe(SPACE_A);
    expect(transaction.notebookId).toBe(NOTEBOOK_A);
    expect(transaction.documentId).toBe(DOCUMENT_A);
    expect(JSON.stringify(transaction.body)).toContain("本地编辑已提交");

    await expect.poll(() => socketFor(boundary, SPACE_A, DOCUMENT_A)).toBeDefined();
    socketFor(boundary, SPACE_A, DOCUMENT_A)!.route.send(JSON.stringify({
      cmd: "transactions",
      code: 0,
      context: { rootIDs: [DOCUMENT_A] },
      data: [{
        contentTargets: [{ documentId: DOCUMENT_A, notebookId: NOTEBOOK_A }],
        doOperations: [{
          action: "update",
          data: paragraphBlock(BLOCK_A, "服务推送已应用"),
          id: BLOCK_A,
        }],
      }],
      msg: "",
      sid: "remote-editor",
    }));
    await expect(editor.locator(`[data-node-id="${BLOCK_A}"]`)).toContainText(
      "服务推送已应用",
    );

    expect(boundary.unexpectedRequests).toEqual([]);
    expectBrowserHealthy(diagnostics, MAX_REQUEST_DURATION_MS);
  });

  test("uses the transaction source editor when the same document has multiple instances", async ({
    page,
  }, testInfo) => {
    requireDesktop(testInfo);
    const diagnostics = collectBrowserDiagnostics(page);
    const boundary = await installGatewayBoundary(page);
    const editor = await openFirstDocument(page);

    await editor.getByText("打开同文档实例").click();
    const panel = page.locator('[data-protyle-block-panel="true"]');
    await expect(panel).toHaveClass(/block__popover--open/);
    await expect(panel.locator(`[data-node-id="${SAME_DOCUMENT_BLOCK}"]`)).toContainText("嵌入式文档内容");
    await expect.poll(() => boundary.sockets.filter(
      (socket) => socket.spaceId === SPACE_A && socket.documentId === DOCUMENT_A,
    ).length).toBe(2);
    const embeddedSocket = boundary.sockets.filter(
      (socket) => socket.spaceId === SPACE_A && socket.documentId === DOCUMENT_A,
    ).at(-1)!;

    const sourceEditable = editor.locator(`[data-node-id="${BLOCK_A}"] [contenteditable="true"]`);
    await sourceEditable.fill("来源实例唯一内容");
    await expect.poll(() => boundary.transactionRequests.length).toBeGreaterThan(0);
    const sourceTransaction = boundary.transactionRequests.at(-1)!;
    const sourceEditorId = (sourceTransaction.body as { session?: unknown }).session;
    expect(typeof sourceEditorId).toBe("string");
    expect(sourceEditorId).not.toBe("");
    const fallbackRequests = boundary.kernelRequests.filter(
      (request) => request.kernelPath === "/api/block/getBlockDOM",
    ).length;

    embeddedSocket.route.send(JSON.stringify({
      cmd: "transactions",
      code: 0,
      context: { rootIDs: [DOCUMENT_A] },
      data: [{
        contentTargets: [{ documentId: DOCUMENT_A, notebookId: NOTEBOOK_A }],
        doOperations: [{
          action: "move",
          id: BLOCK_A,
          previousID: SAME_DOCUMENT_BLOCK,
        }],
        notebook: "",
      }],
      msg: "",
      sid: sourceEditorId,
    }));
    await expect(panel.locator(`[data-node-id="${BLOCK_A}"]`)).toContainText("来源实例唯一内容");
    expect(boundary.kernelRequests.filter(
      (request) => request.kernelPath === "/api/block/getBlockDOM",
    )).toHaveLength(fallbackRequests);

    expect(boundary.unexpectedRequests).toEqual([]);
    expectBrowserHealthy(diagnostics, MAX_REQUEST_DURATION_MS);
  });

  test("viewer mounts the same real DOM as read-only and cannot submit", async ({
    page,
  }, testInfo) => {
    requireDesktop(testInfo);
    const diagnostics = collectBrowserDiagnostics(page);
    const boundary = await installGatewayBoundary(page, "viewer");
    const editor = await openFirstDocument(page);
    const wysiwyg = editor.locator(".protyle-wysiwyg");
    const paragraph = editor.locator(`[data-node-id="${BLOCK_A}"] [spellcheck]`);

    await expect(wysiwyg).toHaveAttribute("data-readonly", "true");
    await expect(wysiwyg).toHaveAttribute("contenteditable", "false");
    await expect(paragraph).toHaveAttribute("contenteditable", "false");
    await paragraph.click();
    await page.keyboard.type("不会写入");
    await expect(paragraph).toHaveText("第一文档初始内容打开嵌入式文档");
    expect(boundary.transactionRequests).toEqual([]);

    expect(boundary.unexpectedRequests).toEqual([]);
    expectBrowserHealthy(diagnostics, MAX_REQUEST_DURATION_MS);
  });

  test("closing an embedded owner removes its DOM and terminates its subscription", async ({
    page,
  }, testInfo) => {
    requireDesktop(testInfo);
    const diagnostics = collectBrowserDiagnostics(page);
    const boundary = await installGatewayBoundary(page);
    const editor = await openFirstDocument(page);

    await editor.getByText("打开嵌入式文档").click();
    const panel = page.locator('[data-protyle-block-panel="true"]');
    await expect(panel).toHaveClass(/block__popover--open/);
    await expect(panel.getByText("嵌入式文档内容")).toBeVisible();
    await expect.poll(() => socketFor(boundary, SPACE_A, DOCUMENT_B)).toBeDefined();
    const embeddedSocket = socketFor(boundary, SPACE_A, DOCUMENT_B)!;

    await panel.locator('[data-type="close"]').click();
    await expect(panel).toHaveCount(0);
    await expect.poll(() => embeddedSocket.closed).toBe(true);
    embeddedSocket.route.send(JSON.stringify({
      cmd: "transactions",
      code: 0,
      data: [{
        contentTargets: [{ documentId: DOCUMENT_B, notebookId: NOTEBOOK_A }],
        doOperations: [{
          action: "update",
          data: paragraphBlock(EMBEDDED_BLOCK, "迟到结果"),
          id: EMBEDDED_BLOCK,
        }],
      }],
      msg: "",
      sid: "late-embedded-editor",
    }));
    await page.evaluate(() => new Promise<void>((resolve) => {
      requestAnimationFrame(() => resolve());
    }));
    await expect(panel).toHaveCount(0);
    await expect(editor.locator(`[data-node-id="${BLOCK_A}"]`)).toBeVisible();

    expect(boundary.unexpectedRequests).toEqual([]);
    expectBrowserHealthy(diagnostics, MAX_REQUEST_DURATION_MS);
  });

  test("removeDoc closes only the embedded owner with the matching identity", async ({
    page,
  }, testInfo) => {
    requireDesktop(testInfo);
    const diagnostics = collectBrowserDiagnostics(page);
    const boundary = await installGatewayBoundary(page);
    const editor = await openFirstDocument(page);

    await editor.getByText("打开嵌入式文档").click();
    const panel = page.locator('[data-protyle-block-panel="true"]');
    await expect(panel.getByText("嵌入式文档内容")).toBeVisible();
    await expect.poll(() => socketFor(boundary, SPACE_A, DOCUMENT_B)).toBeDefined();
    const embeddedSocket = socketFor(boundary, SPACE_A, DOCUMENT_B)!;

    embeddedSocket.route.send(JSON.stringify({
      cmd: "removeDoc",
      code: 0,
      data: { documentId: DOCUMENT_B, notebookId: NOTEBOOK_B },
      msg: "",
    }));
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
    await expect(panel).toHaveCount(1);

    embeddedSocket.route.send(JSON.stringify({
      cmd: "removeDoc",
      code: 0,
      data: { documentId: DOCUMENT_B, notebookId: NOTEBOOK_A },
      msg: "",
    }));
    await expect(panel).toHaveCount(0);
    await expect.poll(() => embeddedSocket.closed).toBe(true);
    await expect(editor.locator(`[data-node-id="${BLOCK_A}"]`)).toBeVisible();

    expect(boundary.unexpectedRequests).toEqual([]);
    expectBrowserHealthy(diagnostics, MAX_REQUEST_DURATION_MS);
  });

  test("switching documents closes the old editor before the successor becomes current", async ({
    page,
  }, testInfo) => {
    requireDesktop(testInfo);
    const diagnostics = collectBrowserDiagnostics(page);
    const boundary = await installGatewayBoundary(page);
    const editor = await openFirstDocument(page);
    await expect.poll(() => socketFor(boundary, SPACE_A, DOCUMENT_A)).toBeDefined();
    const oldSocket = socketFor(boundary, SPACE_A, DOCUMENT_A)!;

    await page.getByRole("button", { name: "第二文档" }).click();
    await expect(editor.locator(`[data-node-id="${BLOCK_B}"]`)).toContainText(
      "第二文档初始内容",
    );
    await expect(editor.locator(`[data-node-id="${BLOCK_A}"]`)).toHaveCount(0);
    await expect.poll(() => oldSocket.closed).toBe(true);
    await expect.poll(() => socketFor(boundary, SPACE_A, DOCUMENT_B)).toBeDefined();
    const oldClose = boundary.events.indexOf(
      `socket:close:${SPACE_A}:${DOCUMENT_A}`,
    );
    const successorOpen = boundary.events.indexOf(
      `socket:open:${SPACE_A}:${DOCUMENT_B}`,
    );
    expect(oldClose).toBeGreaterThanOrEqual(0);
    expect(successorOpen).toBeGreaterThan(oldClose);
    expect(
      boundary.kernelRequests.filter(
        (request) =>
          request.kernelPath === "/api/filetree/getDoc" &&
          request.documentId === DOCUMENT_A,
      ),
    ).toHaveLength(1);

    const requestsAfterSwitch = boundary.kernelRequests.length;
    oldSocket.route.send(JSON.stringify({
      cmd: "moveDoc",
      code: 0,
      data: {
        fromNotebook: NOTEBOOK_A,
        fromPath: `/${DOCUMENT_A}.sy`,
        documentId: DOCUMENT_A,
        newPath: `/moved/${DOCUMENT_A}.sy`,
        toNotebook: NOTEBOOK_B,
        toPath: `/moved/${DOCUMENT_A}.sy`,
      },
      msg: "",
    }));
    await page.evaluate(() => new Promise<void>((resolve) => {
      requestAnimationFrame(() => resolve());
    }));
    expect(boundary.kernelRequests).toHaveLength(requestsAfterSwitch);
    await expect(editor.locator(`[data-node-id="${BLOCK_B}"]`)).toContainText(
      "第二文档初始内容",
    );

    expect(boundary.unexpectedRequests).toEqual([]);
    expectBrowserHealthy(diagnostics, MAX_REQUEST_DURATION_MS);
  });

  test("switching spaces disposes the old Session before mounting the newly authorized space", async ({
    page,
  }, testInfo) => {
    requireDesktop(testInfo);
    const diagnostics = collectBrowserDiagnostics(page);
    const boundary = await installGatewayBoundary(page);
    await openFirstDocument(page);
    await expect.poll(() => socketFor(boundary, SPACE_A, DOCUMENT_A)).toBeDefined();
    const oldSocket = socketFor(boundary, SPACE_A, DOCUMENT_A)!;

    await page.getByRole("link", { name: /星际工程手册/ }).click();
    await expect(page).toHaveURL(workspacePath(ORGANIZATION_B, SPACE_B));
    const newEditor = page.getByTestId("protyle-host");
    await expect(newEditor.locator(`[data-node-id="${BLOCK_C}"]`)).toContainText(
      "新空间文档内容",
    );
    await expect.poll(() => oldSocket.closed).toBe(true);
    await expect.poll(() => socketFor(boundary, SPACE_B, DOCUMENT_C)).toBeDefined();
    const oldClose = boundary.events.indexOf(
      `socket:close:${SPACE_A}:${DOCUMENT_A}`,
    );
    const successorOpen = boundary.events.indexOf(
      `socket:open:${SPACE_B}:${DOCUMENT_C}`,
    );
    expect(oldClose).toBeGreaterThanOrEqual(0);
    expect(successorOpen).toBeGreaterThan(oldClose);
    await expect(page.locator('[data-space-session-state="ready"]')).toBeVisible();
    await expect(page.locator(`[data-node-id="${BLOCK_A}"]`)).toHaveCount(0);

    const requestsAfterSwitch = boundary.kernelRequests.length;
    oldSocket.route.send(JSON.stringify({
      cmd: "moveDoc",
      code: 0,
      data: {
        fromNotebook: NOTEBOOK_A,
        fromPath: `/${DOCUMENT_A}.sy`,
        documentId: DOCUMENT_A,
        newPath: `/moved/${DOCUMENT_A}.sy`,
        toNotebook: NOTEBOOK_A,
        toPath: `/moved/${DOCUMENT_A}.sy`,
      },
      msg: "",
    }));
    await page.evaluate(() => new Promise<void>((resolve) => {
      requestAnimationFrame(() => resolve());
    }));
    expect(boundary.kernelRequests).toHaveLength(requestsAfterSwitch);
    await expect(newEditor.locator(`[data-node-id="${BLOCK_C}"]`)).toContainText(
      "新空间文档内容",
    );

    expect(boundary.unexpectedRequests).toEqual([]);
    expectBrowserHealthy(diagnostics, MAX_REQUEST_DURATION_MS);
  });
});
