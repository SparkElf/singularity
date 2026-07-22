import { Inject, Injectable, Logger } from "@nestjs/common";
import {
  collaborationJoinRequestSchema,
  collaborationJoinResponseSchema,
  collaborationOperationEnvelopeSchema,
  collaborationOperationResultSchema,
  collaborationPresenceSchema,
  collaborationResumeRequestSchema,
  collaborationRevocationSchema,
  type CollaborationBroadcast,
  type CollaborationCapability,
  type CollaborationFeatureMode,
  type CollaborationJoinResponse,
  type CollaborationOperationEnvelope,
  type CollaborationOperationResult,
  type CollaborationPresence,
  type CollaborationResumeRequest,
  type CollaborationRevocation,
  type CollaborationSessionState,
  type DocumentIdentity,
} from "@singularity/contracts";
import { DocumentAccessPolicyService } from "../document-access/document-access.service.js";
import { CLOCK } from "../tokens.js";
import type { Clock } from "../identity/clock.js";
import { CollaborationOperationDiscovery } from "./realtime-handler-discovery.js";

export const KERNEL_COLLABORATION_PORT = Symbol("KERNEL_COLLABORATION_PORT");
export const COLLABORATION_FEATURE_GATE = Symbol("COLLABORATION_FEATURE_GATE");

const MAX_ACTIVE_SESSIONS_PER_DOCUMENT = 64;
const MAX_ACTIVE_SESSIONS_PER_USER = 128;
const OPERATION_WINDOW_MILLISECONDS = 10_000;
const MAX_OPERATIONS_PER_WINDOW = 120;
const MAX_OPERATION_BYTES = 256 * 1_024;
const SUPPORTED_PROTOCOL_VERSION = 1;

export interface KernelCollaborationAdmission {
  readonly sessionGeneration: number;
  readonly version: Readonly<Record<string, number>>;
}

export interface KernelCollaborationPort {
  admit(input: {
    readonly actorUserId: string;
    readonly capability: CollaborationCapability;
    readonly featureMode: CollaborationFeatureMode;
    readonly identity: DocumentIdentity;
    readonly requestId: string;
  }): Promise<KernelCollaborationAdmission>;
  apply(input: {
    readonly actorUserId: string;
    readonly featureMode: CollaborationFeatureMode;
    readonly envelope: CollaborationOperationEnvelope;
    readonly requestId: string;
  }): Promise<CollaborationSubmitResult>;
  replay(input: {
    readonly actorUserId: string;
    readonly causalContext: Readonly<Record<string, number>>;
    readonly identity: DocumentIdentity;
    readonly requestId: string;
  }): Promise<readonly CollaborationBroadcast[]>;
}

export interface CollaborationSubmitResult {
  readonly broadcast: CollaborationBroadcast | null;
  readonly result: CollaborationOperationResult;
}

export interface CollaborationFeatureGate {
  isEnabled(identity: DocumentIdentity, mode: CollaborationFeatureMode): Promise<boolean>;
  openSession(input: {
    readonly authSessionId: string;
    readonly actorUserId: string;
    readonly clientId: string;
    readonly connectionId: string;
    readonly featureMode: CollaborationFeatureMode;
    readonly identity: DocumentIdentity;
    readonly protocolVersion: number;
    readonly requestId: string;
    readonly sessionGeneration: number;
  }): Promise<void>;
  closeSession(input: {
    readonly clientId: string;
    readonly connectionId: string;
    readonly requestId: string;
    readonly sessionGeneration: number;
    readonly status: "closed" | "conflict" | "revoked";
  }): Promise<void>;
  recordOperation(input: {
    readonly actorUserId: string;
    readonly clientId: string;
    readonly featureMode: CollaborationFeatureMode;
    readonly identity: DocumentIdentity;
    readonly operationId: string;
    readonly requestId: string;
    readonly result: CollaborationOperationResult;
    readonly sessionGeneration: number;
    readonly durationMs: number;
  }): Promise<void>;
  recordResume(input: {
    readonly authSessionId: string;
    readonly actorUserId: string;
    readonly clientId: string;
    readonly featureMode: CollaborationFeatureMode;
    readonly identity: DocumentIdentity;
    readonly requestId: string;
    readonly sessionGeneration: number;
    readonly durationMs: number;
  }): Promise<void>;
}

export interface CollaborationJoinContext {
  readonly authSessionId: string;
  readonly actorUserId: string;
  readonly connectionId: string;
  readonly requestId: string;
  readonly value: unknown;
}

export interface CollaborationSubmitContext {
  readonly actorUserId: string;
  readonly clientId: string;
  readonly connectionId: string;
  readonly requestId: string;
  readonly value: unknown;
}

export interface CollaborationResumeContext {
  readonly actorUserId: string;
  readonly connectionId: string;
  readonly requestId: string;
  readonly value: unknown;
}

interface ManagedSession {
  readonly actorUserId: string;
  readonly capability: CollaborationCapability;
  readonly clientId: string;
  readonly authSessionId: string;
  readonly connectionId: string;
  readonly featureMode: CollaborationFeatureMode;
  readonly identity: DocumentIdentity;
  readonly protocolVersion: number;
  readonly sessionGeneration: number;
  readonly requestId: string;
  operationWindowStartedAt: number;
  operationCount: number;
  state: CollaborationSessionState;
}

type PresenceEntry = CollaborationPresence & { readonly expiresAt: number };
type PendingJoin = { readonly actorUserId: string; readonly identity: DocumentIdentity };

export class CollaborationAdmissionError extends Error {
  constructor(
    readonly code:
      | "collaboration-disabled"
      | "encrypted-collaboration-unavailable"
      | "unsupported-client-version"
      | "duplicate-session"
      | "collaboration-capacity-exceeded",
    options?: ErrorOptions,
  ) {
    super(`Collaboration admission failed: ${code}`, options);
    this.name = "CollaborationAdmissionError";
  }
}

function identityKey(identity: DocumentIdentity): string {
  return [identity.organizationId, identity.spaceId, identity.notebookId, identity.documentId].join("/");
}

function sameIdentity(left: DocumentIdentity, right: DocumentIdentity): boolean {
  return identityKey(left) === identityKey(right);
}

function logError(error: unknown): { readonly name: string; readonly message: string; readonly stack: string | undefined } {
  if (error instanceof Error) {
    return { name: error.name, message: error.message, stack: error.stack };
  }
  return { name: "UnknownError", message: String(error), stack: undefined };
}

/** 去除只供单副本 TTL 清理使用的内部字段，避免 presence 把协调器状态泄露给客户端。 */
function publicPresence(entry: PresenceEntry): CollaborationPresence {
  return {
    clientId: entry.clientId,
    cursor: entry.cursor,
    identity: entry.identity,
    sessionGeneration: entry.sessionGeneration,
    ttlMs: entry.ttlMs,
  };
}

/**
 * 生产协调器只管理会话、身份、幂等边界和临时 presence；正文语义必须由 Kernel port 处理。
 * 进入本函数的 value 是专用 WSS 的唯一协议边界，后续 service 依赖已解析的四段身份合同。
 */
@Injectable()
export class CollaborationCoordinator {
  readonly #logger = new Logger("CollaborationCoordinator");
  readonly #sessions = new Map<string, ManagedSession>();
  readonly #pendingJoins = new Map<string, PendingJoin>();
  readonly #presence = new Map<string, PresenceEntry>();

  constructor(
    private readonly access: DocumentAccessPolicyService,
    @Inject(KERNEL_COLLABORATION_PORT)
    private readonly kernel: KernelCollaborationPort,
    @Inject(COLLABORATION_FEATURE_GATE)
    private readonly featureGate: CollaborationFeatureGate,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly operationDiscovery: CollaborationOperationDiscovery,
  ) {}

  /** 在进入实时会话前重新读取 ACL 和 feature gate，再向 Kernel 申请 canonical 代次。 */
  async join(input: CollaborationJoinContext): Promise<CollaborationJoinResponse> {
    const request = collaborationJoinRequestSchema.parse(input.value);
    if (request.protocolVersion !== SUPPORTED_PROTOCOL_VERSION) {
      throw new CollaborationAdmissionError("unsupported-client-version");
    }
    if (this.#sessions.has(request.clientId) || this.#pendingJoins.has(request.clientId)) {
      throw new CollaborationAdmissionError("duplicate-session");
    }
    const pendingJoins = [...this.#pendingJoins.values()];
    const activeForDocument = [...this.#sessions.values()].filter(
      (session) => session.state === "ready" && sameIdentity(session.identity, request.identity),
    ).length;
    const pendingForDocument = pendingJoins.filter((pending) => sameIdentity(pending.identity, request.identity)).length;
    if (activeForDocument + pendingForDocument >= MAX_ACTIVE_SESSIONS_PER_DOCUMENT) {
      throw new CollaborationAdmissionError("collaboration-capacity-exceeded");
    }
    const activeForUser = [...this.#sessions.values()].filter(
      (session) => session.state === "ready" && session.actorUserId === input.actorUserId,
    ).length;
    const pendingForUser = pendingJoins.filter((pending) => pending.actorUserId === input.actorUserId).length;
    if (activeForUser + pendingForUser >= MAX_ACTIVE_SESSIONS_PER_USER) {
      throw new CollaborationAdmissionError("collaboration-capacity-exceeded");
    }
    this.#pendingJoins.set(request.clientId, { actorUserId: input.actorUserId, identity: request.identity });
    try {
      return await this.#admitJoin(input, request);
    } finally {
      this.#pendingJoins.delete(request.clientId);
    }
  }

  /** 完成已计入 pending 容量的 ACL、Kernel 和控制面 admission，再发布 ready 会话。 */
  async #admitJoin(
    input: CollaborationJoinContext,
    request: { readonly capability: CollaborationCapability; readonly clientId: string; readonly featureMode: CollaborationFeatureMode; readonly identity: DocumentIdentity; readonly protocolVersion: number },
  ): Promise<CollaborationJoinResponse> {
    if (!(await this.featureGate.isEnabled(request.identity, request.featureMode))) {
      throw new CollaborationAdmissionError("collaboration-disabled");
    }
    await this.access.requireDocumentRole(
      { actorUserId: input.actorUserId, ...request.identity },
      request.capability === "editor" ? "editor" : "viewer",
    );
    let admission: KernelCollaborationAdmission;
    try {
      admission = await this.kernel.admit({
        actorUserId: input.actorUserId,
        capability: request.capability,
        featureMode: request.featureMode,
        identity: request.identity,
        requestId: input.requestId,
      });
    } catch (error) {
      this.#logger.error({
        ...logError(error),
        clientId: request.clientId,
        event: "collaboration.join",
        identity: request.identity,
        outcome: "kernel-admission-failed",
        requestId: input.requestId,
      });
      throw error;
    }
    const session: ManagedSession = {
      actorUserId: input.actorUserId,
      authSessionId: input.authSessionId,
      capability: request.capability,
      clientId: request.clientId,
      connectionId: input.connectionId,
      featureMode: request.featureMode,
      identity: request.identity,
      protocolVersion: request.protocolVersion,
      requestId: input.requestId,
      sessionGeneration: admission.sessionGeneration,
      state: "ready",
      operationWindowStartedAt: this.clock.now().getTime(),
      operationCount: 0,
    };
    try {
      await this.featureGate.openSession({
        authSessionId: session.authSessionId,
        actorUserId: input.actorUserId,
        clientId: session.clientId,
        connectionId: session.connectionId,
        featureMode: session.featureMode,
        identity: session.identity,
        protocolVersion: session.protocolVersion,
        requestId: input.requestId,
        sessionGeneration: session.sessionGeneration,
      });
    } catch (error) {
      this.#logger.error({ ...logError(error), clientId: session.clientId, event: "collaboration.session", outcome: "open-persist-failed" });
      throw error;
    }
    this.#sessions.set(session.clientId, session);
    return collaborationJoinResponseSchema.parse({
      capability: session.capability,
      featureMode: session.featureMode,
      identity: session.identity,
      protocolVersion: session.protocolVersion,
      sessionGeneration: session.sessionGeneration,
      sessionState: "ready",
      version: admission.version,
    });
  }

  /** 只允许 editor 提交；generation 和身份绑定在协调器边界完成，Kernel 只消费 typed envelope。 */
  async submit(input: CollaborationSubmitContext): Promise<CollaborationSubmitResult> {
    const envelope = collaborationOperationEnvelopeSchema.parse(input.value);
    const session = this.#sessions.get(input.clientId);
    if (session === undefined) {
      return { broadcast: null, result: this.#rejected(envelope, "session-not-ready") };
    }
    if (session.actorUserId !== input.actorUserId || session.connectionId !== input.connectionId) {
      return { broadcast: null, result: this.#rejected(envelope, "permission-revoked") };
    }
    if (session.state === "revoked") {
      return { broadcast: null, result: this.#rejected(envelope, "permission-revoked") };
    }
    if (session.state !== "ready") {
      return { broadcast: null, result: this.#rejected(envelope, "session-not-ready") };
    }
    if (session.capability !== "editor") {
      return { broadcast: null, result: this.#rejected(envelope, "permission-revoked") };
    }
    if (!sameIdentity(session.identity, envelope.identity)) {
      return { broadcast: null, result: this.#rejected(envelope, "missing-identity") };
    }
    if (session.sessionGeneration !== envelope.sessionGeneration) {
      return { broadcast: null, result: this.#rejected(envelope, "session-generation-mismatch") };
    }
    const operationStartedAt = this.clock.now().getTime();
    const rejectWithOperationAudit = async (
      code: "encrypted-collaboration-unavailable" | "invalid-operation" | "operation-too-large" | "rate-limited",
    ): Promise<CollaborationSubmitResult> => {
      const result = this.#rejected(envelope, code);
      await this.featureGate.recordOperation({
        actorUserId: input.actorUserId,
        clientId: session.clientId,
        featureMode: session.featureMode,
        identity: session.identity,
        operationId: envelope.operationId,
        requestId: input.requestId,
        result,
        sessionGeneration: session.sessionGeneration,
        durationMs: Math.max(0, this.clock.now().getTime() - operationStartedAt),
      });
      return { broadcast: null, result };
    };
    const serializedBytes = Buffer.byteLength(JSON.stringify(envelope), "utf8");
    if (serializedBytes > MAX_OPERATION_BYTES) {
      return rejectWithOperationAudit("operation-too-large");
    }
    const now = this.clock.now().getTime();
    if (now - session.operationWindowStartedAt >= OPERATION_WINDOW_MILLISECONDS) {
      session.operationWindowStartedAt = now;
      session.operationCount = 0;
    }
    if (session.operationCount >= MAX_OPERATIONS_PER_WINDOW) {
      return rejectWithOperationAudit("rate-limited");
    }
    session.operationCount += 1;
    try {
      const startedAt = this.clock.now().getTime();
      const handler = this.operationDiscovery.handlers().get(`${envelope.operation.kind}:v1`);
      if (handler === undefined) {
        return rejectWithOperationAudit("invalid-operation");
      }
      const applied = await handler.execute({
        actorUserId: input.actorUserId,
        envelope,
        featureMode: session.featureMode,
        requestId: input.requestId,
      });
      const parsed = collaborationOperationResultSchema.parse(applied.result);
      if (parsed.outcome === "conflict") {
        session.state = "conflict";
        await this.featureGate.closeSession({
          clientId: session.clientId,
          connectionId: session.connectionId,
          requestId: session.requestId,
          sessionGeneration: session.sessionGeneration,
          status: "conflict",
        });
      }
      await this.featureGate.recordOperation({
        actorUserId: input.actorUserId,
        clientId: session.clientId,
        featureMode: session.featureMode,
        identity: envelope.identity,
        operationId: envelope.operationId,
        requestId: input.requestId,
        result: parsed,
        sessionGeneration: session.sessionGeneration,
        durationMs: Math.max(0, this.clock.now().getTime() - startedAt),
      });
      return { broadcast: applied.broadcast, result: parsed };
    } catch (error) {
      if (
        error instanceof CollaborationAdmissionError &&
        error.code === "encrypted-collaboration-unavailable"
      ) {
        const rejected = await rejectWithOperationAudit(error.code);
        session.state = "closed";
        void this.featureGate.closeSession({
          clientId: session.clientId,
          connectionId: session.connectionId,
          requestId: session.requestId,
          sessionGeneration: session.sessionGeneration,
          status: "closed",
        }).catch((closeError: unknown) => {
          this.#logger.error({
            ...logError(closeError),
            clientId: session.clientId,
            event: "collaboration.session",
            outcome: "encrypted-admission-close-failed",
          });
        });
        return rejected;
      }
      this.#logger.error({
        ...logError(error),
        clientId: input.clientId,
        event: "collaboration.operation",
        identity: envelope.identity,
        operationId: envelope.operationId,
        outcome: "failed",
        requestId: input.requestId,
      });
      throw error;
    }
  }

  /** 从 Kernel canonical history 读取缺口；不会把首个响应身份写回当前页面。 */
  async resume(input: CollaborationResumeContext): Promise<readonly CollaborationBroadcast[]> {
    const request: CollaborationResumeRequest = collaborationResumeRequestSchema.parse(input.value);
    const session = this.#sessions.get(request.clientId);
    if (
      session === undefined ||
      session.actorUserId !== input.actorUserId ||
      session.connectionId !== input.connectionId ||
      session.state !== "ready" ||
      !sameIdentity(session.identity, request.identity) ||
      session.sessionGeneration !== request.sessionGeneration
    ) {
      return [];
    }
    const startedAt = this.clock.now().getTime();
    const broadcasts = await this.kernel.replay({
      actorUserId: input.actorUserId,
      causalContext: request.causalContext,
      identity: request.identity,
      requestId: input.requestId,
    });
    await this.featureGate.recordResume({
      authSessionId: session.authSessionId,
      actorUserId: input.actorUserId,
      clientId: session.clientId,
      durationMs: Math.max(0, this.clock.now().getTime() - startedAt),
      featureMode: session.featureMode,
      identity: session.identity,
      requestId: input.requestId,
      sessionGeneration: session.sessionGeneration,
    });
    return broadcasts;
  }

  /** presence 只进入单副本内存 TTL，既不落 Kernel 历史，也不落 PostgreSQL。 */
  updatePresence(input: { readonly actorUserId: string; readonly connectionId: string; readonly requestId: string; readonly value: unknown }): readonly CollaborationPresence[] {
    const presence = collaborationPresenceSchema.parse(input.value);
    const session = this.#sessions.get(presence.clientId);
    if (
      session === undefined ||
      session.actorUserId !== input.actorUserId ||
      session.connectionId !== input.connectionId ||
      session.state !== "ready" ||
      !sameIdentity(session.identity, presence.identity) ||
      session.sessionGeneration !== presence.sessionGeneration
    ) {
      return [];
    }
    const now = this.clock.now().getTime();
    this.#prunePresence(now);
    this.#presence.set(`${identityKey(presence.identity)}:${presence.clientId}`, {
      ...presence,
      expiresAt: now + presence.ttlMs,
    });
    return this.presence(presence.identity);
  }

  presence(identity: DocumentIdentity): readonly CollaborationPresence[] {
    this.#prunePresence(this.clock.now().getTime());
    return [...this.#presence.values()]
      .filter((entry) => sameIdentity(entry.identity, identity))
      .map(publicPresence);
  }

  /** 先标记单个会话撤权再清理 presence，避免文档内其他成员被连带撤权或收到撤权广播。 */
  revoke(clientId: string, connectionId: string, requestId?: string): CollaborationRevocation | null {
    const session = this.#sessions.get(clientId);
    if (session === undefined || session.connectionId !== connectionId) {
      return null;
    }
    session.state = "revoked";
    void this.featureGate.closeSession({
      clientId: session.clientId,
      connectionId: session.connectionId,
      requestId: requestId ?? session.requestId,
      sessionGeneration: session.sessionGeneration,
      status: "revoked",
    }).catch((error: unknown) => {
      this.#logger.error({ ...logError(error), clientId: session.clientId, event: "collaboration.session", outcome: "revoke-persist-failed" });
    });
    this.#presence.delete(`${identityKey(session.identity)}:${session.clientId}`);
    // 撤权提交后立即从活跃表删除，迟到的 submit/resume/presence 只能命中 session-not-ready。
    this.#sessions.delete(session.clientId);
    return collaborationRevocationSchema.parse({
      identity: session.identity,
      reason: "permission-revoked",
      sessionGeneration: session.sessionGeneration,
      sessionState: "revoked",
    });
  }

  close(clientId: string, connectionId: string): void {
    const session = this.#sessions.get(clientId);
    if (session === undefined || session.connectionId !== connectionId) {
      return;
    }
    session.state = "closed";
    void this.featureGate.closeSession({
      clientId: session.clientId,
      connectionId: session.connectionId,
      requestId: session.requestId,
      sessionGeneration: session.sessionGeneration,
      status: "closed",
    }).catch((error: unknown) => {
      this.#logger.error({ ...logError(error), clientId, event: "collaboration.session", outcome: "close-persist-failed" });
    });
    this.#presence.delete(`${identityKey(session.identity)}:${clientId}`);
    this.#sessions.delete(clientId);
  }

  #rejected(
    envelope: CollaborationOperationEnvelope,
    code: "invalid-operation" | "permission-revoked" | "session-not-ready" | "missing-identity" | "session-generation-mismatch" | "operation-too-large" | "rate-limited" | "encrypted-collaboration-unavailable",
  ): CollaborationOperationResult {
    return collaborationOperationResultSchema.parse({
      code,
      identity: envelope.identity,
      operationId: envelope.operationId,
      outcome: "rejected",
      sessionGeneration: envelope.sessionGeneration,
    });
  }

  #prunePresence(now: number): void {
    for (const [key, entry] of this.#presence) {
      if (entry.expiresAt <= now) {
        this.#presence.delete(key);
      }
    }
  }
}
