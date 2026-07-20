import { randomUUID } from "node:crypto";

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
  await expect.poll(() => getDocumentRequests.length).toBeGreaterThan(0);
  const initialRequest = getDocumentRequests[0]!;
  expect(initialRequest.headers()["x-singularity-notebook-id"]).toBe(
    state.notebookId,
  );
  expect(initialRequest.headers()["x-singularity-document-id"]).toBe(
    state.documentId,
  );

  const editableParagraph = editor.locator(
    '[data-type="NodeParagraph"] [contenteditable="true"]',
  ).first();
  const currentText = (await editableParagraph.innerText()).trim();
  expect(currentText.length).toBeGreaterThan(0);
  const persistedMarker = `P5 content transaction ${randomUUID()}`;
  const persistedText = `${currentText} ${persistedMarker}`;
  const transactionResponse = page.waitForResponse((response) =>
    response.request().method() === "POST" &&
    new URL(response.url()).pathname.endsWith("/kernel/api/transactions") &&
    response.ok(),
  );
  await editableParagraph.fill(persistedText);
  const committedResponse = await transactionResponse;
  const auditRequestId = committedResponse.headers()["x-request-id"];
  if (auditRequestId === undefined) {
    throw new Error("Committed content response omitted its request identity");
  }
  expect(auditRequestId).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
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
  await expect(reloadedEditor).toContainText(persistedMarker, { timeout: 30_000 });

  await page.goto(
    `/organizations/${state.organizationId}/settings/spaces/${state.spaceId}/audit`,
  );
  const refreshAudit = page.getByRole("button", {
    name: "刷新审计事件",
  });
  const requestMarker = page.getByTitle(auditRequestId, { exact: true });
  await expect.poll(
    async () => {
      await expect(refreshAudit).toBeEnabled();
      const count = await requestMarker.count();
      if (count > 0) {
        return count;
      }
      const refreshed = page.waitForResponse((response) =>
        response.ok() &&
        new URL(response.url()).pathname.endsWith(
          `/spaces/${state.spaceId}/audit-events`,
        ),
      );
      await refreshAudit.click();
      await refreshed;
      await expect(refreshAudit).toBeEnabled();
      return requestMarker.count();
    },
    { timeout: 30_000 },
  ).toBe(1);
  const auditRow = requestMarker.locator("xpath=ancestor::tr");
  await expect(auditRow).toContainText("编辑内容");
  await expect(auditRow).toContainText(state.documentId);
  await expect(auditRow).toContainText("成功");
  await expect.poll(() => diagnostics.pendingRequests.size).toBe(0);
  expectBrowserHealthy(diagnostics, maximumRequestDurationMilliseconds);
});
