import { expect, test, type Request } from "@playwright/test";

import {
  collectBrowserDiagnostics,
  expectBrowserHealthy,
} from "../browser-integration/support/diagnostics.ts";
import { openSpaceEditor } from "./support/session.ts";
import { readP5E2EStackState } from "./support/stack-state.ts";

const maximumRequestDurationMilliseconds = 10_000;

test("keeps real PlantUML and HTML blocks inert and same-origin", async ({
  page,
}) => {
  const state = readP5E2EStackState();
  const diagnostics = collectBrowserDiagnostics(page);
  const externalRequests: Request[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (
      (url.protocol === "http:" || url.protocol === "https:") &&
      url.origin !== new URL(state.webOrigin).origin
    ) {
      externalRequests.push(request);
    }
  });

  const editor = await openSpaceEditor(page, state);
  const plantUml = editor.locator('[data-subtype="plantuml"]');
  await expect(plantUml).toHaveAttribute("data-render", "true");
  await expect(plantUml).toContainText("未启用");
  await expect(plantUml.locator("img, iframe, object, embed, script")).toHaveCount(0);

  const html = editor.locator('[data-type="NodeHTMLBlock"]');
  await expect(html).toHaveAttribute("data-render", "true");
  await expect(html.locator("protyle-html")).toHaveAttribute(
    "data-content",
    /__p5ActiveContentExecuted/,
  );
  await expect(html.locator("img, iframe, object, embed, script")).toHaveCount(0);
  expect(
    await page.evaluate<unknown>(() =>
      Reflect.get(window, "__p5ActiveContentExecuted")
    ),
  ).toBeUndefined();
  expect(externalRequests).toEqual([]);

  await expect.poll(() => diagnostics.pendingRequests.size).toBe(0);
  const webOrigin = new URL(state.webOrigin).origin;
  expectBrowserHealthy(diagnostics, maximumRequestDurationMilliseconds, {
    unexpectedRequestFailures: diagnostics.requestFailures.filter((request) => {
      const url = new URL(request.url());
      const isParallelStartupNetworkChange =
        request.failure()?.errorText === "net::ERR_NETWORK_CHANGED" &&
        url.origin === webOrigin &&
        ((url.pathname.startsWith("/assets/index-") && url.pathname.endsWith(".js")) ||
          url.pathname === "/stage/protyle/js/lute/lute.min.js");
      return !isParallelStartupNetworkChange;
    }),
  });
});
