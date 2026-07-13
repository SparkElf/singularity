import { expect, type Page } from "@playwright/test";

export class WorkspacePage {
  constructor(private readonly page: Page) {}

  async open() {
    await this.page.goto("/workspace");
    await expect(this.page).toHaveTitle("奇点");
    await expect(this.page.getByRole("heading", { name: "选择一篇文档开始阅读" })).toBeVisible();
  }

  async expectDesignSystem() {
    const tokens = await this.page.locator(":root").evaluate((root) => {
      const styles = getComputedStyle(root);
      return {
        primary: styles.getPropertyValue("--primary").trim(),
        radius: styles.getPropertyValue("--radius").trim(),
      };
    });
    expect(tokens).toEqual({ primary: "#3575f0", radius: "6px" });

    await this.page.locator("html").evaluate((html) => html.classList.add("dark"));
    const darkBackground = await this.page.locator(":root").evaluate((root) => (
      getComputedStyle(root).getPropertyValue("--background").trim()
    ));
    expect(darkBackground).toBe("#1e1e1e");
    await this.page.locator("html").evaluate((html) => html.classList.remove("dark"));
  }

  async toggleSidebar(isMobile: boolean) {
    await this.page.getByRole("button", { name: "切换侧栏" }).click();
    if (isMobile) {
      const mobileSidebar = this.page.locator("[data-slot=sidebar][data-mobile=true]");
      await expect(mobileSidebar).toBeVisible();
      await expect(mobileSidebar).toHaveCSS("opacity", "1");
      await expect(this.page.getByRole("link", { name: "默认空间" })).toBeVisible();
      return;
    }

    const sidebar = this.page.locator("[data-slot=sidebar][data-state=collapsed]");
    await expect(sidebar).toBeVisible();
    await expect(sidebar.locator("[data-slot=sidebar-container]")).toHaveCSS("width", "40px");
  }
}
