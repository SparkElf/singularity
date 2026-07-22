import type { IncomingMessage } from "node:http";
import { performance } from "node:perf_hooks";

import { Injectable, Logger } from "@nestjs/common";
import {
  contentDirectoryDocumentsResponseSchema,
  contentDirectoryNotebooksResponseSchema,
  type ContentDirectoryDocumentsResponse,
  type ContentDirectoryNotebooksResponse,
} from "@singularity/contracts";
import { DatabaseRuntime } from "@singularity/database";
import {
  KernelPrivateClient,
  type KernelPrivateResponse,
} from "@singularity/kernel-client";

import {
  ApiProblemError,
  notFound,
  serviceUnavailable,
} from "../problem.js";
import { DocumentAccessPolicyService } from "../document-access/document-access.service.js";
import { KernelAccessService } from "./kernel-access.service.js";

const DIRECTORY_NOTEBOOKS_PATH =
  "/internal/enterprise/directory/notebooks";
const DIRECTORY_DOCUMENTS_PATH =
  "/internal/enterprise/directory/documents";
const DOCUMENT_EXISTS_PATH = "/api/block/checkBlockExist";
const MAX_DIRECTORY_RESPONSE_BYTES = 1_024 * 1_024;

interface DirectoryRequestContext {
  readonly actorUserId: string;
  readonly organizationId: string;
  readonly requestId: string;
  readonly signal: AbortSignal;
  readonly spaceId: string;
}

interface DirectoryLogContext {
  readonly notebookId?: string;
  readonly offset?: number;
  readonly organizationId: string;
  readonly parentDocumentId?: string;
  readonly requestId: string;
  readonly spaceId: string;
}

function jsonContentType(message: IncomingMessage): boolean {
  const value = message.headers["content-type"];
  return (
    typeof value === "string" &&
    value.split(";", 1)[0]?.trim().toLowerCase() === "application/json"
  );
}

function directoryUnavailable(cause: unknown): ApiProblemError {
  return new ApiProblemError("service-unavailable", 503, undefined, { cause });
}

/** 读取目录响应的有限 JSON 投影，保证连接断开、超限和解析失败都会终止上游流。 */
async function readDirectoryJson(message: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let sizeBytes = 0;
  try {
    for await (const chunk of message) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      sizeBytes += bytes.byteLength;
      if (sizeBytes > MAX_DIRECTORY_RESPONSE_BYTES) {
        message.destroy();
        throw serviceUnavailable();
      }
      chunks.push(bytes as Buffer<ArrayBufferLike>);
    }
    const text = Buffer.concat(chunks).toString("utf8");
    try {
      return JSON.parse(text);
    } catch (error) {
      throw directoryUnavailable(
        new SyntaxError("Kernel directory JSON is invalid", {
          cause: error,
        }),
      );
    }
  } catch (error) {
    if (error instanceof ApiProblemError) {
      throw error;
    }
    throw directoryUnavailable(error);
  }
}

@Injectable()
export class ContentDirectoryService {
  readonly #logger = new Logger("ContentDirectoryService");

  constructor(
    private readonly access: KernelAccessService,
    private readonly database: DatabaseRuntime,
    private readonly documentAccess: DocumentAccessPolicyService,
    private readonly kernel: KernelPrivateClient,
  ) {}

  /** 在协作开关写入前向 Kernel 确认文档确实属于指定内容库，避免控制面凭复合 ID 创建孤儿记录。 */
  async assertDocumentExists(
    input: DirectoryRequestContext & {
      readonly documentId: string;
      readonly notebookId: string;
    },
  ): Promise<void> {
    const authorized = await this.access.authorizeHttp({
      action: "read",
      organizationId: input.organizationId,
      requestId: input.requestId,
      spaceId: input.spaceId,
      userId: input.actorUserId,
    });
    let response: KernelPrivateResponse;
    try {
      response = await this.kernel.request({
        body: JSON.stringify({ id: input.documentId, notebook: input.notebookId }),
        contentIdentity: {
          documentId: input.documentId,
          notebookId: input.notebookId,
        },
        deployment: authorized.deployment,
        headers: { accept: "application/json", "content-type": "application/json" },
        method: "POST",
        path: DOCUMENT_EXISTS_PATH,
        requestId: input.requestId,
        signal: input.signal,
      });
    } catch (error) {
      throw directoryUnavailable(error);
    }
    if (response.status !== 200 || !jsonContentType(response.message)) {
      response.message.destroy();
      throw directoryUnavailable(
        new Error(`Kernel document existence returned HTTP ${response.status}`),
      );
    }
    const value = await readDirectoryJson(response.message);
    if (
      typeof value !== "object" ||
      value === null ||
      !("code" in value) ||
      value.code !== 0 ||
      !("data" in value) ||
      typeof value.data !== "boolean"
    ) {
      throw directoryUnavailable(new Error("Kernel document existence response is invalid"));
    }
    if (!value.data) {
      throw notFound();
    }
  }

  /** 获取当前授权空间的可见笔记本，不把锁定库或文档身份下沉给浏览器。 */
  listNotebooks(
    input: DirectoryRequestContext,
  ): Promise<ContentDirectoryNotebooksResponse> {
    return this.#observe(input, async () => {
      const value = await this.#requestJson(input, DIRECTORY_NOTEBOOKS_PATH);
      const parsed = contentDirectoryNotebooksResponseSchema.safeParse(value);
      if (!parsed.success) {
        throw directoryUnavailable(parsed.error);
      }
      return parsed.data;
    });
  }

  /** 按真实父文档和 offset 分页读取目录，拒绝跨笔记本响应与倒退游标。 */
  listDocuments(
    input: DirectoryRequestContext & {
      readonly notebookId: string;
      readonly offset: number;
      readonly parentDocumentId?: string;
    },
  ): Promise<ContentDirectoryDocumentsResponse> {
    return this.#observe(input, async () => {
      const query = new URLSearchParams({
        notebookId: input.notebookId,
        offset: String(input.offset),
        ...(input.parentDocumentId === undefined
          ? {}
          : { parentDocumentId: input.parentDocumentId }),
      });
      const value = await this.#requestJson(
        input,
        `${DIRECTORY_DOCUMENTS_PATH}?${query.toString()}`,
      );
      const parsed = contentDirectoryDocumentsResponseSchema.safeParse(value);
      if (!parsed.success) {
        throw directoryUnavailable(parsed.error);
      }
      if (
        parsed.data.documents.some(
          (document) => document.notebookId !== input.notebookId,
        )
      ) {
        throw directoryUnavailable(
          new Error("Kernel directory returned a document from another notebook"),
        );
      }
      if (
        parsed.data.nextOffset !== null &&
        parsed.data.nextOffset <= input.offset
      ) {
        throw directoryUnavailable(
          new Error("Kernel directory returned a non-forward pagination offset"),
        );
      }
      const visibleDocuments = await this.database.client.$transaction(
        (transaction) =>
          this.documentAccess.filterVisibleDocumentsInTransaction(transaction, {
            actorUserId: input.actorUserId,
            documents: parsed.data.documents,
            organizationId: input.organizationId,
            spaceId: input.spaceId,
          }),
      );
      const visibleDocumentIds = new Set(
        visibleDocuments.map((document) =>
          `${document.notebookId}:${document.documentId}`,
        ),
      );
      return {
        ...parsed.data,
        documents: parsed.data.documents.filter((document) =>
          visibleDocumentIds.has(`${document.notebookId}:${document.documentId}`),
        ),
      };
    });
  }

  /** 在空间授权后调用私有 Kernel 目录接口，并在唯一跨进程边界解析 JSON。 */
  async #requestJson(
    input: DirectoryRequestContext,
    path: string,
  ): Promise<unknown> {
    const authorized = await this.access.authorizeHttp({
      action: "read",
      organizationId: input.organizationId,
      requestId: input.requestId,
      spaceId: input.spaceId,
      userId: input.actorUserId,
    });

    let response: KernelPrivateResponse;
    try {
      response = await this.kernel.request({
        deployment: authorized.deployment,
        headers: { accept: "application/json" },
        method: "GET",
        path,
        requestId: input.requestId,
        signal: input.signal,
      });
    } catch (error) {
      throw directoryUnavailable(error);
    }

    if (response.status === 404) {
      response.message.destroy();
      throw notFound();
    }
    if (response.status !== 200) {
      response.message.destroy();
      throw directoryUnavailable(
        new Error(`Kernel directory returned HTTP ${response.status}`),
      );
    }
    if (!jsonContentType(response.message)) {
      response.message.destroy();
      throw directoryUnavailable(
        new Error("Kernel directory returned a non-JSON response"),
      );
    }
    return readDirectoryJson(response.message);
  }

  async #observe<Result>(
    context: DirectoryLogContext,
    operation: () => Promise<Result>,
  ): Promise<Result> {
    const startedAt = performance.now();
    const logContext = {
      event: "content.directory",
      organizationId: context.organizationId,
      ...(context.notebookId === undefined
        ? {}
        : { notebookId: context.notebookId }),
      ...(context.offset === undefined ? {} : { offset: context.offset }),
      ...(context.parentDocumentId === undefined
        ? {}
        : { parentDocumentId: context.parentDocumentId }),
      requestId: context.requestId,
      spaceId: context.spaceId,
    };
    try {
      const result = await operation();
      this.#logger.log({
        durationMilliseconds: performance.now() - startedAt,
        ...logContext,
        outcome: "succeeded",
      });
      return result;
    } catch (error) {
      this.#logger.warn({
        durationMilliseconds: performance.now() - startedAt,
        error,
        ...logContext,
        outcome:
          error instanceof ApiProblemError && error.code === "not-found"
            ? "not-found"
            : "unavailable",
      });
      throw error;
    }
  }
}
