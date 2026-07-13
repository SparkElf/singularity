import { expect, test as base } from "@playwright/test";

interface BrowserDiagnostics {
  consoleMessages: string[];
  failedRequests: string[];
  failedResponses: string[];
}

interface AppFixtures {
  diagnostics: BrowserDiagnostics;
}

export const test = base.extend<AppFixtures>({
  diagnostics: async ({ page }, use) => {
    const diagnostics: BrowserDiagnostics = {
      consoleMessages: [],
      failedRequests: [],
      failedResponses: [],
    };

    page.on("console", (message) => {
      if (message.type() === "error" || message.type() === "warning") {
        diagnostics.consoleMessages.push(`${message.type()}: ${message.text()}`);
      }
    });
    page.on("requestfailed", (request) => {
      diagnostics.failedRequests.push(`${request.method()} ${request.url()}: ${request.failure()?.errorText ?? "unknown"}`);
    });
    page.on("response", (response) => {
      if (response.status() >= 400) {
        diagnostics.failedResponses.push(`${response.status()} ${response.url()}`);
      }
    });

    await use(diagnostics);
  },
});

export function expectHealthyBrowser(diagnostics: BrowserDiagnostics) {
  expect(diagnostics.consoleMessages).toEqual([]);
  expect(diagnostics.failedRequests).toEqual([]);
  expect(diagnostics.failedResponses).toEqual([]);
}

