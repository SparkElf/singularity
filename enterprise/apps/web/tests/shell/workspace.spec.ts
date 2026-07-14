import { expect, test } from "@playwright/test";

test("workspace shell renders and its primary controls respond", async ({ page }, testInfo) => {
  const consoleMessages: string[] = [];
  const failedRequests: string[] = [];
  const failedResponses: string[] = [];

  page.on("console", (message) => {
    if (message.type() === "error" || message.type() === "warning") {
      consoleMessages.push(`${message.type()}: ${message.text()}`);
    }
  });
  page.on("requestfailed", (request) => {
    failedRequests.push(`${request.method()} ${request.url()}: ${request.failure()?.errorText ?? "unknown"}`);
  });
  page.on("response", (response) => {
    if (response.status() >= 400) {
      failedResponses.push(`${response.status()} ${response.url()}`);
    }
  });

  await page.goto("/workspace");
  await expect(page).toHaveTitle("奇点");
  await expect(page.getByRole("heading", { name: "选择一篇文档开始阅读" })).toBeVisible();

  const tokens = await page.locator(":root").evaluate((root) => {
    const styles = getComputedStyle(root);
    return {
      primary: styles.getPropertyValue("--primary").trim(),
      radius: styles.getPropertyValue("--radius").trim(),
    };
  });
  expect(tokens).toEqual({ primary: "#3575f0", radius: "6px" });

  await page.locator("html").evaluate((html) => html.classList.add("dark"));
  const darkBackground = await page.locator(":root").evaluate((root) => (
    getComputedStyle(root).getPropertyValue("--background").trim()
  ));
  expect(darkBackground).toBe("#1e1e1e");
  await page.locator("html").evaluate((html) => html.classList.remove("dark"));

  await page.getByRole("button", { name: "切换侧栏" }).click();
  if (testInfo.project.name === "mobile") {
    const mobileSidebar = page.locator("[data-slot=sidebar][data-mobile=true]");
    await expect(mobileSidebar).toBeVisible();
    await expect(mobileSidebar).toHaveCSS("opacity", "1");
    await expect(page.getByRole("link", { name: "默认空间" })).toBeVisible();
  } else {
    const sidebar = page.locator("[data-slot=sidebar][data-state=collapsed]");
    await expect(sidebar).toBeVisible();
    await expect(sidebar.locator("[data-slot=sidebar-container]")).toHaveCSS("width", "40px");
  }

  await expect(page.locator("#root")).not.toBeEmpty();
  expect(consoleMessages).toEqual([]);
  expect(failedRequests).toEqual([]);
  expect(failedResponses).toEqual([]);
});
