import { randomUUID } from "node:crypto";

import { spaceBackupSchema, spaceRestoreSchema } from "@singularity/contracts";
import { expect, test } from "@playwright/test";

import {
  collectBrowserDiagnostics,
  expectBrowserHealthy,
} from "../browser-integration/support/diagnostics.ts";
import { openSpaceEditor } from "./support/session.ts";
import { readP5E2EStackState } from "./support/stack-state.ts";

const maximumRequestDurationMilliseconds = 10_000;

test("restores one committed content version into an activated isolated space", async ({
  page,
}) => {
  test.setTimeout(180_000);

  const state = readP5E2EStackState();
  const diagnostics = collectBrowserDiagnostics(page);
  const marker = `P5 backup restore ${randomUUID()}`;
  const targetSpaceName = `P5 restore ${randomUUID().slice(0, 8)}`;
  const editor = await openSpaceEditor(page, state);
  const editableParagraph = editor.locator(
    '[data-type="NodeParagraph"] [contenteditable="true"]',
  ).first();
  const currentText = (await editableParagraph.innerText()).trim();
  expect(currentText.length).toBeGreaterThan(0);

  const transactionResponse = page.waitForResponse((response) =>
    response.request().method() === "POST" &&
    new URL(response.url()).pathname.endsWith("/kernel/api/transactions") &&
    response.ok(),
  );
  await editableParagraph.fill(`${currentText} ${marker}`);
  await transactionResponse;
  await page.reload();
  await expect(page.getByTestId("protyle-host")).toContainText(marker, {
    timeout: 30_000,
  });

  const backupsApiPath =
    `/api/v1/organizations/${state.organizationId}` +
    `/spaces/${state.spaceId}/backups`;
  const backupsPagePath =
    `/organizations/${state.organizationId}` +
    `/settings/spaces/${state.spaceId}/backups`;
  await page.goto(backupsPagePath);
  await expect(page.getByRole("heading", { name: "备份恢复" })).toBeVisible();

  const createdBackupResponse = page.waitForResponse((response) =>
    response.request().method() === "POST" &&
    new URL(response.url()).pathname === backupsApiPath &&
    response.status() === 201,
  );
  await page.getByRole("button", { name: "创建备份" }).click();
  const backup = spaceBackupSchema.parse(
    await (await createdBackupResponse).json(),
  );
  expect(backup).toMatchObject({
    organizationId: state.organizationId,
    sourceSpaceId: state.spaceId,
    status: "queued",
  });

  const backupRow = page.getByRole("row").filter({ hasText: backup.backupId });
  await expect(backupRow).toContainText("可恢复", { timeout: 60_000 });
  await expect(backupRow).toContainText("格式 1");

  const restoreApiPath = `${backupsApiPath}/${backup.backupId}/restores`;
  const createdRestoreResponse = page.waitForResponse((response) =>
    response.request().method() === "POST" &&
    new URL(response.url()).pathname === restoreApiPath &&
    response.status() === 201,
  );
  await backupRow.getByLabel("恢复空间名称").fill(targetSpaceName);
  await backupRow.getByRole("button", { name: "开始恢复" }).click();
  const restore = spaceRestoreSchema.parse(
    await (await createdRestoreResponse).json(),
  );
  expect(restore).toMatchObject({
    backupId: backup.backupId,
    organizationId: state.organizationId,
    sourceSpaceId: state.spaceId,
    status: "queued",
  });
  expect(restore.targetSpaceId).not.toBeNull();
  const targetSpaceId = restore.targetSpaceId!;

  const restoreRow = page.getByRole("row").filter({
    hasText: restore.restoreId,
  });
  await expect(restoreRow).toContainText("等待激活", { timeout: 90_000 });
  await expect(restoreRow).toContainText(targetSpaceId);

  const activationApiPath =
    `/api/v1/organizations/${state.organizationId}` +
    `/spaces/${targetSpaceId}/restores/${restore.restoreId}/activation`;
  await restoreRow.getByRole("button", { name: "激活空间" }).click();
  const confirmation = page.getByRole("alertdialog");
  await expect(confirmation).toBeVisible();
  const activatedResponse = page.waitForResponse((response) =>
    response.request().method() === "POST" &&
    new URL(response.url()).pathname === activationApiPath &&
    response.status() === 200,
  );
  await confirmation
    .getByRole("button", { name: "激活空间", exact: true })
    .click();
  const activated = spaceRestoreSchema.parse(
    await (await activatedResponse).json(),
  );
  expect(activated).toMatchObject({
    restoreId: restore.restoreId,
    status: "activated",
    targetSpaceId,
  });
  await expect(restoreRow).toContainText("已激活");

  const targetSpacePath =
    `/organizations/${state.organizationId}/spaces/${targetSpaceId}`;
  const targetDirectoryPath =
    `/api/v1/organizations/${state.organizationId}` +
    `/spaces/${targetSpaceId}/content-directory/notebooks`;
  const targetDirectoryResponse = page.waitForResponse((response) =>
    response.request().method() === "GET" &&
    new URL(response.url()).pathname === targetDirectoryPath &&
    response.status() === 200,
  );
  const targetDocumentRequest = page.waitForRequest((request) =>
    request.method() === "POST" &&
    new URL(request.url()).pathname ===
      `/api/v1/organizations/${state.organizationId}` +
        `/spaces/${targetSpaceId}/kernel/api/filetree/getDoc`,
  );
  await page.goto(targetSpacePath);
  await targetDirectoryResponse;

  const directory = page.getByRole("navigation", { name: "文档目录" });
  await expect(directory).toContainText(state.notebookName, { timeout: 30_000 });
  const restoredDocumentButton = directory.getByRole("button", {
    name: state.documentTitle,
  });
  await expect(restoredDocumentButton).toBeVisible({ timeout: 30_000 });
  await restoredDocumentButton.click();
  const restoredEditor = page.getByTestId("protyle-host");
  await expect(restoredEditor).toContainText(marker, { timeout: 30_000 });

  const restoredDocumentRequest = await targetDocumentRequest;
  expect(
    restoredDocumentRequest.headers()["x-singularity-notebook-id"],
  ).toBe(state.notebookId);
  expect(
    restoredDocumentRequest.headers()["x-singularity-document-id"],
  ).not.toBe(state.documentId);

  const sourceSpaceApiPrefix =
    `/api/v1/organizations/${state.organizationId}/spaces/${state.spaceId}`;
  const targetSpaceApiPrefix =
    `/api/v1/organizations/${state.organizationId}/spaces/${targetSpaceId}`;
  const expectedNavigationAbortPaths = new Set([
    `${sourceSpaceApiPrefix}/backups`,
    `${sourceSpaceApiPrefix}/restores`,
    `${sourceSpaceApiPrefix}/content-directory/notebooks`,
    `${sourceSpaceApiPrefix}/content-directory/notebooks/${state.notebookId}/documents`,
    `${sourceSpaceApiPrefix}/kernel/api/block/getDocInfo`,
    `${sourceSpaceApiPrefix}/kernel/api/block/getBlockBreadcrumb`,
    `${sourceSpaceApiPrefix}/kernel/api/transactions/undoState`,
    `${targetSpaceApiPrefix}/kernel/api/block/getDocInfo`,
    `${targetSpaceApiPrefix}/kernel/api/block/getBlockBreadcrumb`,
    `${targetSpaceApiPrefix}/kernel/api/transactions/undoState`,
  ]);
  const isExpectedNavigationRequest = (request: { url(): string }) =>
    expectedNavigationAbortPaths.has(new URL(request.url()).pathname);
  await expect.poll(() =>
    [...diagnostics.pendingRequests]
      .filter((request) => !isExpectedNavigationRequest(request))
      .map((request) => new URL(request.url()).pathname),
  ).toEqual([]);
  const expectedPendingRequests = [...diagnostics.pendingRequests].filter(
    isExpectedNavigationRequest,
  );
  const expectedNavigationConsoleMessages = diagnostics.consoleMessages.filter((message) => {
    const text = message.text();
    return text === "[global-undo] initialize failed: Failed to fetch" ||
      text.startsWith("[protyle.breadcrumb] render path failed TypeError: Failed to fetch") ||
      (text.startsWith("[protyle.gateway]") &&
        text.includes(`documentId: ${state.documentId}`) &&
        text.includes(`phase: request-network, spaceId: ${state.spaceId}`)) ||
      text ===
        `[protyle.lifecycle] {category: network-failure, documentId: ${state.documentId}, ` +
        `phase: transport, spaceId: ${state.spaceId}}`;
  });
  expectBrowserHealthy(diagnostics, maximumRequestDurationMilliseconds, {
    unexpectedConsoleMessages: diagnostics.consoleMessages.filter((message) =>
      !expectedNavigationConsoleMessages.includes(message),
    ),
    // 页面切换会取消旧页面的轮询和编辑器读取，请求路径必须属于已知导航终态。
    unexpectedRequestFailures: diagnostics.requestFailures.filter((request) =>
      request.failure()?.errorText !== "net::ERR_ABORTED" ||
      !expectedNavigationAbortPaths.has(new URL(request.url()).pathname),
    ),
    expectedPendingRequests,
  });
});
