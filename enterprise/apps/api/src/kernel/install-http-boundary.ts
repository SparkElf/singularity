import type { IncomingHttpHeaders, IncomingMessage } from "node:http";
import { Transform, type Readable } from "node:stream";

import {
  KernelGatewayAdmissionError,
} from "./gateway-path.js";
import { KernelGatewayAdmission } from "./kernel-gateway-admission.js";

const CONTROL_PLANE_MAXIMUM_BODY_BYTES = 16 * 1_024;
export const KERNEL_JSON_MAXIMUM_BODY_BYTES = 16 * 1_024 * 1_024;
export const KERNEL_GATEWAY_MAXIMUM_BODY_BYTES = 64 * 1_024 * 1_024;

class PayloadTooLargeError extends Error {
  readonly code = "FST_ERR_CTP_BODY_TOO_LARGE";
  readonly statusCode = 413;

  constructor() {
    super("Request body is too large");
    this.name = "PayloadTooLargeError";
  }
}

type CountedPayload = Transform & {
  receivedEncodedLength?: number;
};

function limitPayload(payload: Readable, maximumBytes: number): Readable {
  const limited = new Transform({
    transform(chunk: Buffer, _encoding, done): void {
      const nextLength = (limited.receivedEncodedLength ?? 0) + chunk.length;
      limited.receivedEncodedLength = nextLength;
      if (nextLength > maximumBytes) {
        done(new PayloadTooLargeError());
        return;
      }
      done(null, chunk);
    },
  }) as CountedPayload;
  limited.receivedEncodedLength = 0;
  payload.pipe(limited);
  return limited;
}

interface FastifyRequestBoundary {
  readonly headers: IncomingHttpHeaders;
  readonly id: string;
  readonly method: string;
  readonly raw: IncomingMessage;
  readonly url: string;
}

interface FastifyReplyBoundary {
  header(name: string, value: string): FastifyReplyBoundary;
  send(payload: unknown): unknown;
  status(code: number): FastifyReplyBoundary;
}

interface FastifyBoundary {
  addContentTypeParser(
    contentType: RegExp,
    options: { bodyLimit: number; parseAs: "buffer" },
    parser: (
      request: FastifyRequestBoundary,
      body: Buffer,
      done: (error: Error | null, value?: unknown) => void,
    ) => void,
  ): void;
  addHook(
    name: "onRequest",
    hook: (
      request: FastifyRequestBoundary,
      reply: FastifyReplyBoundary,
    ) => Promise<unknown>,
  ): void;
  addHook(
    name: "preParsing",
    hook: (
      request: FastifyRequestBoundary,
      reply: FastifyReplyBoundary,
      payload: Readable,
    ) => Promise<Readable>,
  ): void;
}

export function installKernelGatewayHttpBoundary(
  fastify: FastifyBoundary,
  admission: KernelGatewayAdmission,
): void {
  fastify.addContentTypeParser(
    /^multipart\/form-data(?:;.*)?$/i,
    { bodyLimit: KERNEL_GATEWAY_MAXIMUM_BODY_BYTES, parseAs: "buffer" },
    (_request, body, done) => done(null, body),
  );
  fastify.addContentTypeParser(
    /^application\/json(?:;.*)?$/i,
    { bodyLimit: KERNEL_JSON_MAXIMUM_BODY_BYTES, parseAs: "buffer" },
    (_request, body, done) => {
      if (body.byteLength === 0) {
        done(null, undefined);
        return;
      }
      try {
        done(null, JSON.parse(body.toString("utf8")) as unknown);
      } catch (error) {
        done(
          error instanceof Error
            ? error
            : new Error("JSON request body parsing failed", { cause: error }),
        );
      }
    },
  );
  // Fastify 需要通过异步 hook 的返回 Promise 接收 reply.send 的终止信号。
  // eslint-disable-next-line @typescript-eslint/require-await
  fastify.addHook("onRequest", async (request, reply) => {
    try {
      admission.admit({
        headers: request.headers,
        method: request.method,
        rawRequest: request.raw,
        requestId: request.id,
        url: request.url,
      });
    } catch (error) {
      const status =
        error instanceof KernelGatewayAdmissionError ? error.status : 400;
      return reply
        .status(status)
        .header("Cache-Control", "no-store")
        .header("Content-Type", "application/problem+json; charset=utf-8")
        .send({
          code: status === 403 ? "forbidden" : "validation-failed",
          requestId: request.id,
          status,
        });
    }
  });
  // 保持 Fastify preParsing 的 Promise 合同，让有界流在解析阶段完成替换。
  // eslint-disable-next-line @typescript-eslint/require-await
  fastify.addHook("preParsing", async (request, _reply, payload) => {
    const target = admission.inspect(request.raw);
    const maximumBytes =
      target?.policy.contentMode === "upload"
        ? KERNEL_GATEWAY_MAXIMUM_BODY_BYTES
        : target?.policy.contentMode === "json"
          ? KERNEL_JSON_MAXIMUM_BODY_BYTES
          : CONTROL_PLANE_MAXIMUM_BODY_BYTES;
    return limitPayload(payload, maximumBytes);
  });
}
