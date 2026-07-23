import { expect, test } from "@playwright/test";
import {
  buildDocumentCollaborationFeaturePath,
} from "@singularity/contracts";

import {
  loginAs,
  openSpaceEditor,
  sessionRequest,
} from "./support/session.ts";
import { readP5E2EStackState } from "./support/stack-state.ts";
import {
  collectBrowserDiagnostics,
  expectBrowserHealthy,
} from "../browser-integration/support/diagnostics.ts";

const maximumRequestDurationMilliseconds = 10_000;

test("@l3-release exposes real collaboration state and closes revoked sessions", async ({
  browser,
  page,
}) => {
  const state = readP5E2EStackState();
  const diagnostics = collectBrowserDiagnostics(page);
  const identity = {
    documentId: state.documentId,
    notebookId: state.notebookId,
    organizationId: state.organizationId,
    spaceId: state.spaceId,
  };
  const featurePath = buildDocumentCollaborationFeaturePath(identity);
  let viewerContext: Awaited<ReturnType<typeof browser.newContext>> | undefined;
  let viewerMembershipRevoked = false;

  try {
    await loginAs(page, state.editor);
    const enabled = await sessionRequest(page, featurePath, {
      body: { restrictedEncryptedEnabled: false, standardEnabled: true },
      method: "PATCH",
    });
    expect(enabled.status).toBe(200);

    await openSpaceEditor(page, state, state.editor);
    const editorCollaborationState = page.locator("[data-collaboration-state]");
    await expect(editorCollaborationState).toHaveAttribute(
      "data-collaboration-state",
      "ready",
      { timeout: 30_000 },
    );

    viewerContext = await browser.newContext({
      baseURL: state.webOrigin,
      ignoreHTTPSErrors: true,
    });
    const viewerPage = await viewerContext.newPage();
    const viewerDiagnostics = collectBrowserDiagnostics(viewerPage);
    const viewerCollaborationSocketPromise = viewerPage.waitForEvent("websocket", {
      predicate: (socket) => new URL(socket.url()).pathname.endsWith("/collaboration/ws"),
    });
    await openSpaceEditor(viewerPage, state, state.viewer);
    const viewerCollaborationSocket = await viewerCollaborationSocketPromise;
    const viewerCollaborationState = viewerPage.locator("[data-collaboration-state]");
    await expect(viewerCollaborationState).toHaveAttribute(
      "data-collaboration-state",
      "ready",
      { timeout: 30_000 },
    );

    const revoked = await sessionRequest(page,
      `/api/v1/organizations/${state.organizationId}/spaces/${state.spaceId}/members/${state.viewer.userId}`,
      { method: "DELETE" },
    );
    expect(revoked.status).toBe(204);
    viewerMembershipRevoked = true;
    // 空间撤权会先关闭协作 WSS，再由内容会话安全退出；编辑器卸载后不再渲染 revoked 状态节点。
    await expect.poll(() => viewerCollaborationSocket.isClosed(), { timeout: 10_000 }).toBe(true);
    await expect(viewerPage.getByTestId("protyle-host")).toHaveCount(0, { timeout: 10_000 });
    await expect(viewerPage.getByRole("heading", { name: "找不到该空间" })).toBeVisible();

    const disabled = await sessionRequest(page, featurePath, {
      body: { restrictedEncryptedEnabled: false, standardEnabled: false },
      method: "PATCH",
    });
    expect(disabled.status).toBe(200);
    await expect(editorCollaborationState).toHaveAttribute(
      "data-collaboration-state",
      "closed",
      { timeout: 30_000 },
    );
    await expect.poll(() => diagnostics.pendingRequests.size).toBe(0);
    await expect.poll(() => viewerDiagnostics.pendingRequests.size).toBe(0);
    expectBrowserHealthy(diagnostics, maximumRequestDurationMilliseconds);
    const currentSpaceRuntimeUrl = `${state.webOrigin}/api/v1/organizations/${state.organizationId}` +
      `/spaces/${state.spaceId}/runtime`;
    const accessLossWarnings = viewerDiagnostics.consoleMessages.filter((message) =>
      message.type() === "warning" &&
      message.text().startsWith("[protyle.lifecycle]") &&
      /category:\s*['\"]?forbidden\b/.test(message.text()),
    );
    expect(accessLossWarnings.length).toBeGreaterThan(0);
    expectBrowserHealthy(viewerDiagnostics, maximumRequestDurationMilliseconds, {
      unexpectedConsoleMessages: viewerDiagnostics.consoleMessages.filter(
        (message) =>
          !accessLossWarnings.includes(message) &&
          !(
            message.type() === "error" &&
            message.location().url === currentSpaceRuntimeUrl &&
            /\b404\b/.test(message.text())
          ),
      ),
      unexpectedErrorResponses: viewerDiagnostics.responses.filter((response) =>
        response.status() >= 400 &&
        !(response.status() === 404 && response.url() === currentSpaceRuntimeUrl),
      ),
    });
  } finally {
    try {
      if (viewerMembershipRevoked) {
        const restored = await sessionRequest(page,
          `/api/v1/organizations/${state.organizationId}/spaces/${state.spaceId}/members/${state.viewer.userId}`,
          { body: { role: "viewer" }, method: "PUT" },
        );
        expect(restored.status).toBe(204);
      }
    } finally {
      await viewerContext?.close();
    }
  }
});
