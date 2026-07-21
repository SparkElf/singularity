import type {
  IncomingHttpHeaders,
  IncomingMessage,
  ServerResponse,
} from "node:http";
import { basename } from "node:path";
import { performance } from "node:perf_hooks";

import { Injectable, Logger } from "@nestjs/common";
import type { KernelAuditMode } from "@singularity/authorization";
import type { ContentAuditAction } from "@singularity/contracts";
import {
  KernelPrivateClient,
  KernelTransportError,
} from "@singularity/kernel-client";

import {
  ContentAuditIntentService,
  type ObservedContentAuditOutcome,
} from "../audit/content-audit-intent.service.js";
import { DocumentAccessPolicyService } from "../document-access/document-access.service.js";
import {
  ApiProblemError,
  conflict,
  notFound,
  validationFailed,
} from "../problem.js";
import type { KernelGatewayTarget } from "./gateway-path.js";
import { KERNEL_JSON_MAXIMUM_BODY_BYTES } from "./install-http-boundary.js";
import { KernelAccessService } from "./kernel-access.service.js";

export interface KernelGatewayProxyRequest {
  readonly body: unknown;
  readonly headers: IncomingHttpHeaders;
  readonly requestId: string;
  readonly signal: AbortSignal;
  readonly target: KernelGatewayTarget;
  readonly userId: string;
}

export interface KernelGatewayProxyReply {
  hijack(): void;
  readonly raw: ServerResponse;
}

const INLINE_CONTENT_TYPES = new Set([
  "image/avif",
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
  "audio/aac",
  "audio/flac",
  "audio/mpeg",
  "audio/ogg",
  "audio/wav",
  "video/mp4",
  "video/ogg",
  "video/webm",
]);

function normalizedContentType(headers: IncomingHttpHeaders): string | null {
  const value = headers["content-type"];
  if (typeof value !== "string") {
    return null;
  }
  const mediaType = value.split(";", 1)[0]?.trim().toLowerCase();
  return mediaType && mediaType.length > 0 ? mediaType : null;
}

function safeFileName(path: string): {
  readonly decodeError?: unknown;
  readonly value: string;
} {
  let decoded: string;
  let decodeError: unknown;
  try {
    decoded = decodeURIComponent(basename(path.split("?", 1)[0] ?? "download"));
  } catch (error) {
    decodeError = error;
    decoded = "download";
  }
  const sanitized = decoded.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120);
  return {
    ...(decodeError === undefined ? {} : { decodeError }),
    value:
      sanitized.length === 0 || sanitized === "." || sanitized === ".."
        ? "download"
        : sanitized,
  };
}

function serializedBody(body: unknown): string | Uint8Array | undefined {
  if (body === undefined || body === null) {
    return body === null ? "null" : undefined;
  }
  if (typeof body === "string" || body instanceof Uint8Array) {
    return body;
  }
  return JSON.stringify(body);
}

function transactionDeletesContent(body: unknown): boolean {
  if (typeof body !== "object" || body === null || !("transactions" in body)) {
    return false;
  }
  const transactions = body.transactions;
  if (!Array.isArray(transactions)) {
    return false;
  }
  return transactions.some((transaction: unknown) => {
    if (
      typeof transaction !== "object" ||
      transaction === null ||
      !("doOperations" in transaction) ||
      !Array.isArray(transaction.doOperations)
    ) {
      return false;
    }
    const doOperations = transaction.doOperations;
    return doOperations.some(
      (operation: unknown) =>
        typeof operation === "object" &&
        operation !== null &&
        "action" in operation &&
        operation.action === "delete",
    );
  });
}

function auditAction(
  mode: KernelAuditMode | undefined,
  body: unknown,
): ContentAuditAction | null {
  if (mode === undefined) {
    return null;
  }
  if (mode === "content.mutation") {
    return transactionDeletesContent(body)
      ? "content.delete"
      : "content.edit";
  }
  return mode;
}

/** 读取有界的 Kernel JSON 响应；超限或解析失败时关闭上游流并把原始异常交给调用方。 */
async function readKernelJsonResult(message: IncomingMessage): Promise<{
  readonly body: Buffer;
  readonly code: number;
}> {
  const chunks: Buffer[] = [];
  let sizeBytes = 0;
  try {
    for await (const chunk of message) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      sizeBytes += bytes.byteLength;
      if (sizeBytes > KERNEL_JSON_MAXIMUM_BODY_BYTES) {
        const error = new Error("Kernel JSON response exceeded the size limit");
        message.destroy();
        throw new ApiProblemError("service-unavailable", 502, undefined, {
          cause: error,
        });
      }
      chunks.push(bytes as Buffer<ArrayBufferLike>);
    }
  } catch (error) {
    message.destroy();
    if (error instanceof ApiProblemError) {
      throw error;
    }
    throw new ApiProblemError("service-unavailable", 502, undefined, {
      cause: error,
    });
  }
  const body = Buffer.concat(chunks);
  let value: unknown;
  try {
    value = JSON.parse(body.toString("utf8"));
  } catch (error) {
    message.destroy();
    throw new ApiProblemError("service-unavailable", 502, undefined, {
      cause: error,
    });
  }
  if (
    typeof value !== "object" ||
    value === null ||
    !("code" in value) ||
    typeof value.code !== "number" ||
    !Number.isInteger(value.code)
  ) {
    const error = new Error("Kernel JSON response did not contain a valid code");
    message.destroy();
    throw new ApiProblemError("service-unavailable", 502, undefined, {
      cause: error,
    });
  }
  return { body, code: value.code };
}

function kernelResultProblem(code: number): ApiProblemError | null {
  if (code === 0) {
    return null;
  }
  if (code === 400) {
    return validationFailed();
  }
  if (code === 404) {
    return notFound();
  }
  if (code === 409) {
    return conflict();
  }
  if (code === 422) {
    return new ApiProblemError("validation-failed", 422);
  }
  if (code >= 500) {
    return new ApiProblemError(
      "service-unavailable",
      code === 503 || code === 504 ? code : 502,
    );
  }
  return new ApiProblemError("validation-failed", 422);
}

function upstreamProblem(status: number): ApiProblemError | null {
  if (status === 400 || status === 422) {
    return validationFailed();
  }
  if (status === 404) {
    return notFound();
  }
  if (status === 409) {
    return conflict();
  }
  if (status === 401 || status === 403 || (status >= 300 && status < 400)) {
    return new ApiProblemError("service-unavailable", 502);
  }
  if (status >= 500) {
    return new ApiProblemError(
      "service-unavailable",
      status === 503 || status === 504 ? status : 502,
    );
  }
  if (status >= 400) {
    return validationFailed();
  }
  return null;
}

function isExplicitKernelHttpRejection(status: number): boolean {
  return (
    status >= 400 &&
    status < 500 &&
    status !== 401 &&
    status !== 403
  );
}

@Injectable()
export class KernelGatewayService {
  readonly #logger = new Logger("KernelGateway");

  constructor(
    private readonly access: KernelAccessService,
    private readonly client: KernelPrivateClient,
    private readonly contentAudit: ContentAuditIntentService,
    private readonly documentAccess: DocumentAccessPolicyService,
  ) {}

  /** 按路由策略完成授权、审计、Kernel 请求及响应转发，并维持流式响应的生命周期。 */
  async proxy(
    input: KernelGatewayProxyRequest,
    reply: KernelGatewayProxyReply,
  ): Promise<void> {
    const startedAt = performance.now();
    await this.documentAccess.requireDocumentRole(
      {
        actorUserId: input.userId,
        documentId: input.target.identity.documentId,
        notebookId: input.target.identity.notebookId,
        organizationId: input.target.organizationId,
        spaceId: input.target.spaceId,
      },
      input.target.policy.action === "read" ? "viewer" : "editor",
    );
    const authorized = await this.access.authorizeHttp({
      action: input.target.policy.action,
      organizationId: input.target.organizationId,
      requestId: input.requestId,
      spaceId: input.target.spaceId,
      userId: input.userId,
    });

    const body = serializedBody(input.body);
    const contentAuditAction = auditAction(
      input.target.policy.audit,
      input.body,
    );
    if (contentAuditAction !== null) {
      await this.#prepareContentAudit(input, contentAuditAction, startedAt);
    }
    let upstream;
    try {
      upstream = await this.client.request({
        ...(body === undefined ? {} : { body }),
        contentIdentity: input.target.identity,
        deployment: authorized.deployment,
        headers: input.headers,
        method: input.target.policy.method,
        path: input.target.upstreamPath,
        requestId: input.requestId,
        signal: input.signal,
      });
    } catch (error) {
      const status =
        error instanceof KernelTransportError && error.failure === "timeout"
          ? 504
          : 502;
      this.#log(
        input,
        "upstream-unavailable",
        status,
        startedAt,
        authorized.deployment.kernelInstanceId,
        error,
      );
      this.#deferContentAudit(
        input,
        contentAuditAction,
        "kernel-result-indeterminate",
        startedAt,
      );
      throw new ApiProblemError("service-unavailable", status, undefined, {
        cause: error,
      });
    }

    const problem = upstreamProblem(upstream.status);
    if (problem !== null) {
      const cause = new Error(`Kernel returned HTTP ${upstream.status}`);
      upstream.message.destroy();
      this.#log(
        input,
        "upstream-rejected",
        problem.status,
        startedAt,
        authorized.deployment.kernelInstanceId,
        cause,
      );
      if (isExplicitKernelHttpRejection(upstream.status)) {
        await this.#resolveContentAudit(
          input,
          contentAuditAction,
          "failed",
          startedAt,
        );
      } else {
        this.#deferContentAudit(
          input,
          contentAuditAction,
          "kernel-result-indeterminate",
          startedAt,
        );
      }
      throw new ApiProblemError(
        problem.code,
        problem.status,
        problem.retryAfter,
        { cause },
      );
    }
    if (
      (input.target.surface === "api" || input.target.surface === "upload") &&
      upstream.status !== 204 &&
      normalizedContentType(upstream.headers) !== "application/json"
    ) {
      const cause = new Error("Kernel returned a non-JSON response");
      upstream.message.destroy();
      this.#log(
        input,
        "upstream-rejected",
        502,
        startedAt,
        authorized.deployment.kernelInstanceId,
        cause,
      );
      this.#deferContentAudit(
        input,
        contentAuditAction,
        "kernel-response-invalid",
        startedAt,
      );
      throw new ApiProblemError("service-unavailable", 502, undefined, {
        cause,
      });
    }
    if (
      (input.target.surface === "api" || input.target.surface === "upload") &&
      upstream.status !== 204
    ) {
      let result: Awaited<ReturnType<typeof readKernelJsonResult>>;
      try {
        result = await readKernelJsonResult(upstream.message);
      } catch (error) {
        this.#log(
          input,
          "upstream-rejected",
          502,
          startedAt,
          authorized.deployment.kernelInstanceId,
          error,
        );
        this.#deferContentAudit(
          input,
          contentAuditAction,
          "kernel-response-invalid",
          startedAt,
        );
        throw error instanceof ApiProblemError
          ? error
          : new ApiProblemError("service-unavailable", 502, undefined, {
              cause: error,
            });
      }
      const resultProblem = kernelResultProblem(result.code);
      if (resultProblem !== null) {
        this.#log(
          input,
          "upstream-rejected",
          resultProblem.status,
          startedAt,
          authorized.deployment.kernelInstanceId,
        );
        if (result.code >= 500) {
          this.#deferContentAudit(
            input,
            contentAuditAction,
            "kernel-result-indeterminate",
            startedAt,
          );
        } else {
          await this.#resolveContentAudit(
            input,
            contentAuditAction,
            "failed",
            startedAt,
          );
        }
        throw resultProblem;
      }
      await this.#resolveContentAudit(
        input,
        contentAuditAction,
        "succeeded",
        startedAt,
      );
      this.#sendBufferedResponse(
        input,
        reply,
        upstream.headers,
        upstream.status,
        result.body,
        startedAt,
        authorized.deployment.kernelInstanceId,
      );
      return;
    }
    await this.#resolveContentAudit(
      input,
      contentAuditAction,
      "succeeded",
      startedAt,
    );

    reply.hijack();
    const response = reply.raw;
    response.statusCode = upstream.status;
    this.#applyResponseHeaders(
      input.target,
      upstream.headers,
      response,
      input.requestId,
    );
    upstream.message.once("error", (error) => {
      this.#logger.error({
        canonicalRoute: input.target.policy.path,
        durationMilliseconds: performance.now() - startedAt,
        error,
        event: "kernel.route-stream",
        kernelInstanceId: authorized.deployment.kernelInstanceId,
        outcome: "failed",
        requestId: input.requestId,
        spaceId: input.target.spaceId,
        status: upstream.status,
      });
      response.destroy();
    });
    response.once("close", () => upstream.message.destroy());
    upstream.message.pipe(response);
    this.#log(
      input,
      "proxied",
      upstream.status,
      startedAt,
      authorized.deployment.kernelInstanceId,
    );
  }

  /** 在写入请求发往 Kernel 前登记待解析的审计意图，失败时阻止请求继续执行。 */
  async #prepareContentAudit(
    input: KernelGatewayProxyRequest,
    action: ContentAuditAction,
    startedAt: number,
  ): Promise<void> {
    try {
      await this.contentAudit.prepare({
        action,
        actorUserId: input.userId,
        documentId: input.target.identity.documentId,
        organizationId: input.target.organizationId,
        requestId: input.requestId,
        spaceId: input.target.spaceId,
      });
    } catch (error) {
      this.#logger.error({
        action,
        canonicalRoute: input.target.policy.path,
        durationMilliseconds: performance.now() - startedAt,
        error,
        event: "content.audit-intent",
        outcome: "unavailable",
        requestId: input.requestId,
        spaceId: input.target.spaceId,
      });
      throw new ApiProblemError("service-unavailable", 503, undefined, {
        cause: error,
      });
    }
  }

  /** 用最终可观察的 Kernel 结果收敛审计意图；审计写入失败只记录并保留主请求结果。 */
  async #resolveContentAudit(
    input: KernelGatewayProxyRequest,
    action: ContentAuditAction | null,
    outcome: ObservedContentAuditOutcome,
    startedAt: number,
  ): Promise<void> {
    if (action === null) {
      return;
    }
    try {
      await this.contentAudit.resolve({ outcome, requestId: input.requestId });
    } catch (error) {
      this.#logger.error({
        action,
        canonicalRoute: input.target.policy.path,
        durationMilliseconds: performance.now() - startedAt,
        error,
        event: "content.audit-resolution",
        outcome: "deferred",
        requestId: input.requestId,
        spaceId: input.target.spaceId,
      });
    }
  }

  #deferContentAudit(
    input: KernelGatewayProxyRequest,
    action: ContentAuditAction | null,
    reason: "kernel-response-invalid" | "kernel-result-indeterminate",
    startedAt: number,
  ): void {
    if (action === null) {
      return;
    }
    this.#logger.warn({
      action,
      canonicalRoute: input.target.policy.path,
      durationMilliseconds: performance.now() - startedAt,
      event: "content.audit-resolution",
      outcome: "deferred",
      reason,
      requestId: input.requestId,
      spaceId: input.target.spaceId,
    });
  }

  /** 将已校验且已缓冲的 JSON 响应写回客户端，避免再次读取或推断内容身份。 */
  #sendBufferedResponse(
    input: KernelGatewayProxyRequest,
    reply: KernelGatewayProxyReply,
    headers: IncomingHttpHeaders,
    status: number,
    body: Buffer,
    startedAt: number,
    kernelInstanceId: string,
  ): void {
    reply.hijack();
    const response = reply.raw;
    response.statusCode = status;
    this.#applyResponseHeaders(
      input.target,
      headers,
      response,
      input.requestId,
    );
    response.end(body);
    this.#log(input, "proxied", status, startedAt, kernelInstanceId);
  }

  /** 复制允许的上游头并按资源类型设置安全响应头，避免下载内容被浏览器当作页面执行。 */
  #applyResponseHeaders(
    target: KernelGatewayTarget,
    headers: IncomingHttpHeaders,
    response: ServerResponse,
    requestId: string,
  ): void {
    for (const [name, value] of Object.entries(headers)) {
      if (value !== undefined) {
        response.setHeader(name, value);
      }
    }
    response.setHeader("Cache-Control", "private, no-store");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("X-Request-Id", requestId);

    if (target.surface === "api" || target.surface === "upload") {
      response.setHeader("Content-Type", "application/json; charset=utf-8");
      return;
    }

    const mediaType = normalizedContentType(headers);
    const inline =
      target.surface === "asset" &&
      !target.forceDownload &&
      mediaType !== null &&
      INLINE_CONTENT_TYPES.has(mediaType);
    if (inline) {
      response.setHeader("Content-Type", mediaType);
      response.removeHeader("Content-Disposition");
      return;
    }

    const fileName = safeFileName(target.upstreamPath);
    if (fileName.decodeError !== undefined) {
      this.#logger.warn({
        canonicalRoute: target.policy.path,
        error: fileName.decodeError,
        event: "kernel.response-filename",
        outcome: "decode-failed",
        requestId,
        spaceId: target.spaceId,
      });
    }
    response.setHeader(
      "Content-Disposition",
      `attachment; filename="${fileName.value}"`,
    );
    response.setHeader(
      "Content-Security-Policy",
      "sandbox; default-src 'none'; base-uri 'none'; form-action 'none'",
    );
    response.setHeader(
      "Content-Type",
      mediaType === "application/pdf"
        ? "application/pdf"
        : "application/octet-stream",
    );
  }

  #log(
    input: KernelGatewayProxyRequest,
    outcome: "proxied" | "upstream-rejected" | "upstream-unavailable",
    status: number,
    startedAt: number,
    kernelInstanceId: string,
    error?: unknown,
  ): void {
    const context = {
      canonicalRoute: input.target.policy.path,
      durationMilliseconds: performance.now() - startedAt,
      ...(error === undefined ? {} : { error }),
      event: "kernel.route",
      kernelInstanceId,
      outcome,
      requestId: input.requestId,
      spaceId: input.target.spaceId,
      status,
    };
    if (outcome === "proxied") {
      this.#logger.log(context);
    } else {
      this.#logger.warn(context);
    }
  }
}
