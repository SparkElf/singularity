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
import { contentBlock } from "./support/protyle.ts";

const ORGANIZATION_ID = "11111111-1111-4111-8111-111111111111";
const SPACE_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const NOTEBOOK_ID = "20260719000000-noteb01";
const DOCUMENT_ID = "20260719000100-docum01";
const BLOCK_ID = "20260719000200-block01";
const PLANTUML_BLOCK_ID = "20260719000300-plant01";
const CSRF_TOKEN = "A".repeat(43);
const MAX_REQUEST_DURATION_MS = 5_000;
const GATEWAY_BASE_PATH = `/api/v1/organizations/${ORGANIZATION_ID}/spaces/${SPACE_ID}`;

interface AssetFixture {
  readonly body: Buffer;
  readonly fileName: string;
  readonly label: string;
  readonly mediaType: string;
  readonly path: string;
}

interface ObservedAssetRequest {
  readonly documentId: string;
  readonly download: boolean;
  readonly notebookId: string;
  readonly path: string;
}

interface ObservedOcrRequest {
  readonly documentId: string;
  readonly notebookId: string;
  readonly path: string;
}

interface ActiveContentBoundary {
  readonly assetRequests: ObservedAssetRequest[];
  readonly downloadUrls: string[];
  readonly ocrRequests: ObservedOcrRequest[];
}

const ACTIVE_ASSETS: readonly AssetFixture[] = [
  {
    body: Buffer.from("<script>window.__activeContentExecuted = true</script>", "utf8"),
    fileName: "unsafe.html",
    label: "下载 HTML",
    mediaType: "text/html",
    path: "assets/unsafe.html",
  },
  {
    body: Buffer.from("window.__activeContentExecuted = true", "utf8"),
    fileName: "unsafe.js",
    label: "下载 JavaScript",
    mediaType: "text/javascript",
    path: "assets/unsafe.js",
  },
  {
    body: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="window.__activeContentExecuted = true"/>', "utf8"),
    fileName: "unsafe.svg",
    label: "下载 SVG",
    mediaType: "image/svg+xml",
    path: "assets/unsafe.svg",
  },
  {
    body: Buffer.from('<?xml version="1.0"?><root><script>window.__activeContentExecuted = true</script></root>', "utf8"),
    fileName: "unsafe.xml",
    label: "下载 XML",
    mediaType: "application/xml",
    path: "assets/unsafe.xml",
  },
  {
    body: Buffer.from("unknown active bytes", "utf8"),
    fileName: "unsafe.bin",
    label: "下载未知附件",
    mediaType: "application/octet-stream",
    path: "assets/unsafe.bin",
  },
];

const PNG_ASSET: AssetFixture = {
  body: Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64",
  ),
  fileName: "safe.png",
  label: "预览 PNG",
  mediaType: "image/png",
  path: "assets/safe.png",
};

function buildPdf(): Buffer {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 320 180] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  const stream = "BT /F1 24 Tf 44 92 Td (Singularity PDF) Tj ET";
  objects.push(`<< /Length ${Buffer.byteLength(stream, "ascii")} >>\nstream\n${stream}\nendstream`);

  let output = "%PDF-1.4\n";
  const offsets = [0];
  for (let index = 0; index < objects.length; index += 1) {
    offsets.push(Buffer.byteLength(output, "ascii"));
    output += `${index + 1} 0 obj\n${objects[index]}\nendobj\n`;
  }
  const xrefOffset = Buffer.byteLength(output, "ascii");
  output += `xref\n0 ${objects.length + 1}\n`;
  output += "0000000000 65535 f \n";
  for (const offset of offsets.slice(1)) {
    output += `${String(offset).padStart(10, "0")} 00000 n \n`;
  }
  output += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\n`;
  output += `startxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(output, "ascii");
}

const PDF_ASSET: AssetFixture = {
  body: buildPdf(),
  fileName: "safe-preview.pdf",
  label: "安全预览 PDF",
  mediaType: "application/pdf",
  path: "assets/safe-preview.pdf",
};

function requireDesktop(testInfo: TestInfo): void {
  test.skip(
    testInfo.project.name !== "desktop",
    "P4 active-content integration exercises the full editor and canvas surface once.",
  );
}

function assetLink(asset: AssetFixture, page?: number): string {
  const pageQuery = page ? `?page=${page}` : "";
  return `<span data-type="a" data-href="${asset.path}${pageQuery}">${asset.label}</span>`;
}

function documentResponse(): object {
  const links = [
    assetLink(PDF_ASSET, 1),
    assetLink(PNG_ASSET),
    ...ACTIVE_ASSETS.map((asset) => assetLink(asset)),
  ].join(" ");
  const image = `<span contenteditable="false" data-type="img" class="img"><span> </span><span><span class="protyle-action protyle-icons"></span><img src="${PNG_ASSET.path}" data-src="${PNG_ASSET.path}" alt="OCR 样例"><span class="protyle-action__drag"></span><span class="protyle-action__title"><span></span></span></span><span> </span></span>`;
  const plantUml = `<div data-node-id="${PLANTUML_BLOCK_ID}" data-type="NodeCodeBlock" class="render-node" data-subtype="plantuml" data-content="@startuml&#10;Alice -&gt; Bob&#10;@enduml"><div spin="1"></div><div class="protyle-attr" contenteditable="false">&#8203;</div></div>`;
  return {
    code: 0,
    data: {
      blockCount: 2,
      content: `<div data-node-id="${BLOCK_ID}" data-type="NodeParagraph" class="p" updated="20260719000000"><div contenteditable="true" spellcheck="false">主动内容安全样例 ${links} ${image}</div><div class="protyle-attr" contenteditable="false">&#8203;</div></div>${plantUml}`,
      eof: false,
      id: DOCUMENT_ID,
      isBacklinkExpand: false,
      isSyncing: false,
      mode: 0,
      name: "主动内容安全样例",
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

async function installGatewayBoundary(page: Page): Promise<ActiveContentBoundary> {
  const assets = new Map(
    [PDF_ASSET, PNG_ASSET, ...ACTIVE_ASSETS].map((asset) => [asset.path, asset] as const),
  );
  const boundary: ActiveContentBoundary = {
    assetRequests: [],
    downloadUrls: [],
    ocrRequests: [],
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
          spaceName: "主动内容安全空间",
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
          name: "安全样例",
          notebookId: NOTEBOOK_ID,
          supportsGraph: true,
        }],
      });
      return;
    }
    if (path === `${GATEWAY_BASE_PATH}/content-directory/notebooks/${NOTEBOOK_ID}/documents`) {
      await fulfillJson(route, {
        documents: [{
          documentId: DOCUMENT_ID,
          hasChildren: false,
          icon: "",
          notebookId: NOTEBOOK_ID,
          title: "主动内容安全样例",
        }],
        locked: false,
        nextOffset: null,
      });
      return;
    }

    const assetPrefix = `${GATEWAY_BASE_PATH}/`;
    if (path.startsWith(`${assetPrefix}assets/`)) {
      const assetPath = path.slice(assetPrefix.length);
      const asset = assets.get(assetPath);
      if (!asset) {
        await route.abort("failed");
        return;
      }
      boundary.assetRequests.push({
        documentId: url.searchParams.get("documentId") ?? "",
        download: url.searchParams.get("download") === "true",
        notebookId: url.searchParams.get("notebookId") ?? "",
        path: assetPath,
      });
      const inline = asset.mediaType === "image/png";
      await route.fulfill({
        body: asset.body,
        headers: {
          "Cache-Control": "private, no-store",
          "Content-Type": asset.mediaType,
          "X-Content-Type-Options": "nosniff",
          ...(inline
            ? {}
            : {
                "Content-Disposition": `attachment; filename="${asset.fileName}"`,
                "Content-Security-Policy": "sandbox; default-src 'none'; base-uri 'none'; form-action 'none'",
              }),
        },
        status: 200,
      });
      return;
    }

    const kernelPrefix = `${GATEWAY_BASE_PATH}/kernel/api`;
    if (!path.startsWith(`${kernelPrefix}/api/`)) {
      await route.abort("failed");
      return;
    }
    const kernelPath = path.slice(kernelPrefix.length);
    if (kernelPath === "/api/asset/getImageOCRText") {
      const body = request.postDataJSON() as { path?: unknown };
      const headers = request.headers();
      boundary.ocrRequests.push({
        documentId: headers["x-singularity-document-id"] ?? "",
        notebookId: headers["x-singularity-notebook-id"] ?? "",
        path: typeof body.path === "string" ? body.path : "",
      });
      await fulfillJson(route, { code: 0, data: { text: "受控 OCR 文本" }, msg: "" });
      return;
    }
    if (kernelPath === "/api/filetree/getDoc") {
      await fulfillJson(route, documentResponse());
      return;
    }
    if (kernelPath === "/api/block/getDocInfo") {
      await fulfillJson(route, {
        code: 0,
        data: {
          attrViews: [],
          ial: { id: DOCUMENT_ID, title: "", updated: "20260719000000" },
          icon: "",
          id: DOCUMENT_ID,
          name: "主动内容安全样例",
          refCount: 0,
          refIDs: [],
          rootID: DOCUMENT_ID,
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
          blockId: DOCUMENT_ID,
          documentId: DOCUMENT_ID,
          name: "主动内容安全样例",
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
      await fulfillJson(route, { code: 0, data: [], msg: "" });
      return;
    }
    await route.abort("failed");
  });

  return boundary;
}

// 等待空间编辑器完成首次装载，确保后续主动内容断言运行在 ready DOM 上。
async function openWorkspace(page: Page) {
  await page.goto(`/organizations/${ORGANIZATION_ID}/spaces/${SPACE_ID}`);
  const editor = page.getByTestId("protyle-host");
  await expect(editor).toHaveAttribute("aria-busy", "false");
  await expect(editor.getByText("主动内容安全样例", { exact: false })).toBeVisible();
  return editor;
}

test.describe("active content and PDF preview", () => {
  test("keeps PlantUML inert when production has no rendering endpoint", async ({
    page,
  }, testInfo) => {
    requireDesktop(testInfo);
    const diagnostics = collectBrowserDiagnostics(page);
    const plantUmlRequests: string[] = [];
    await page.route(/plantuml/i, async (route) => {
      plantUmlRequests.push(route.request().url());
      await route.abort("blockedbyclient");
    });
    await installGatewayBoundary(page);
    const editor = await openWorkspace(page);
    const plantUml = contentBlock(editor, PLANTUML_BLOCK_ID);

    await expect(plantUml).toHaveAttribute("data-render", "true");
    await expect(plantUml.locator('[spin="1"]')).toHaveText("未启用");
    await expect(plantUml.locator("object, embed, img")).toHaveCount(0);
    expect(plantUmlRequests).toEqual([]);
    expect(await page.evaluate<unknown>(() => Reflect.get(window, "__activeContentExecuted"))).toBeUndefined();
    expectBrowserHealthy(diagnostics, MAX_REQUEST_DURATION_MS);
  });

  test("renders an authorized PDF only through PDF.js canvas", async ({ page }, testInfo) => {
    requireDesktop(testInfo);
    const diagnostics = collectBrowserDiagnostics(page);
    const boundary = await installGatewayBoundary(page);
    const editor = await openWorkspace(page);

    await editor.getByText(PDF_ASSET.label).click({ button: "right" });
    const linkMenu = page.locator('[data-protyle-menu][data-name="inline-a"]');
    await expect(linkMenu).toBeVisible();
    const openBy = linkMenu.locator(':scope > .b3-menu__items > [data-id="openBy"]');
    await openBy.hover();
    const openCurrent = openBy.locator(
      ':scope > .b3-menu__submenu > .b3-menu__items > [data-id="openBy"]',
    );
    await expect(openCurrent).toBeVisible();
    await openCurrent.click();
    const preview = page.locator("[data-asset-preview]");
    await expect(preview).toBeVisible();
    const canvas = preview.locator("[data-pdf-canvas]");
    await expect(canvas).toBeVisible();
    await expect(preview.getByText("1 / 1")).toBeVisible();
    await expect.poll(() => canvas.evaluate((element: HTMLCanvasElement) => {
      if (element.width === 0 || element.height === 0) {
        return false;
      }
      const context = element.getContext("2d");
      if (!context) {
        return false;
      }
      const pixels = context.getImageData(0, 0, element.width, element.height).data;
      for (let index = 0; index < pixels.length; index += 4) {
        if (
          pixels[index + 3]! > 0 &&
          (pixels[index]! < 245 || pixels[index + 1]! < 245 || pixels[index + 2]! < 245)
        ) {
          return true;
        }
      }
      return false;
    })).toBe(true);
    await expect(preview.locator("iframe, object, embed")).toHaveCount(0);
    expect(boundary.assetRequests).toContainEqual({
      documentId: DOCUMENT_ID,
      download: false,
      notebookId: NOTEBOOK_ID,
      path: PDF_ASSET.path,
    });

    await page.getByRole("button", { name: "关闭" }).click();
    expectBrowserHealthy(diagnostics, MAX_REQUEST_DURATION_MS);
  });

  test("inlines only a Gateway-approved inert image MIME", async ({ page }, testInfo) => {
    requireDesktop(testInfo);
    const diagnostics = collectBrowserDiagnostics(page);
    const boundary = await installGatewayBoundary(page);
    const editor = await openWorkspace(page);

    await editor.getByText(PNG_ASSET.label).click();
    const preview = page.locator("[data-asset-preview]");
    const image = preview.locator('[data-asset-kind="image"] img');
    await expect(image).toBeVisible();
    await expect.poll(() => image.evaluate((element: HTMLImageElement) => (
      element.complete && element.naturalWidth === 1 && element.naturalHeight === 1
    ))).toBe(true);
    expect(await image.getAttribute("src")).toMatch(/^blob:/);
    await expect(preview.locator("iframe, object, embed, script")).toHaveCount(0);
    expect(boundary.assetRequests).toContainEqual({
      documentId: DOCUMENT_ID,
      download: false,
      notebookId: NOTEBOOK_ID,
      path: PNG_ASSET.path,
    });

    await page.getByRole("button", { name: "关闭" }).click();
    expectBrowserHealthy(diagnostics, MAX_REQUEST_DURATION_MS);
  });

  test("submits the canonical persisted image path to OCR", async ({ page }, testInfo) => {
    requireDesktop(testInfo);
    const diagnostics = collectBrowserDiagnostics(page);
    const boundary = await installGatewayBoundary(page);
    const editor = await openWorkspace(page);
    const image = editor.locator(
      `[data-node-id="${BLOCK_ID}"] [data-type~="img"] img[data-src="${PNG_ASSET.path}"]`,
    );

    await expect(image).toBeVisible();
    expect(await image.getAttribute("src")).toContain(`${GATEWAY_BASE_PATH}/${PNG_ASSET.path}`);
    expect(await image.getAttribute("data-src")).toBe(PNG_ASSET.path);
    await image.click({ button: "right", force: true });
    const imageMenu = page.locator('[data-protyle-menu][data-name="inline-img"]');
    await expect(imageMenu).toBeVisible();
    const ocr = imageMenu.locator(':scope > .b3-menu__items > [data-id="ocr"]');
    await expect(ocr).toBeVisible();
    await ocr.hover();
    await expect.poll(() => boundary.ocrRequests.length).toBe(1);
    expect(boundary.ocrRequests).toContainEqual({
      documentId: DOCUMENT_ID,
      notebookId: NOTEBOOK_ID,
      path: PNG_ASSET.path,
    });

    expectBrowserHealthy(diagnostics, MAX_REQUEST_DURATION_MS);
  });

  test("downloads HTML, JavaScript, SVG, XML, and unknown bytes without executing them", async ({
    page,
  }, testInfo) => {
    requireDesktop(testInfo);
    const diagnostics = collectBrowserDiagnostics(page);
    const boundary = await installGatewayBoundary(page);
    const editor = await openWorkspace(page);

    for (const asset of ACTIVE_ASSETS) {
      const downloadPromise = page.waitForEvent("download");
      await editor.getByText(asset.label).click();
      const download = await downloadPromise;
      boundary.downloadUrls.push(download.url());
      expect(download.suggestedFilename()).toBe(asset.fileName);
      await download.path();
      const preview = page.locator("[data-asset-preview]");
      await expect(preview).toBeVisible();
      await expect(preview.locator("iframe, object, embed, script")).toHaveCount(0);
      expect(await page.evaluate<unknown>(() => Reflect.get(window, "__activeContentExecuted"))).toBeUndefined();
      await page.getByRole("button", { name: "关闭" }).click();
      await expect(preview).toHaveCount(0);
    }

    for (const asset of ACTIVE_ASSETS) {
      expect(boundary.assetRequests).toContainEqual({
        documentId: DOCUMENT_ID,
        download: false,
        notebookId: NOTEBOOK_ID,
        path: asset.path,
      });
    }
    expect(boundary.downloadUrls.map((downloadUrl) => {
      const url = new URL(downloadUrl);
      return {
        documentId: url.searchParams.get("documentId"),
        download: url.searchParams.get("download") === "true",
        notebookId: url.searchParams.get("notebookId"),
        path: url.pathname.slice(`${GATEWAY_BASE_PATH}/`.length),
      };
    })).toEqual(ACTIVE_ASSETS.map((asset) => ({
      documentId: DOCUMENT_ID,
      download: true,
      notebookId: NOTEBOOK_ID,
      path: asset.path,
    })));
    await expect.poll(() => diagnostics.pendingRequests.size).toBe(0);
    expectBrowserHealthy(diagnostics, MAX_REQUEST_DURATION_MS, {
      // 浏览器把已交给下载管理器的附件请求标记为 ERR_ABORTED，不代表 Gateway 失败。
      unexpectedRequestFailures: diagnostics.requestFailures.filter((request) => {
        const url = new URL(request.url());
        const isActiveAsset = ACTIVE_ASSETS.some((asset) => url.pathname.endsWith(`/${asset.path}`));
        const isCancelledTreeStat = url.pathname.endsWith("/kernel/api/api/block/getTreeStat");
        const isExpectedAbort = request.failure()?.errorText === "net::ERR_ABORTED" &&
          (isCancelledTreeStat || (
            isActiveAsset &&
            url.searchParams.get("documentId") === DOCUMENT_ID &&
            url.searchParams.get("notebookId") === NOTEBOOK_ID
          ));
        return !isExpectedAbort;
      }),
    });
  });
});
