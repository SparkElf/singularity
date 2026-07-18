import type {
  IncomingHttpHeaders,
  IncomingMessage,
  ServerResponse,
} from "node:http";
import { basename } from "node:path";
import { performance } from "node:perf_hooks";

import { Inject, Injectable, Logger } from "@nestjs/common";
import type { KernelAuditMode } from "@singularity/authorization";
import type { AuditAction } from "@singularity/contracts";
import { DatabaseRuntime } from "@singularity/database";
import {
  KernelPrivateClient,
  KernelTransportError,
} from "@singularity/kernel-client";

import { AuditWriter } from "../audit/audit-writer.service.js";
import type { Clock } from "../identity/clock.js";
import {
  ApiProblemError,
  conflict,
  notFound,
  validationFailed,
} from "../problem.js";
import { CLOCK } from "../tokens.js";
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

function safeFileName(path: string): string {
  let decoded: string;
  try {
    decoded = decodeURIComponent(basename(path.split("?", 1)[0] ?? "download"));
  } catch {
    decoded = "download";
  }
  const sanitized = decoded.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120);
  return sanitized.length === 0 || sanitized === "." || sanitized === ".."
    ? "download"
    : sanitized;
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
): AuditAction | null {
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
        message.destroy();
        throw new ApiProblemError("service-unavailable", 502);
      }
      chunks.push(bytes);
    }
  } catch (error) {
    if (error instanceof ApiProblemError) {
      throw error;
    }
    throw new ApiProblemError("service-unavailable", 502);
  }
  const body = Buffer.concat(chunks);
  let value: unknown;
  try {
    value = JSON.parse(body.toString("utf8"));
  } catch {
    throw new ApiProblemError("service-unavailable", 502);
  }
  if (
    typeof value !== "object" ||
    value === null ||
    !("code" in value) ||
    typeof value.code !== "number" ||
    !Number.isInteger(value.code)
  ) {
    throw new ApiProblemError("service-unavailable", 502);
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

@Injectable()
export class KernelGatewayService {
  readonly #logger = new Logger("KernelGateway");

  constructor(
    private readonly access: KernelAccessService,
    private readonly audit: AuditWriter,
    private readonly client: KernelPrivateClient,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly database: DatabaseRuntime,
  ) {}

  async proxy(
    input: KernelGatewayProxyRequest,
    reply: KernelGatewayProxyReply,
  ): Promise<void> {
    const startedAt = performance.now();
    const authorized = await this.access.authorizeHttp({
      action: input.target.policy.action,
      organizationId: input.target.organizationId,
      requestId: input.requestId,
      spaceId: input.target.spaceId,
      userId: input.userId,
    });

    const body = serializedBody(input.body);
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
      this.#log(input, "upstream-unavailable", status, startedAt);
      throw new ApiProblemError("service-unavailable", status);
    }

    const problem = upstreamProblem(upstream.status);
    if (problem !== null) {
      upstream.message.resume();
      this.#log(input, "upstream-rejected", problem.status, startedAt);
      throw problem;
    }
    if (
      (input.target.surface === "api" || input.target.surface === "upload") &&
      upstream.status !== 204 &&
      normalizedContentType(upstream.headers) !== "application/json"
    ) {
      upstream.message.resume();
      this.#log(input, "upstream-rejected", 502, startedAt);
      throw new ApiProblemError("service-unavailable", 502);
    }

    const contentAuditAction = auditAction(
      input.target.policy.audit,
      input.body,
    );
    if (
      (input.target.surface === "api" || input.target.surface === "upload") &&
      upstream.status !== 204
    ) {
      let result: Awaited<ReturnType<typeof readKernelJsonResult>>;
      try {
        result = await readKernelJsonResult(upstream.message);
      } catch (error) {
        this.#log(input, "upstream-rejected", 502, startedAt);
        throw error;
      }
      const resultProblem = kernelResultProblem(result.code);
      if (resultProblem !== null) {
        this.#log(input, "upstream-rejected", resultProblem.status, startedAt);
        throw resultProblem;
      }
      if (contentAuditAction !== null) {
        try {
          await this.#appendContentAudit(input, contentAuditAction, startedAt);
        } catch (error) {
          upstream.message.destroy();
          throw error;
        }
      }
      this.#sendBufferedResponse(
        input,
        reply,
        upstream.headers,
        upstream.status,
        result.body,
        startedAt,
      );
      return;
    }
    if (contentAuditAction !== null) {
      try {
        await this.#appendContentAudit(input, contentAuditAction, startedAt);
      } catch (error) {
        upstream.message.destroy();
        throw error;
      }
    }

    reply.hijack();
    const response = reply.raw;
    response.statusCode = upstream.status;
    this.#applyResponseHeaders(
      input.target,
      upstream.headers,
      response,
      input.requestId,
    );
    upstream.message.once("error", () => response.destroy());
    response.once("close", () => upstream.message.destroy());
    upstream.message.pipe(response);
    this.#log(input, "proxied", upstream.status, startedAt);
  }

  async #appendContentAudit(
    input: KernelGatewayProxyRequest,
    action: AuditAction,
    startedAt: number,
  ): Promise<void> {
    try {
      await this.database.client.$transaction((transaction) =>
        this.audit.append(transaction, {
          action,
          actorUserId: input.userId,
          occurredAt: this.clock.now(),
          organizationId: input.target.organizationId,
          outcome: "succeeded",
          requestId: input.requestId,
          spaceId: input.target.spaceId,
          targetId: input.target.identity.documentId,
          targetType: "document",
        }),
      );
    } catch {
      this.#logger.error({
        action,
        canonicalRoute: input.target.policy.path,
        durationMilliseconds: performance.now() - startedAt,
        event: "kernel.route",
        outcome: "audit-unavailable",
        requestId: input.requestId,
        spaceId: input.target.spaceId,
      });
      throw new ApiProblemError("service-unavailable", 503);
    }
  }

  #sendBufferedResponse(
    input: KernelGatewayProxyRequest,
    reply: KernelGatewayProxyReply,
    headers: IncomingHttpHeaders,
    status: number,
    body: Buffer,
    startedAt: number,
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
    this.#log(input, "proxied", status, startedAt);
  }

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
      mediaType !== null &&
      INLINE_CONTENT_TYPES.has(mediaType);
    if (inline) {
      response.setHeader("Content-Type", mediaType);
      response.removeHeader("Content-Disposition");
      return;
    }

    const fileName = safeFileName(target.upstreamPath);
    response.setHeader(
      "Content-Disposition",
      `attachment; filename="${fileName}"`,
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
  ): void {
    const context = {
      canonicalRoute: input.target.policy.path,
      durationMilliseconds: performance.now() - startedAt,
      event: "kernel.route",
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
