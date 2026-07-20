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

// 识别思源主题图标在并行浏览器运行中产生的固定网络切换噪声。
export function isExpectedIconNetworkChange(message: ConsoleMessage): boolean {
  return message.text() === "Failed to load resource: net::ERR_NETWORK_CHANGED" &&
    message.location().url.endsWith("/appearance/icons/litheness/icon.js?v=3.7.2");
}

interface BrowserHealthEvidence {
  unexpectedConsoleMessages?: readonly ConsoleMessage[];
  unexpectedErrorResponses?: readonly Response[];
  unexpectedRequestFailures?: readonly Request[];
  expectedPendingRequests?: readonly Request[];
}

// 长生命周期 WebSocket 由专用连接合同验证，不纳入普通 HTTP 请求终态统计。
function isLongLivedRequest(request: Request): boolean {
  return request.resourceType() === "websocket";
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
    if (!isLongLivedRequest(request)) {
      diagnostics.pendingRequests.add(request);
    }
    diagnostics.requestTimings.set(request, {
      durationMs: null,
      finishedAt: null,
      startedAt: performance.now(),
    });
  });
  page.on("response", (response) => {
    diagnostics.responses.push(response);
    // 响应已是健康检查认可的请求终态，避免把事件循环排队时间计入网络耗时。
    const resourceTiming = response.request().timing();
    finishRequest(
      diagnostics,
      response.request(),
      resourceTiming.responseStart >= 0 ? resourceTiming.responseStart : undefined,
    );
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

function finishRequest(
  diagnostics: BrowserDiagnostics,
  request: Request,
  resourceDurationMs?: number,
): void {
  const timing = diagnostics.requestTimings.get(request);
  if (!timing || timing.finishedAt !== null) {
    return;
  }

  timing.finishedAt = performance.now();
  timing.durationMs = resourceDurationMs ?? timing.finishedAt - timing.startedAt;
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
    // WebSocket 是长生命周期连接，由专用 socket 合同验证，不参与 HTTP 请求的终态和耗时检查。
    if (isLongLivedRequest(request)) {
      continue;
    }
    if (expectedPendingRequests.has(request)) {
      continue;
    }
    const timing = diagnostics.requestTimings.get(request);
    expect(timing).toBeDefined();
    expect(timing?.finishedAt).not.toBeNull();
    expect(timing?.durationMs).not.toBeNull();
    expect(
      timing!.durationMs!,
      `请求终态耗时超过阈值：${request.method()} ${request.url()}`,
    ).toBeLessThan(maxRequestDurationMs);
    expect(terminalRequests.has(request)).toBe(true);
  }
}
