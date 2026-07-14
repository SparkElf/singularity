import type { ConsoleMessage, Page, Request } from "@playwright/test";

export interface BrowserRequestDiagnostic {
  durationMs: number | null;
  failure: string | null;
  finishedAt: number | null;
  request: Request;
  startedAt: number;
  status: number | null;
}

export interface BrowserDiagnostics {
  consoleMessages: ConsoleMessage[];
  pageErrors: Error[];
  requests: BrowserRequestDiagnostic[];
}

export function collectBrowserDiagnostics(page: Page): BrowserDiagnostics {
  const diagnostics: BrowserDiagnostics = {
    consoleMessages: [],
    pageErrors: [],
    requests: [],
  };
  const pendingRequests = new Map<Request, BrowserRequestDiagnostic>();

  page.on("console", (message) => {
    if (message.type() === "error" || message.type() === "warning") {
      diagnostics.consoleMessages.push(message);
    }
  });
  page.on("pageerror", (error) => {
    diagnostics.pageErrors.push(error);
  });
  page.on("request", (request) => {
    if (!new URL(request.url()).pathname.startsWith("/api/v1/")) {
      return;
    }

    const diagnostic: BrowserRequestDiagnostic = {
      durationMs: null,
      failure: null,
      finishedAt: null,
      request,
      startedAt: performance.now(),
      status: null,
    };
    diagnostics.requests.push(diagnostic);
    pendingRequests.set(request, diagnostic);
  });
  page.on("response", (response) => {
    const diagnostic = pendingRequests.get(response.request());
    if (diagnostic) {
      diagnostic.status = response.status();
    }
  });
  page.on("requestfinished", (request) => {
    const diagnostic = pendingRequests.get(request);
    if (!diagnostic) {
      return;
    }

    diagnostic.finishedAt = performance.now();
    diagnostic.durationMs = diagnostic.finishedAt - diagnostic.startedAt;
    pendingRequests.delete(request);
  });
  page.on("requestfailed", (request) => {
    const diagnostic = pendingRequests.get(request);
    if (!diagnostic) {
      return;
    }

    diagnostic.finishedAt = performance.now();
    diagnostic.durationMs = diagnostic.finishedAt - diagnostic.startedAt;
    diagnostic.failure = request.failure()?.errorText ?? "unknown";
    pendingRequests.delete(request);
  });

  return diagnostics;
}
