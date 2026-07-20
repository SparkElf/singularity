import { expect, test } from "@playwright/test";

import {
  collectBrowserDiagnostics,
  expectBrowserHealthy,
} from "./support/diagnostics.ts";
import { fulfillJson } from "./support/http.ts";

const SHARE_TOKEN = "A".repeat(43);
const SHARE_PATH = `/api/v1/shares/${SHARE_TOKEN}`;
const REQUEST_ID = "99999999-9999-4999-8999-999999999999";
const MAX_REQUEST_DURATION_MS = 5_000;

test("public shares stay read-only, hide internal identities, and recheck revocation", async ({
  page,
}) => {
  const diagnostics = collectBrowserDiagnostics(page);
  let documentReads = 0;

  await page.route("**/api/v1/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === SHARE_PATH) {
      documentReads += 1;
      if (documentReads === 1) {
        await fulfillJson(route, {
          assets: [],
          html:
            '<p data-node-id="private-node">浏览器分享正文</p>' +
            '<a data-document-id="private-document" href="/organizations/private/spaces/private">内部链接</a>' +
            '<a href="#private-document">内部锚点</a>' +
            '<a href="https://docs.example.test/guide">外部链接</a>' +
            '<svg><script>window.compromised=true</script></svg>',
          title: "只读分享合同",
        });
        return;
      }
      await fulfillJson(
        route,
        { code: "not-found", requestId: REQUEST_ID, status: 404 },
        404,
      );
      return;
    }
    await route.abort("failed");
  });

  await page.goto(`/shares/${SHARE_TOKEN}`);
  await expect(
    page.getByRole("heading", { name: "只读分享合同" }),
  ).toBeVisible();
  await expect(page.getByText("浏览器分享正文")).toBeVisible();
  const article = page.locator("article");
  await expect(article.locator("svg")).toHaveCount(0);
  await expect(article.locator("[data-node-id], [data-document-id]")).toHaveCount(0);
  const internalLink = article.locator("a").filter({ hasText: "内部链接" });
  await expect(internalLink).toHaveCount(1);
  expect(await internalLink.getAttribute("href")).toBeNull();
  expect(
    await article.locator("a").filter({ hasText: "内部锚点" }).getAttribute("href"),
  ).toBeNull();
  await expect(article.getByRole("link", { name: "外部链接" })).toHaveAttribute(
    "href",
    "https://docs.example.test/guide",
  );

  await page.reload();
  await expect(
    page.getByRole("heading", { name: "分享不存在或已失效" }),
  ).toBeVisible();
  expect(documentReads).toBe(2);

  const expectedErrorResponses = diagnostics.responses.filter(
    (response) =>
      response.status() === 404 &&
      new URL(response.url()).pathname === SHARE_PATH,
  );
  expect(expectedErrorResponses).toHaveLength(1);
  expectBrowserHealthy(diagnostics, MAX_REQUEST_DURATION_MS, {
    unexpectedErrorResponses: diagnostics.responses.filter(
      (response) =>
        response.status() >= 400 && !expectedErrorResponses.includes(response),
    ),
  });
});
