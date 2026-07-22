import type { IncomingHttpHeaders, IncomingMessage } from "node:http";
import { request as requestHttps } from "node:https";
import type { Readable } from "node:stream";

import { z } from "zod";

import { KernelCredentialService } from "./credentials.js";
import type {
  KernelDeploymentIdentity,
  KernelDeploymentRegistry,
} from "./deployment.js";
import { KernelTransportError } from "./errors.js";
import {
  KernelRoutePolicyRegistry,
  type ResolvedKernelRoutePolicy,
} from "./policy.js";

export const KERNEL_NOTEBOOK_ID_HEADER = "x-singularity-notebook-id";
export const KERNEL_DOCUMENT_ID_HEADER = "x-singularity-document-id";
export const KERNEL_ORGANIZATION_ID_HEADER = "x-singularity-organization-id";
export const KERNEL_SPACE_ID_HEADER = "x-singularity-space-id";
export const kernelRequestTimeoutSchema = z.number().int().min(1).max(86_400_000);

export interface KernelPrivateContentIdentity {
  readonly documentId: string;
  readonly notebookId: string;
  readonly organizationId?: string;
  readonly spaceId?: string;
}

export interface KernelPrivateRequest {
  body?: Readable | string | Uint8Array;
  contentIdentity?: KernelPrivateContentIdentity;
  deployment: KernelDeploymentIdentity;
  headers: IncomingHttpHeaders;
  method: string;
  path: string;
  requestId: string;
  signal?: AbortSignal;
  timeoutMilliseconds?: number;
}

export interface KernelPrivateResponse {
  headers: IncomingHttpHeaders;
  message: IncomingMessage;
  policy: ResolvedKernelRoutePolicy;
  status: number;
}

export interface KernelPrivateClientOptions {
  credentials: KernelCredentialService;
  deployments: KernelDeploymentRegistry;
  policies: KernelRoutePolicyRegistry;
  timeoutMilliseconds?: number;
}

const FORBIDDEN_REQUEST_HEADERS = new Set([
  "authorization",
  "connection",
  "cookie",
  "forwarded",
  "host",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "x-auth-token",
  KERNEL_DOCUMENT_ID_HEADER,
  KERNEL_NOTEBOOK_ID_HEADER,
  KERNEL_ORGANIZATION_ID_HEADER,
  KERNEL_SPACE_ID_HEADER,
  "x-singularity-service-token",
]);
const CONTENT_ID = /^\d{14}-[0-9a-z]{7}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isForbiddenRequestHeader(name: string): boolean {
  return (
    FORBIDDEN_REQUEST_HEADERS.has(name) ||
    name.startsWith("proxy-") ||
    name.startsWith("x-forwarded-")
  );
}

/** 只投影路由声明允许的上游请求头，避免浏览器或调用方旁路认证边界。 */
function selectRequestHeaders(
  source: IncomingHttpHeaders,
  policy: ResolvedKernelRoutePolicy,
): Record<string, string | string[]> {
  const selected: Record<string, string | string[]> = {};
  for (const name of policy.requestHeaders) {
    if (isForbiddenRequestHeader(name)) {
      throw new Error("Kernel route policy is unavailable");
    }
    const value = source[name];
    if (typeof value === "string" || Array.isArray(value)) {
      selected[name] = value;
    }
  }
  return selected;
}

/**
 * 在路由策略允许的范围内注入内容身份；服务级路由严禁携带文档身份。
 * 这是跨进程内容请求的唯一身份头构造点，下游直接消费已收敛的头部合同。
 */
function addContentIdentity(
  headers: Record<string, string | string[]>,
  identity: KernelPrivateContentIdentity | undefined,
  policy: ResolvedKernelRoutePolicy,
): void {
  if (policy.identity === "service") {
    if (identity !== undefined) {
      throw new Error("Kernel service route identity is unavailable");
    }
    return;
  }
  if (
    identity === undefined ||
    !CONTENT_ID.test(identity.notebookId) ||
    !CONTENT_ID.test(identity.documentId)
  ) {
    throw new Error("Kernel content identity is unavailable");
  }
  if ((identity.organizationId === undefined) !== (identity.spaceId === undefined)) {
    throw new Error("Kernel content identity is unavailable");
  }
  if (
    policy.identity === "full-content" &&
    (identity.organizationId === undefined || identity.spaceId === undefined)
  ) {
    throw new Error("Kernel full content identity is unavailable");
  }
  if (identity.organizationId !== undefined &&
    (!UUID.test(identity.organizationId) || !UUID.test(identity.spaceId!))) {
    throw new Error("Kernel content identity is unavailable");
  }
  headers[KERNEL_NOTEBOOK_ID_HEADER] = identity.notebookId;
  headers[KERNEL_DOCUMENT_ID_HEADER] = identity.documentId;
  if (identity.organizationId !== undefined && identity.spaceId !== undefined) {
    headers[KERNEL_ORGANIZATION_ID_HEADER] = identity.organizationId;
    headers[KERNEL_SPACE_ID_HEADER] = identity.spaceId;
  }
}

function selectResponseHeaders(
  source: IncomingHttpHeaders,
  policy: ResolvedKernelRoutePolicy,
): IncomingHttpHeaders {
  const selected: IncomingHttpHeaders = {};
  for (const name of policy.responseHeaders) {
    if (name === "set-cookie" || name === "location") {
      continue;
    }
    const value = source[name];
    if (value !== undefined) {
      selected[name] = value;
    }
  }
  return selected;
}

export class KernelPrivateClient {
  readonly #credentials: KernelCredentialService;
  readonly #deployments: KernelDeploymentRegistry;
  readonly #policies: KernelRoutePolicyRegistry;
  readonly #timeoutMilliseconds: number;

  constructor(options: KernelPrivateClientOptions) {
    this.#credentials = options.credentials;
    this.#deployments = options.deployments;
    this.#policies = options.policies;
    this.#timeoutMilliseconds = options.timeoutMilliseconds ?? 15_000;
    if (
      !Number.isInteger(this.#timeoutMilliseconds) ||
      this.#timeoutMilliseconds < 1 ||
      this.#timeoutMilliseconds > 60_000
    ) {
      throw new Error("Kernel client configuration is unavailable");
    }
  }

  /**
   * 通过已解析部署句柄发起单次 mTLS 请求，并把请求体、响应流和 AbortSignal 绑定到同一生命周期。
   * 返回响应头后仍由消费者负责消费或销毁响应体，直到流结束前不能解除取消监听。
   */
  request(input: KernelPrivateRequest): Promise<KernelPrivateResponse> {
    if (input.signal?.aborted) {
      const reason: unknown = input.signal.reason;
      return Promise.reject(
        new KernelTransportError("unavailable", {
          cause: reason,
        }),
      );
    }
    const timeoutMilliseconds =
      input.timeoutMilliseconds ?? this.#timeoutMilliseconds;
    if (!kernelRequestTimeoutSchema.safeParse(timeoutMilliseconds).success) {
      throw new Error("Kernel request timeout is unavailable");
    }
    const policy = this.#policies.resolve(input.method, input.path);
    const deployment = this.#deployments.resolve(input.deployment);
    const headers = selectRequestHeaders(input.headers, policy);
    addContentIdentity(headers, input.contentIdentity, policy);
    headers["x-singularity-request-id"] = input.requestId;
    headers["x-singularity-service-token"] = this.#credentials.sign({
      kernelInstanceId: deployment.kernelInstanceId,
      requestId: input.requestId,
      spaceId: deployment.spaceId,
    });

    return new Promise((resolve, reject) => {
      let settled = false;
      let response: IncomingMessage | undefined;
      // 请求与监听器在 cleanup 闭包创建后一次绑定，确保同步失败也能统一释放。
      // eslint-disable-next-line prefer-const
      let request: ReturnType<typeof requestHttps>;
      // eslint-disable-next-line prefer-const
      let onRequestError: ((error: Error) => void) | undefined;
      // eslint-disable-next-line prefer-const
      let onRequestTimeout: (() => void) | undefined;
      let onAbort: (() => void) | undefined;
      let onBodyError: ((error: Error) => void) | undefined;
      let onResponseEnd: (() => void) | undefined;

      const destroyBody = (error?: Error): void => {
        if (
          input.body !== undefined &&
          typeof input.body !== "string" &&
          !(input.body instanceof Uint8Array) &&
          !input.body.destroyed
        ) {
          input.body.destroy(error);
        }
      };

      const cleanup = (): void => {
        if (onRequestError !== undefined) {
          request.off("error", onRequestError);
        }
        if (onRequestTimeout !== undefined) {
          request.off("timeout", onRequestTimeout);
        }
        if (onAbort !== undefined) {
          input.signal?.removeEventListener("abort", onAbort);
        }
        if (
          onBodyError !== undefined &&
          input.body !== undefined &&
          typeof input.body !== "string" &&
          !(input.body instanceof Uint8Array)
        ) {
          input.body.off("error", onBodyError);
        }
        if (response !== undefined && onResponseEnd !== undefined) {
          response.off("end", onResponseEnd);
          response.off("close", onResponseEnd);
          response.off("aborted", onResponseEnd);
          response.off("error", onResponseEnd);
        }
      };

      const fail = (error: unknown): void => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        destroyBody(error instanceof Error ? error : undefined);
        reject(
          error instanceof KernelTransportError
            ? error
            : new KernelTransportError("unavailable", { cause: error }),
        );
      };

      request = requestHttps(
        {
          agent: false,
          ca: deployment.tls.caCertificate,
          cert: deployment.tls.clientCertificate,
          headers,
          hostname: deployment.hostname,
          key: deployment.tls.clientPrivateKey,
          method: policy.method,
          minVersion: "TLSv1.3",
          path: input.path,
          port: deployment.port,
          rejectUnauthorized: true,
          servername: deployment.serverName,
          timeout: timeoutMilliseconds,
        },
        (incomingResponse) => {
          response = incomingResponse;
          settled = true;
          onResponseEnd = (): void => cleanup();
          incomingResponse.once("end", onResponseEnd);
          incomingResponse.once("close", onResponseEnd);
          incomingResponse.once("aborted", onResponseEnd);
          incomingResponse.once("error", onResponseEnd);
          resolve({
            headers: selectResponseHeaders(incomingResponse.headers, policy),
            message: incomingResponse,
            policy,
            status: incomingResponse.statusCode ?? 502,
          });
        },
      );
      onRequestError = (error: Error): void => fail(error);
      request.once("error", onRequestError);
      onRequestTimeout = (): void => {
        const error = new KernelTransportError("timeout");
        fail(error);
        request.destroy(error);
      };
      request.once("timeout", onRequestTimeout);
      if (input.signal) {
        onAbort = (): void => {
          const reason: unknown = input.signal?.reason;
          const abortError =
            reason instanceof Error
              ? reason
              : new KernelTransportError("unavailable", { cause: reason });
          destroyBody(abortError);
          request.destroy(abortError);
          response?.destroy(abortError);
        };
        input.signal.addEventListener("abort", onAbort, { once: true });
      }

      if (input.body === undefined) {
        request.end();
      } else if (
        typeof input.body === "string" ||
        input.body instanceof Uint8Array
      ) {
        request.end(input.body);
      } else {
        onBodyError = (error: Error): void => {
          fail(error);
          request.destroy(error);
        };
        input.body.once("error", onBodyError);
        input.body.pipe(request);
      }
    });
  }
}
