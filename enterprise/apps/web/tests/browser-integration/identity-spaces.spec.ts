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
const MAX_REQUEST_DURATION_MS = 5_000;
const MANAGEMENT_ACCESS_PATH = "/api/v1/enterprise-management-access";

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
  managementAccess: unknown = { organizations: [] },
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

    if (path === "/api/v1/auth/oidc/providers") {
      await fulfillJson(route, { providers: [] });
      return;
    }

    if (path === "/api/v1/spaces") {
      await fulfillJson(route, { spaces: authorizedSpaces });
      return;
    }

    if (path === MANAGEMENT_ACCESS_PATH) {
      await fulfillJson(route, managementAccess);
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
  const submit = page.getByRole("button", { name: "登录", exact: true });

  if (testInfo.project.name !== "desktop") {
    for (const control of [identifier, password, submit]) {
      const box = await control.boundingBox();
      expect(box).not.toBeNull();
      expect(box!.height).toBeGreaterThanOrEqual(40);
      expect(box!.width).toBeGreaterThanOrEqual(40);
    }
  }

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
  const longSpaceLink = page.getByRole("link", {
    name: new RegExp(LONG_SPACE_NAME),
  });
  const engineeringSpaceLink = page.getByRole("link", {
    name: /星际工程手册/,
  });
  await expect(longSpaceLink).toBeVisible();
  await expect(engineeringSpaceLink).toBeVisible();

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
  await expect(engineeringSpaceLink).toBeVisible();
  await expect(longSpaceLink).toBeHidden();
  await search.fill("");
  await search.focus();
  await page.keyboard.press("Tab");
  await expect(longSpaceLink).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(engineeringSpaceLink).toBeFocused();

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
    page.getByText("这里只显示你当前有权访问的空间与管理范围。"),
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
    for (const control of [
      page.locator('[data-slot="input-group"]'),
      longSpaceLink,
      engineeringSpaceLink,
      page.getByRole("button", { name: "退出登录" }),
    ]) {
      const box = await control.boundingBox();
      expect(box).not.toBeNull();
      expect(box!.height).toBeGreaterThanOrEqual(40);
      expect(box!.width).toBeGreaterThanOrEqual(40);
    }
  }

  const apiRequests = diagnostics.requests.filter((request) =>
    new URL(request.url()).pathname.startsWith("/api/v1/"),
  );
  const observedApiRequests = apiRequests.map((request) => ({
    method: request.method(),
    path: new URL(request.url()).pathname,
  }));
  expect(observedApiRequests).toHaveLength(4);
  expect(observedApiRequests).toEqual(expect.arrayContaining([
    {
      method: "POST",
      path: "/api/v1/auth/login",
    },
    {
      method: "GET",
      path: "/api/v1/auth/oidc/providers",
    },
    {
      method: "GET",
      path: "/api/v1/spaces",
    },
    {
      method: "GET",
      path: MANAGEMENT_ACCESS_PATH,
    },
  ]));
  const observedApiResponses = diagnostics.responses
    .filter((response) =>
      new URL(response.url()).pathname.startsWith("/api/v1/"),
    )
    .map((response) => ({
      path: new URL(response.url()).pathname,
      status: response.status(),
    }));
  expect(observedApiResponses).toHaveLength(4);
  expect(observedApiResponses).toEqual(expect.arrayContaining([
    { path: "/api/v1/auth/login", status: 200 },
    { path: "/api/v1/auth/oidc/providers", status: 200 },
    { path: "/api/v1/spaces", status: 200 },
    { path: MANAGEMENT_ACCESS_PATH, status: 200 },
  ]));
  expectBrowserHealthy(diagnostics, MAX_REQUEST_DURATION_MS);
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
  const spaceRequests = diagnostics.requests.filter(
    (request) => new URL(request.url()).pathname === "/api/v1/spaces",
  );
  const spaceResponses = diagnostics.responses.filter(
    (response) => new URL(response.url()).pathname === "/api/v1/spaces",
  );
  expect(spaceRequests).toHaveLength(1);
  expect(spaceRequests[0]?.method()).toBe("GET");
  expect(spaceResponses).toHaveLength(1);
  expect(spaceResponses[0]?.status()).toBe(200);
  const expectedIconNetworkChange = diagnostics.consoleMessages.filter((message) =>
    message.text() === "Failed to load resource: net::ERR_NETWORK_CHANGED" &&
    message.location().url.endsWith("/appearance/icons/litheness/icon.js?v=3.7.2"),
  );
  expectBrowserHealthy(diagnostics, MAX_REQUEST_DURATION_MS, {
    unexpectedConsoleMessages: diagnostics.consoleMessages.filter(
      (message) => !expectedIconNetworkChange.includes(message),
    ),
  });
});

test("a delegated space administrator enters only the declared enterprise sections", async ({
  page,
}, testInfo) => {
  const diagnostics = collectBrowserDiagnostics(page);
  await installIdentityRoutes(page, [spaces[0]], {
    organizations: [
      {
        organizationCapabilities: [],
        organizationId: ORGANIZATION_A,
        organizationName: LONG_ORGANIZATION_NAME,
        spaces: [
          {
            capabilities: ["backups"],
            spaceId: SPACE_A,
            spaceName: LONG_SPACE_NAME,
          },
        ],
      },
    ],
  });
  await page.route(
    `**/api/v1/organizations/${ORGANIZATION_A}/spaces/${SPACE_A}/backups`,
    (route) => fulfillJson(route, { backups: [] }),
  );
  await page.route(
    `**/api/v1/organizations/${ORGANIZATION_A}/spaces/${SPACE_A}/restores`,
    (route) => fulfillJson(route, { restores: [] }),
  );
  await page.goto("/spaces");

  const managementSection = page.locator(
    'section[aria-labelledby="enterprise-management-heading"]',
  );
  await managementSection.getByRole("link").click();
  await expect(page).toHaveURL(
    `/organizations/${ORGANIZATION_A}/settings/spaces/${SPACE_A}/backups`,
  );
  await expect(page.getByRole("heading", { name: "备份恢复" })).toBeVisible();

  if (testInfo.project.name !== "desktop") {
    await page.getByRole("button", { name: "切换侧栏" }).click();
  }
  await expect(page.getByText("空间管理", { exact: true })).toBeVisible();
  await expect(page.getByText("组织管理", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "备份恢复" })).toBeVisible();
  await expect(page.getByRole("link", { name: "访问权限" })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "组织审计" })).toHaveCount(0);
  expectBrowserHealthy(diagnostics, MAX_REQUEST_DURATION_MS);
});

test("dark design tokens keep the authorized space list readable", async ({
  page,
}) => {
  const diagnostics = collectBrowserDiagnostics(page);
  await installIdentityRoutes(page);
  await page.goto("/spaces");
  await page.evaluate(() => {
    document.documentElement.classList.add("dark");
  });

  const heading = page.getByRole("heading", { name: "选择知识空间" });
  const description = page.getByText(
    "这里只显示你当前有权访问的空间与管理范围。",
  );
  await expect(heading).toBeVisible();
  const colors = await page.evaluate(() => ({
    background: getComputedStyle(document.body).backgroundColor,
    colorScheme: getComputedStyle(document.documentElement).colorScheme,
    foreground: getComputedStyle(document.body).color,
  }));
  expect(colors.colorScheme).toBe("dark");
  expect(colors.background).not.toBe("rgb(255, 255, 255)");
  expect(contrastRatio(colors.foreground, colors.background)).toBeGreaterThanOrEqual(
    4.5,
  );
  const descriptionColor = await description.evaluate(
    (element) => getComputedStyle(element).color,
  );
  expect(contrastRatio(descriptionColor, colors.background)).toBeGreaterThanOrEqual(
    4.5,
  );

  const spaceRequests = diagnostics.requests.filter(
    (request) => new URL(request.url()).pathname === "/api/v1/spaces",
  );
  const spaceResponses = diagnostics.responses.filter(
    (response) => new URL(response.url()).pathname === "/api/v1/spaces",
  );
  expect(spaceRequests).toHaveLength(1);
  expect(spaceResponses).toHaveLength(1);
  expect(spaceResponses[0]?.status()).toBe(200);
  expectBrowserHealthy(diagnostics, MAX_REQUEST_DURATION_MS);
});
