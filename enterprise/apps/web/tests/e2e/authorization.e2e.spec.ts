import { expect, test } from "@playwright/test";

import {
  collectBrowserDiagnostics,
  expectBrowserHealthy,
} from "../browser-integration/support/diagnostics.ts";
import { openSpaceEditor } from "./support/session.ts";
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
