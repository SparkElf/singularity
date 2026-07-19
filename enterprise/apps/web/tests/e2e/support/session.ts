import { expect, type Locator, type Page } from "@playwright/test";

import type { P5E2EStackState } from "./stack-state.ts";

export async function loginAs(
  page: Page,
  credentials: P5E2EStackState["editor"] | P5E2EStackState["viewer"],
): Promise<void> {
  await page.goto("/login");
  await page.getByLabel("账号").fill(credentials.loginIdentifier);
  await page.getByLabel("密码").fill(credentials.password);
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await expect(page).not.toHaveURL(/\/login(?:\?|$)/, { timeout: 20_000 });
}

export async function openSpaceEditor(
  page: Page,
  state: P5E2EStackState,
  credentials: P5E2EStackState["editor"] | P5E2EStackState["viewer"] = state.editor,
): Promise<Locator> {
  await loginAs(page, credentials);
  const spaceLink = page.getByRole("link").filter({ hasText: state.spaceName }).first();
  const targetUrl = new RegExp(
    `/organizations/${state.organizationId}/spaces/${state.spaceId}$`,
  );
  const spaceSelectionRequired = await Promise.any([
    page.waitForURL(targetUrl, { timeout: 20_000 }).then(() => false),
    spaceLink.waitFor({ state: "visible", timeout: 20_000 }).then(() => true),
  ]);
  if (spaceSelectionRequired) {
    await spaceLink.click();
  }
  await expect(page).toHaveURL(targetUrl, { timeout: 20_000 });
  const editor = page.getByTestId("protyle-host");
  await expect(editor).toBeVisible({ timeout: 30_000 });
  await expect(editor.locator(".protyle-wysiwyg")).toBeVisible({ timeout: 30_000 });
  return editor;
}
