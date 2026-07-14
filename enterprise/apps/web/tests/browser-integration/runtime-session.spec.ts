import { expect, test, type Page } from "@playwright/test";

import { collectBrowserDiagnostics } from "./support/diagnostics.ts";
import { fulfillJson } from "./support/http.ts";

const ORGANIZATION_A = "11111111-1111-4111-8111-111111111111";
const ORGANIZATION_B = "22222222-2222-4222-8222-222222222222";
const SPACE_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SPACE_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const REQUEST_ID = "99999999-9999-4999-8999-999999999999";
const CSRF_TOKEN = "A".repeat(43);
const MAX_API_REQUEST_DURATION_MS = 5_000;

const spaces = [
  {
    organizationId: ORGANIZATION_A,
    organizationName: "银河研究院",
    spaceId: SPACE_A,
    spaceName: "深空知识空间",
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

function workspacePath(organizationId = ORGANIZATION_A, spaceId = SPACE_A) {
  return `/organizations/${organizationId}/spaces/${spaceId}`;
}

function runtimePath(organizationId = ORGANIZATION_A, spaceId = SPACE_A) {
  return `/api/v1/organizations/${organizationId}/spaces/${spaceId}/runtime`;
}

async function openMobileSidebarIfNeeded(page: Page) {
  const logout = page.getByRole("button", { name: "退出登录" });
  if (!(await logout.isVisible())) {
    await page.getByRole("button", { name: "切换侧栏" }).click();
    await expect(logout).toBeVisible();
  }
}

test("logout clears authorized history and sends the in-memory CSRF token", async ({ page }) => {
  const diagnostics = collectBrowserDiagnostics(page);
  let authenticated = true;
  let logoutHeaders: Record<string, string> | null = null;

  await page.route("**/api/v1/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === "/api/v1/spaces") {
      if (!authenticated) {
        await fulfillJson(
          route,
          { code: "unauthenticated", requestId: REQUEST_ID, status: 401 },
          401,
        );
        return;
      }
      await fulfillJson(route, { spaces });
      return;
    }
    if (path === runtimePath()) {
      await fulfillJson(route, {
        organizationId: ORGANIZATION_A,
        spaceId: SPACE_A,
        role: "viewer",
        kernelState: "ready",
      });
      return;
    }
    if (path === "/api/v1/auth/csrf") {
      await fulfillJson(route, { csrfToken: CSRF_TOKEN });
      return;
    }
    if (path === "/api/v1/auth/logout") {
      logoutHeaders = request.headers();
      authenticated = false;
      await route.fulfill({ status: 204 });
      return;
    }
    await route.abort("failed");
  });

  await page.goto("/spaces");
  await page.getByRole("link", { name: /深空知识空间/ }).click();
  await expect(page.getByRole("heading", { name: "空间已就绪" })).toBeVisible();
  await expect(page.getByText("阅读者")).toBeVisible();

  await openMobileSidebarIfNeeded(page);
  await page.getByRole("button", { name: "退出登录" }).click();
  await expect(page.getByRole("heading", { name: "登录奇点" })).toBeVisible();
  await expect(page).toHaveURL("/login");
  expect(logoutHeaders?.["x-csrf-token"]).toBe(CSRF_TOKEN);

  await page.goBack();
  await expect(page.getByRole("heading", { name: "登录奇点" })).toBeVisible();
  await expect(page).toHaveURL("/login?returnTo=%2Fspaces");
  await expect(page.getByRole("heading", { name: "空间已就绪" })).toHaveCount(0);
  await page.goForward();
  await expect(page.getByRole("heading", { name: "登录奇点" })).toBeVisible();
  await expect(page).toHaveURL("/login");
  await expect(page.getByRole("heading", { name: "空间已就绪" })).toHaveCount(0);
  const consoleMessages = diagnostics.consoleMessages.map((message) =>
    message.text(),
  );
  expect(
    consoleMessages.filter((message) => !message.includes("401 (Unauthorized)")),
  ).toEqual([]);
  expect(
    consoleMessages.some((message) => message.includes("401 (Unauthorized)")),
  ).toBe(true);
  expect(diagnostics.pageErrors).toEqual([]);
  const errorResponses = diagnostics.requests.filter(
    (request) => request.status !== null && request.status >= 400,
  );
  expect(errorResponses).toHaveLength(1);
  expect(errorResponses[0]?.status).toBe(401);
  expect(new URL(errorResponses[0]!.request.url()).pathname).toBe(
    "/api/v1/spaces",
  );
  expect(
    diagnostics.requests.filter((request) => request.failure !== null),
  ).toEqual([]);
  for (const request of diagnostics.requests) {
    expect(request.finishedAt).not.toBeNull();
    expect(request.durationMs).not.toBeNull();
    expect(request.durationMs!).toBeLessThan(MAX_API_REQUEST_DURATION_MS);
  }
});

test("a visible starting page polls once and adopts the new ready state", async ({ page }) => {
  const diagnostics = collectBrowserDiagnostics(page);
  let runtimeRequests = 0;
  await page.route("**/api/v1/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/v1/spaces") {
      await fulfillJson(route, { spaces: [spaces[0]] });
      return;
    }
    if (path === runtimePath()) {
      runtimeRequests += 1;
      await fulfillJson(route, {
        organizationId: ORGANIZATION_A,
        spaceId: SPACE_A,
        role: "viewer",
        kernelState: runtimeRequests === 1 ? "starting" : "ready",
      });
      return;
    }
    await route.abort("failed");
  });

  await page.goto(workspacePath());
  await expect(page.getByRole("heading", { name: "空间正在启动" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "空间已就绪" })).toBeVisible({
    timeout: 5_000,
  });
  expect(runtimeRequests).toBe(2);
  expect(diagnostics.consoleMessages).toEqual([]);
  expect(diagnostics.pageErrors).toEqual([]);
  expect(
    diagnostics.requests.filter(
      (request) =>
        request.status !== null && request.status >= 400,
    ),
  ).toEqual([]);
  expect(
    diagnostics.requests.filter((request) => request.failure !== null),
  ).toEqual([]);
  const runtimeDiagnostics = diagnostics.requests.filter(
    (request) => new URL(request.request.url()).pathname === runtimePath(),
  );
  expect(runtimeDiagnostics).toHaveLength(2);
  expect(runtimeDiagnostics[0]?.request).not.toBe(runtimeDiagnostics[1]?.request);
  for (const request of diagnostics.requests) {
    expect(request.finishedAt).not.toBeNull();
    expect(request.durationMs).not.toBeNull();
    expect(request.durationMs!).toBeLessThan(MAX_API_REQUEST_DURATION_MS);
  }
});

test("a browser network failure remains distinct and explicit retry recovers", async ({ page }) => {
  const diagnostics = collectBrowserDiagnostics(page);
  let networkFailure = true;
  await page.route("**/api/v1/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/v1/spaces") {
      await fulfillJson(route, { spaces: [spaces[0]] });
      return;
    }
    if (path === runtimePath()) {
      if (networkFailure) {
        await route.abort("connectionfailed");
        return;
      }
      await fulfillJson(route, {
        organizationId: ORGANIZATION_A,
        spaceId: SPACE_A,
        role: "viewer",
        kernelState: "ready",
      });
      return;
    }
    await route.abort("failed");
  });

  await page.goto(workspacePath());
  await expect(page.getByRole("heading", { name: "无法加载空间" })).toBeVisible();
  await expect(page.getByText("无法连接到服务，请检查网络后重试。")).toBeVisible();

  networkFailure = false;
  await page.getByRole("button", { name: "立即重试" }).click();
  await expect(page.getByRole("heading", { name: "空间已就绪" })).toBeVisible();
  const consoleMessages = diagnostics.consoleMessages.map((message) =>
    message.text(),
  );
  expect(
    consoleMessages.filter(
      (message) => !message.includes("net::ERR_CONNECTION_FAILED"),
    ),
  ).toEqual([]);
  expect(
    consoleMessages.some((message) =>
      message.includes("net::ERR_CONNECTION_FAILED"),
    ),
  ).toBe(true);
  expect(diagnostics.pageErrors).toEqual([]);
  expect(
    diagnostics.requests.filter(
      (request) =>
        request.status !== null && request.status >= 400,
    ),
  ).toEqual([]);
  const requestFailures = diagnostics.requests.filter(
    (request) => request.failure !== null,
  );
  expect(requestFailures).toHaveLength(1);
  expect(new URL(requestFailures[0]!.request.url()).pathname).toBe(runtimePath());
  expect(requestFailures[0]?.failure).toContain("net::ERR_CONNECTION_FAILED");
  for (const request of diagnostics.requests) {
    expect(request.finishedAt).not.toBeNull();
    expect(request.durationMs).not.toBeNull();
    expect(request.durationMs!).toBeLessThan(MAX_API_REQUEST_DURATION_MS);
  }
});

test("the sidebar collapses on desktop and closes after mobile space navigation", async ({
  page,
}, testInfo) => {
  const diagnostics = collectBrowserDiagnostics(page);
  await page.route("**/api/v1/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/v1/spaces") {
      await fulfillJson(route, { spaces });
      return;
    }
    if (
      path === runtimePath(ORGANIZATION_A, SPACE_A) ||
      path === runtimePath(ORGANIZATION_B, SPACE_B)
    ) {
      const secondSpace = path === runtimePath(ORGANIZATION_B, SPACE_B);
      await fulfillJson(route, {
        organizationId: secondSpace ? ORGANIZATION_B : ORGANIZATION_A,
        spaceId: secondSpace ? SPACE_B : SPACE_A,
        role: secondSpace ? "editor" : "viewer",
        kernelState: "ready",
      });
      return;
    }
    await route.abort("failed");
  });

  await page.goto(workspacePath());
  await expect(page.getByRole("heading", { name: "空间已就绪" })).toBeVisible();
  const trigger = page.getByRole("button", { name: "切换侧栏" });

  if (testInfo.project.name === "desktop") {
    const desktopSidebar = page.locator('[data-slot="sidebar"][data-state]');
    await expect(desktopSidebar).toHaveAttribute("data-state", "expanded");
    await trigger.click();
    await expect(desktopSidebar).toHaveAttribute("data-state", "collapsed");
    await trigger.click();
    await expect(desktopSidebar).toHaveAttribute("data-state", "expanded");
  } else {
    const triggerBox = await trigger.boundingBox();
    expect(triggerBox).not.toBeNull();
    expect(triggerBox!.height).toBeGreaterThanOrEqual(40);
    expect(triggerBox!.width).toBeGreaterThanOrEqual(40);

    await openMobileSidebarIfNeeded(page);
    const logout = page.getByRole("button", { name: "退出登录" });
    const nextSpace = page.getByRole("link", { name: /星际工程手册/ });
    const logoutBox = await logout.boundingBox();
    const nextSpaceBox = await nextSpace.boundingBox();
    expect(logoutBox).not.toBeNull();
    expect(nextSpaceBox).not.toBeNull();
    expect(logoutBox!.height).toBeGreaterThanOrEqual(40);
    expect(nextSpaceBox!.height).toBeGreaterThanOrEqual(40);

    await page.touchscreen.tap(
      nextSpaceBox!.x + nextSpaceBox!.width / 2,
      nextSpaceBox!.y + nextSpaceBox!.height / 2,
    );
    await expect(page).toHaveURL(workspacePath(ORGANIZATION_B, SPACE_B));
    await expect(page.getByText("编辑者")).toBeVisible();
    await expect(logout).toBeHidden();
  }

  expect(diagnostics.consoleMessages).toEqual([]);
  expect(diagnostics.pageErrors).toEqual([]);
  expect(
    diagnostics.requests.filter(
      (request) =>
        request.status !== null && request.status >= 400,
    ),
  ).toEqual([]);
  expect(
    diagnostics.requests.filter((request) => request.failure !== null),
  ).toEqual([]);
  for (const request of diagnostics.requests) {
    expect(request.finishedAt).not.toBeNull();
    expect(request.durationMs).not.toBeNull();
    expect(request.durationMs!).toBeLessThan(MAX_API_REQUEST_DURATION_MS);
  }
});
