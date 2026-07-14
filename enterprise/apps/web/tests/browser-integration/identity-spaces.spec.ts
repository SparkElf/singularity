import { expect, test, type Page } from "@playwright/test";

import {
  collectBrowserDiagnostics,
  expectBrowserHealthy,
} from "./support/diagnostics.ts";
import { fulfillJson } from "./support/http.ts";

const ORGANIZATION_A = "11111111-1111-4111-8111-111111111111";
const ORGANIZATION_B = "22222222-2222-4222-8222-222222222222";
const SPACE_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SPACE_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const CSRF_TOKEN = "A".repeat(43);

const LONG_ORGANIZATION_NAME =
  "银河系企业知识与工程协作研究中心超长组织名称用于验证最窄布局";
const LONG_SPACE_NAME =
  "深空基础设施设计决策与运行手册超长知识空间名称用于验证最窄布局";

const spaces = [
  {
    organizationId: ORGANIZATION_A,
    organizationName: LONG_ORGANIZATION_NAME,
    spaceId: SPACE_A,
    spaceName: LONG_SPACE_NAME,
    role: "viewer",
  },
  {
    organizationId: ORGANIZATION_B,
    organizationName: "奇点工程中心",
    spaceId: SPACE_B,
    spaceName: "星际工程手册",
    role: "editor",
  },
] as const;

async function installIdentityRoutes(
  page: Page,
  authorizedSpaces: readonly (typeof spaces)[number][] = spaces,
) {
  await page.route("**/api/v1/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;

    if (path === "/api/v1/auth/login") {
      expect(request.method()).toBe("POST");
      expect(request.postDataJSON()).toEqual({
        loginIdentifier: "owner@example.com",
        password: "correct horse battery staple",
      });
      await fulfillJson(route, { csrfToken: CSRF_TOKEN });
      return;
    }

    if (path === "/api/v1/spaces") {
      await fulfillJson(route, { spaces: authorizedSpaces });
      return;
    }

    await route.abort("failed");
  });
}

function parseRgb(color: string): [number, number, number] {
  const channels = color.match(/[\d.]+/g)?.slice(0, 3).map(Number);
  if (!channels || channels.length !== 3) {
    throw new Error(`Unsupported color: ${color}`);
  }
  return [channels[0]!, channels[1]!, channels[2]!];
}

function relativeLuminance([red, green, blue]: [number, number, number]): number {
  const linear = [red, green, blue].map((channel) => {
    const value = channel / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * linear[0]! + 0.7152 * linear[1]! + 0.0722 * linear[2]!;
}

function contrastRatio(foreground: string, background: string): number {
  const first = relativeLuminance(parseRgb(foreground));
  const second = relativeLuminance(parseRgb(background));
  const light = Math.max(first, second);
  const dark = Math.min(first, second);
  return (light + 0.05) / (dark + 0.05);
}

test("keyboard login reaches only the authorized responsive space list", async ({
  page,
}, testInfo) => {
  const diagnostics = collectBrowserDiagnostics(page);
  await installIdentityRoutes(page);
  await page.goto("/login");
  await expect(page).toHaveTitle("奇点");

  const identifier = page.getByLabel("账号");
  const password = page.getByLabel("密码");
  const submit = page.getByRole("button", { name: "登录" });

  await page.keyboard.press("Tab");
  await expect(identifier).toBeFocused();
  await expect(identifier).not.toHaveCSS("box-shadow", "none");
  await identifier.fill(" Owner@Example.COM ");
  await page.keyboard.press("Tab");
  await expect(password).toBeFocused();
  await expect(password).not.toHaveCSS("box-shadow", "none");
  await password.fill("correct horse battery staple");
  await page.keyboard.press("Tab");
  await expect(submit).toBeFocused();
  await expect(submit).not.toHaveCSS("box-shadow", "none");
  await page.keyboard.press("Enter");

  await expect(page.getByRole("heading", { name: "选择知识空间" })).toBeVisible();
  await expect(page.getByRole("link", { name: new RegExp(LONG_SPACE_NAME) })).toBeVisible();
  await expect(page.getByRole("link", { name: /星际工程手册/ })).toBeVisible();

  const longSpaceText = page.getByTitle(LONG_SPACE_NAME);
  const longOrganizationText = page.getByTitle(LONG_ORGANIZATION_NAME);
  const viewerRole = page.getByText("阅读者", { exact: true });
  const [spaceBox, organizationBox, roleBox] = await Promise.all([
    longSpaceText.boundingBox(),
    longOrganizationText.boundingBox(),
    viewerRole.boundingBox(),
  ]);
  expect(spaceBox).not.toBeNull();
  expect(organizationBox).not.toBeNull();
  expect(roleBox).not.toBeNull();
  expect(spaceBox!.x + spaceBox!.width).toBeLessThanOrEqual(roleBox!.x);
  expect(organizationBox!.x + organizationBox!.width).toBeLessThanOrEqual(
    roleBox!.x,
  );

  const search = page.getByLabel("搜索空间");
  await search.fill("工程中心");
  await expect(page.getByRole("link", { name: /星际工程手册/ })).toBeVisible();
  await expect(page.getByRole("link", { name: new RegExp(LONG_SPACE_NAME) })).toBeHidden();
  await search.fill("");

  const expectedViewportWidths: Record<string, number> = {
    desktop: 1440,
    mobile: 390,
    "narrow-320": 320,
  };
  expect(page.viewportSize()?.width).toBe(
    expectedViewportWidths[testInfo.project.name],
  );
  const layout = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  expect(layout.scrollWidth).toBeLessThanOrEqual(layout.clientWidth);

  const pageBackground = await page.evaluate(
    () => getComputedStyle(document.body).backgroundColor,
  );
  for (const actualText of [
    page.getByText("选择知识空间"),
    page.getByText("这里只显示你当前有权访问的空间。"),
    longSpaceText,
  ]) {
    const foreground = await actualText.evaluate(
      (element) => getComputedStyle(element).color,
    );
    expect(contrastRatio(foreground, pageBackground)).toBeGreaterThanOrEqual(
      4.5,
    );
  }
  const roleColors = await viewerRole.evaluate((element) => ({
    background: getComputedStyle(element).backgroundColor,
    foreground: getComputedStyle(element).color,
  }));
  expect(
    contrastRatio(roleColors.foreground, roleColors.background),
  ).toBeGreaterThanOrEqual(4.5);

  if (testInfo.project.name !== "desktop") {
    await expect(page.getByRole("button", { name: "退出登录" })).toHaveCSS(
      "height",
      "40px",
    );
  }

  expectBrowserHealthy(diagnostics);
});

test("an account without space access sees an explicit empty state", async ({ page }) => {
  const diagnostics = collectBrowserDiagnostics(page);
  await installIdentityRoutes(page, []);
  await page.goto("/spaces");

  await expect(
    page.getByRole("heading", { name: "尚未获得空间访问权限" }),
  ).toBeVisible();
  const layout = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  expect(layout.scrollWidth).toBeLessThanOrEqual(layout.clientWidth);
  expectBrowserHealthy(diagnostics);
});
