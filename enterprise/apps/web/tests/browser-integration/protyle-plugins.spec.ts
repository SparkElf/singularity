import {
  expect,
  test,
  type Page,
  type TestInfo,
} from "@playwright/test";

import {
  collectBrowserDiagnostics,
  expectBrowserHealthy,
} from "./support/diagnostics.ts";
import { fulfillJson } from "./support/http.ts";

const ORGANIZATION_ID = "11111111-1111-4111-8111-111111111111";
const SPACE_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const NOTEBOOK_ID = "20260719000000-noteb01";
const DOCUMENT_ID = "20260719000100-docum01";
const BLOCK_ID = "20260719000200-block01";
const PERSISTENCE_IMAGE_PATH = "assets/plugin-persistence.png";
const CSRF_TOKEN = "A".repeat(43);
const MAX_REQUEST_DURATION_MS = 5_000;
const FOCUS_LABEL = "聚焦当前块";

interface ObservedKernelRequest {
  readonly body: unknown;
  readonly documentId: string;
  readonly kernelPath: string;
  readonly notebookId: string;
}

interface PluginGatewayBoundary {
  readonly transactionRequests: ObservedKernelRequest[];
  readonly unexpectedRequests: string[];
}

function workspacePath() {
  return `/organizations/${ORGANIZATION_ID}/spaces/${SPACE_ID}`;
}

function gatewayBasePath() {
  return `/api/v1/organizations/${ORGANIZATION_ID}/spaces/${SPACE_ID}`;
}

function paragraphBlock(text: string, includePersistenceImage: boolean) {
  const image = includePersistenceImage
    ? `<span contenteditable="false" data-type="img" class="img"><span> </span><span><img src="${PERSISTENCE_IMAGE_PATH}" data-src="${PERSISTENCE_IMAGE_PATH}" alt="plugin persistence" /><span class="protyle-action__drag"></span><span class="protyle-action__title"></span></span><span> </span></span>`
    : "";
  return `<div data-node-id="${BLOCK_ID}" data-type="NodeParagraph" class="p" updated="20260719000000"><div contenteditable="true" spellcheck="false">${text}${image}</div><div class="protyle-attr" contenteditable="false">&#8203;</div></div>`;
}

function documentResponse(includePersistenceImage = false) {
  return {
    code: 0,
    data: {
      blockCount: 1,
      content: paragraphBlock("插件初始内容", includePersistenceImage),
      eof: false,
      id: DOCUMENT_ID,
      isBacklinkExpand: false,
      isSyncing: false,
      mode: 0,
      notebook: NOTEBOOK_ID,
      parent2ID: "",
      parentDocument: false,
      parentID: "",
      path: `/${DOCUMENT_ID}.sy`,
      rootID: DOCUMENT_ID,
      scroll: {},
      type: "NodeDocument",
    },
    msg: "",
  };
}

function requireDesktop(testInfo: TestInfo) {
  test.skip(
    testInfo.project.name !== "desktop",
    "P4 exercises desktop Protyle plugin surfaces; responsive shell contracts have separate browser coverage.",
  );
}

async function installPluginGatewayBoundary(
  page: Page,
  options: { readonly includePersistenceImage?: boolean } = {},
): Promise<PluginGatewayBoundary> {
  const boundary: PluginGatewayBoundary = {
    transactionRequests: [],
    unexpectedRequests: [],
  };
  const basePath = gatewayBasePath();

  await page.routeWebSocket(/\/kernel\/ws(?:\?|$)/, () => undefined);
  await page.route("**/api/v1/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;

    if (path === "/api/v1/spaces") {
      await fulfillJson(route, {
        spaces: [{
          organizationId: ORGANIZATION_ID,
          organizationName: "银河研究院",
          role: "editor",
          spaceId: SPACE_ID,
          spaceName: "深空知识空间",
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
    if (path === `${basePath}/runtime`) {
      await fulfillJson(route, {
        kernelState: "ready",
        organizationId: ORGANIZATION_ID,
        role: "editor",
        spaceId: SPACE_ID,
      });
      return;
    }
    if (path === `${basePath}/content-directory/notebooks`) {
      await fulfillJson(route, {
        notebooks: [{
          icon: "",
          locked: false,
          name: "插件笔记本",
          notebookId: NOTEBOOK_ID,
          supportsGraph: true,
        }],
      });
      return;
    }
    if (
      path ===
      `${basePath}/content-directory/notebooks/${NOTEBOOK_ID}/documents`
    ) {
      await fulfillJson(route, {
        documents: [{
          documentId: DOCUMENT_ID,
          hasChildren: false,
          icon: "",
          notebookId: NOTEBOOK_ID,
          title: "插件文档",
        }],
        locked: false,
        nextOffset: null,
      });
      return;
    }
    if (path === `${basePath}/${PERSISTENCE_IMAGE_PATH}`) {
      await route.fulfill({
        body: Buffer.from(
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2ZQAAAABJRU5ErkJggg==",
          "base64",
        ),
        contentType: "image/png",
        status: 200,
      });
      return;
    }

    const kernelPrefix = `${basePath}/kernel/api`;
    if (path.startsWith(`${kernelPrefix}/api/`)) {
      const kernelPath = path.slice(kernelPrefix.length);
      const headers = request.headers();
      const observed: ObservedKernelRequest = {
        body: request.postDataJSON(),
        documentId: headers["x-singularity-document-id"] ?? "",
        kernelPath,
        notebookId: headers["x-singularity-notebook-id"] ?? "",
      };

      if (kernelPath === "/api/filetree/getDoc") {
        await fulfillJson(
          route,
          documentResponse(options.includePersistenceImage),
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
            blockId: DOCUMENT_ID,
            documentId: DOCUMENT_ID,
            name: "插件文档",
            notebookId: NOTEBOOK_ID,
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
        const transactions = (observed.body as { transactions?: unknown }).transactions;
        await fulfillJson(route, { code: 0, data: transactions ?? [], msg: "" });
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

async function openPluginDocument(page: Page) {
  await page.goto(workspacePath());
  const editor = page.getByTestId("protyle-host");
  const block = editor.locator(`[data-node-id="${BLOCK_ID}"]`);
  await expect(block).toContainText("插件初始内容");
  return {
    block,
    editable: block.locator('[contenteditable="true"]'),
    editor,
  };
}

test.describe("React Protyle plugin browser integration", () => {
  test("adds a real grouped content-menu contribution and runs its action", async ({
    page,
  }, testInfo) => {
    requireDesktop(testInfo);
    const diagnostics = collectBrowserDiagnostics(page);
    const boundary = await installPluginGatewayBoundary(page);
    const { block, editable } = await openPluginDocument(page);

    await expect(block).not.toHaveClass(/protyle-wysiwyg--hl/);
    await editable.click();
    await editable.click({ button: "right" });
    const pluginMenu = page.getByRole("menuitem", { name: "插件" });
    await expect(pluginMenu).toBeVisible();
    await pluginMenu.hover();
    const focusItem = page.getByRole("menuitem", {
      name: FOCUS_LABEL,
    });
    await expect(focusItem).toBeVisible();
    await focusItem.click();
    await expect(block).toHaveClass(/protyle-wysiwyg--hl/);

    expect(boundary.unexpectedRequests).toEqual([]);
    expectBrowserHealthy(diagnostics, MAX_REQUEST_DURATION_MS);
  });

  test("runs the matching editor command through the real keydown path", async ({
    page,
  }, testInfo) => {
    requireDesktop(testInfo);
    const diagnostics = collectBrowserDiagnostics(page);
    const boundary = await installPluginGatewayBoundary(page);
    const { block, editable } = await openPluginDocument(page);

    await expect(block).not.toHaveClass(/protyle-wysiwyg--hl/);
    await editable.click();
    await page.keyboard.press("Alt+Shift+M");
    await expect(block).toHaveClass(/protyle-wysiwyg--hl/);

    expect(boundary.unexpectedRequests).toEqual([]);
    expectBrowserHealthy(diagnostics, MAX_REQUEST_DURATION_MS);
  });

  test("keeps plugin focus local while persisting edited content", async ({
    page,
  }, testInfo) => {
    requireDesktop(testInfo);
    const diagnostics = collectBrowserDiagnostics(page);
    const boundary = await installPluginGatewayBoundary(page, {
      includePersistenceImage: true,
    });
    const { block, editable } = await openPluginDocument(page);
    const image = block.locator(
      `.img img[data-src="${PERSISTENCE_IMAGE_PATH}"]`,
    );
    const gatewayImageSource = `${gatewayBasePath()}/${PERSISTENCE_IMAGE_PATH}?documentId=${DOCUMENT_ID}&notebookId=${NOTEBOOK_ID}`;

    await editable.click();
    await page.keyboard.press("Alt+Shift+M");
    await expect(block).toHaveClass(/protyle-wysiwyg--hl/);
    await expect(image).toHaveAttribute("src", gatewayImageSource);
    await editable.evaluate((element) => {
      const range = document.createRange();
      range.selectNodeContents(element);
      range.collapse(false);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      (element as HTMLElement).focus();
    });
    await page.keyboard.type("插件事务净化前置");
    await expect.poll(() => boundary.transactionRequests.length).toBeGreaterThan(0);
    const transactionCount = boundary.transactionRequests.length;
    await expect(block).toHaveClass(/protyle-wysiwyg--hl/);
    await page.keyboard.type("插件事务净化标记");
    await expect.poll(() => boundary.transactionRequests.length).toBeGreaterThan(transactionCount);

    const request = boundary.transactionRequests.at(-1)!;
    const transaction = (request.body as {
      transactions?: Array<{
        doOperations?: unknown[];
        undoOperations?: unknown[];
      }>;
    }).transactions?.[0];
    expect(transaction?.doOperations).toBeInstanceOf(Array);
    expect(transaction?.undoOperations).toBeInstanceOf(Array);
    const doHTML = transaction?.doOperations?.flatMap((operation) => {
      const record = operation as { data?: unknown; retData?: unknown };
      return [record.data, record.retData].filter(
        (value): value is string => typeof value === "string",
      );
    }) ?? [];
    const undoHTML = transaction?.undoOperations?.flatMap((operation) => {
      const record = operation as { data?: unknown; retData?: unknown };
      return [record.data, record.retData].filter(
        (value): value is string => typeof value === "string",
      );
    }) ?? [];
    const persistedDoImage = doHTML.find((html) =>
      html.includes(`data-src="${PERSISTENCE_IMAGE_PATH}"`)
    );
    const persistedUndoImage = undoHTML.find((html) =>
      html.includes(`data-src="${PERSISTENCE_IMAGE_PATH}"`)
    );
    expect(persistedDoImage).toContain(`src="${PERSISTENCE_IMAGE_PATH}"`);
    expect(persistedUndoImage).toContain(`src="${PERSISTENCE_IMAGE_PATH}"`);
    expect(persistedDoImage).not.toContain(gatewayImageSource);
    expect(persistedUndoImage).not.toContain(gatewayImageSource);
    expect(doHTML.join("\n")).toContain("插件事务净化标记");
    expect(undoHTML.join("\n")).toContain("插件事务净化前置");
    expect(JSON.stringify(transaction)).not.toContain("protyle-wysiwyg--hl");
    await expect(block).toHaveClass(/protyle-wysiwyg--hl/);
    await expect(image).toHaveAttribute("src", gatewayImageSource);

    expect(boundary.unexpectedRequests).toEqual([]);
    expectBrowserHealthy(diagnostics, MAX_REQUEST_DURATION_MS);
  });

  test("discovers and executes the identity-bound slash contribution", async ({
    page,
  }, testInfo) => {
    requireDesktop(testInfo);
    const diagnostics = collectBrowserDiagnostics(page);
    const boundary = await installPluginGatewayBoundary(page);
    const { block, editable } = await openPluginDocument(page);

    await expect(block).not.toHaveClass(/protyle-wysiwyg--hl/);
    await editable.click();
    await page.keyboard.press("End");
    await page.keyboard.type("/focus");
    const slashItem = page.locator(".protyle-hint .b3-list-item").filter({
      hasText: FOCUS_LABEL,
    });
    await expect(slashItem).toBeVisible();
    await expect(slashItem).toHaveAttribute("data-value", "");
    await slashItem.click();
    await expect(block).toHaveClass(/protyle-wysiwyg--hl/);

    expect(boundary.unexpectedRequests).toEqual([]);
    expectBrowserHealthy(diagnostics, MAX_REQUEST_DURATION_MS);
  });

  test("awaits the paste contribution before committing normalized content", async ({
    page,
  }, testInfo) => {
    requireDesktop(testInfo);
    const diagnostics = collectBrowserDiagnostics(page);
    const boundary = await installPluginGatewayBoundary(page);
    const { editable } = await openPluginDocument(page);

    await editable.evaluate((element) => {
      const range = document.createRange();
      range.selectNodeContents(element);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      const clipboardData = new DataTransfer();
      clipboardData.setData("text/plain", "插件\u00a0粘贴");
      element.dispatchEvent(new ClipboardEvent("paste", {
        bubbles: true,
        cancelable: true,
        clipboardData,
      }));
    });

    await expect.poll(async () => editable.textContent()).toBe("插件 粘贴");
    await expect.poll(() => boundary.transactionRequests.length).toBeGreaterThan(0);
    const transaction = boundary.transactionRequests.at(-1)!;
    expect(transaction.documentId).toBe(DOCUMENT_ID);
    expect(transaction.notebookId).toBe(NOTEBOOK_ID);
    expect(JSON.stringify(transaction.body)).toContain("插件 粘贴");
    expect(JSON.stringify(transaction.body)).not.toContain("插件\u00a0粘贴");

    expect(boundary.unexpectedRequests).toEqual([]);
    expectBrowserHealthy(diagnostics, MAX_REQUEST_DURATION_MS);
  });
});
