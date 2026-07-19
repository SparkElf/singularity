import {
  createdDocumentShareSchema,
  shareTokenSchema,
  sharedDocumentPayloadSchema,
} from "@singularity/contracts";
import { expect, test, type BrowserContext } from "@playwright/test";

import {
  collectBrowserDiagnostics,
  expectBrowserHealthy,
  type BrowserDiagnostics,
} from "../browser-integration/support/diagnostics.ts";
import { openSpaceEditor, sessionRequest } from "./support/session.ts";
import { readP5E2EStackState } from "./support/stack-state.ts";

const maximumRequestDurationMilliseconds = 10_000;

test("creates, reads, and immediately revokes a real read-only share", async ({
  browser,
  page,
}) => {
  const state = readP5E2EStackState();
  const adminDiagnostics = collectBrowserDiagnostics(page);
  const editor = await openSpaceEditor(page, state);
  const currentDocumentText = (
    await editor
      .locator('[data-type="NodeParagraph"] [contenteditable="true"]')
      .first()
      .innerText()
  ).trim();
  expect(currentDocumentText.length).toBeGreaterThan(0);

  const sharesPath =
    `/organizations/${state.organizationId}/settings/spaces/${state.spaceId}/shares`;
  const managedSharesApiPath =
    `/api/v1/organizations/${state.organizationId}` +
    `/spaces/${state.spaceId}/shares`;
  await page.goto(sharesPath);
  await expect(page.getByRole("heading", { name: "分享" })).toBeVisible();

  const directory = page.getByRole("navigation", { name: "文档目录" });
  const documentButton = directory.getByRole("button", {
    name: state.documentTitle,
  });
  await expect(documentButton).toBeVisible({ timeout: 30_000 });
  await documentButton.click();
  await expect(page.getByText(state.documentId)).toBeVisible();

  let createdShareId: string | null = null;
  let publicContext: BrowserContext | null = null;
  let publicDiagnostics!: BrowserDiagnostics;
  let shareApiUrl = "";
  let shareRevoked = false;

  try {
    const createdResponse = page.waitForResponse((response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname === managedSharesApiPath &&
      response.status() === 201,
    );
    await page.getByRole("button", { name: "创建分享" }).click();
    const createdShare = createdDocumentShareSchema.parse(
      await (await createdResponse).json(),
    );
    createdShareId = createdShare.shareId;

    const createdAlert = page
      .getByRole("alert")
      .filter({ hasText: "分享已创建" });
    await expect(createdAlert).toBeVisible();
    const shareAddress = (await createdAlert.locator("code").innerText()).trim();
    const shareUrl = new URL(shareAddress);
    const shareToken = shareTokenSchema.parse(
      shareUrl.pathname.split("/").at(-1),
    );
    shareApiUrl = new URL(`/api/v1/shares/${shareToken}`, state.webOrigin).href;

    expect(shareToken).toBe(createdShare.shareToken);
    expect(shareUrl.origin).toBe(new URL(state.webOrigin).origin);
    expect(shareUrl.pathname).toMatch(/^\/shares\/[A-Za-z0-9_-]{43}$/);
    expect(shareUrl.search).toBe("");
    expect(shareUrl.hash).toBe("");
    expect(shareAddress).not.toContain(state.organizationId);
    expect(shareAddress).not.toContain(state.spaceId);
    expect(shareAddress).not.toContain(state.notebookId);
    expect(shareAddress).not.toContain(state.documentId);
    expect(shareUrl.origin).not.toBe(new URL(state.apiOrigin).origin);

    publicContext = await browser.newContext({
      baseURL: state.webOrigin,
      ignoreHTTPSErrors: true,
    });
    const publicPage = await publicContext.newPage();
    publicDiagnostics = collectBrowserDiagnostics(publicPage);
    const initialShareResponse = publicPage.waitForResponse((response) =>
      response.request().method() === "GET" &&
      response.url() === shareApiUrl &&
      response.status() === 200,
    );
    await publicPage.goto(shareUrl.toString());
    const publicPayload = sharedDocumentPayloadSchema.parse(
      await (await initialShareResponse).json(),
    );
    expect(publicPayload).not.toHaveProperty("documentId");
    const serializedPublicPayload = JSON.stringify(publicPayload);
    const privateValues = [
      state.organizationId,
      state.spaceId,
      state.notebookId,
      state.documentId,
      state.apiOrigin,
      `127.0.0.1:${String(state.kernelPort)}`,
    ];
    for (const internalValue of privateValues) {
      expect(serializedPublicPayload).not.toContain(internalValue);
    }
    await expect(
      publicPage.getByRole("heading", { name: state.documentTitle }),
    ).toBeVisible();
    await expect(publicPage.getByText("只读", { exact: true })).toBeVisible();

    const article = publicPage.locator("article");
    await expect(article).toContainText(currentDocumentText);
    await expect(article.locator("[contenteditable='true'], input, textarea, button")).toHaveCount(0);
    await expect(
      article.locator("[data-node-id], [data-document-id], [data-notebook-id]"),
    ).toHaveCount(0);
    const articleHtml = await article.evaluate((element) => element.outerHTML);
    for (const internalValue of privateValues) {
      expect(articleHtml).not.toContain(internalValue);
    }
    for (const request of publicDiagnostics.requests) {
      expect(new URL(request.url()).origin).toBe(new URL(state.webOrigin).origin);
    }

    const shareRow = page.getByRole("row").filter({ hasText: state.documentId });
    await expect(shareRow).toContainText("有效");
    await shareRow
      .getByRole("button", {
        name: `撤销文档 ${state.documentId} 的分享`,
      })
      .click();
    const confirmation = page.getByRole("alertdialog");
    await expect(confirmation).toBeVisible();
    const revokeApiPath = `${managedSharesApiPath}/${createdShareId}`;
    const revokedAdminResponse = page.waitForResponse((response) =>
      response.request().method() === "DELETE" &&
      new URL(response.url()).pathname === revokeApiPath &&
      response.status() === 204,
    );
    await confirmation.getByRole("button", { name: "撤销分享", exact: true }).click();
    await revokedAdminResponse;
    shareRevoked = true;
    await expect(shareRow).toContainText("已撤销");

    const revokedResponse = publicPage.waitForResponse((response) =>
      response.request().method() === "GET" &&
      response.url() === shareApiUrl &&
      response.status() === 404,
    );
    await publicPage.reload();
    await revokedResponse;
    await expect(
      publicPage.getByRole("heading", { name: "分享不存在或已失效" }),
    ).toBeVisible();
  } finally {
    try {
      await publicContext?.close();
    } finally {
      if (createdShareId !== null && !shareRevoked) {
        const cleanupResult = await sessionRequest(
          page,
          `${managedSharesApiPath}/${createdShareId}`,
          { method: "DELETE" },
        );
        expect([204, 404]).toContain(cleanupResult.status);
      }
    }
  }

  await expect.poll(() => adminDiagnostics.pendingRequests.size).toBe(0);
  await expect.poll(() => publicDiagnostics.pendingRequests.size).toBe(0);
  const expectedRevocationResponses = publicDiagnostics.responses.filter(
    (response) =>
      response.status() === 404 &&
      response.url() === shareApiUrl,
  );
  expect(expectedRevocationResponses).toHaveLength(1);
  const expectedRevocationConsoleMessages =
    publicDiagnostics.consoleMessages.filter((message) =>
      message.type() === "error" &&
      message.location().url === shareApiUrl &&
      /\b404\b/.test(message.text()),
    );
  expectBrowserHealthy(adminDiagnostics, maximumRequestDurationMilliseconds);
  expectBrowserHealthy(publicDiagnostics, maximumRequestDurationMilliseconds, {
    unexpectedConsoleMessages: publicDiagnostics.consoleMessages.filter(
      (message) => !expectedRevocationConsoleMessages.includes(message),
    ),
    unexpectedErrorResponses: publicDiagnostics.responses.filter(
      (response) => !expectedRevocationResponses.includes(response) && response.status() >= 400,
    ),
  });
});
