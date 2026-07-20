import { expect, test } from "@playwright/test";

import {
  collectBrowserDiagnostics,
  expectBrowserHealthy,
} from "../browser-integration/support/diagnostics.ts";
import { openSpaceEditor } from "./support/session.ts";
import { readP5E2EStackState } from "./support/stack-state.ts";

const maximumRequestDurationMilliseconds = 10_000;

test("searches the real space index and navigates to the matching document", async ({
  page,
}) => {
  const state = readP5E2EStackState();
  const diagnostics = collectBrowserDiagnostics(page);
  const editor = await openSpaceEditor(page, state);

  await page.getByRole("button", { name: "搜索当前空间" }).click();
  const searchPanel = page.locator('[data-discovery-kind="space-search"]');
  await expect(searchPanel).toBeVisible();
  await searchPanel.getByRole("searchbox").fill(state.searchMarker);
  await searchPanel.getByRole("button", { name: "执行搜索" }).click();
  const result = searchPanel.getByRole("button").filter({
    hasText: state.searchMarker,
  });
  await expect(result).toBeVisible({ timeout: 30_000 });
  await result.click();
  await expect(editor).toContainText(state.searchMarker, { timeout: 30_000 });

  await expect.poll(() => diagnostics.pendingRequests.size).toBe(0);
  expectBrowserHealthy(diagnostics, maximumRequestDurationMilliseconds, {
    unexpectedRequestFailures: diagnostics.requestFailures.filter((request) =>
      request.failure()?.errorText !== "net::ERR_ABORTED" ||
      !(
        new URL(request.url()).pathname.endsWith("/kernel/api/filetree/getDoc") ||
        new URL(request.url()).pathname.endsWith("/kernel/api/block/getBlockBreadcrumb")
      ),
    ),
  });
});

test("shows a real Kernel backlink for the selected document", async ({
  page,
}) => {
  const state = readP5E2EStackState();
  const diagnostics = collectBrowserDiagnostics(page);
  const editor = await openSpaceEditor(page, state);

  await editor.locator(".protyle-title__icon").click();
  await page.locator('[data-protyle-menu] [data-id="backlinks"]').click();
  const backlinksPanel = page.locator('[data-discovery-kind="backlinks"]');
  const reference = backlinksPanel.getByRole("button", {
    exact: true,
    name: state.referenceDocumentTitle,
  });
  await expect(reference).toBeVisible({ timeout: 30_000 });
  const referenceDocumentRequest = page.waitForRequest((request) =>
    new URL(request.url()).pathname.endsWith("/kernel/api/filetree/getDoc") &&
    request.headers()["x-singularity-document-id"] === state.referenceDocumentId &&
    request.headers()["x-singularity-notebook-id"] === state.notebookId
  );
  await reference.click();
  await referenceDocumentRequest;
  await expect(editor.locator(".protyle-title__input")).toHaveText(
    state.referenceDocumentTitle,
    { timeout: 30_000 },
  );
  await expect(editor).toContainText("P5 引用");

  await expect.poll(() => diagnostics.pendingRequests.size).toBe(0);
  expectBrowserHealthy(diagnostics, maximumRequestDurationMilliseconds, {
    unexpectedRequestFailures: diagnostics.requestFailures.filter((request) =>
      request.failure()?.errorText !== "net::ERR_ABORTED" ||
      !(
        new URL(request.url()).pathname.endsWith("/kernel/api/filetree/getDoc") ||
        new URL(request.url()).pathname.endsWith("/kernel/api/block/getBlockBreadcrumb")
      ),
    ),
  });
});
