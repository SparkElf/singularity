import { expect, test } from "@playwright/test";

test.describe("L3 realtime collaboration prototype", () => {
  test("keeps four-part identity visible and synchronizes a confirmed operation", async ({ browser, baseURL }) => {
    const context = await browser.newContext();
    const first = await context.newPage();
    const second = await context.newPage();
    const errors: string[] = [];
    const failedRequests: string[] = [];
    first.on("pageerror", (error) => errors.push(error.message));
    second.on("pageerror", (error) => errors.push(error.message));
    first.on("requestfailed", (request) => failedRequests.push(request.url()));
    second.on("requestfailed", (request) => failedRequests.push(request.url()));
    await first.goto(`${baseURL}/l3-prototype.html`);
    await second.goto(`${baseURL}/l3-prototype.html`);
    await expect(first.getByTestId("organization-id")).toHaveText("11111111-1111-4111-8111-111111111111");
    await expect(first.getByTestId("space-id")).toHaveText("22222222-2222-4222-8222-222222222222");
    await expect(first.getByTestId("notebook-id")).toHaveText("20260722090001-bookabc");
    await expect(first.getByTestId("document-id")).toHaveText("20260722090000-docabcd");
    await first.bringToFront();
    await first.getByTestId("submit-operation").click({ force: true });
    await expect(first.getByTestId("document-block")).toHaveAttribute("data-confirmed", "true");
    await expect(second.getByTestId("presence-remote")).toHaveText("已同步操作");
    await expect(second.getByTestId("document-content")).toContainText("已确认：客户端");
    await expect(first.getByTestId("reference-state")).toHaveText("已确认 · target block");
    await expect(first.getByTestId("embed-state")).toHaveText("已确认 · transclusion");
    await expect(first.getByTestId("av-cell-state")).toHaveText("已确认 · cell value");
    await first.getByTestId("undo-operation").click({ force: true });
    await expect(first.getByTestId("operation-status")).toHaveText("已撤销当前客户端操作");
    await expect(first.getByTestId("undo-operation")).toBeDisabled();
    expect(errors).toEqual([]);
    expect(failedRequests).toEqual([]);
    await first.close();
    await second.close();
    await context.close();
  });

  test("stops accepting operations after permission revoke and remains usable at 320px", async ({ page }) => {
    await page.goto("/l3-prototype.html");
    await expect(page.getByTestId("session-state")).toHaveAttribute("data-state", "ready");
    await page.bringToFront();
    await page.getByTestId("revoke-session").click({ force: true });
    await expect(page.getByTestId("session-state")).toHaveAttribute("data-state", "revoked");
    await expect(page.getByTestId("submit-operation")).toBeDisabled();
    await expect(page.getByTestId("operation-status")).toHaveText("权限已撤销，停止接受新操作");
  });
});
