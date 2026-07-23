import { expect, test, type Page, type Route } from "@playwright/test";

import { collectBrowserDiagnostics, expectBrowserHealthy } from "./support/diagnostics.ts";
import { fulfillJson } from "./support/http.ts";

const ORGANIZATION_ID = "11111111-1111-4111-8111-111111111111";
const SPACE_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SPACE_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const CSRF_TOKEN = "A".repeat(43);

const managementAccess = {
  organizations: [{
    organizationCapabilities: ["governance"],
    organizationId: ORGANIZATION_ID,
    organizationName: "奇点工程中心",
    spaces: [
      { capabilities: ["governance"], spaceId: SPACE_A, spaceName: "工程手册" },
      { capabilities: ["governance"], spaceId: SPACE_B, spaceName: "运行手册" },
    ],
  }],
};

async function installRoutes(page: Page, searchGate?: Promise<void>): Promise<void> {
  await page.route("**/api/v1/**", async (route: Route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    if (path === "/api/v1/auth/csrf") {
      await fulfillJson(route, { csrfToken: CSRF_TOKEN });
      return;
    }
    if (path === "/api/v1/enterprise-management-access") {
      await fulfillJson(route, managementAccess);
      return;
    }
    if (path.endsWith("/governance/dashboard")) {
      await fulfillJson(route, { approvalsPending: 1, documentsExpired: 0, documentsNeedingReview: 2, legalHolds: 0, tasksFailed: 0 });
      return;
    }
    if (path.endsWith(`/spaces/${SPACE_A}/governance/policy`)) {
      await fulfillJson(route, { archiveAfterDays: 365, defaultClassification: "internal", governanceEnabled: false, organizationId: ORGANIZATION_ID, policyId: "33333333-3333-4333-8333-333333333333", retentionDays: 365, spaceId: SPACE_A, updatedAt: "2026-07-23T00:00:00.000Z", verificationGraceDays: 30, verificationIntervalDays: 180, watermarkEnabled: true });
      return;
    }
    if (path === "/api/v1/auth/mfa/factors") {
      await fulfillJson(route, { factors: [] });
      return;
    }
    if (path.endsWith("/api-keys") && request.method() === "GET") {
      await fulfillJson(route, { keys: [] });
      return;
    }
    if (path.endsWith("/saml/providers") && request.method() === "GET") {
      await fulfillJson(route, { providers: [] });
      return;
    }
    if (path.endsWith("/scim/tokens") && request.method() === "GET") {
      await fulfillJson(route, { tokens: [] });
      return;
    }
    if (path.endsWith("/api-keys") && request.method() === "POST") {
      expect(request.postDataJSON()).toMatchObject({ name: "automation", scopes: ["governance.read"] });
      await fulfillJson(route, { apiKeyId: "44444444-4444-4444-8444-444444444444", keyPrefix: "sk_sing_test", name: "automation", scopes: ["governance.read"], secret: "sk_sing_once_only" }, 201);
      return;
    }
    if (path.endsWith("/governance/search")) {
      expect(request.postDataJSON()).toEqual({ query: "release", spaceIds: [SPACE_A, SPACE_B] });
      if (searchGate !== undefined) await searchGate;
      try {
        await fulfillJson(route, { results: [{ classification: "internal", document: { documentId: "20260723090001-doc0001", notebookId: "20260723090000-book001", organizationId: ORGANIZATION_ID, spaceId: SPACE_B }, excerpt: "release runbook", title: "Release Runbook", updatedAt: "2026-07-23T00:00:00.000Z" }] });
      } catch (error) {
        const failure = error instanceof Error ? error : new Error("迟到搜索响应未能完成", { cause: error });
        console.debug("[l4-governance.browser-search]", failure);
      }
      return;
    }
    await route.abort("failed");
  });
}

test("opens L4 governance paths and keeps identity-bound search requests", async ({ page }) => {
  const diagnostics = collectBrowserDiagnostics(page);
  await installRoutes(page);
  await page.goto(`/organizations/${ORGANIZATION_ID}/settings/governance`);
  await expect(page.getByRole("heading", { name: "知识治理" })).toBeVisible();
  await page.getByRole("button", { name: "身份安全" }).click();
  await page.getByLabel("Key 名称").fill("automation");
  await page.getByRole("button", { name: "创建 Key" }).click();
  await expect(page.getByText("sk_sing_once_only")).toBeVisible();
  await page.getByRole("button", { name: "发现与个人空间" }).click();
  await page.getByLabel("跨空间搜索").fill("release");
  await page.getByRole("button", { name: "搜索授权内容" }).click();
  await expect(page.getByRole("button", { name: /Release Runbook/ })).toBeVisible();
  expectBrowserHealthy(diagnostics, 5_000);
});

test("drops a late search response after the query scope changes", async ({ page }) => {
  const diagnostics = collectBrowserDiagnostics(page);
  let releaseSearchStarted: (() => void) | undefined;
  const releaseSearch = new Promise<void>((resolve) => { releaseSearchStarted = resolve; });
  await installRoutes(page, releaseSearch);
  await page.goto(`/organizations/${ORGANIZATION_ID}/settings/governance`);
  await expect(page.getByRole("heading", { name: "知识治理" })).toBeVisible();
  await page.getByRole("button", { name: "发现与个人空间" }).click();
  await page.getByLabel("跨空间搜索").fill("release");
  await page.getByRole("button", { name: "搜索授权内容" }).click();
  await expect.poll(() => releaseSearchStarted !== undefined).toBe(true);
  await page.getByLabel("跨空间搜索").fill("new scope");
  releaseSearchStarted?.();
  await expect(page.getByText("Release Runbook")).not.toBeVisible();
  const cancelledSearches = diagnostics.requestFailures.filter((request) => request.url().includes("/governance/search"));
  expectBrowserHealthy(diagnostics, 5_000, { expectedRequestFailures: cancelledSearches });
});
