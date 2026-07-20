import {
  expect,
  type ConsoleMessage,
  type Page,
  type Request,
  type Response,
} from "@playwright/test";

export interface BrowserRequestTiming {
  durationMs: number | null;
  finishedAt: number | null;
  startedAt: number;
}

export interface BrowserDiagnostics {
  consoleMessages: ConsoleMessage[];
  pageErrors: Error[];
  pendingRequests: Set<Request>;
  requestFailures: Request[];
  requestTimings: Map<Request, BrowserRequestTiming>;
  requests: Request[];
  responses: Response[];
}

interface BrowserHealthEvidence {
  unexpectedConsoleMessages?: readonly ConsoleMessage[];
  unexpectedErrorResponses?: readonly Response[];
  unexpectedRequestFailures?: readonly Request[];
  expectedPendingRequests?: readonly Request[];
}

export function collectBrowserDiagnostics(page: Page): BrowserDiagnostics {
  const diagnostics: BrowserDiagnostics = {
    consoleMessages: [],
    pageErrors: [],
    pendingRequests: new Set(),
    requestFailures: [],
    requestTimings: new Map(),
    requests: [],
    responses: [],
  };

  page.on("console", (message) => {
    if (message.type() === "error" || message.type() === "warning") {
      diagnostics.consoleMessages.push(message);
    }
  });
  page.on("pageerror", (error) => {
    diagnostics.pageErrors.push(error);
  });
  page.on("request", (request) => {
    diagnostics.requests.push(request);
    diagnostics.pendingRequests.add(request);
    diagnostics.requestTimings.set(request, {
      durationMs: null,
      finishedAt: null,
      startedAt: performance.now(),
    });
  });
  page.on("response", (response) => {
    diagnostics.responses.push(response);
  });
  page.on("requestfinished", (request) => {
    finishRequest(diagnostics, request);
  });
  page.on("requestfailed", (request) => {
    diagnostics.requestFailures.push(request);
    finishRequest(diagnostics, request);
  });

  return diagnostics;
}

function finishRequest(diagnostics: BrowserDiagnostics, request: Request): void {
  const timing = diagnostics.requestTimings.get(request);
  if (!timing) {
    return;
  }

  timing.finishedAt = performance.now();
  timing.durationMs = timing.finishedAt - timing.startedAt;
  diagnostics.pendingRequests.delete(request);
}

export function expectBrowserHealthy(
  diagnostics: BrowserDiagnostics,
  maxRequestDurationMs: number,
  evidence: BrowserHealthEvidence = {},
): void {
  expect(
    evidence.unexpectedConsoleMessages ?? diagnostics.consoleMessages,
  ).toEqual([]);
  expect(diagnostics.pageErrors).toEqual([]);
  expect(
    evidence.unexpectedErrorResponses ??
      diagnostics.responses.filter((response) => response.status() >= 400),
  ).toEqual([]);
  expect(
    evidence.unexpectedRequestFailures ?? diagnostics.requestFailures,
  ).toEqual([]);
  // 允许调用方明确列出仍在等待终态的已取消请求，其他请求仍必须完成。
  const expectedPendingRequests = new Set(evidence.expectedPendingRequests ?? []);
  expect(
    [...diagnostics.pendingRequests].filter((request) => !expectedPendingRequests.has(request)),
  ).toEqual([]);

  const terminalRequests = new Set([
    ...diagnostics.responses.map((response) => response.request()),
    ...diagnostics.requestFailures,
  ]);
  for (const request of diagnostics.requests) {
    if (expectedPendingRequests.has(request)) {
      continue;
    }
    const timing = diagnostics.requestTimings.get(request);
    expect(timing).toBeDefined();
    expect(timing?.finishedAt).not.toBeNull();
    expect(timing?.durationMs).not.toBeNull();
    expect(timing!.durationMs!).toBeLessThan(maxRequestDurationMs);
    expect(terminalRequests.has(request)).toBe(true);
  }
}
