import { expect, test, type Page } from "@playwright/test";
import {
  DOCUMENT_ACCESS_POLICY_PATH_TEMPLATE,
  DOCUMENT_COMMENT_THREADS_PATH_TEMPLATE,
  DOCUMENT_HISTORY_DIFF_PATH_TEMPLATE,
  DOCUMENT_HISTORY_PATH_TEMPLATE,
  DOCUMENT_HISTORY_RESTORE_PATH_TEMPLATE,
  NOTIFICATION_UNREAD_COUNT_PATH,
  contentDirectoryDocumentsResponseSchema,
  documentAccessPolicySchema,
  historyDiffSchema,
  historyVersionsResponseSchema,
  type HistoryVersionsResponse,
  restoredHistoryVersionSchema,
} from "@singularity/contracts";

import {
  collectBrowserDiagnostics,
  expectBrowserHealthy,
} from "../browser-integration/support/diagnostics.ts";
import {
  openSpaceEditor,
  sessionRequest,
} from "./support/session.ts";
import { readP5E2EStackState } from "./support/stack-state.ts";

const maximumRequestDurationMilliseconds = 10_000;

function buildPath(template: string, parameters: Record<string, string>): string {
  return Object.entries(parameters).reduce(
    (path, [name, value]) => path.replace(`{${name}}`, encodeURIComponent(value)),
    template,
  );
}

async function readJson(page: Page, path: string): Promise<{
  readonly body: unknown;
  readonly status: number;
}> {
  return page.evaluate(async (requestPath) => {
    const response = await fetch(requestPath, {
      credentials: "same-origin",
      headers: { Accept: "application/json" },
    });
    return {
      body: JSON.parse(await response.text()) as unknown,
      status: response.status,
    };
  }, path);
}

test("comments, mentions, notifications, history, and ACL use one real document chain", async ({
  browser,
  page,
}) => {
  const state = readP5E2EStackState();
  const diagnostics = collectBrowserDiagnostics(page);
  const identity = {
    documentId: state.documentId,
    notebookId: state.notebookId,
    organizationId: state.organizationId,
    spaceId: state.spaceId,
  };
  const accessPath = buildPath(DOCUMENT_ACCESS_POLICY_PATH_TEMPLATE, identity);
  const historyPath = buildPath(DOCUMENT_HISTORY_PATH_TEMPLATE, identity);
  const historyRestorePath = buildPath(
    DOCUMENT_HISTORY_RESTORE_PATH_TEMPLATE,
    identity,
  );
  const commentsPath = buildPath(
    DOCUMENT_COMMENT_THREADS_PATH_TEMPLATE,
    identity,
  );
  let viewerContext: Awaited<ReturnType<typeof browser.newContext>> | undefined;
  let aclChanged = false;

  try {
    const editor = await openSpaceEditor(page, state);
    const panel = page.locator("[data-collaboration-panel]");
    await expect(panel).toBeVisible();

    const mentionCandidates = panel.getByRole("listbox", {
      name: "选择提及成员",
    });
    await expect(mentionCandidates).toBeVisible();
    await mentionCandidates.selectOption(state.viewer.userId);
    const commentBody = `P5 L2 mention ${state.searchMarker}`;
    await panel.getByPlaceholder("写下评论…").fill(commentBody);
    const commentResponse = page.waitForResponse((response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname === commentsPath &&
      response.status() === 201,
    );
    await panel.getByRole("button", { name: "发布评论" }).click();
    await commentResponse;
    await expect(panel).toContainText(commentBody);

    viewerContext = await browser.newContext({
      baseURL: state.webOrigin,
      ignoreHTTPSErrors: true,
    });
    const viewerPage = await viewerContext.newPage();
    const viewerDiagnostics = collectBrowserDiagnostics(viewerPage);
    await openSpaceEditor(viewerPage, state, state.viewer);
    const viewerPanel = viewerPage.locator("[data-collaboration-panel]");
    await viewerPanel.getByRole("tab", { name: "通知" }).click();
    await expect(viewerPanel).toContainText("mention");
    const mentionNotification = viewerPanel.locator("button").filter({
      hasText: "mention",
    }).first();
    await mentionNotification.click();
    await expect(viewerPanel.getByText("mention", { exact: true })).toBeVisible();

    const editableParagraph = editor.locator(
      '[data-type="NodeParagraph"] [contenteditable="true"]',
    ).first();
    const currentText = (await editableParagraph.innerText()).trim();
    const historyMarker = `P5 L2 history ${state.searchMarker}`;
    const transactionResponse = page.waitForResponse((response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname.endsWith("/kernel/api/transactions") &&
      response.ok(),
    );
    await editableParagraph.fill(`${currentText} ${historyMarker}`);
    await transactionResponse;
    const createHistoryPath =
      `/api/v1/organizations/${state.organizationId}` +
      `/spaces/${state.spaceId}/kernel/api/history/createDocHistory`;
    const createdHistory = await sessionRequest(page, createHistoryPath, {
      body: { id: state.documentId },
      headers: {
        "X-Singularity-Document-Id": state.documentId,
        "X-Singularity-Notebook-Id": state.notebookId,
      },
      method: "POST",
    });
    expect(createdHistory.status).toBe(200);

    let history: HistoryVersionsResponse | undefined;
    await expect.poll(async () => {
      const historyResult = await readJson(page, historyPath);
      if (historyResult.status !== 200) {
        return 0;
      }
      const currentHistory = historyVersionsResponseSchema.parse(historyResult.body);
      history = currentHistory;
      return currentHistory.versions.length;
    }, { timeout: maximumRequestDurationMilliseconds }).toBeGreaterThan(0);
    const selectedVersion = history?.versions[0];
    if (selectedVersion === undefined) {
      throw new Error("P5 L2 history did not return a version");
    }
    const diffPath = buildPath(DOCUMENT_HISTORY_DIFF_PATH_TEMPLATE, {
      ...identity,
      versionId: selectedVersion.versionId,
    });
    const diffResult = await readJson(page, diffPath);
    expect(diffResult.status).toBe(200);
    expect(historyDiffSchema.parse(diffResult.body).toVersionId).toBe(
      selectedVersion.versionId,
    );
    const restored = await sessionRequest(page, historyRestorePath, {
      body: { versionId: selectedVersion.versionId },
      method: "POST",
    });
    expect(restored.status).toBe(201);
    const restoredVersion = restoredHistoryVersionSchema.parse(restored.body);
    expect(restoredVersion.restoredVersionId).toBe(selectedVersion.versionId);
    expect(restoredVersion.versionId).not.toBe(selectedVersion.versionId);
    const directoryAfterRestore = await page.evaluate(async (path) => {
      const response = await fetch(path, {
        credentials: "same-origin",
        headers: { Accept: "application/json" },
      });
      return { body: await response.json() as unknown, status: response.status };
    }, `/api/v1/organizations/${state.organizationId}/spaces/${state.spaceId}` +
      `/content-directory/notebooks/${state.notebookId}/documents`);
    const restoredDirectory = contentDirectoryDocumentsResponseSchema.parse(
      directoryAfterRestore.body,
    );
    expect(restoredDirectory.documents).toContainEqual(expect.objectContaining({
      documentId: state.documentId,
      notebookId: state.notebookId,
      title: state.documentTitle,
    }));

    // 在权限切换主动关闭旧内容 WebSocket 前，先固定本次评论/历史链路的浏览器健康证据。
    await expect.poll(() => diagnostics.pendingRequests.size).toBe(0);
    await expect.poll(() => viewerDiagnostics.pendingRequests.size).toBe(0);
    expectBrowserHealthy(diagnostics, maximumRequestDurationMilliseconds);
    // 通知已读会取消尚未完成的 unread-count 重取；只豁免这个明确的客户端取消，不放宽其他请求失败。
    expectBrowserHealthy(viewerDiagnostics, maximumRequestDurationMilliseconds, {
      unexpectedRequestFailures: viewerDiagnostics.requestFailures.filter((request) => {
        return request.failure()?.errorText !== "net::ERR_ABORTED" ||
          new URL(request.url()).pathname !== NOTIFICATION_UNREAD_COUNT_PATH;
      }),
    });

    const seededPolicy = await sessionRequest(page, accessPath, {
      body: {
        grants: [{ kind: "user", role: "viewer", userId: state.viewer.userId }],
        mode: "restricted",
      },
      method: "PATCH",
    });
    expect(seededPolicy.status).toBe(200);
    expect(documentAccessPolicySchema.parse(seededPolicy.body).mode).toBe(
      "restricted",
    );
    aclChanged = true;
    await page.getByRole("tab", { name: "权限" }).click();
    const mode = panel.getByLabel("文档访问模式");
    await expect(mode).toHaveValue("restricted");
    const inheritResponse = page.waitForResponse((response) =>
      response.request().method() === "PATCH" &&
      new URL(response.url()).pathname === accessPath &&
      response.status() === 200,
    );
    await mode.selectOption("inherit");
    await inheritResponse;
    const restrictedResponse = page.waitForResponse((response) =>
      response.request().method() === "PATCH" &&
      new URL(response.url()).pathname === accessPath &&
      response.status() === 200,
    );
    await mode.selectOption("restricted");
    await restrictedResponse;
    await expect(mode).toHaveValue("restricted");

  } finally {
    if (aclChanged) {
      const restoredPolicy = await sessionRequest(page, accessPath, {
        body: { grants: [], mode: "inherit" },
        method: "PATCH",
      });
      expect(restoredPolicy.status).toBe(200);
      expect(documentAccessPolicySchema.parse(restoredPolicy.body)).toMatchObject({
        documentId: state.documentId,
        mode: "inherit",
        notebookId: state.notebookId,
        organizationId: state.organizationId,
        spaceId: state.spaceId,
        grants: [],
      });
    }
    await viewerContext?.close();
  }
});
