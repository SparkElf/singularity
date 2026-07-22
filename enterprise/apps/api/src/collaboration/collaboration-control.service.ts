import { Inject, Injectable, Logger } from "@nestjs/common";
import { AuditWriter, DatabaseRuntime } from "@singularity/database";
import type {
  CollaborationFeature,
  CollaborationFeatureMode,
  DocumentIdentity,
  CollaborationOperationResult,
  UpdateCollaborationFeatureRequest,
} from "@singularity/contracts";
import { collaborationFeatureSchema } from "@singularity/contracts";

import type { ApiConfiguration } from "../configuration.js";
import { API_CONFIGURATION } from "../tokens.js";
import type { CollaborationFeatureGate } from "./realtime-coordinator.js";
import { SpaceManagementService } from "../spaces/space-management.service.js";
import { ContentDirectoryService } from "../kernel/content-directory.service.js";
import { DocumentAccessPolicyService } from "../document-access/document-access.service.js";

export interface CollaborationFeatureChange {
  readonly feature: CollaborationFeature;
  readonly identity: DocumentIdentity;
}

function collaborationResultCode(result: CollaborationOperationResult): string | null {
  if (result.outcome === "rejected") {
    return result.code;
  }
  if (result.outcome === "conflict") {
    return result.conflict.code;
  }
  return null;
}

/** 控制面只存协作开关、会话元数据和审计投影；正文、操作内容和密钥始终留在 Kernel。 */
@Injectable()
export class CollaborationControlService implements CollaborationFeatureGate {
  readonly #logger = new Logger("CollaborationControlService");
  readonly #featureListeners = new Set<(change: CollaborationFeatureChange) => void>();

  constructor(
    private readonly database: DatabaseRuntime,
    private readonly audit: AuditWriter,
    @Inject(API_CONFIGURATION) private readonly configuration: ApiConfiguration,
    private readonly documentAccess: DocumentAccessPolicyService,
    private readonly directory: ContentDirectoryService,
    private readonly spaces: SpaceManagementService,
  ) {}

  /** 注册功能开关变更监听；监听者只负责关闭受影响会话，不读取正文或重做权限。 */
  subscribeFeatureChanges(listener: (change: CollaborationFeatureChange) => void): () => void {
    this.#featureListeners.add(listener);
    return () => this.#featureListeners.delete(listener);
  }

  /** 全局开关和文档控制面均开启时才允许加入；缺少控制面记录按关闭处理。 */
  async isEnabled(identity: DocumentIdentity, mode: CollaborationFeatureMode): Promise<boolean> {
    if (!this.configuration.collaborationEnabled) {
      return false;
    }
    const feature = await this.database.client.collaborationFeature.findUnique({
      where: {
        organizationId_spaceId_notebookId_documentId: {
          documentId: identity.documentId,
          notebookId: identity.notebookId,
          organizationId: identity.organizationId,
          spaceId: identity.spaceId,
        },
      },
      select: { restrictedEncryptedEnabled: true, standardEnabled: true },
    });
    return mode === "restricted-encrypted"
      ? feature?.restrictedEncryptedEnabled === true
      : feature?.standardEnabled === true;
  }

  /** 读取文档协作开关；不存在的记录保持关闭，避免未明确批准的文档意外开放。 */
  async getFeature(input: {
    readonly actorUserId: string;
    readonly identity: DocumentIdentity;
    readonly requestId: string;
    readonly signal: AbortSignal;
  }): Promise<CollaborationFeature> {
    await this.documentAccess.requireDocumentRole(
      { actorUserId: input.actorUserId, ...input.identity },
      "viewer",
    );
    await this.directory.assertDocumentExists({
      actorUserId: input.actorUserId,
      documentId: input.identity.documentId,
      notebookId: input.identity.notebookId,
      organizationId: input.identity.organizationId,
      requestId: input.requestId,
      signal: input.signal,
      spaceId: input.identity.spaceId,
    });
    const feature = await this.database.client.collaborationFeature.findUnique({
      where: {
        organizationId_spaceId_notebookId_documentId: {
          documentId: input.identity.documentId,
          notebookId: input.identity.notebookId,
          organizationId: input.identity.organizationId,
          spaceId: input.identity.spaceId,
        },
      },
    });
    return collaborationFeatureSchema.parse({
      ...input.identity,
      restrictedEncryptedEnabled: this.configuration.collaborationEnabled &&
        feature?.restrictedEncryptedEnabled === true,
      standardEnabled: this.configuration.collaborationEnabled && feature?.standardEnabled === true,
    });
  }

  /** 由空间管理员显式设置 feature；受限加密开关不会隐式打开标准协作。 */
  async updateFeature(
    input: {
      readonly actorUserId: string;
      readonly identity: DocumentIdentity;
      readonly requestId: string;
      readonly signal: AbortSignal;
      readonly value: UpdateCollaborationFeatureRequest;
    },
  ): Promise<CollaborationFeature> {
    await this.spaces.requireSpaceManager(
      input.actorUserId,
      input.identity.organizationId,
      input.identity.spaceId,
    );
    await this.directory.assertDocumentExists({
      actorUserId: input.actorUserId,
      documentId: input.identity.documentId,
      notebookId: input.identity.notebookId,
      organizationId: input.identity.organizationId,
      requestId: input.requestId,
      signal: input.signal,
      spaceId: input.identity.spaceId,
    });
    const change = await this.database.client.$transaction(async (transaction) => {
      const previous = await transaction.collaborationFeature.findUnique({
        where: {
          organizationId_spaceId_notebookId_documentId: {
            documentId: input.identity.documentId,
            notebookId: input.identity.notebookId,
            organizationId: input.identity.organizationId,
            spaceId: input.identity.spaceId,
          },
        },
        select: { restrictedEncryptedEnabled: true, standardEnabled: true },
      });
      const updated = await transaction.collaborationFeature.upsert({
        where: {
          organizationId_spaceId_notebookId_documentId: {
            documentId: input.identity.documentId,
            notebookId: input.identity.notebookId,
            organizationId: input.identity.organizationId,
            spaceId: input.identity.spaceId,
          },
        },
        create: { ...input.identity, ...input.value },
        update: input.value,
      });
      await transaction.collaborationAuditEvent.create({
        data: {
          actorUserId: input.actorUserId,
          documentId: input.identity.documentId,
          event: "feature",
          featureMode: null,
          notebookId: input.identity.notebookId,
          operationId: null,
          organizationId: input.identity.organizationId,
          outcome: "updated",
          requestId: input.requestId,
          sessionGeneration: null,
          spaceId: input.identity.spaceId,
        },
      });
      return {
        changed: previous?.restrictedEncryptedEnabled !== updated.restrictedEncryptedEnabled ||
          previous?.standardEnabled !== updated.standardEnabled,
        feature: updated,
      };
    });
    const result = collaborationFeatureSchema.parse({
      ...input.identity,
      restrictedEncryptedEnabled: change.feature.restrictedEncryptedEnabled,
      standardEnabled: change.feature.standardEnabled,
    });
    if (change.changed) {
      this.#featureListeners.forEach((listener) => {
        try {
          listener({
            feature: result,
            identity: input.identity,
          });
        } catch (error) {
          this.#logger.error({
            error: error instanceof Error
              ? { name: error.name, message: error.message, stack: error.stack }
              : { name: "UnknownError", message: String(error), stack: undefined },
            event: "collaboration.feature",
            outcome: "listener-failed",
            requestId: input.requestId,
          });
        }
      });
    }
    return result;
  }

  /** 在协作加入成功后写入最小会话元数据与审计投影，不复制业务操作。 */
  async openSession(input: {
    readonly authSessionId: string;
    readonly actorUserId: string;
    readonly clientId: string;
    readonly featureMode: CollaborationFeatureMode;
    readonly connectionId: string;
    readonly identity: DocumentIdentity;
    readonly protocolVersion: number;
    readonly requestId: string;
    readonly sessionGeneration: number;
  }): Promise<void> {
    await this.database.client.$transaction(async (transaction) => {
      await transaction.collaborationSession.create({
        data: {
          actorUserId: input.actorUserId,
          authSessionId: input.authSessionId,
          clientId: input.clientId,
          connectionId: input.connectionId,
          documentId: input.identity.documentId,
          featureMode: input.featureMode === "restricted-encrypted" ? "restricted_encrypted" : "standard",
          notebookId: input.identity.notebookId,
          organizationId: input.identity.organizationId,
          protocolVersion: input.protocolVersion,
          sessionGeneration: BigInt(input.sessionGeneration),
          spaceId: input.identity.spaceId,
          status: "ready",
        },
      });
      await transaction.collaborationAuditEvent.create({
        data: this.#auditData(input, "join", "accepted"),
      });
      await this.audit.append(transaction, {
        action: "collaboration.join",
        actorUserId: input.actorUserId,
        occurredAt: new Date(),
        organizationId: input.identity.organizationId,
        outcome: "succeeded",
        requestId: input.requestId,
        spaceId: input.identity.spaceId,
        targetId: input.clientId,
        targetType: "session",
      });
    });
  }

  /** 关闭会话时按连接代号回读其四段身份，再原子更新状态和审计投影。 */
  async closeSession(input: {
    readonly clientId: string;
    readonly connectionId: string;
    readonly requestId: string;
    readonly sessionGeneration: number;
    readonly status: "closed" | "conflict" | "revoked";
  }): Promise<void> {
    await this.database.client.$transaction(async (transaction) => {
      const session = await transaction.collaborationSession.findUnique({
        where: {
          connectionId: input.connectionId,
        },
      });
      if (session === null || session.closedAt !== null) {
        return;
      }
      await transaction.collaborationSession.update({
        where: { id: session.id },
        data: { closedAt: new Date(), status: input.status },
      });
      await transaction.collaborationAuditEvent.create({
        data: {
          actorUserId: session.actorUserId,
          authSessionId: session.authSessionId,
          clientId: session.clientId,
          documentId: session.documentId,
          featureMode: session.featureMode,
          notebookId: session.notebookId,
          operationId: null,
          organizationId: session.organizationId,
          outcome: input.status,
          requestId: input.requestId,
          sessionGeneration: session.sessionGeneration,
          spaceId: session.spaceId,
          event: "lifecycle",
        },
      });
      if (input.status === "revoked") {
        await this.audit.append(transaction, {
          action: "collaboration.revoke",
          actorUserId: session.actorUserId,
          occurredAt: new Date(),
          organizationId: session.organizationId,
          outcome: "succeeded",
          requestId: input.requestId,
          spaceId: session.spaceId,
          targetId: session.clientId,
          targetType: "session",
        });
      }
    }).catch((error: unknown) => {
      this.#logger.error({
        error: error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : { name: "UnknownError", message: String(error), stack: undefined },
        clientId: input.clientId,
        event: "collaboration.session",
        outcome: "persist-failed",
      });
      throw error;
    });
  }

  /** 只记录协作操作的身份、编号、结果和代次，禁止把语义 payload 写入控制面。 */
  async recordOperation(input: {
    readonly actorUserId: string;
    readonly clientId: string;
    readonly featureMode: CollaborationFeatureMode;
    readonly identity: DocumentIdentity;
    readonly operationId: string;
    readonly requestId: string;
    readonly result: CollaborationOperationResult;
    readonly sessionGeneration: number;
    readonly durationMs: number;
  }): Promise<void> {
    await this.database.client.$transaction(async (transaction) => {
      await transaction.collaborationAuditEvent.create({
        data: {
          actorUserId: input.actorUserId,
          clientId: input.clientId,
          documentId: input.identity.documentId,
          featureMode: input.featureMode === "restricted-encrypted" ? "restricted_encrypted" : "standard",
          notebookId: input.identity.notebookId,
          operationId: input.operationId,
          organizationId: input.identity.organizationId,
          outcome: input.result.outcome,
          resultCode: collaborationResultCode(input.result),
          requestId: input.requestId,
          sessionGeneration: BigInt(input.sessionGeneration),
          durationMs: input.durationMs,
          spaceId: input.identity.spaceId,
          event: input.result.outcome === "conflict" ? "conflict" : "operation",
        },
      });
      await this.audit.append(transaction, {
        action: input.result.outcome === "conflict" ? "collaboration.conflict" : "collaboration.operation",
        actorUserId: input.actorUserId,
        occurredAt: new Date(),
        organizationId: input.identity.organizationId,
        outcome: input.result.outcome === "accepted" || input.result.outcome === "duplicate" ? "succeeded" : "denied",
        requestId: input.requestId,
        spaceId: input.identity.spaceId,
        targetId: input.identity.documentId,
        targetType: "document",
      });
    }).catch((error: unknown) => {
      this.#logger.error({
        error: error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : { name: "UnknownError", message: String(error), stack: undefined },
        clientId: input.clientId,
        event: "collaboration.operation",
        operationId: input.operationId,
        outcome: "audit-persist-failed",
        requestId: input.requestId,
      });
      throw error;
    });
  }

  /** 将恢复请求写入详细投影和既有防篡改审计链，正文广播仍只来自 Kernel history。 */
  async recordResume(input: {
    readonly authSessionId: string;
    readonly actorUserId: string;
    readonly clientId: string;
    readonly featureMode: CollaborationFeatureMode;
    readonly identity: DocumentIdentity;
    readonly requestId: string;
    readonly sessionGeneration: number;
    readonly durationMs: number;
  }): Promise<void> {
    await this.database.client.$transaction(async (transaction) => {
      await transaction.collaborationAuditEvent.create({
        data: {
          actorUserId: input.actorUserId,
          authSessionId: input.authSessionId,
          clientId: input.clientId,
          documentId: input.identity.documentId,
          featureMode: input.featureMode === "restricted-encrypted" ? "restricted_encrypted" : "standard",
          notebookId: input.identity.notebookId,
          operationId: null,
          organizationId: input.identity.organizationId,
          outcome: "accepted",
          requestId: input.requestId,
          sessionGeneration: BigInt(input.sessionGeneration),
          durationMs: input.durationMs,
          spaceId: input.identity.spaceId,
          event: "resume",
        },
      });
      await this.audit.append(transaction, {
        action: "collaboration.resume",
        actorUserId: input.actorUserId,
        occurredAt: new Date(),
        organizationId: input.identity.organizationId,
        outcome: "succeeded",
        requestId: input.requestId,
        spaceId: input.identity.spaceId,
        targetId: input.clientId,
        targetType: "session",
      });
    }).catch((error: unknown) => {
      this.#logger.error({
        error: error instanceof Error
          ? { name: error.name, message: error.message, stack: error.stack }
          : { name: "UnknownError", message: String(error), stack: undefined },
        clientId: input.clientId,
        event: "collaboration.resume",
        outcome: "audit-persist-failed",
        requestId: input.requestId,
      });
      throw error;
    });
  }

  #auditData(
    input: {
      readonly actorUserId: string;
      readonly authSessionId: string;
      readonly clientId: string;
      readonly featureMode: CollaborationFeatureMode;
      readonly identity: DocumentIdentity;
      readonly requestId: string;
      readonly sessionGeneration: number;
    },
    event: string,
    outcome: string,
  ) {
    return {
      actorUserId: input.actorUserId,
      authSessionId: input.authSessionId,
      clientId: input.clientId,
      documentId: input.identity.documentId,
      featureMode: input.featureMode === "restricted-encrypted" ? "restricted_encrypted" as const : "standard" as const,
      notebookId: input.identity.notebookId,
      operationId: null,
      organizationId: input.identity.organizationId,
      outcome,
      requestId: input.requestId,
      sessionGeneration: BigInt(input.sessionGeneration),
      spaceId: input.identity.spaceId,
      event,
    };
  }
}
