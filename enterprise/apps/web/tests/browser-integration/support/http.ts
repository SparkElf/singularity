import type { Route } from "@playwright/test";

export async function fulfillJson(
  route: Route,
  body: unknown,
  status = 200,
): Promise<void> {
  await route.fulfill({
    body: JSON.stringify(body),
    contentType: "application/json",
    headers: { "Cache-Control": "no-store" },
    status,
  });
}
