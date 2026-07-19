import { expect, test, type Request } from "@playwright/test";

import {
  collectBrowserDiagnostics,
  expectBrowserHealthy,
} from "../browser-integration/support/diagnostics.ts";
import { openSpaceEditor } from "./support/session.ts";
import { readP5E2EStackState } from "./support/stack-state.ts";

const maximumRequestDurationMilliseconds = 10_000;

function kernelPath(request: Request): string {
  return new URL(request.url()).pathname;
}

test("persists an editor transaction through React, Nest, PostgreSQL routing, and Go Kernel", async ({
  page,
}) => {
  const state = readP5E2EStackState();
  const diagnostics = collectBrowserDiagnostics(page);
  const getDocumentRequests: Request[] = [];
  const transactionRequests: Request[] = [];
  page.on("request", (request) => {
    const path = kernelPath(request);
    if (path.endsWith("/kernel/api/filetree/getDoc")) {
      getDocumentRequests.push(request);
    }
    if (path.endsWith("/kernel/api/transactions")) {
      transactionRequests.push(request);
    }
  });

  const editor = await openSpaceEditor(page, state);
  await expect(editor).toContainText(state.documentInitialText);
  await expect.poll(() => getDocumentRequests.length).toBeGreaterThan(0);
  const initialRequest = getDocumentRequests[0]!;
  expect(initialRequest.headers()["x-singularity-notebook-id"]).toBe(
    state.notebookId,
  );
  expect(initialRequest.headers()["x-singularity-document-id"]).toBe(
    state.documentId,
  );

  const persistedText = "P5 persisted content from the real transaction";
  const editableParagraph = editor.locator(
    '[data-type="NodeParagraph"] [contenteditable="true"]',
  ).first();
  await expect(editableParagraph).toContainText(state.documentInitialText);
  const transactionResponse = page.waitForResponse((response) =>
    response.request().method() === "POST" &&
    new URL(response.url()).pathname.endsWith("/kernel/api/transactions") &&
    response.ok(),
  );
  await editableParagraph.fill(persistedText);
  await transactionResponse;
  await expect.poll(() => transactionRequests.length).toBeGreaterThan(0);
  const committedRequest = transactionRequests.at(-1)!;
  expect(committedRequest.headers()["x-singularity-notebook-id"]).toBe(
    state.notebookId,
  );
  expect(committedRequest.headers()["x-singularity-document-id"]).toBe(
    state.documentId,
  );
  expect(committedRequest.postData()).toContain(persistedText);

  await page.reload();
  const reloadedEditor = page.getByTestId("protyle-host");
  await expect(reloadedEditor).toContainText(persistedText, { timeout: 30_000 });
  await expect.poll(() => diagnostics.pendingRequests.size).toBe(0);
  expectBrowserHealthy(diagnostics, maximumRequestDurationMilliseconds);
});
