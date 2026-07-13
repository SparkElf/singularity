import { expect } from "@playwright/test";

import { expectHealthyBrowser, test } from "./fixtures/app.fixture.ts";
import { WorkspacePage } from "./pages/workspace.page.ts";

test("workspace shell renders and its primary controls respond", async ({ page, diagnostics }, testInfo) => {
  const workspace = new WorkspacePage(page);

  await workspace.open();
  await workspace.expectDesignSystem();
  await workspace.toggleSidebar(testInfo.project.name === "mobile");
  await expect(page.locator("#root")).not.toBeEmpty();
  expectHealthyBrowser(diagnostics);
});
