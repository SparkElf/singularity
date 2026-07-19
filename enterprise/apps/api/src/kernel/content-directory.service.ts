import type { IncomingMessage } from "node:http";
import { performance } from "node:perf_hooks";

import { Injectable, Logger } from "@nestjs/common";
import {
  contentDirectoryDocumentsResponseSchema,
  contentDirectoryNotebooksResponseSchema,
  type ContentDirectoryDocumentsResponse,
  type ContentDirectoryNotebooksResponse,
} from "@singularity/contracts";
import {
  KernelPrivateClient,
  type KernelPrivateResponse,
} from "@singularity/kernel-client";

import {
  ApiProblemError,
  notFound,
  serviceUnavailable,
} from "../problem.js";
import { KernelAccessService } from "./kernel-access.service.js";

const DIRECTORY_NOTEBOOKS_PATH =
  "/internal/enterprise/directory/notebooks";
const DIRECTORY_DOCUMENTS_PATH =
  "/internal/enterprise/directory/documents";
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
      chunks.push(bytes);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch (error) {
    if (error instanceof ApiProblemError) {
      throw error;
    }
    throw serviceUnavailable();
  }
}

@Injectable()
export class ContentDirectoryService {
  readonly #logger = new Logger("ContentDirectoryService");

  constructor(
    private readonly access: KernelAccessService,
    private readonly kernel: KernelPrivateClient,
  ) {}

  listNotebooks(
    input: DirectoryRequestContext,
  ): Promise<ContentDirectoryNotebooksResponse> {
    return this.#observe(input, async () => {
      const value = await this.#requestJson(input, DIRECTORY_NOTEBOOKS_PATH);
      const parsed = contentDirectoryNotebooksResponseSchema.safeParse(value);
      if (!parsed.success) {
        throw serviceUnavailable();
      }
      return parsed.data;
    });
  }

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
        `${DIRECTORY_DOCUMENTS_PATH}?${query}`,
      );
      const parsed = contentDirectoryDocumentsResponseSchema.safeParse(value);
      if (
        !parsed.success ||
        parsed.data.documents.some(
          (document) => document.notebookId !== input.notebookId,
        ) ||
        (parsed.data.nextOffset !== null &&
          parsed.data.nextOffset <= input.offset)
      ) {
        throw serviceUnavailable();
      }
      return parsed.data;
    });
  }

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
    } catch {
      throw serviceUnavailable();
    }

    if (response.status === 404) {
      response.message.resume();
      throw notFound();
    }
    if (response.status !== 200 || !jsonContentType(response.message)) {
      response.message.resume();
      throw serviceUnavailable();
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
