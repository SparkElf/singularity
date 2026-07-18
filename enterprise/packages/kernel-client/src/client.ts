import type { IncomingHttpHeaders, IncomingMessage } from "node:http";
import { request as requestHttps } from "node:https";
import type { Readable } from "node:stream";

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

export interface KernelPrivateContentIdentity {
  readonly documentId: string;
  readonly notebookId: string;
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
  "x-singularity-service-token",
]);
const CONTENT_ID = /^\d{14}-[0-9a-z]{7}$/;

function isForbiddenRequestHeader(name: string): boolean {
  return (
    FORBIDDEN_REQUEST_HEADERS.has(name) ||
    name.startsWith("proxy-") ||
    name.startsWith("x-forwarded-")
  );
}

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
  headers[KERNEL_NOTEBOOK_ID_HEADER] = identity.notebookId;
  headers[KERNEL_DOCUMENT_ID_HEADER] = identity.documentId;
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

  request(input: KernelPrivateRequest): Promise<KernelPrivateResponse> {
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
      const fail = (error: unknown) => {
        if (settled) {
          return;
        }
        settled = true;
        reject(
          error instanceof KernelTransportError
            ? error
            : new KernelTransportError("unavailable", { cause: error }),
        );
      };
      const request = requestHttps(
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
          timeout: this.#timeoutMilliseconds,
        },
        (response) => {
          settled = true;
          resolve({
            headers: selectResponseHeaders(response.headers, policy),
            message: response,
            policy,
            status: response.statusCode ?? 502,
          });
        },
      );
      request.once("error", fail);
      request.once("timeout", () => {
        const error = new KernelTransportError("timeout");
        fail(error);
        request.destroy(error);
      });
      if (input.signal) {
        if (input.signal.aborted) {
          request.destroy(input.signal.reason);
        } else {
          input.signal.addEventListener(
            "abort",
            () => request.destroy(input.signal?.reason),
            { once: true },
          );
        }
      }

      if (input.body === undefined) {
        request.end();
      } else if (typeof input.body === "string" || input.body instanceof Uint8Array) {
        request.end(input.body);
      } else {
        input.body.once("error", (error) => request.destroy(error));
        input.body.pipe(request);
      }
    });
  }
}
