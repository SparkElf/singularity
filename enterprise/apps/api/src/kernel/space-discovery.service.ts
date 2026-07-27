import type { IncomingMessage } from "node:http";
import { performance } from "node:perf_hooks";

import { Injectable, Logger } from "@nestjs/common";
import {
  spaceDiscoveryDocumentContentResponseSchema,
  spaceDiscoveryGraphResponseSchema,
  spaceDiscoverySearchResponseSchema,
  type SpaceDiscoveryDocumentContentResponse,
  type SpaceDiscoveryGraphRequest,
  type SpaceDiscoveryGraphResponse,
  type SpaceDiscoverySearchRequest,
  type SpaceDiscoverySearchResponse,
} from "@singularity/contracts";
import {
  KernelPrivateClient,
  type KernelPrivateResponse,
} from "@singularity/kernel-client";

import { ApiProblemError, notFound } from "../problem.js";
import {
  type AuthorizedKernelTarget,
  KernelAccessService,
} from "./kernel-access.service.js";

const SPACE_DISCOVERY_SEARCH_PATH =
  "/internal/enterprise/discovery/search";
const SPACE_DISCOVERY_GRAPH_PATH = "/internal/enterprise/discovery/graph";
const SPACE_DISCOVERY_DOCUMENT_CONTENT_PATH =
  "/internal/enterprise/discovery/document-content";
const MAX_SPACE_DISCOVERY_RESPONSE_BYTES = 2 * 1024 * 1024;

interface SpaceDiscoveryRequestContext {
  readonly actorUserId: string;
  readonly organizationId: string;
  readonly requestId: string;
  readonly signal: AbortSignal;
  readonly spaceId: string;
}

function jsonContentType(message: IncomingMessage): boolean {
  const value = message.headers["content-type"];
  return (
    typeof value === "string" &&
    value.split(";", 1)[0]?.trim().toLowerCase() === "application/json"
  );
}

function discoveryUnavailable(cause: unknown): ApiProblemError {
  return new ApiProblemError("service-unavailable", 503, undefined, { cause });
}

/** 读取有界图谱/搜索响应，确保上游流在超限或解析失败时立即关闭。 */
async function readDiscoveryJson(message: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let sizeBytes = 0;
  try {
    for await (const chunk of message) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      sizeBytes += bytes.byteLength;
      if (sizeBytes > MAX_SPACE_DISCOVERY_RESPONSE_BYTES) {
        message.destroy();
        throw discoveryUnavailable(
          new Error("Kernel discovery response exceeded the size limit"),
        );
      }
      chunks.push(bytes as Buffer<ArrayBufferLike>);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch (error) {
    if (error instanceof ApiProblemError) {
      throw error;
    }
    throw discoveryUnavailable(error);
  }
}

@Injectable()
export class SpaceDiscoveryService {
  readonly #logger = new Logger("SpaceDiscoveryService");

  constructor(
    private readonly access: KernelAccessService,
    private readonly kernel: KernelPrivateClient,
  ) {}

  /** 在当前授权空间执行服务端全文搜索，响应身份由 Kernel 源 block 提供。 */
  search(
    input: SpaceDiscoveryRequestContext & {
      readonly body: SpaceDiscoverySearchRequest;
    },
  ): Promise<SpaceDiscoverySearchResponse> {
    return this.#observe(input, "search", async () => {
      const value = await this.#requestJson(
        input,
        SPACE_DISCOVERY_SEARCH_PATH,
        {},
        input.body,
      );
      const parsed = spaceDiscoverySearchResponseSchema.safeParse(value);
      if (!parsed.success) {
        throw discoveryUnavailable(
          parsed.error,
        );
      }
      return parsed.data;
    });
  }

  /** 在当前授权空间执行图谱查询，tag 等非内容节点不在此处补造文档身份。 */
  graph(
    input: SpaceDiscoveryRequestContext & {
      readonly body: SpaceDiscoveryGraphRequest;
    },
  ): Promise<SpaceDiscoveryGraphResponse> {
    return this.#observe(input, "graph", async () => {
      const value = await this.#requestJson(
        input,
        SPACE_DISCOVERY_GRAPH_PATH,
        {},
        input.body,
      );
      const parsed = spaceDiscoveryGraphResponseSchema.safeParse(value);
      if (!parsed.success) {
        throw discoveryUnavailable(
          parsed.error,
        );
      }
      return parsed.data;
    });
  }

  /** 按显式四段内容身份读取 Kernel 当前文档的有界纯文本，供 AI 取证而不依赖问题关键词。 */
  readDocumentContent(
    input: SpaceDiscoveryRequestContext & {
      readonly documentId: string;
      readonly notebookId: string;
    },
  ): Promise<SpaceDiscoveryDocumentContentResponse> {
    return this.#observe(input, "document-content", async () => {
      const value = await this.#requestJson(
        input,
        SPACE_DISCOVERY_DOCUMENT_CONTENT_PATH,
        { method: "GET", notFoundOn404: true },
      );
      const parsed = spaceDiscoveryDocumentContentResponseSchema.safeParse(value);
      if (!parsed.success) {
        throw discoveryUnavailable(parsed.error);
      }
      if (
        parsed.data.documentId !== input.documentId ||
        parsed.data.notebookId !== input.notebookId
      ) {
        throw discoveryUnavailable(
          new Error("Kernel document content identity does not match the request"),
        );
      }
      return parsed.data;
    });
  }

  /** 复验空间授权并通过私有 Gateway 请求已声明的 discovery 数据。 */
  async #requestJson(
    input: SpaceDiscoveryRequestContext & {
      readonly documentId?: string;
      readonly notebookId?: string;
    },
    path: string,
    options: {
      readonly method?: "GET" | "POST";
      readonly notFoundOn404?: boolean;
    } = {},
    body?: SpaceDiscoverySearchRequest | SpaceDiscoveryGraphRequest,
  ): Promise<unknown> {
    let authorized: AuthorizedKernelTarget;
    try {
      authorized = await this.access.authorizeHttp({
        action: "read",
        organizationId: input.organizationId,
        requestId: input.requestId,
        spaceId: input.spaceId,
        userId: input.actorUserId,
      });
    } catch (error) {
      if (error instanceof ApiProblemError && error.code === "forbidden") {
        throw notFound({ cause: error });
      }
      throw error;
    }

    const serializedBody = body === undefined ? undefined : JSON.stringify(body);
    const method = options.method ?? "POST";
    let response: KernelPrivateResponse;
    try {
      response = await this.kernel.request({
        ...(serializedBody === undefined ? {} : { body: serializedBody }),
        ...(input.documentId === undefined || input.notebookId === undefined
          ? {}
          : {
              contentIdentity: {
                documentId: input.documentId,
                notebookId: input.notebookId,
                organizationId: input.organizationId,
                spaceId: input.spaceId,
              },
            }),
        deployment: authorized.deployment,
        headers: {
          accept: "application/json",
          ...(serializedBody === undefined
            ? {}
            : {
                "content-length": String(Buffer.byteLength(serializedBody)),
                "content-type": "application/json",
              }),
        },
        method,
        path,
        requestId: input.requestId,
        signal: input.signal,
      });
    } catch (error) {
      throw discoveryUnavailable(error);
    }

    if (response.status === 404 && options.notFoundOn404 === true) {
      response.message.destroy();
      throw notFound();
    }
    if (response.status !== 200) {
      response.message.destroy();
      throw discoveryUnavailable(
        new Error(`Kernel discovery returned HTTP ${response.status}`),
      );
    }
    if (!jsonContentType(response.message)) {
      response.message.destroy();
      throw discoveryUnavailable(
        new Error("Kernel discovery returned a non-JSON response"),
      );
    }
    return readDiscoveryJson(response.message);
  }

  /** 统一记录 discovery 延迟和完整异常对象；调用方只消费已解析的 Kernel 合同。 */
  async #observe<Result>(
    input: SpaceDiscoveryRequestContext & {
      readonly body?: { readonly query?: string };
    },
    operation: "document-content" | "graph" | "search",
    work: () => Promise<Result>,
  ): Promise<Result> {
    const startedAt = performance.now();
    const queryLength = input.body?.query === undefined
      ? 0
      : Array.from(input.body.query).length;
    try {
      const result = await work();
      this.#logger.log({
        durationMilliseconds: performance.now() - startedAt,
        event: "content.discovery",
        operation,
        organizationId: input.organizationId,
        queryLength,
        requestId: input.requestId,
        outcome: "succeeded",
        spaceId: input.spaceId,
      });
      return result;
    } catch (error) {
      this.#logger.warn({
        durationMilliseconds: performance.now() - startedAt,
        event: "content.discovery",
        operation,
        organizationId: input.organizationId,
        queryLength,
        requestId: input.requestId,
        outcome: "failed",
        spaceId: input.spaceId,
        error,
      });
      throw error;
    }
  }
}
