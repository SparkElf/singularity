import { randomUUID } from "node:crypto";
import type { IncomingMessage, Server as HttpServer } from "node:http";
import type { Duplex } from "node:stream";

import { fastifyCookie } from "@fastify/cookie";
import { Inject, Injectable, Logger, type BeforeApplicationShutdown } from "@nestjs/common";
import {
  AUTH_SESSION_COOKIE_NAME,
  COLLABORATION_WEBSOCKET_PATH,
  collaborationClientMessageSchema,
  collaborationServerMessageSchema,
  type CollaborationClientMessage,
  type CollaborationFeatureMode,
  type CollaborationServerMessage,
  type DocumentIdentity,
} from "@singularity/contracts";
import WebSocket, { WebSocketServer } from "ws";

import type { ApiConfiguration } from "../configuration.js";
import { IdentityService } from "../identity/identity.service.js";
import { ApiProblemError } from "../problem.js";
import { API_CONFIGURATION } from "../tokens.js";
import type { AccessChanged, AccessSelector } from "../kernel/access-changed.js";
import { CollaborationAdmissionError, CollaborationCoordinator } from "./realtime-coordinator.js";
import { CollaborationControlService, type CollaborationFeatureChange } from "./collaboration-control.service.js";
import { collaborationErrorContext as logError } from "./error-context.js";

export const COLLABORATION_PATH = COLLABORATION_WEBSOCKET_PATH;
const MAX_MESSAGE_BYTES = 1 * 1_024 * 1_024;

interface Connection {
  readonly authSessionId: string;
  readonly actorUserId: string;
  readonly connectionId: string;
  readonly close: () => Promise<void>;
  readonly requestId: string;
  readonly socket: WebSocket;
  messageQueue: Promise<void>;
  joined: boolean;
  clientId?: string;
  featureMode?: CollaborationFeatureMode;
  identity?: DocumentIdentity;
}

function sameIdentity(left: DocumentIdentity, right: DocumentIdentity): boolean {
  return (
    left.organizationId === right.organizationId &&
    left.spaceId === right.spaceId &&
    left.notebookId === right.notebookId &&
    left.documentId === right.documentId
  );
}

/** 将 ws 的多种原始帧形态统一为 UTF-8 文本，协议解析只在这一个边界执行。 */
function rawDataText(data: WebSocket.RawData): string {
  if (typeof data === "string") {
    return data;
  }
  if (Buffer.isBuffer(data)) {
    return data.toString("utf8");
  }
  if (Array.isArray(data)) {
    return Buffer.concat(data).toString("utf8");
  }
  return Buffer.from(data).toString("utf8");
}

function matchesSelector(connection: Connection, selector: AccessSelector): boolean {
  switch (selector.kind) {
    case "auth-session":
      return connection.authSessionId === selector.value;
    case "user":
      return connection.actorUserId === selector.value;
    case "organization":
      return connection.identity?.organizationId === selector.value;
    case "space":
      return connection.identity?.spaceId === selector.value;
    case "document":
      return connection.identity !== undefined && sameIdentity(connection.identity, selector);
  }
}

export function matchesAccessChange(connection: Connection, change: AccessChanged): boolean {
  // selectors 是同一授权事实的交集，例如“文档 + 用户”只能命中该用户在该文档的连接。
  return change.selectors.every((selector) => matchesSelector(connection, selector));
}

function errorCode(error: unknown): CollaborationServerMessage {
  if (error instanceof CollaborationAdmissionError) {
    return collaborationServerMessageSchema.parse({ type: "error", code: error.code });
  }
  if (error instanceof ApiProblemError) {
    return collaborationServerMessageSchema.parse({
      type: "error",
      code: error.status === 401 ? "unauthenticated" : error.status === 403 || error.status === 404 ? "forbidden" : "service-unavailable",
    });
  }
  return collaborationServerMessageSchema.parse({ type: "error", code: "invalid-message" });
}

/**
 * 专用双向协作 WSS；它只负责认证、协议解析和广播，不保存正文或实现并发 reducer。
 * 升级前只建立用户会话，文档四段身份必须由首条 join 合同明确提供并交给 coordinator。
 */
@Injectable()
export class RealtimeCollaborationWebSocketGateway implements BeforeApplicationShutdown {
  readonly #logger = new Logger("RealtimeCollaborationWebSocketGateway");
  readonly #server = new WebSocketServer({
    clientTracking: true,
    maxPayload: MAX_MESSAGE_BYTES,
    noServer: true,
    perMessageDeflate: false,
  });
  readonly #connections = new Set<Connection>();
  #httpServer: HttpServer | undefined;
  #shuttingDown = false;
  readonly #unsubscribeFeatureChanges: () => void;

  constructor(
    @Inject(API_CONFIGURATION)
    private readonly configuration: ApiConfiguration,
    private readonly identity: IdentityService,
    private readonly coordinator: CollaborationCoordinator,
    private readonly control: CollaborationControlService,
  ) {
    this.#unsubscribeFeatureChanges = this.control.subscribeFeatureChanges((change) => {
      this.#closeByFeatureChange(change);
    });
  }

  /** 把独立协作升级入口挂到 HTTP server，不复用只读 Protyle 推送路径。 */
  attach(server: HttpServer): void {
    if (this.#httpServer !== undefined || this.#shuttingDown) {
      throw new Error("Realtime collaboration WebSocket gateway is already attached");
    }
    this.#httpServer = server;
    server.on("upgrade", this.#handleUpgrade);
  }

  /** 关闭升级入口和全部临时会话，避免 presence 或 socket 在应用退出后残留。 */
  async beforeApplicationShutdown(): Promise<void> {
    this.#shuttingDown = true;
    this.#unsubscribeFeatureChanges();
    if (this.#httpServer !== undefined) {
      this.#httpServer.off("upgrade", this.#handleUpgrade);
      this.#httpServer = undefined;
    }
    const connections = [...this.#connections];
    // 先排空已经进入队列的 join/submit，再关闭连接，避免待处理消息在 shutdown 后补建 session。
    await Promise.all(connections.map(async (connection) => {
      try {
        await connection.messageQueue;
      } catch (error) {
        this.#logger.error({
          error: logError(error),
          event: "collaboration.lifecycle",
          outcome: "shutdown-message-drain-failed",
          requestId: connection.requestId,
        });
      }
    }));
    await Promise.all(connections.map((connection) => connection.close()));
    await this.coordinator.flushPersistence();
    await new Promise<void>((resolve) => {
      this.#server.close(() => resolve());
    });
  }

  /** ACL 提交事实到达后关闭命中的实时会话；撤权先于 socket 清理。 */
  closeByAccessChange(change: AccessChanged): void {
    const matches = [...this.#connections].filter((connection) =>
      matchesAccessChange(connection, change),
    );
    for (const connection of matches) {
      const revocation = connection.clientId === undefined
        ? null
        : this.coordinator.revoke(connection.clientId, connection.connectionId, change.requestId);
      if (revocation !== null) {
        this.#send(connection, { revocation, type: "revoked" });
      }
      void connection.close();
    }
  }

  readonly #handleUpgrade = (request: IncomingMessage, socket: Duplex, head: Buffer): void => {
    if (this.#shuttingDown || socket.destroyed) {
      socket.destroy();
      return;
    }
    const pathname = new URL(
      request.url ?? "/",
      "https://singularity.invalid",
    ).pathname;
    if (pathname !== COLLABORATION_PATH) {
      return;
    }
    const requestId = randomUUID();
    void this.#authorizeUpgrade(request, requestId)
      .then((session) => {
        if (this.#shuttingDown || socket.destroyed) {
          socket.destroy();
          return;
        }
        this.#server.handleUpgrade(request, socket, head, (browser) => {
          const connection: Connection = {
            authSessionId: session.authSessionId,
            actorUserId: session.userId,
            close: () => this.#close(connection),
            connectionId: randomUUID(),
            messageQueue: Promise.resolve(),
            joined: false,
            requestId,
            socket: browser,
          };
          this.#connections.add(connection);
          browser.on("message", (data, isBinary) => {
            if (this.#shuttingDown) {
              return;
            }
            connection.messageQueue = connection.messageQueue.then(
              () => this.#handleMessage(connection, data, isBinary),
              () => this.#handleMessage(connection, data, isBinary),
            );
          });
          browser.on("close", () => { void this.#close(connection); });
          browser.on("error", (error) => {
            this.#logger.error({
              error: logError(error),
              event: "collaboration.lifecycle",
              outcome: "browser-websocket-error",
              requestId,
            });
            void this.#close(connection);
          });
        });
      })
      .catch((error: unknown) => {
        this.#logger.warn({
          error: logError(error),
          event: "collaboration.join",
          outcome: "upgrade-rejected",
          requestId,
        });
        this.#rejectUpgrade(socket, error instanceof ApiProblemError ? error.status : 503, requestId);
      });
  };

  async #authorizeUpgrade(request: IncomingMessage, requestId: string): Promise<{ readonly authSessionId: string; readonly userId: string }> {
    if (request.headers.origin !== this.configuration.publicOrigin) {
      throw new ApiProblemError("forbidden", 403);
    }
    const pathname = new URL(request.url ?? "/", "https://singularity.invalid").pathname;
    if (pathname !== COLLABORATION_PATH) {
      throw new ApiProblemError("not-found", 404);
    }
    const cookies = fastifyCookie.parse(request.headers.cookie ?? "");
    const session = await this.identity.authenticate(cookies[AUTH_SESSION_COOKIE_NAME], requestId);
    return { authSessionId: session.authSessionId, userId: session.userId };
  }

  async #handleMessage(connection: Connection, data: WebSocket.RawData, isBinary: boolean): Promise<void> {
    if (!this.#connections.has(connection)) {
      return;
    }
    if (isBinary) {
      this.#send(connection, { type: "error", code: "invalid-message" });
      return;
    }
    let message: CollaborationClientMessage;
    try {
      const value: unknown = JSON.parse(rawDataText(data));
      message = collaborationClientMessageSchema.parse(value);
    } catch (error) {
      this.#logger.warn({
        error: logError(error),
        event: "collaboration.lifecycle",
        outcome: "invalid-message",
        requestId: connection.requestId,
      });
      this.#send(connection, { type: "error", code: "invalid-message" });
      return;
    }
    try {
      await this.#dispatch(connection, message);
    } catch (error) {
      this.#logger.error({
        error: logError(error),
        event: "collaboration.lifecycle",
        outcome: "message-failed",
        requestId: connection.requestId,
      });
      this.#send(connection, errorCode(error));
    }
  }

  /** 按已认证连接代号分派协议消息；连接关闭后任何迟到任务都不能借用新会话。 */
  async #dispatch(connection: Connection, message: CollaborationClientMessage): Promise<void> {
    switch (message.type) {
      case "join": {
        if (connection.clientId !== undefined) {
          this.#send(connection, { type: "error", code: "invalid-message" });
          return;
        }
        // 在异步 ACL/Kernel admission 前绑定请求身份，让期间到达的撤权事件可以命中 pending 连接。
        connection.clientId = message.request.clientId;
        connection.featureMode = message.request.featureMode;
        connection.identity = message.request.identity;
        let response: Awaited<ReturnType<CollaborationCoordinator["join"]>>;
        try {
          response = await this.coordinator.join({
            actorUserId: connection.actorUserId,
            authSessionId: connection.authSessionId,
            connectionId: connection.connectionId,
            requestId: connection.requestId,
            value: message.request,
          });
        } catch (error) {
          delete connection.clientId;
          delete connection.featureMode;
          delete connection.identity;
          throw error;
        }
        if (!this.#connections.has(connection)) {
          void this.coordinator.close(message.request.clientId, connection.connectionId);
          return;
        }
        connection.joined = true;
        this.#send(connection, { response, type: "joined" });
        return;
      }
      case "submit": {
        if (!connection.joined || connection.clientId === undefined || message.envelope.clientId !== connection.clientId) {
          this.#send(connection, { type: "error", code: "forbidden" });
          return;
        }
        const submitted = await this.coordinator.submit({
          actorUserId: connection.actorUserId,
          clientId: connection.clientId,
          connectionId: connection.connectionId,
          requestId: connection.requestId,
          value: message.envelope,
        });
        this.#send(connection, { result: submitted.result, type: "operation-result" });
        if (submitted.broadcast !== null) {
          this.#broadcast(message.envelope.identity, { broadcast: submitted.broadcast, type: "operation-broadcast" });
        }
        return;
      }
      case "resume": {
        if (!connection.joined || connection.clientId === undefined || message.request.clientId !== connection.clientId) {
          this.#send(connection, { type: "error", code: "forbidden" });
          return;
        }
        const broadcasts = await this.coordinator.resume({ actorUserId: connection.actorUserId, connectionId: connection.connectionId, requestId: connection.requestId, value: message.request });
        this.#send(connection, { broadcasts: [...broadcasts], type: "resumed" });
        return;
      }
      case "presence": {
        if (
          !connection.joined ||
          connection.clientId === undefined ||
          connection.identity === undefined ||
          message.presence.clientId !== connection.clientId ||
          !sameIdentity(connection.identity, message.presence.identity)
        ) {
          this.#send(connection, { type: "error", code: "forbidden" });
          return;
        }
        const presence = this.coordinator.updatePresence({
          actorUserId: connection.actorUserId,
          connectionId: connection.connectionId,
          requestId: connection.requestId,
          value: message.presence,
        });
        this.#broadcast(message.presence.identity, { presence: [...presence], type: "presence" });
        return;
      }
      case "leave":
        await this.#close(connection);
        return;
    }
  }

  #broadcast(identity: DocumentIdentity, message: CollaborationServerMessage): void {
    const parsed = collaborationServerMessageSchema.parse(message);
    for (const connection of this.#connections) {
      if (connection.joined && connection.identity !== undefined && sameIdentity(connection.identity, identity)) {
        this.#send(connection, parsed);
      }
    }
  }

  /** 功能开关提交后只关闭对应模式的旧连接，客户端收到明确错误后停止自动重连。 */
  #closeByFeatureChange(change: CollaborationFeatureChange): void {
    for (const connection of [...this.#connections]) {
      if (
        connection.identity === undefined ||
        connection.featureMode === undefined ||
        !sameIdentity(connection.identity, change.identity) ||
        (connection.featureMode === "standard" && change.feature.standardEnabled) ||
        (connection.featureMode === "restricted-encrypted" && change.feature.restrictedEncryptedEnabled)
      ) {
        continue;
      }
      this.#send(connection, { code: "collaboration-disabled", type: "error" });
      void this.#close(connection);
    }
  }

  #send(connection: Connection, message: CollaborationServerMessage): void {
    if (connection.socket.readyState !== WebSocket.OPEN) {
      return;
    }
    connection.socket.send(JSON.stringify(collaborationServerMessageSchema.parse(message)));
  }

  /** 先从广播集合摘除连接，再等待会话投影落盘，最后关闭浏览器 socket。 */
  async #close(connection: Connection): Promise<void> {
    if (!this.#connections.delete(connection)) {
      return;
    }
    const hadSession = connection.joined;
    connection.joined = false;
    const identity = connection.identity;
    if (connection.clientId !== undefined) {
      await this.coordinator.close(connection.clientId, connection.connectionId);
    }
    if (hadSession && identity !== undefined) {
      this.#broadcast(identity, { presence: [...this.coordinator.presence(identity)], type: "presence" });
    }
    if (connection.socket.readyState < WebSocket.CLOSING) {
      connection.socket.close(1000, "closed");
    }
  }

  #rejectUpgrade(socket: Duplex, status: number, requestId: string): void {
    if (socket.destroyed || !socket.writable) {
      return;
    }
    const code = status === 401
      ? "unauthenticated"
      : status === 403
        ? "forbidden"
        : "service-unavailable";
    const reason = status === 401 ? "Unauthorized" : status === 403 ? "Forbidden" : "Service Unavailable";
    const body = JSON.stringify({ code, requestId, status });
    socket.end(
      `HTTP/1.1 ${String(status)} ${reason}\r\n` +
        "Cache-Control: no-store\r\nConnection: close\r\nContent-Type: application/problem+json; charset=utf-8\r\n" +
        `Content-Length: ${String(Buffer.byteLength(body))}\r\nX-Request-Id: ${requestId}\r\n\r\n${body}`,
    );
  }
}
