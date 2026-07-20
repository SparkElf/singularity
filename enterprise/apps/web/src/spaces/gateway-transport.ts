import {
  apiProblemSchema,
  CSRF_HEADER_NAME,
  RUNTIME_ACCESS_LOST_HEADER_NAME,
  RUNTIME_ACCESS_LOST_HEADER_VALUE,
  type ApiProblem,
} from "@singularity/contracts";
import type {
  ProtyleRequestOptions,
  ProtyleRuntimeErrorEvent,
  ProtyleSubscription,
  ProtyleSubscriptionOptions,
  ProtyleTransport,
  ProtyleUploadOptions,
} from "@singularity/protyle-browser";

import { isApiProblem, NetworkFailureError } from "@/api/http.ts";
import {
  buildKernelApiPath,
  buildKernelUploadPath,
  buildKernelWebSocketUrl,
  DOCUMENT_ID_HEADER_NAME,
  NOTEBOOK_ID_HEADER_NAME,
  type SpaceGatewayIdentity,
} from "@/spaces/gateway-paths.ts";

export interface SpaceGatewayTransport<TMessage> extends ProtyleTransport<TMessage> {
  freeze: () => void;
  resumeSubmission: () => void;
}

interface CreateSpaceGatewayTransportOptions {
  readonly getCsrfToken: (signal: AbortSignal) => Promise<string>;
  readonly onRuntimeError: (event: ProtyleRuntimeErrorEvent) => void;
  readonly space: SpaceGatewayIdentity;
}

export class GatewayResponseError extends Error {
  readonly problem: ApiProblem | null;
  readonly status: number;
  readonly triggeringRequestId: string | undefined;

  constructor(
    status: number,
    triggeringRequestId: string | undefined,
    problem: ApiProblem | null,
    cause?: unknown,
  ) {
    super(
      problem?.code ?? `Gateway returned HTTP ${status}`,
      cause === undefined ? undefined : { cause },
    );
    this.name = "GatewayResponseError";
    this.problem = problem;
    this.status = status;
    this.triggeringRequestId = triggeringRequestId;
  }
}

interface ParsedProblem {
  readonly cause?: unknown;
  readonly problem: ApiProblem | null;
}

interface GatewayErrorLogContext {
  readonly documentId: string;
  readonly phase: string;
  readonly spaceId: string;
  readonly status?: number;
  readonly triggeringRequestId?: string;
}

function logGatewayError(
  context: GatewayErrorLogContext,
  error: unknown,
): void {
  console.error("[protyle.gateway]", context, error);
}

export class GatewayProtocolError extends Error {
  readonly status: number;
  readonly triggeringRequestId: string | undefined;

  constructor(
    status: number,
    triggeringRequestId: string | undefined,
    cause: unknown,
  ) {
    super("Gateway response did not match the Protyle transport contract", { cause });
    this.name = "GatewayProtocolError";
    this.status = status;
    this.triggeringRequestId = triggeringRequestId;
  }
}

function rangeHeader(options: ProtyleRequestOptions): string | null {
  if (!options.range) {
    return null;
  }
  const { end, start } = options.range;
  if (
    !Number.isSafeInteger(start) ||
    start < 0 ||
    (end !== undefined && (!Number.isSafeInteger(end) || end < start))
  ) {
    throw new Error("[protyle.gateway] byte range is not canonical");
  }
  return `bytes=${start}-${end ?? ""}`;
}

/** 解析 Gateway 的公开错误合同；响应不是合法 Problem 时保留 Zod 原始异常供日志和 cause 链使用。 */
async function parseProblem(
  response: Response,
  context: Omit<GatewayErrorLogContext, "phase" | "status">,
): Promise<ParsedProblem> {
  let body: unknown;
  try {
    body = await response.json();
  } catch (error) {
    logGatewayError({
      ...context,
      phase: "problem-response-json",
      status: response.status,
    }, error);
    return { cause: error, problem: null };
  }
  const parsed = parseProblemValue(body);
  if (parsed.cause !== undefined) {
    logGatewayError({
      ...context,
      phase: "problem-response-contract",
      status: response.status,
    }, parsed.cause);
  }
  return parsed;
}

function parseProblemValue(body: unknown): ParsedProblem {
  const parsed = apiProblemSchema.safeParse(body);
  return parsed.success
    ? { problem: parsed.data }
    : { cause: parsed.error, problem: null };
}

function isRuntimeAccessLost(value: string | null): boolean {
  return value === RUNTIME_ACCESS_LOST_HEADER_VALUE;
}

/** 创建绑定单一空间身份的 Protyle 传输层，统一处理 CSRF、HTTP、上传、WebSocket 和生命周期冻结。 */
export function createSpaceGatewayTransport<TMessage>(
  options: CreateSpaceGatewayTransportOptions,
): SpaceGatewayTransport<TMessage> {
  const lifecycle = new AbortController();
  const subscriptions = new Set<() => void>();
  let disposed = false;
  let frozen = false;
  let submissionBlocked = false;
  let terminalErrorReported = false;

  /** 在发起请求前检查传输是否仍属于当前空间代次，以及写入是否被暂时阻断。 */
  const assertAvailable = (intent: ProtyleRequestOptions["intent"]) => {
    if (disposed) {
      throw new Error("[protyle.transport] cannot use a disposed transport");
    }
    if (frozen) {
      throw new Error("[protyle.transport] commands are frozen");
    }
    if (submissionBlocked && intent === "write") {
      throw new Error("[protyle.transport] submission is blocked until explicit retry");
    }
  };

  const closeSubscriptions = () => {
    subscriptions.forEach((disconnect) => disconnect());
    subscriptions.clear();
  };

  /** 终止当前空间的请求和订阅，防止旧空间事件在权限变化后继续抵达编辑器。 */
  const freeze = () => {
    if (frozen) {
      return;
    }
    frozen = true;
    lifecycle.abort();
    closeSubscriptions();
  };

  const reportRuntimeError = (
    category: ProtyleRuntimeErrorEvent["category"],
    documentId: string,
    triggeringRequestId?: string,
  ) => {
    const terminal = category === "unauthenticated" || category === "forbidden";
    if (terminal) {
      if (terminalErrorReported) {
        return;
      }
      terminalErrorReported = true;
      freeze();
    } else {
      submissionBlocked = true;
    }
    console.warn("[protyle.lifecycle]", {
      category,
      documentId,
      phase: "transport",
      spaceId: options.space.spaceId,
      ...(triggeringRequestId ? { triggeringRequestId } : {}),
    });
    options.onRuntimeError({
      category,
      documentId,
      type: "runtime-error",
      ...(triggeringRequestId ? { triggeringRequestId } : {}),
    });
  };

  const reportResponseError = (
    status: number,
    runtimeAccessLost: boolean,
    documentId: string,
    triggeringRequestId?: string,
  ): void => {
    if (status === 401) {
      reportRuntimeError(
        "unauthenticated",
        documentId,
        triggeringRequestId,
      );
    } else if (status === 403 || runtimeAccessLost) {
      reportRuntimeError("forbidden", documentId, triggeringRequestId);
    } else if ([502, 503, 504].includes(status)) {
      reportRuntimeError(
        "kernel-unavailable",
        documentId,
        triggeringRequestId,
      );
    }
  };

  /** 发送带完整文档/笔记本身份的 Kernel API 请求，并将协议错误转换为可诊断异常。 */
  const request = async <TResponse>(
    path: string,
    body: unknown,
    requestOptions: ProtyleRequestOptions,
  ): Promise<TResponse> => {
    assertAvailable(requestOptions.intent);
    const signal = requestOptions.signal
      ? AbortSignal.any([lifecycle.signal, requestOptions.signal])
      : lifecycle.signal;

    let csrfToken: string;
    try {
      csrfToken = await options.getCsrfToken(signal);
    } catch (error) {
      if (!signal.aborted) {
        logGatewayError({
          documentId: requestOptions.identity.documentId,
          phase: "request-csrf",
          spaceId: options.space.spaceId,
        }, error);
        if (isApiProblem(error, "unauthenticated")) {
          reportRuntimeError(
            "unauthenticated",
            requestOptions.identity.documentId,
            error.problem.requestId,
          );
        } else if (error instanceof NetworkFailureError) {
          reportRuntimeError("network-failure", requestOptions.identity.documentId);
        }
      }
      throw error;
    }

    assertAvailable(requestOptions.intent);
    const headers = new Headers({
      Accept: requestOptions.responseType === "blob"
        ? "application/octet-stream"
        : "application/json",
      "Content-Type": "application/json",
      [CSRF_HEADER_NAME]: csrfToken,
      [DOCUMENT_ID_HEADER_NAME]: requestOptions.identity.documentId,
      [NOTEBOOK_ID_HEADER_NAME]: requestOptions.identity.notebookId,
    });
    const range = rangeHeader(requestOptions);
    if (range) {
      headers.set("Range", range);
    }
    const serializedBody = body === undefined ? null : JSON.stringify(body);
    if (serializedBody === undefined) {
      throw new Error("[protyle.gateway] request body is not JSON serializable");
    }

    let response: Response;
    try {
      response = await fetch(buildKernelApiPath(options.space, path), {
        body: serializedBody,
        credentials: "same-origin",
        headers,
        method: "POST",
        redirect: "error",
        signal,
      });
    } catch (error) {
      if (!signal.aborted) {
        logGatewayError({
          documentId: requestOptions.identity.documentId,
          phase: "request-network",
          spaceId: options.space.spaceId,
        }, error);
        reportRuntimeError("network-failure", requestOptions.identity.documentId);
      }
      throw error;
    }

    const headerRequestId = response.headers.get("X-Request-Id") ?? undefined;
    const parsedProblem: ParsedProblem = response.ok
      ? { problem: null }
      : await parseProblem(response, {
          documentId: requestOptions.identity.documentId,
          spaceId: options.space.spaceId,
          ...(headerRequestId === undefined
            ? {}
            : { triggeringRequestId: headerRequestId }),
        });
    const problem = parsedProblem.problem;
    const responseRequestId = problem?.requestId
      ?? headerRequestId;
    if (!response.ok) {
      reportResponseError(
        response.status,
        isRuntimeAccessLost(
          response.headers.get(RUNTIME_ACCESS_LOST_HEADER_NAME),
        ),
        requestOptions.identity.documentId,
        responseRequestId,
      );
      throw new GatewayResponseError(
        response.status,
        responseRequestId,
        problem,
        parsedProblem.cause,
      );
    }

    if (response.status === 204) {
      return undefined as TResponse;
    }
    if (requestOptions.responseType === "blob") {
      return await response.blob() as TResponse;
    }
    try {
      return await response.json() as TResponse;
    } catch (error) {
      logGatewayError({
        documentId: requestOptions.identity.documentId,
        phase: "request-response-json",
        spaceId: options.space.spaceId,
        status: response.status,
        ...(responseRequestId === undefined
          ? {}
          : { triggeringRequestId: responseRequestId }),
      }, error);
      reportRuntimeError(
        "kernel-unavailable",
        requestOptions.identity.documentId,
        responseRequestId,
      );
      throw new GatewayProtocolError(response.status, responseRequestId, error);
    }
  };

  /** 使用 XHR 保留上传进度，同时让取消、权限失效和响应合同共享同一生命周期。 */
  const upload = async <TResponse>(
    body: FormData,
    uploadOptions: ProtyleUploadOptions,
  ): Promise<TResponse> => {
    assertAvailable("write");
    const signal = uploadOptions.signal
      ? AbortSignal.any([lifecycle.signal, uploadOptions.signal])
      : lifecycle.signal;

    let csrfToken: string;
    try {
      csrfToken = await options.getCsrfToken(signal);
    } catch (error) {
      if (!signal.aborted) {
        logGatewayError({
          documentId: uploadOptions.identity.documentId,
          phase: "upload-csrf",
          spaceId: options.space.spaceId,
        }, error);
        if (isApiProblem(error, "unauthenticated")) {
          reportRuntimeError(
            "unauthenticated",
            uploadOptions.identity.documentId,
            error.problem.requestId,
          );
        } else if (error instanceof NetworkFailureError) {
          reportRuntimeError("network-failure", uploadOptions.identity.documentId);
        }
      }
      throw error;
    }

    assertAvailable("write");
    return await new Promise<TResponse>((resolve, reject) => {
      const request = new XMLHttpRequest();
      let settled = false;

      const finish = (callback: () => void) => {
        if (settled) {
          return;
        }
        settled = true;
        signal.removeEventListener("abort", abort);
        request.onload = null;
        request.onerror = null;
        request.onabort = null;
        request.upload.onprogress = null;
        callback();
      };
      const rejectAbort = () => {
        const reason: unknown = signal.reason ?? new DOMException("Gateway upload was aborted", "AbortError");
        finish(() => reject(
          reason instanceof Error ? reason : new Error(String(reason), { cause: reason }),
        ));
      };
      const abort = () => {
        request.abort();
        rejectAbort();
      };

      request.open("POST", buildKernelUploadPath(options.space));
      request.setRequestHeader("Accept", "application/json");
      request.setRequestHeader(CSRF_HEADER_NAME, csrfToken);
      request.setRequestHeader(
        DOCUMENT_ID_HEADER_NAME,
        uploadOptions.identity.documentId,
      );
      request.setRequestHeader(
        NOTEBOOK_ID_HEADER_NAME,
        uploadOptions.identity.notebookId,
      );
      request.upload.onprogress = (event) => {
        uploadOptions.onProgress?.({
          loadedBytes: event.loaded,
          ...(event.lengthComputable ? { totalBytes: event.total } : {}),
        });
      };
      request.onerror = () => {
        if (!signal.aborted) {
          reportRuntimeError("network-failure", uploadOptions.identity.documentId);
        }
        finish(() => reject(new NetworkFailureError(
          new Error("Gateway upload request failed"),
        )));
      };
      request.onabort = () => {
        rejectAbort();
      };
      request.onload = () => {
        let responseBody: unknown;
        let responseCause: unknown;
        try {
          responseBody = request.status === 204 || request.responseText === ""
            ? undefined
            : JSON.parse(request.responseText);
        } catch (error) {
          responseCause = error;
        }

        const successful = request.status >= 200 && request.status < 300;
        const parsedProblem: ParsedProblem = successful
          ? { problem: null }
          : responseCause === undefined
            ? parseProblemValue(responseBody)
            : { cause: responseCause, problem: null };
        const problem = parsedProblem.problem;
        const responseRequestId = problem?.requestId
          ?? request.getResponseHeader("X-Request-Id")
          ?? undefined;
        const protocolCause = responseCause ?? parsedProblem.cause;
        if (protocolCause !== undefined) {
          logGatewayError({
            documentId: uploadOptions.identity.documentId,
            phase: responseCause === undefined
              ? "upload-problem-contract"
              : "upload-response-json",
            spaceId: options.space.spaceId,
            status: request.status,
            ...(responseRequestId === undefined
              ? {}
              : { triggeringRequestId: responseRequestId }),
          }, protocolCause);
        }
        if (!successful) {
          finish(() => reject(new GatewayResponseError(
            request.status,
            responseRequestId,
            problem,
            protocolCause,
          )));
          reportResponseError(
            request.status,
            isRuntimeAccessLost(
              request.getResponseHeader(RUNTIME_ACCESS_LOST_HEADER_NAME),
            ),
            uploadOptions.identity.documentId,
            responseRequestId,
          );
          return;
        }
        if (responseCause !== undefined) {
          reportRuntimeError(
            "kernel-unavailable",
            uploadOptions.identity.documentId,
            responseRequestId,
          );
          finish(() => reject(new GatewayProtocolError(
            request.status,
            responseRequestId,
            responseCause,
          )));
          return;
        }
        if (request.status !== 204 && responseBody === undefined) {
          const error = new Error("Gateway upload response was empty");
          logGatewayError({
            documentId: uploadOptions.identity.documentId,
            phase: "upload-response-empty",
            spaceId: options.space.spaceId,
            status: request.status,
            ...(responseRequestId === undefined
              ? {}
              : { triggeringRequestId: responseRequestId }),
          }, error);
          reportRuntimeError(
            "kernel-unavailable",
            uploadOptions.identity.documentId,
            responseRequestId,
          );
          finish(() => reject(new GatewayProtocolError(
            request.status,
            responseRequestId,
            error,
          )));
          return;
        }
        finish(() => resolve(responseBody as TResponse));
      };

      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) {
        abort();
        return;
      }
      request.send(body);
    });
  };

  /** 建立绑定当前文档身份的 WebSocket 订阅，关闭时撤销所有迟到消息处理器。 */
  const subscribe = (
    subscriptionOptions: ProtyleSubscriptionOptions<TMessage>,
  ): ProtyleSubscription => {
    assertAvailable("read");
    const socket = new WebSocket(
      buildKernelWebSocketUrl(options.space, subscriptionOptions),
    );
    let active = true;

    const disconnect = () => {
      if (!active) {
        return;
      }
      active = false;
      subscriptions.delete(disconnect);
      socket.onclose = null;
      socket.onmessage = null;
      if (socket.readyState === WebSocket.CONNECTING || socket.readyState === WebSocket.OPEN) {
        socket.close(1000, "client-disconnect");
      }
    };

    socket.onmessage = (event) => {
      if (!active) {
        return;
      }
      if (typeof event.data !== "string") {
        disconnect();
        reportRuntimeError(
          "kernel-unavailable",
          subscriptionOptions.documentId,
        );
        return;
      }
      let message: TMessage;
      try {
        message = JSON.parse(event.data) as TMessage;
      } catch (error) {
        logGatewayError({
          documentId: subscriptionOptions.documentId,
          phase: "websocket-message-json",
          spaceId: options.space.spaceId,
        }, error);
        disconnect();
        reportRuntimeError(
          "kernel-unavailable",
          subscriptionOptions.documentId,
        );
        return;
      }
      subscriptionOptions.onMessage(message);
    };
    socket.onclose = (event) => {
      if (!active) {
        return;
      }
      active = false;
      subscriptions.delete(disconnect);
      if (event.code === 1000) {
        return;
      }
      if (event.code === 4401) {
        reportRuntimeError("unauthenticated", subscriptionOptions.documentId);
      } else if (event.code === 4403 || event.code === 4408) {
        reportRuntimeError("forbidden", subscriptionOptions.documentId);
      } else if (event.code === 1006) {
        reportRuntimeError("network-failure", subscriptionOptions.documentId);
      } else {
        reportRuntimeError("kernel-unavailable", subscriptionOptions.documentId);
      }
    };

    subscriptions.add(disconnect);
    return { disconnect };
  };

  return {
    dispose: () => {
      if (disposed) {
        return;
      }
      disposed = true;
      freeze();
    },
    freeze,
    request,
    resumeSubmission: () => {
      if (disposed || frozen) {
        throw new Error("[protyle.transport] cannot resume a terminal transport");
      }
      submissionBlocked = false;
    },
    subscribe,
    upload,
  };
}
