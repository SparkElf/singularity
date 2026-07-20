import type { IncomingMessage } from "node:http";
import { Readable } from "node:stream";

import { Injectable, Logger } from "@nestjs/common";
import {
  contentIdSchema,
  sharedDocumentPayloadSchema,
} from "@singularity/contracts";
import { DatabaseRuntime } from "@singularity/database";
import {
  KernelPrivateClient,
  type KernelDeploymentIdentity,
} from "@singularity/kernel-client";

import { serviceUnavailable } from "../problem.js";
import type {
  ShareKernelPort,
  SharedAssetPayload,
  SharedDocumentPayload,
} from "./share.types.js";

const VERIFY_PATH = "/internal/enterprise/share/verify";
const DOCUMENT_PATH = "/internal/enterprise/share/document";
const ASSET_PATH = "/internal/enterprise/share/asset";
const MAX_DOCUMENT_RESPONSE_BYTES = 16 * 1_024 * 1_024;
const MAX_ASSET_RESPONSE_BYTES = 100 * 1_024 * 1_024;
const kernelSharedDocumentPayloadSchema = sharedDocumentPayloadSchema.extend({
  documentId: contentIdSchema,
});
const logger = new Logger("ShareKernelClient");

/** 将 Kernel 跨进程错误保留为 cause，供 HTTP Problem 与日志边界继续输出完整堆栈。 */
function kernelBoundaryError(message: string, cause?: unknown): Error {
  return new Error(message, {
    ...(cause instanceof Error ? { cause } : {}),
  });
}

function logKernelResponseFailure(
  operation: string,
  message: string,
  cause?: unknown,
): Error {
  const error = kernelBoundaryError(message, cause);
  const originalError = error.cause instanceof Error ? error.cause : undefined;
  logger.error({
    cause: originalError === undefined
      ? undefined
      : {
          message: originalError.message,
          name: originalError.name,
          stack: originalError.stack,
        },
    error: { message: error.message, name: error.name, stack: error.stack },
    event: "share.kernel",
    operation,
    result: "rejected",
  });
  return error;
}

function rejectKernelResponse(
  operation: string,
  message: string,
  cause?: unknown,
): never {
  const error = logKernelResponseFailure(operation, message, cause);
  throw serviceUnavailable({ cause: error });
}

function stringHeader(
  message: IncomingMessage,
  name: string,
): string | undefined {
  const value = message.headers[name];
  return typeof value === "string" ? value : undefined;
}

/** 在消费 JSON 前执行唯一字节边界校验；声明长度、实际长度和解析失败都销毁上游流。 */
async function readJson(message: IncomingMessage): Promise<unknown> {
  const contentLength = stringHeader(message, "content-length");
  const declaredSizeBytes = contentLength === undefined
    ? undefined
    : /^[0-9]+$/.test(contentLength)
    ? Number(contentLength)
    : Number.NaN;
  if (
    declaredSizeBytes !== undefined &&
    (!Number.isSafeInteger(declaredSizeBytes) ||
      declaredSizeBytes > MAX_DOCUMENT_RESPONSE_BYTES)
  ) {
    message.destroy();
    rejectKernelResponse(
      "validate-document-headers",
      "Kernel shared document headers failed validation",
    );
  }
  const chunks: Buffer[] = [];
  let sizeBytes = 0;
  let exceeded = false;
  try {
    for await (const chunk of message) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      sizeBytes += bytes.byteLength;
      if (sizeBytes > MAX_DOCUMENT_RESPONSE_BYTES) {
        exceeded = true;
        break;
      }
      chunks.push(bytes);
    }
  } catch (error) {
    message.destroy();
    rejectKernelResponse(
      "read-document-body",
      "Kernel shared document body failed",
      error,
    );
  }
  if (exceeded) {
    message.destroy();
    rejectKernelResponse(
      "read-document-body",
      "Kernel shared document response exceeded the byte limit",
    );
  }
  if (
    declaredSizeBytes !== undefined &&
    sizeBytes !== declaredSizeBytes
  ) {
    message.destroy();
    rejectKernelResponse(
      "validate-document-body-length",
      "Kernel shared document body length did not match its declaration",
    );
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch (error) {
    message.destroy();
    rejectKernelResponse(
      "parse-document-json",
      "Kernel shared document JSON parsing failed",
      error,
    );
  }
}

function sharedDocument(
  value: unknown,
  expectedDocumentId: string,
): SharedDocumentPayload {
  const parsed = kernelSharedDocumentPayloadSchema.safeParse(value);
  if (!parsed.success || parsed.data.documentId !== expectedDocumentId) {
    rejectKernelResponse(
      "validate-document-projection",
      "Kernel shared document projection failed validation",
      parsed.success ? undefined : parsed.error,
    );
  }
  return {
    assets: parsed.data.assets,
    html: parsed.data.html,
    title: parsed.data.title,
  };
}

/** 将资产响应包装为有界可销毁流，并在实际字节数与声明长度不一致时失败关闭。 */
function boundedAssetBody(
  message: IncomingMessage,
  declaredSizeBytes: number,
): Readable {
  let actualSizeBytes = 0;
  let boundaryFailure: Error | undefined;
  const failure = (
    operation: string,
    messageText: string,
    cause?: unknown,
  ): Error => {
    if (boundaryFailure !== undefined) {
      return boundaryFailure;
    }
    message.destroy();
    boundaryFailure = logKernelResponseFailure(
      operation,
      messageText,
      cause,
    );
    return boundaryFailure;
  };
  const body = Readable.from((async function* () {
    try {
      for await (const chunk of message) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        actualSizeBytes += bytes.byteLength;
        if (
          actualSizeBytes > declaredSizeBytes ||
          actualSizeBytes > MAX_ASSET_RESPONSE_BYTES
        ) {
          throw failure(
            "validate-asset-body-size",
            "Kernel shared asset body exceeded its byte limit",
          );
        }
        yield bytes;
      }
      if (actualSizeBytes !== declaredSizeBytes) {
        throw failure(
          "validate-asset-body-length",
          "Kernel shared asset body length did not match its declaration",
        );
      }
    } catch (error) {
      if (error === boundaryFailure) {
        throw error;
      }
      throw failure(
        "read-asset-body",
        "Kernel shared asset body failed",
        error,
      );
    }
  })());
  body.once("close", () => {
    if (!message.complete) {
      message.destroy();
    }
  });
  return body;
}

@Injectable()
export class ShareKernelClient implements ShareKernelPort {
  constructor(
    private readonly database: DatabaseRuntime,
    private readonly kernel: KernelPrivateClient,
  ) {}

  /** 通过真实 Kernel 内容身份确认分享源文档仍存在且属于目标空间。 */
  async verifyDocument(input: {
    documentId: string;
    notebookId: string;
    organizationId: string;
    requestId: string;
    spaceId: string;
  }): Promise<boolean> {
    const response = await this.#request(input, "POST", VERIFY_PATH);
    response.message.destroy();
    if (response.status === 200) {
      return true;
    }
    if (response.status === 404) {
      return false;
    }
    rejectKernelResponse(
      "verify-document-status",
      "Kernel shared document verification returned an invalid status",
    );
  }

  /** 读取分享文档的最小公开投影，响应体必须在大小和文档身份边界内。 */
  async readDocument(input: {
    documentId: string;
    notebookId: string;
    organizationId: string;
    requestId: string;
    signal: AbortSignal;
    spaceId: string;
  }): Promise<SharedDocumentPayload | null> {
    const response = await this.#request(input, "POST", DOCUMENT_PATH);
    if (response.status === 404) {
      response.message.destroy();
      return null;
    }
    if (response.status !== 200) {
      response.message.destroy();
      rejectKernelResponse(
        "read-document-status",
        "Kernel shared document returned an invalid status",
      );
    }
    return sharedDocument(await readJson(response.message), input.documentId);
  }

  /** 读取分享文档闭包内的单个资产，并把流生命周期交给公开响应 owner。 */
  async readAsset(input: {
    assetId: string;
    documentId: string;
    notebookId: string;
    organizationId: string;
    requestId: string;
    signal: AbortSignal;
    spaceId: string;
  }): Promise<SharedAssetPayload | null> {
    const response = await this.#request(
      input,
      "GET",
      `${ASSET_PATH}?assetId=${encodeURIComponent(input.assetId)}`,
    );
    if (response.status === 404) {
      response.message.destroy();
      return null;
    }
    if (response.status !== 200) {
      response.message.destroy();
      rejectKernelResponse(
        "read-asset-status",
        "Kernel shared asset returned an invalid status",
      );
    }
    const contentLength = stringHeader(response.message, "content-length");
    const disposition = stringHeader(
      response.message,
      "x-singularity-asset-disposition",
    );
    const encodedFileName = stringHeader(
      response.message,
      "x-singularity-asset-filename",
    );
    const mediaType = stringHeader(response.message, "content-type");
    const sizeBytes =
      contentLength !== undefined && /^[0-9]+$/.test(contentLength)
        ? Number(contentLength)
        : Number.NaN;
    if (
      (disposition !== "attachment" && disposition !== "inline") ||
      encodedFileName === undefined ||
      mediaType === undefined ||
      mediaType.trim().length === 0 ||
      /[\r\n]/.test(mediaType) ||
      !Number.isSafeInteger(sizeBytes) ||
      sizeBytes < 0 ||
      sizeBytes > MAX_ASSET_RESPONSE_BYTES
    ) {
      response.message.destroy();
      rejectKernelResponse(
        "validate-asset-headers",
        "Kernel shared asset headers failed validation",
      );
    }
    let fileName: string;
    try {
      const decoded = Buffer.from(encodedFileName, "base64url");
      if (
        decoded.byteLength === 0 ||
        decoded.toString("base64url") !== encodedFileName
      ) {
        throw new Error("Asset filename encoding is invalid");
      }
      fileName = decoded.toString("utf8");
    } catch (error) {
      response.message.destroy();
      rejectKernelResponse(
        "decode-asset-filename",
        "Kernel shared asset filename decoding failed",
        error,
      );
    }
    if (
      fileName.trim().length === 0 ||
      fileName.includes("/") ||
      fileName.includes("\\") ||
      [...fileName].some((character) => character.charCodeAt(0) < 0x20)
    ) {
      response.message.destroy();
      rejectKernelResponse(
        "validate-asset-filename",
        "Kernel shared asset filename failed validation",
      );
    }
    return {
      body: boundedAssetBody(response.message, sizeBytes),
      disposition,
      fileName,
      mediaType,
      sizeBytes,
    };
  }

  /** 通过受信部署调用分享专用 Kernel 路径，并在唯一边界校验响应头与流体。 */
  async #request(
    input: {
      documentId: string;
      notebookId: string;
      organizationId: string;
      requestId: string;
      signal?: AbortSignal;
      spaceId: string;
    },
    method: string,
    path: string,
  ) {
    const deployment = await this.#deployment(input);
    return this.kernel.request({
      contentIdentity: {
        documentId: input.documentId,
        notebookId: input.notebookId,
      },
      deployment,
      headers: {},
      method,
      path,
      requestId: input.requestId,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
  }

  /** 解析目标空间的 ready 部署，并确保 Kernel 实例与分享空间身份一致。 */
  async #deployment(input: {
    organizationId: string;
    spaceId: string;
  }): Promise<KernelDeploymentIdentity> {
    const instance = await this.database.client.kernelInstance.findFirst({
      where: {
        spaceId: input.spaceId,
        status: "ready",
        space: {
          id: input.spaceId,
          organizationId: input.organizationId,
          status: "active",
          organization: { id: input.organizationId, status: "active" },
        },
      },
      select: { deploymentHandle: true, id: true },
    });
    if (
      instance === null ||
      instance === undefined ||
      instance.deploymentHandle === null
    ) {
      throw serviceUnavailable();
    }
    return {
      handle: instance.deploymentHandle,
      kernelInstanceId: instance.id,
      spaceId: input.spaceId,
    };
  }
}
