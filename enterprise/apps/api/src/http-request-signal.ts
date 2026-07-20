import type { IncomingMessage } from "node:http";

export interface HttpRequestAbortScope {
  dispose(): void;
  readonly signal: AbortSignal;
}

/**
 * 将浏览器 HTTP 连接绑定到一个显式作用域；响应 owner 在完整 I/O 结束后释放作用域。
 */
export function bindHttpRequestAbortSignal(
  rawRequest: IncomingMessage,
): HttpRequestAbortScope {
  const controller = new AbortController();
  const abort = () => controller.abort(new Error("HTTP request closed"));
  if (rawRequest.aborted || rawRequest.socket.destroyed) {
    abort();
  } else {
    rawRequest.once("aborted", abort);
    rawRequest.socket.once("close", abort);
  }

  return {
    dispose(): void {
      rawRequest.off("aborted", abort);
      rawRequest.socket.off("close", abort);
    },
    signal: controller.signal,
  };
}
