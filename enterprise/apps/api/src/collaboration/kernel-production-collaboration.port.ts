import { Injectable, Logger } from "@nestjs/common";
import {
  collaborationConflictSchema,
  collaborationBroadcastSchema,
  collaborationOperationResultSchema,
  type CollaborationBroadcast,
  type CollaborationCapability,
  type CollaborationFeatureMode,
  type CollaborationOperationEnvelope,
  type CollaborationOperationResult,
  type DocumentIdentity,
} from "@singularity/contracts";
import {
  KernelPrivateClient,
  type KernelPrivateResponse,
} from "@singularity/kernel-client";

import { KernelAccessService } from "../kernel/kernel-access.service.js";
import { serviceUnavailable } from "../problem.js";
import type {
  CollaborationSubmitResult,
  KernelCollaborationAdmission,
  KernelCollaborationPort,
} from "./realtime-coordinator.js";
import { CollaborationAdmissionError } from "./realtime-coordinator.js";
import { collaborationErrorContext } from "./error-context.js";

const COLLABORATION_PATH = "/internal/enterprise/collaboration";
const MAX_RESPONSE_BYTES = 1 * 1_024 * 1_024;

interface KernelHistoryEntry {
  readonly operation: CollaborationOperationEnvelope;
  readonly serverSequence: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function sameIdentity(left: DocumentIdentity, right: DocumentIdentity): boolean {
  return left.organizationId === right.organizationId && left.spaceId === right.spaceId &&
    left.notebookId === right.notebookId && left.documentId === right.documentId;
}

function chunkBuffer(chunk: unknown): Buffer {
  if (Buffer.isBuffer(chunk)) {
    return chunk;
  }
  if (typeof chunk === "string") {
    return Buffer.from(chunk, "utf8");
  }
  if (chunk instanceof Uint8Array) {
    return Buffer.from(chunk);
  }
  throw new Error("Kernel collaboration response contains an invalid byte chunk");
}

async function readJson(response: KernelPrivateResponse): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for await (const chunk of response.message) {
      const bytes = chunkBuffer(chunk);
      size += bytes.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        throw new Error("Kernel collaboration response exceeded the size limit");
      }
      chunks.push(bytes);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch (error) {
    response.message.destroy(error instanceof Error ? error : undefined);
    throw serviceUnavailable({ cause: error });
  }
}

function unwrap(value: unknown): unknown {
  if (!isRecord(value) || value.code !== 0 || !("data" in value)) {
    throw serviceUnavailable({ cause: new Error("Kernel collaboration response is invalid") });
  }
  return value.data;
}

/** 将 Kernel 的受限加密拒绝保留为协作协议错误，其余非合同响应仍进入统一 503 转换。 */
function unwrapKernelResponse(response: KernelPrivateResponse, value: unknown): unknown {
  if (
    response.status === 409 &&
    isRecord(value) &&
    value.code === "encrypted-collaboration-unavailable"
  ) {
    throw new CollaborationAdmissionError("encrypted-collaboration-unavailable");
  }
  return unwrap(value);
}

function toConflict(value: unknown, envelope: CollaborationOperationEnvelope) {
  if (!isRecord(value)) {
    throw serviceUnavailable({ cause: new Error("Kernel collaboration conflict is invalid") });
  }
  const operationIds = Array.isArray(value.operationIds)
    ? value.operationIds.filter((item): item is string => typeof item === "string")
    : [];
  const kind = value.kind;
  if (
    kind !== "delete-edit" &&
    kind !== "block-move" &&
    kind !== "attribute-view-cell" &&
    kind !== "reference-target"
  ) {
    throw serviceUnavailable({ cause: new Error("Kernel collaboration conflict kind is invalid") });
  }
  return collaborationConflictSchema.parse({
    code: value.code,
    conflictId: typeof value.conflictId === "string" ? value.conflictId : envelope.operationId,
    identity: envelope.identity,
    kind,
    operationId: operationIds.at(-1) ?? envelope.operationId,
    sessionGeneration: envelope.sessionGeneration,
    status: "open",
  });
}

function toResult(value: unknown, envelope: CollaborationOperationEnvelope): CollaborationOperationResult {
  if (!isRecord(value)) {
    throw serviceUnavailable({ cause: new Error("Kernel collaboration result is invalid") });
  }
  const common = {
    identity: envelope.identity,
    operationId: envelope.operationId,
    sessionGeneration: envelope.sessionGeneration,
  };
  if (value.outcome === "accepted" || value.outcome === "duplicate") {
    return collaborationOperationResultSchema.parse({
      ...common,
      outcome: value.outcome,
      serverSequence: value.serverSequence,
    });
  }
  if (value.outcome === "conflict") {
    return collaborationOperationResultSchema.parse({
      ...common,
      conflict: toConflict(value.conflict, envelope),
      outcome: "conflict",
    });
  }
  return collaborationOperationResultSchema.parse({
    ...common,
    code: value.code,
    outcome: "rejected",
  });
}

/** 验证 Kernel history 仍属于当前请求文档，阻断错误响应造成跨库广播。 */
function toBroadcast(entry: KernelHistoryEntry, expectedIdentity: DocumentIdentity): CollaborationBroadcast {
  const broadcast = collaborationBroadcastSchema.parse({
    identity: entry.operation.identity,
    operation: entry.operation,
    serverSequence: entry.serverSequence,
  });
  if (!sameIdentity(broadcast.identity, expectedIdentity) || !sameIdentity(broadcast.operation.identity, expectedIdentity)) {
    throw serviceUnavailable({ cause: new Error("Kernel collaboration history identity is invalid") });
  }
  return broadcast;
}

@Injectable()
export class KernelProductionCollaborationPort implements KernelCollaborationPort {
  readonly #logger = new Logger("KernelProductionCollaborationPort");

  constructor(
    private readonly kernel: KernelPrivateClient,
    private readonly access: KernelAccessService,
  ) {}

  /** 通过既有 Kernel 授权和 mTLS 边界申请协作代次；控制面不接触密钥或正文。 */
  async admit(input: {
    readonly actorUserId: string;
    readonly capability: CollaborationCapability;
    readonly featureMode: CollaborationFeatureMode;
    readonly identity: DocumentIdentity;
    readonly requestId: string;
  }): Promise<KernelCollaborationAdmission> {
    const authorized = await this.access.authorizeHttp({
      action: input.capability === "editor" ? "write" : "read",
      organizationId: input.identity.organizationId,
      requestId: input.requestId,
      spaceId: input.identity.spaceId,
      userId: input.actorUserId,
    });
    const response = await this.#request(authorized.deployment, input.identity, input.requestId, {
      action: "admit",
      featureMode: input.featureMode,
      identity: input.identity,
    });
    const data = unwrapKernelResponse(response, await readJson(response));
    if (!isRecord(data) || typeof data.sessionGeneration !== "number" || !isRecord(data.version)) {
      throw serviceUnavailable({ cause: new Error("Kernel collaboration admission is invalid") });
    }
    return { sessionGeneration: data.sessionGeneration, version: data.version as Readonly<Record<string, number>> };
  }

  /** 把语义操作发送给 Kernel，并把 Go 结果转换为当前公开合同。 */
  async apply(input: {
    readonly actorUserId: string;
    readonly featureMode: CollaborationFeatureMode;
    readonly envelope: CollaborationOperationEnvelope;
    readonly requestId: string;
  }): Promise<CollaborationSubmitResult> {
    const authorized = await this.access.authorizeHttp({
      action: "write",
      organizationId: input.envelope.identity.organizationId,
      requestId: input.requestId,
      spaceId: input.envelope.identity.spaceId,
      userId: input.actorUserId,
    });
    const response = await this.#request(authorized.deployment, input.envelope.identity, input.requestId, {
      action: "apply",
      envelope: input.envelope,
      featureMode: input.featureMode,
      identity: input.envelope.identity,
    });
    const data = unwrapKernelResponse(response, await readJson(response));
    if (!isRecord(data) || !isRecord(data.result)) {
      throw serviceUnavailable({ cause: new Error("Kernel collaboration apply is invalid") });
    }
    const result = toResult(data.result, input.envelope);
    return {
      broadcast: isRecord(data.broadcast) && isRecord(data.broadcast.operation)
        ? toBroadcast(data.broadcast as unknown as KernelHistoryEntry, input.envelope.identity)
        : null,
      result,
    };
  }

  /** 从 Kernel canonical history 裁剪客户端缺口，防止迟到响应覆盖当前文档。 */
  async replay(input: {
    readonly actorUserId: string;
    readonly causalContext: Readonly<Record<string, number>>;
    readonly identity: DocumentIdentity;
    readonly requestId: string;
  }): Promise<readonly CollaborationBroadcast[]> {
    const authorized = await this.access.authorizeHttp({
      action: "read",
      organizationId: input.identity.organizationId,
      requestId: input.requestId,
      spaceId: input.identity.spaceId,
      userId: input.actorUserId,
    });
    const response = await this.#request(authorized.deployment, input.identity, input.requestId, {
      action: "replay",
      identity: input.identity,
    });
    const data = unwrapKernelResponse(response, await readJson(response));
    if (!isRecord(data) || !Array.isArray(data.entries)) {
      throw serviceUnavailable({ cause: new Error("Kernel collaboration replay is invalid") });
    }
    return data.entries
      .filter((entry): entry is KernelHistoryEntry => isRecord(entry) && isRecord(entry.operation))
      .filter((entry) => entry.operation.clientSequence > (input.causalContext[entry.operation.clientId] ?? 0))
      .map((entry) => toBroadcast(entry, input.identity));
  }

  async #request(
    deployment: Parameters<KernelPrivateClient["request"]>[0]["deployment"],
    identity: DocumentIdentity,
    requestId: string,
    body: Record<string, unknown>,
  ): Promise<KernelPrivateResponse> {
    try {
      return await this.kernel.request({
        body: JSON.stringify(body),
        contentIdentity: {
          documentId: identity.documentId,
          notebookId: identity.notebookId,
          organizationId: identity.organizationId,
          spaceId: identity.spaceId,
        },
        deployment,
        headers: { accept: "application/json", "content-type": "application/json" },
        method: "POST",
        path: COLLABORATION_PATH,
        requestId,
      });
    } catch (error) {
      this.#logger.error({
        error: collaborationErrorContext(error),
        event: "collaboration.kernel-request",
        outcome: "failed",
        requestId,
      });
      throw error;
    }
  }
}
