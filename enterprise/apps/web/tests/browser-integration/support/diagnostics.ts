import { expect, type Page } from "@playwright/test";

interface BrowserDiagnostics {
  consoleMessages: string[];
  errorResponses: string[];
  pageErrors: string[];
  pendingApiRequests: Set<string>;
  requestFailures: string[];
}

interface DiagnosticAllowlist {
  consoleMessageFragments?: string[];
  errorResponses?: string[];
  requestFailurePaths?: string[];
}

export function collectBrowserDiagnostics(page: Page): BrowserDiagnostics {
  const diagnostics: BrowserDiagnostics = {
    consoleMessages: [],
    errorResponses: [],
    pageErrors: [],
    pendingApiRequests: new Set(),
    requestFailures: [],
  };

  page.on("console", (message) => {
    if (message.type() === "error" || message.type() === "warning") {
      diagnostics.consoleMessages.push(`${message.type()}: ${message.text()}`);
    }
  });
  page.on("pageerror", (error) => {
    diagnostics.pageErrors.push(error.message);
  });
  page.on("request", (request) => {
    if (new URL(request.url()).pathname.startsWith("/api/v1/")) {
      diagnostics.pendingApiRequests.add(`${request.method()} ${request.url()}`);
    }
  });
  page.on("requestfinished", (request) => {
    diagnostics.pendingApiRequests.delete(`${request.method()} ${request.url()}`);
  });
  page.on("requestfailed", (request) => {
    diagnostics.pendingApiRequests.delete(`${request.method()} ${request.url()}`);
    diagnostics.requestFailures.push(
      `${request.method()} ${new URL(request.url()).pathname}: ${request.failure()?.errorText ?? "unknown"}`,
    );
  });
  page.on("response", (response) => {
    if (response.status() >= 400) {
      diagnostics.errorResponses.push(
        `${response.status()} ${new URL(response.url()).pathname}`,
      );
    }
  });

  return diagnostics;
}

export function expectBrowserHealthy(
  diagnostics: BrowserDiagnostics,
  allowlist: DiagnosticAllowlist = {},
): void {
  const allowedConsoleFragments = allowlist.consoleMessageFragments ?? [];
  const unexpectedConsoleMessages = diagnostics.consoleMessages.filter(
    (message) =>
      !allowedConsoleFragments.some((fragment) => message.includes(fragment)),
  );
  expect(unexpectedConsoleMessages).toEqual([]);
  for (const fragment of allowedConsoleFragments) {
    expect(
      diagnostics.consoleMessages.some((message) => message.includes(fragment)),
    ).toBe(true);
  }
  expect(diagnostics.pageErrors).toEqual([]);
  expect(diagnostics.errorResponses).toEqual(allowlist.errorResponses ?? []);
  const allowedFailurePaths = allowlist.requestFailurePaths ?? [];
  const unexpectedFailures = diagnostics.requestFailures.filter(
    (failure) =>
      !allowedFailurePaths.some((path) => failure.includes(` ${path}:`)),
  );
  expect(unexpectedFailures).toEqual([]);
  for (const path of allowedFailurePaths) {
    expect(
      diagnostics.requestFailures.some((failure) =>
        failure.includes(` ${path}:`),
      ),
    ).toBe(true);
  }
  expect([...diagnostics.pendingApiRequests]).toEqual([]);
}
