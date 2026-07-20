import { expect, type Locator, type Page } from "@playwright/test";

import type { P5E2EStackState } from "./stack-state.ts";

export interface SessionRequestResult {
  readonly body: unknown;
  readonly status: number;
}

interface SessionRequestOptions {
  readonly body?: unknown;
  readonly headers?: Readonly<Record<string, string>>;
  readonly method: "DELETE" | "PATCH" | "POST" | "PUT";
}

async function sessionCsrfToken(page: Page): Promise<string> {
  const result = await page.evaluate(async () => {
    const response = await fetch("/api/v1/auth/csrf", {
      credentials: "same-origin",
      headers: { Accept: "application/json" },
    });
    return {
      body: await response.json() as unknown,
      status: response.status,
    };
  });
  if (
    result.status !== 200 ||
    typeof result.body !== "object" ||
    result.body === null ||
    !("csrfToken" in result.body) ||
    typeof result.body.csrfToken !== "string"
  ) {
    throw new Error("P5 E2E session CSRF token was not returned");
  }
  return result.body.csrfToken;
}

export async function sessionRequest(
  page: Page,
  path: string,
  options: SessionRequestOptions,
): Promise<SessionRequestResult> {
  const csrfToken = await sessionCsrfToken(page);
  const result = await page.evaluate(async ({ body, headers: extraHeaders, method, path, csrfToken }) => {
    const headers = new Headers({
      Accept: "application/json",
      "X-CSRF-Token": csrfToken,
      ...extraHeaders,
    });
    const serializedBody = body === undefined ? undefined : JSON.stringify(body);
    if (serializedBody !== undefined) {
      headers.set("Content-Type", "application/json");
    }
    const response = await fetch(path, {
      ...(serializedBody === undefined ? {} : { body: serializedBody }),
      credentials: "same-origin",
      headers,
      method,
    });
    return {
      contentType: response.headers.get("content-type"),
      status: response.status,
      text: await response.text(),
    };
  }, { ...options, csrfToken, path });
  let body: unknown = undefined;
  if (result.text.length > 0) {
    const mediaType = result.contentType?.split(";", 1)[0]?.trim().toLowerCase();
    if (mediaType === "application/json" || mediaType?.endsWith("+json")) {
      try {
        body = JSON.parse(result.text) as unknown;
      } catch (error) {
        throw new Error(`P5 E2E ${path} returned malformed JSON`, {
          cause: error,
        });
      }
    } else {
      body = result.text;
    }
  }
  return { body, status: result.status };
}

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
  const directory = page.getByRole("navigation", { name: "文档目录" });
  const documentButton = directory.getByRole("button", {
    exact: true,
    name: state.documentTitle,
  });
  await expect(documentButton).toBeVisible({ timeout: 30_000 });
  if (await documentButton.getAttribute("aria-current") !== "page") {
    await documentButton.click();
  }
  const editor = page.getByTestId("protyle-host");
  await expect(editor).toBeVisible({ timeout: 30_000 });
  await expect(editor.locator(".protyle-wysiwyg")).toBeVisible({ timeout: 30_000 });
  return editor;
}
