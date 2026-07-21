import { Injectable } from "@nestjs/common";
import type {
  HistoryDiff,
  HistoryVersion,
  HistoryVersionsResponse,
  RestoredHistoryVersion,
} from "@singularity/contracts";
import { AuditWriter, DatabaseRuntime } from "@singularity/database";
import { KernelPrivateClient } from "@singularity/kernel-client";

import { DocumentAccessPolicyService } from "../document-access/document-access.service.js";
import { writeNotificationsInTransaction } from "../notifications/notification-writer.js";
import {
  ApiProblemError,
  notFound,
  serviceUnavailable,
  validationFailed,
} from "../problem.js";
import type { DocumentIdentity } from "@singularity/contracts";
import { KernelAccessService } from "./kernel-access.service.js";

const HISTORY_SEARCH_PATH = "/api/history/searchHistory";
const HISTORY_ITEMS_PATH = "/api/history/getHistoryItems";
const HISTORY_CONTENT_PATH = "/api/history/getDocHistoryContent";
const HISTORY_RESTORE_PATH = "/api/history/rollbackDocHistory";
const MAX_HISTORY_RESPONSE_BYTES = 4 * 1024 * 1024;

interface HistoryContext extends DocumentIdentity {
  actorUserId: string;
  requestId: string;
}

interface HistoryItem {
  readonly notebook?: string;
  readonly op?: string;
  readonly path?: string;
  readonly title?: string;
}

/** 将 Kernel 返回的历史路径封装为 URL 安全的 opaque 版本标识，不生成内容事实。 */
function encodeVersion(historyPath: string, created: string): string {
  return Buffer.from(JSON.stringify({ created, historyPath })).toString("base64url");
}

/** 还原 opaque 版本并确认历史路径仍明确指向当前文档，拒绝跨文档路径伪造。 */
function decodeVersion(versionId: string, documentId: string): { created: string; historyPath: string } {
  try {
    const value: unknown = JSON.parse(Buffer.from(versionId, "base64url").toString("utf8"));
    if (
      typeof value !== "object" ||
      value === null ||
      !("created" in value) ||
      typeof value.created !== "string" ||
      !("historyPath" in value) ||
      typeof value.historyPath !== "string" ||
      !value.historyPath.split("/").some((segment) => segment === `${documentId}.sy`)
    ) {
      throw new Error("History version identity is unavailable");
    }
    return { created: value.created, historyPath: value.historyPath };
  } catch (error) {
    throw validationFailed({ cause: error });
  }
}

function parseCreated(value: string): Date {
  const numeric = Number(value);
  const date = Number.isFinite(numeric)
    ? new Date(numeric > 10_000_000_000 ? numeric : numeric * 1_000)
    : new Date(value);
  if (Number.isNaN(date.valueOf())) {
    throw serviceUnavailable({ cause: new Error("Kernel history timestamp is invalid") });
  }
  return date;
}

/** 读取有界 Kernel 历史 JSON；超限、断流和解析失败保留原始异常并关闭上游。 */
async function readJson(message: NodeJS.ReadableStream): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for await (const chunk of message as AsyncIterable<Buffer | string>) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += bytes.byteLength;
      if (size > MAX_HISTORY_RESPONSE_BYTES) {
        throw new Error("Kernel history response exceeded the size limit");
      }
      chunks.push(bytes);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch (error) {
    const destroyable = message as NodeJS.ReadableStream & { destroy?: (error?: Error) => void };
    destroyable.destroy?.(error instanceof Error ? error : new Error("Kernel history response failed", { cause: error }));
    throw serviceUnavailable({ cause: error });
  }
}

/** 解包 Kernel 统一 code/data 响应，并把上游失败映射为可审计的 API Problem。 */
function unwrapKernelData(value: unknown): unknown {
  if (typeof value !== "object" || value === null || !("code" in value)) {
    throw serviceUnavailable({ cause: new Error("Kernel history response envelope is invalid") });
  }
  if (value.code !== 0) {
    if (value.code === 404) {
      throw notFound();
    }
    throw new ApiProblemError("service-unavailable", 502, undefined, {
      cause: new Error(`Kernel history returned code ${String(value.code)}`),
    });
  }
  return "data" in value ? value.data : undefined;
}

@Injectable()
export class HistoryService {
  constructor(
    private readonly database: DatabaseRuntime,
    private readonly access: DocumentAccessPolicyService,
    private readonly kernelAccess: KernelAccessService,
    private readonly kernel: KernelPrivateClient,
    private readonly audit: AuditWriter,
  ) {}

  /** 从 Kernel 历史索引投影最小版本摘要，不把历史全文复制到 PostgreSQL 或全局状态。 */
  async listVersions(input: HistoryContext): Promise<HistoryVersionsResponse> {
    await this.#require(input, "viewer");
    const search = await this.#request(input, "read", HISTORY_SEARCH_PATH, {
      page: 1,
      query: input.documentId,
      type: 3,
    });
    const createdValues = this.#stringArray(search, "histories");
    const versions: HistoryVersion[] = [];
    for (const created of createdValues) {
      const items = await this.#request(input, "read", HISTORY_ITEMS_PATH, {
        created,
        query: input.documentId,
        type: 3,
      });
      for (const item of this.#historyItems(items)) {
        if (
          item.path === undefined ||
          !item.path.split("/").some((segment) => segment === `${input.documentId}.sy`)
        ) {
          continue;
        }
        versions.push({
          createdAt: parseCreated(created).toISOString(),
          createdByUserId: null,
          isCurrent: false,
          summary: `${item.title ?? input.documentId} (${item.op ?? "update"})`.slice(0, 500),
          versionId: encodeVersion(item.path, created),
        });
      }
    }
    await this.#auditView(input, input.documentId);
    return { versions };
  }

  /** 通过 Kernel 历史内容接口生成受 ACL 保护的最小差异投影。 */
  async diff(input: HistoryContext & { versionId: string }): Promise<HistoryDiff> {
    await this.#require(input, "viewer");
    const version = decodeVersion(input.versionId, input.documentId);
    const data = await this.#request(input, "read", HISTORY_CONTENT_PATH, {
      historyPath: version.historyPath,
      highlight: false,
    });
    const content = this.#content(data);
    await this.#auditView(input, `${input.documentId}:${input.versionId}`);
    return {
      changes: [
        {
          after: content,
          before: null,
          blockId: input.documentId,
          kind: "updated",
        },
      ],
      document: {
        documentId: input.documentId,
        notebookId: input.notebookId,
        organizationId: input.organizationId,
        spaceId: input.spaceId,
      },
      fromVersionId: null,
      toVersionId: input.versionId,
    };
  }

  /** 先让 Kernel 原子恢复，再在控制面记录新版本事件和通知；失败不会写入部分恢复审计。 */
  async restore(input: HistoryContext & { versionId: string }): Promise<RestoredHistoryVersion> {
    await this.#require(input, "editor");
    const version = decodeVersion(input.versionId, input.documentId);
    const restored = await this.#request(input, "write", HISTORY_RESTORE_PATH, {
      historyPath: version.historyPath,
    });
    const canonicalPath = this.#canonicalRestorePath(restored, input.documentId);
    const restoredVersionId = input.versionId;
    const versionId = encodeVersion(canonicalPath, new Date().toISOString());
    await this.database.client.$transaction(async (transaction) => {
      await this.audit.append(transaction, {
        action: "history.restore",
        actorUserId: input.actorUserId,
        occurredAt: new Date(),
        organizationId: input.organizationId,
        outcome: "succeeded",
        requestId: input.requestId,
        spaceId: input.spaceId,
        targetId: input.documentId,
        targetType: "history",
      });
      const members = await transaction.organizationMembership.findMany({
        where: { organizationId: input.organizationId, status: "active", user: { status: "active" } },
        select: { userId: true },
      });
      const recipients: string[] = [];
      for (const member of members) {
        const decision = await this.access.decideInTransaction(transaction, {
          actorUserId: member.userId,
          documentId: input.documentId,
          notebookId: input.notebookId,
          organizationId: input.organizationId,
          spaceId: input.spaceId,
        });
        if (decision.role !== null) {
          recipients.push(member.userId);
        }
      }
      await writeNotificationsInTransaction(transaction, {
        actorUserId: input.actorUserId,
        documentId: input.documentId,
        eventId: versionId,
        kind: "history-restored",
        notebookId: input.notebookId,
        organizationId: input.organizationId,
        recipientUserIds: recipients,
        spaceId: input.spaceId,
        threadId: null,
      });
    });
    return {
      document: {
        documentId: input.documentId,
        notebookId: input.notebookId,
        organizationId: input.organizationId,
        spaceId: input.spaceId,
      },
      restoredVersionId,
      versionId,
    };
  }

  async #require(input: HistoryContext, role: "editor" | "viewer"): Promise<void> {
    await this.database.client.$transaction((transaction) =>
      this.access.requireRole(transaction, input, role),
    );
  }

  /** 通过 Kernel Gateway 读取或恢复历史；只把有界响应交给投影解析器。 */
  async #request(
    input: HistoryContext,
    action: "read" | "write",
    path: string,
    body: Record<string, unknown>,
  ): Promise<unknown> {
    const authorized = await this.kernelAccess.authorizeHttp({
      action,
      organizationId: input.organizationId,
      requestId: input.requestId,
      spaceId: input.spaceId,
      userId: input.actorUserId,
    });
    const response = await this.kernel.request({
      body: JSON.stringify(body),
      contentIdentity: { documentId: input.documentId, notebookId: input.notebookId },
      deployment: authorized.deployment,
      headers: { accept: "application/json", "content-type": "application/json" },
      method: "POST",
      path,
      requestId: input.requestId,
    });
    if (response.status === 404) {
      response.message.destroy();
      throw notFound();
    }
    if (response.status !== 200) {
      response.message.destroy();
      throw serviceUnavailable({ cause: new Error(`Kernel history returned HTTP ${response.status}`) });
    }
    return unwrapKernelData(await readJson(response.message));
  }

  /** 将历史查看动作写入既有审计链，不把历史正文写入控制面。 */
  async #auditView(input: HistoryContext, targetId: string): Promise<void> {
    await this.database.client.$transaction((transaction) =>
      this.audit.append(transaction, {
        action: "history.view",
        actorUserId: input.actorUserId,
        occurredAt: new Date(),
        organizationId: input.organizationId,
        outcome: "succeeded",
        requestId: input.requestId,
        spaceId: input.spaceId,
        targetId,
        targetType: "history",
      }),
    );
  }

  /** 校验 Kernel 历史索引的字符串数组投影，格式错误统一转为服务不可用。 */
  #stringArray(value: unknown, key: string): string[] {
    if (typeof value !== "object" || value === null) {
      throw serviceUnavailable({ cause: new Error("Kernel history list projection is invalid") });
    }
    const record = value as Record<string, unknown>;
    if (
      !(key in record) ||
      !Array.isArray(record[key]) ||
      record[key].some((item: unknown) => typeof item !== "string")
    ) {
      throw serviceUnavailable({ cause: new Error("Kernel history list projection is invalid") });
    }
    return record[key] as string[];
  }

  /** 从 Kernel 历史条目中投影允许的路径字段，忽略无路径的非文档条目。 */
  #historyItems(value: unknown): HistoryItem[] {
    if (
      typeof value !== "object" ||
      value === null ||
      !("items" in value) ||
      !Array.isArray(value.items)
    ) {
      throw serviceUnavailable({ cause: new Error("Kernel history item projection is invalid") });
    }
    return value.items.filter((item: unknown): item is HistoryItem => {
      if (typeof item !== "object" || item === null) {
        return false;
      }
      return !(
        "path" in item &&
        item.path !== undefined &&
        typeof item.path !== "string"
      );
    });
  }

  /** 读取 Kernel 历史详情中的正文字段，不在控制面持久化内容。 */
  #content(value: unknown): string {
    if (
      typeof value !== "object" ||
      value === null ||
      !("content" in value) ||
      typeof value.content !== "string"
    ) {
      throw serviceUnavailable({ cause: new Error("Kernel history content projection is invalid") });
    }
    return value.content;
  }

  /** 只接受 Kernel 返回且仍指向当前文档的规范恢复路径。 */
  #canonicalRestorePath(value: unknown, documentId: string): string {
    if (
      typeof value !== "object" ||
      value === null ||
      !("versionId" in value) ||
      typeof value.versionId !== "string" ||
      !value.versionId.split("/").some((segment) => segment === `${documentId}.sy`)
    ) {
      throw serviceUnavailable({
        cause: new Error("Kernel restore response did not contain a canonical version"),
      });
    }
    return value.versionId;
  }
}
