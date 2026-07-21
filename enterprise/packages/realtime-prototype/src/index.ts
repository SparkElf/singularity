import {
  collaborationBroadcastSchema,
  collaborationCapabilitySchema,
  collaborationJoinRequestSchema,
  collaborationJoinResponseSchema,
  collaborationOperationEnvelopeSchema,
  collaborationOperationResultSchema,
  collaborationPresenceSchema,
  collaborationResumeRequestSchema,
  collaborationRevocationSchema,
  type CollaborationBroadcast,
  type CollaborationCapability,
  type CollaborationJoinResponse,
  type CollaborationOperationEnvelope,
  type CollaborationOperationResult,
  type CollaborationPresence,
  type CollaborationResumeRequest,
  type CollaborationRevocation,
  type CollaborationSessionState,
  type DocumentIdentity,
} from "@singularity/contracts";

export interface SemanticCoreApplyResult {
  readonly broadcast: CollaborationBroadcast | null;
  readonly result: CollaborationOperationResult;
}

export interface SemanticCore {
  apply(envelope: CollaborationOperationEnvelope, serverSequence: number): SemanticCoreApplyResult;
  history(identity: DocumentIdentity): readonly CollaborationBroadcast[];
}

export interface Session {
  readonly capability: CollaborationCapability;
  readonly clientId: string;
  readonly identity: DocumentIdentity;
  state: CollaborationSessionState;
}

export interface ProtocolLogEntry {
  readonly clientId: string;
  readonly identity: DocumentIdentity;
  readonly operationId?: string;
  readonly phase: "join" | "operation" | "presence" | "resume" | "lifecycle";
  readonly result: string;
  readonly error?: { name: string; message: string; stack: string | undefined };
}

export interface CoordinatorOptions {
  readonly authorize?: (identity: DocumentIdentity, capability: CollaborationCapability) => boolean;
  readonly now?: () => number;
}

type PresenceEntry = CollaborationPresence & { expiresAt: number };

function identityKey(identity: DocumentIdentity): string {
  return [identity.organizationId, identity.spaceId, identity.notebookId, identity.documentId].join("/");
}

function sameIdentity(left: DocumentIdentity, right: DocumentIdentity): boolean {
  return identityKey(left) === identityKey(right);
}

function logError(error: unknown): NonNullable<ProtocolLogEntry["error"]> {
  if (error instanceof Error) {
    return { name: error.name, message: error.message, stack: error.stack };
  }
  return { name: "UnknownError", message: String(error), stack: undefined };
}

/** 协调器只管理协议生命周期，正文语义由注入的 Go core 端口负责。 */
export class PrototypeCoordinator {
  readonly #core: SemanticCore;
  readonly #authorize: (identity: DocumentIdentity, capability: CollaborationCapability) => boolean;
  readonly #now: () => number;
  readonly #sessions = new Map<string, Session>();
  readonly #presence = new Map<string, PresenceEntry>();
  readonly #logs: ProtocolLogEntry[] = [];

  constructor(core: SemanticCore, options: CoordinatorOptions = {}) {
    this.#core = core;
    this.#authorize = options.authorize ?? (() => true);
    this.#now = options.now ?? (() => Date.now());
  }

  /** 建立绑定四段身份的会话；撤权只在既有 ACL 回调拒绝时进入 revoked。 */
  join(input: unknown): CollaborationJoinResponse {
    const request = collaborationJoinRequestSchema.parse(input);
    const key = request.clientId;
    const session: Session = {
      capability: collaborationCapabilitySchema.parse(request.capability),
      clientId: request.clientId,
      identity: request.identity,
      state: "connecting",
    };
    if (!this.#authorize(request.identity, request.capability)) {
      session.state = "revoked";
      this.#sessions.set(key, session);
      this.#record({ clientId: key, identity: request.identity, phase: "join", result: "revoked" });
      throw new Error("Collaboration permission revoked");
    }
    session.state = "ready";
    this.#sessions.set(key, session);
    const response = collaborationJoinResponseSchema.parse({
      capability: request.capability,
      identity: request.identity,
      sessionState: "ready",
      version: this.#version(request.identity),
    });
    this.#record({ clientId: key, identity: request.identity, phase: "join", result: "ready" });
    return response;
  }

  /** 只有 editor 会话能提交语义操作，其他能力在协议边界返回明确拒绝。 */
  submit(clientId: string, input: unknown): SemanticCoreApplyResult {
    const session = this.#requireSession(clientId);
    const envelope = collaborationOperationEnvelopeSchema.parse(input);
    if (session.state === "revoked") {
      return this.#rejected(envelope, "permission-revoked");
    }
    if (session.state !== "ready") {
      return this.#rejected(envelope, "session-not-ready");
    }
    if (session.capability !== "editor") {
      return this.#rejected(envelope, "permission-revoked");
    }
    if (!sameIdentity(session.identity, envelope.identity)) {
      return this.#rejected(envelope, "missing-identity");
    }
    try {
      const result = this.#core.apply(envelope, this.#nextServerSequence(envelope.identity));
      this.#record({ clientId, identity: envelope.identity, operationId: envelope.operationId, phase: "operation", result: result.result.outcome });
      collaborationOperationResultSchema.parse(result.result);
      return result;
    } catch (error) {
      this.#record({ clientId, identity: envelope.identity, operationId: envelope.operationId, phase: "operation", result: "failed", error: logError(error) });
      throw error;
    }
  }

  resume(input: unknown): readonly CollaborationBroadcast[] {
    const request = collaborationResumeRequestSchema.parse(input) as CollaborationResumeRequest;
    const session = this.#requireSession(request.clientId);
    if (session.state !== "ready" || !sameIdentity(session.identity, request.identity)) {
      this.#record({ clientId: request.clientId, identity: request.identity, phase: "resume", result: "rejected" });
      return [];
    }
    const result = this.#core.history(request.identity).filter((broadcast) => {
      const seen = request.causalContext[broadcast.operation.clientId] ?? 0;
      return broadcast.operation.clientSequence > seen;
    });
    this.#record({ clientId: request.clientId, identity: request.identity, phase: "resume", result: String(result.length) });
    return result;
  }

  /** presence 只写入内存 TTL，返回投影时主动清理过期会话。 */
  updatePresence(input: unknown): readonly CollaborationPresence[] {
    const presence = collaborationPresenceSchema.parse(input);
    const session = this.#requireSession(presence.clientId);
    if (session.state !== "ready" || !sameIdentity(session.identity, presence.identity)) {
      this.#record({ clientId: presence.clientId, identity: presence.identity, phase: "presence", result: "rejected" });
      return [];
    }
    const entry = { ...presence, expiresAt: this.#now() + presence.ttlMs };
    this.#presence.set(`${identityKey(presence.identity)}:${presence.clientId}`, entry);
    this.#record({ clientId: presence.clientId, identity: presence.identity, phase: "presence", result: "published" });
    return this.presence(presence.identity);
  }

  presence(identity: DocumentIdentity): readonly CollaborationPresence[] {
    this.prunePresence();
    return [...this.#presence.values()]
      .filter((entry) => sameIdentity(entry.identity, identity))
      .map(({ expiresAt: _expiresAt, ...value }) => value);
  }

  /** ACL 撤销同时关闭所有匹配文档会话并移除临时 presence。 */
  revoke(identity: DocumentIdentity): readonly CollaborationRevocation[] {
    const revocations: CollaborationRevocation[] = [];
    for (const session of this.#sessions.values()) {
      if (!sameIdentity(session.identity, identity)) {
        continue;
      }
      session.state = "revoked";
      this.#presence.delete(`${identityKey(identity)}:${session.clientId}`);
      revocations.push(collaborationRevocationSchema.parse({ identity, reason: "permission-revoked", sessionState: "revoked" }));
      this.#record({ clientId: session.clientId, identity, phase: "lifecycle", result: "revoked" });
    }
    return revocations;
  }

  close(clientId: string): void {
    const session = this.#sessions.get(clientId);
    if (session === undefined) {
      return;
    }
    session.state = "closed";
    this.#presence.delete(`${identityKey(session.identity)}:${clientId}`);
    this.#record({ clientId, identity: session.identity, phase: "lifecycle", result: "closed" });
  }

  logs(): readonly ProtocolLogEntry[] {
    return [...this.#logs];
  }

  #requireSession(clientId: string): Session {
    const session = this.#sessions.get(clientId);
    if (session === undefined) {
      throw new Error("Collaboration session unavailable");
    }
    return session;
  }

  #rejected(envelope: CollaborationOperationEnvelope, code: "permission-revoked" | "session-not-ready" | "missing-identity"): SemanticCoreApplyResult {
    const result = collaborationOperationResultSchema.parse({ identity: envelope.identity, operationId: envelope.operationId, outcome: "rejected", code });
    this.#record({ clientId: envelope.clientId, identity: envelope.identity, operationId: envelope.operationId, phase: "operation", result: code });
    return { broadcast: null, result };
  }

  #version(identity: DocumentIdentity): Readonly<Record<string, number>> {
    const version: Record<string, number> = {};
    for (const broadcast of this.#core.history(identity)) {
      const clientId = broadcast.operation.clientId;
      version[clientId] = Math.max(version[clientId] ?? 0, broadcast.operation.clientSequence);
    }
    return version;
  }

  #nextServerSequence(identity: DocumentIdentity): number {
    const history = this.#core.history(identity);
    return (history.at(-1)?.serverSequence ?? 0) + 1;
  }

  #record(entry: ProtocolLogEntry): void {
    this.#logs.push(entry);
  }

  #prunePresence(): void {
    const now = this.#now();
    for (const [key, entry] of this.#presence) {
      if (entry.expiresAt <= now) {
        this.#presence.delete(key);
      }
    }
  }

  private prunePresence(): void {
    this.#prunePresence();
  }
}

/** 仅供协议/浏览器原型使用的外部语义服务替身；不复制 Go reducer，只记录已确认 canonical 操作。 */
export class RecordingSemanticCore implements SemanticCore {
  readonly #historyByIdentity = new Map<string, CollaborationBroadcast[]>();
  readonly #operationIds = new Set<string>();

  apply(envelope: CollaborationOperationEnvelope, serverSequence: number): SemanticCoreApplyResult {
    const key = identityKey(envelope.identity);
    if (this.#operationIds.has(envelope.operationId)) {
      return {
        broadcast: null,
        result: collaborationOperationResultSchema.parse({ identity: envelope.identity, operationId: envelope.operationId, outcome: "duplicate", serverSequence }),
      };
    }
    this.#operationIds.add(envelope.operationId);
    const broadcast = collaborationBroadcastSchema.parse({ identity: envelope.identity, operation: envelope, serverSequence });
    const list = this.#historyByIdentity.get(key) ?? [];
    list.push(broadcast);
    this.#historyByIdentity.set(key, list);
    return {
      broadcast,
      result: collaborationOperationResultSchema.parse({ identity: envelope.identity, operationId: envelope.operationId, outcome: "accepted", serverSequence }),
    };
  }

  history(identity: DocumentIdentity): readonly CollaborationBroadcast[] {
    return [...(this.#historyByIdentity.get(identityKey(identity)) ?? [])];
  }
}

export function parseBroadcast(value: unknown): CollaborationBroadcast {
  return collaborationBroadcastSchema.parse(value);
}
