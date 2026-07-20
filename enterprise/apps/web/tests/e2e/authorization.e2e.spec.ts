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
  let uploadRequests = 0;
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (path.endsWith("/kernel/api/transactions")) {
      transactionRequests += 1;
    }
    if (path.endsWith(`/spaces/${state.spaceId}/upload`)) {
      uploadRequests += 1;
    }
  });

  const editor = await openSpaceEditor(page, state, state.viewer);
  const wysiwyg = editor.locator(".protyle-wysiwyg");
  await expect(wysiwyg).toHaveAttribute("data-readonly", "true");
  await expect(wysiwyg).toHaveAttribute("contenteditable", "false");
  const paragraph = editor.locator('[data-type="NodeParagraph"] [spellcheck]').first();
  await expect(paragraph).toHaveAttribute("contenteditable", "false");
  const initialEditorHtml = await wysiwyg.innerHTML();
  await paragraph.click();
  await page.keyboard.type(" viewer write must be rejected");
  await expect(paragraph).not.toContainText("viewer write must be rejected");
  await paragraph.evaluate((element) => {
    const text = new DataTransfer();
    text.setData("text/plain", "viewer paste must be rejected");
    element.dispatchEvent(new ClipboardEvent("paste", {
      bubbles: true,
      cancelable: true,
      clipboardData: text,
    }));

    const pastedFile = new DataTransfer();
    pastedFile.items.add(new File(["paste"], "viewer-paste.txt", {
      type: "text/plain",
    }));
    element.dispatchEvent(new ClipboardEvent("paste", {
      bubbles: true,
      cancelable: true,
      clipboardData: pastedFile,
    }));

    const droppedFile = new DataTransfer();
    droppedFile.items.add(new File(["drop"], "viewer-drop.txt", {
      type: "text/plain",
    }));
    element.dispatchEvent(new DragEvent("drop", {
      bubbles: true,
      cancelable: true,
      dataTransfer: droppedFile,
    }));
  });
  await page.evaluate(() => new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  }));
  await expect.poll(() => wysiwyg.innerHTML()).toBe(initialEditorHtml);
  expect(transactionRequests).toBe(0);
  expect(uploadRequests).toBe(0);
  await expect.poll(() => diagnostics.pendingRequests.size).toBe(0);
  expectBrowserHealthy(diagnostics, maximumRequestDurationMilliseconds);
});

test("viewer multipart uploads are rejected by the real Gateway authorization", async ({
  page,
}) => {
  const state = readP5E2EStackState();
  const diagnostics = collectBrowserDiagnostics(page);
  await openSpaceEditor(page, state, state.viewer);
  const uploadPath =
    `/api/v1/organizations/${state.organizationId}` +
    `/spaces/${state.spaceId}/upload`;
  const result = await page.evaluate(async ({
    documentId,
    notebookId,
    path,
  }) => {
    const csrfResponse = await fetch("/api/v1/auth/csrf", {
      credentials: "same-origin",
      headers: { Accept: "application/json" },
    });
    const csrf = await csrfResponse.json() as { csrfToken?: unknown };
    if (csrfResponse.status !== 200 || typeof csrf.csrfToken !== "string") {
      throw new Error("P5 E2E upload CSRF token was not returned");
    }
    const form = new FormData();
    form.append("file[]", new File(["viewer upload"], "viewer-upload.txt", {
      type: "text/plain",
    }));
    form.set("id", documentId);
    form.set("notebook", notebookId);
    const response = await fetch(path, {
      body: form,
      credentials: "same-origin",
      headers: {
        Accept: "application/json",
        "X-CSRF-Token": csrf.csrfToken,
        "X-Singularity-Document-Id": documentId,
        "X-Singularity-Notebook-Id": notebookId,
      },
      method: "POST",
    });
    return {
      body: await response.text(),
      contentType: response.headers.get("content-type"),
      status: response.status,
    };
  }, {
    documentId: state.documentId,
    notebookId: state.notebookId,
    path: uploadPath,
  });

  expect(result.status).toBe(403);
  expect(result.contentType?.split(";", 1)[0]).toBe("application/problem+json");
  expect(JSON.parse(result.body)).toMatchObject({ code: "forbidden", status: 403 });
  await expect.poll(() => diagnostics.pendingRequests.size).toBe(0);
  const expectedUploadUrl = new URL(uploadPath, state.webOrigin).href;
  expectBrowserHealthy(diagnostics, maximumRequestDurationMilliseconds, {
    unexpectedConsoleMessages: diagnostics.consoleMessages.filter((message) =>
      !(
        message.type() === "error" &&
        message.location().url === expectedUploadUrl &&
        /\b403\b/.test(message.text())
      )
    ),
    unexpectedErrorResponses: diagnostics.responses.filter((response) =>
      response.status() >= 400 && response.url() !== expectedUploadUrl
    ),
  });
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
    /category:\s*['"]?forbidden\b/.test(message.text()),
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
  const expectedUnauthorizedUrls = new Set(
    diagnostics.responses
      .filter((candidate) => candidate.status() === 401)
      .map((candidate) => candidate.url()),
  );
  expectedUnauthorizedUrls.add(expectedUnauthorizedUrl);
  const logoutWarnings = diagnostics.consoleMessages.filter((message) =>
    message.type() === "warning" &&
    message.text().startsWith("[protyle.lifecycle]") &&
    /category:\s*['"]?unauthenticated\b/.test(message.text()),
  );
  expectBrowserHealthy(diagnostics, maximumRequestDurationMilliseconds, {
    unexpectedConsoleMessages: diagnostics.consoleMessages.filter((message) =>
      !logoutWarnings.includes(message) &&
      !(
        message.type() === "error" &&
        expectedUnauthorizedUrls.has(message.location().url) &&
        /\b401\b/.test(message.text())
      )
    ),
    unexpectedErrorResponses: diagnostics.responses.filter(
      (response) => response.status() >= 400 && response.status() !== 401,
    ),
  });
});
