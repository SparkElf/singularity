import { expect, test } from "@playwright/test";

import {
  collectBrowserDiagnostics,
  expectBrowserHealthy,
} from "../browser-integration/support/diagnostics.ts";
import {
  loginAs,
  openSpaceEditor,
  sessionRequest,
} from "./support/session.ts";
import { readP5E2EStackState } from "./support/stack-state.ts";

const maximumRequestDurationMilliseconds = 10_000;

test("viewer receives the real editor DOM but cannot submit a transaction", async ({
  page,
}) => {
  const state = readP5E2EStackState();
  const diagnostics = collectBrowserDiagnostics(page);
  let transactionRequests = 0;
  page.on("request", (request) => {
    if (new URL(request.url()).pathname.endsWith("/kernel/api/transactions")) {
      transactionRequests += 1;
    }
  });

  const editor = await openSpaceEditor(page, state, state.viewer);
  const wysiwyg = editor.locator(".protyle-wysiwyg");
  await expect(wysiwyg).toHaveAttribute("data-readonly", "true");
  await expect(wysiwyg).toHaveAttribute("contenteditable", "false");
  const paragraph = editor.locator('[data-type="NodeParagraph"] [spellcheck]').first();
  await expect(paragraph).toHaveAttribute("contenteditable", "false");
  await paragraph.click();
  await page.keyboard.type(" viewer write must be rejected");
  await expect(paragraph).not.toContainText("viewer write must be rejected");
  expect(transactionRequests).toBe(0);
  await expect.poll(() => diagnostics.pendingRequests.size).toBe(0);
  expectBrowserHealthy(diagnostics, maximumRequestDurationMilliseconds);
});

test("viewer direct HTTP writes are rejected by the real Gateway authorization", async ({
  page,
}) => {
  const state = readP5E2EStackState();
  const diagnostics = collectBrowserDiagnostics(page);
  await openSpaceEditor(page, state, state.viewer);
  const transactionPath =
    `/api/v1/organizations/${state.organizationId}` +
    `/spaces/${state.spaceId}/kernel/api/transactions`;
  const response = await sessionRequest(page, transactionPath, {
    body: { transactions: [] },
    headers: {
      "X-Singularity-Document-Id": state.documentId,
      "X-Singularity-Notebook-Id": state.notebookId,
    },
    method: "POST",
  });

  expect(response.status).toBe(403);
  expect(response.body).toMatchObject({ code: "forbidden", status: 403 });
  await expect.poll(() => diagnostics.pendingRequests.size).toBe(0);
  const expectedTransactionUrl = new URL(transactionPath, state.webOrigin).href;
  expectBrowserHealthy(diagnostics, maximumRequestDurationMilliseconds, {
    unexpectedConsoleMessages: diagnostics.consoleMessages.filter((message) =>
      !(
        message.type() === "error" &&
        message.location().url === expectedTransactionUrl &&
        /\b403\b/.test(message.text())
      ),
    ),
    unexpectedErrorResponses: diagnostics.responses.filter((item) =>
      item.status() >= 400 && item.url() !== expectedTransactionUrl,
    ),
  });
});

test("revoking a live viewer closes its Kernel connection and clears the editor", async ({
  browser,
  page,
}) => {
  const state = readP5E2EStackState();
  const diagnostics = collectBrowserDiagnostics(page);
  const socketPromise = page.waitForEvent("websocket", {
    predicate: (socket) =>
      new URL(socket.url()).pathname.endsWith("/kernel/ws"),
  });
  await openSpaceEditor(page, state, state.viewer);
  const socket = await socketPromise;
  const memberPath =
    `/api/v1/organizations/${state.organizationId}` +
    `/spaces/${state.spaceId}/members/${state.viewer.userId}`;
  const adminContext = await browser.newContext({
    baseURL: state.webOrigin,
    ignoreHTTPSErrors: true,
  });
  const adminPage = await adminContext.newPage();
  let adminAuthenticated = false;

  try {
    await loginAs(adminPage, state.editor);
    adminAuthenticated = true;
    const revoked = await sessionRequest(adminPage, memberPath, {
      method: "DELETE",
    });
    expect(revoked.status).toBe(204);
    await expect.poll(() => socket.isClosed(), { timeout: 10_000 }).toBe(true);
    await expect(page.getByTestId("protyle-host")).toHaveCount(0, {
      timeout: 10_000,
    });
    await expect(page.getByRole("heading", { name: "找不到该空间" })).toBeVisible();
  } finally {
    try {
      if (adminAuthenticated) {
        const restored = await sessionRequest(adminPage, memberPath, {
          body: { role: "viewer" },
          method: "PUT",
        });
        expect(restored.status).toBe(204);
      }
    } finally {
      await adminContext.close();
    }
  }

  await expect.poll(() => diagnostics.pendingRequests.size).toBe(0);
  const currentSpaceRuntimeUrl =
    `${state.webOrigin}/api/v1/organizations/${state.organizationId}` +
    `/spaces/${state.spaceId}/runtime`;
  const accessLossWarnings = diagnostics.consoleMessages.filter((message) =>
    message.type() === "warning" &&
    message.text().startsWith("[protyle.lifecycle]") &&
    /category:\s*['\"]?forbidden\b/.test(message.text()),
  );
  expect(accessLossWarnings.length).toBeGreaterThan(0);
  expectBrowserHealthy(diagnostics, maximumRequestDurationMilliseconds, {
    unexpectedConsoleMessages: diagnostics.consoleMessages.filter(
      (message) =>
        !accessLossWarnings.includes(message) &&
        !(
          message.type() === "error" &&
          message.location().url === currentSpaceRuntimeUrl &&
          /\b404\b/.test(message.text())
        ),
    ),
    unexpectedErrorResponses: diagnostics.responses.filter((response) =>
      response.status() >= 400 &&
      !(response.status() === 404 && response.url() === currentSpaceRuntimeUrl),
    ),
  });
});

test("logout removes the authorized space from browser history", async ({ page }) => {
  const state = readP5E2EStackState();
  const diagnostics = collectBrowserDiagnostics(page);
  await openSpaceEditor(page, state);
  await page.getByRole("button", { name: "退出登录" }).click();
  await expect(page).toHaveURL(/\/login(?:\?.*)?$/);
  await expect(page.getByRole("heading", { name: "登录奇点" })).toBeVisible();

  const unauthorizedResponse = page.waitForResponse((response) =>
    response.status() === 401 && response.url().includes("/api/v1/"),
  );
  await page.goBack();
  const response = await unauthorizedResponse;
  await expect(page).toHaveURL(/\/login(?:\?.*)?$/);
  await expect(page.getByTestId("protyle-host")).toHaveCount(0);
  await expect.poll(() => diagnostics.pendingRequests.size).toBe(0);
  const expectedUnauthorizedUrl = response.url();
  expectBrowserHealthy(diagnostics, maximumRequestDurationMilliseconds, {
    unexpectedConsoleMessages: diagnostics.consoleMessages.filter((message) =>
      !(
        message.type() === "error" &&
        message.location().url === expectedUnauthorizedUrl &&
        /\b401\b/.test(message.text())
      )
    ),
    unexpectedErrorResponses: diagnostics.responses.filter(
      (response) => response.status() >= 400 && response.status() !== 401,
    ),
  });
});
