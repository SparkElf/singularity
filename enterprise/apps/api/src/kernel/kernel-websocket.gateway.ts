import { randomUUID } from "node:crypto";
import type { IncomingMessage, Server as HttpServer } from "node:http";
import type { Duplex } from "node:stream";

import { fastifyCookie } from "@fastify/cookie";
import {
  Inject,
  Injectable,
  Logger,
  type BeforeApplicationShutdown,
} from "@nestjs/common";
import {
  AUTH_SESSION_COOKIE_NAME,
  COLLABORATION_WEBSOCKET_PATH,
} from "@singularity/contracts";
import {
  KernelPrivateWebSocketClient,
  KernelRoutePolicyRegistry,
} from "@singularity/kernel-client";
import WebSocket, {
  WebSocketServer,
} from "ws";

import type { ApiConfiguration } from "../configuration.js";
import { DocumentAccessPolicyService } from "../document-access/document-access.service.js";
import { IdentityService } from "../identity/identity.service.js";
import { ApiProblemError } from "../problem.js";
import { API_CONFIGURATION } from "../tokens.js";
import {
  KernelGatewayAdmissionError,
  parseKernelWebSocketTarget,
  type KernelWebSocketTarget,
} from "./gateway-path.js";
import { kernelErrorContext } from "./error-context.js";
import { KernelAccessService } from "./kernel-access.service.js";
import type { SpaceConnectionHandle } from "./space-connection.registry.js";
import { SpaceConnectionRegistry } from "./space-connection.registry.js";

function statusText(status: number): string {
  if (status === 400) {
    return "Bad Request";
  }
  if (status === 401) {
    return "Unauthorized";
  }
  if (status === 403) {
    return "Forbidden";
  }
  if (status === 404) {
    return "Not Found";
  }
  return "Service Unavailable";
}

const WEBSOCKET_SHUTDOWN_GRACE_MILLISECONDS = 2_000;

@Injectable()
export class KernelWebSocketGateway implements BeforeApplicationShutdown {
  readonly #logger = new Logger("KernelWebSocketGateway");
  readonly #server = new WebSocketServer({
    clientTracking: true,
    maxPayload: 8 * 1_024 * 1_024,
    noServer: true,
    perMessageDeflate: false,
  });
  #httpServer: HttpServer | undefined;
  readonly #pendingUpgradeSockets = new Set<Duplex>();
  #shutdownPromise: Promise<void> | undefined;
  #shuttingDown = false;

  constructor(
    private readonly access: KernelAccessService,
    @Inject(API_CONFIGURATION)
    private readonly configuration: ApiConfiguration,
    private readonly connections: SpaceConnectionRegistry,
    private readonly documentAccess: DocumentAccessPolicyService,
    private readonly identity: IdentityService,
    private readonly policies: KernelRoutePolicyRegistry,
    private readonly upstream: KernelPrivateWebSocketClient,
  ) {}

  /** 把升级入口挂到 Nest 管理的 HTTP server；只有通知链可用后才接受连接。 */
  attach(server: HttpServer): void {
    if (this.#httpServer !== undefined || this.#shuttingDown) {
      throw new Error("Kernel WebSocket gateway is already attached");
    }
    this.#httpServer = server;
    server.on("upgrade", this.#handleUpgrade);
  }

  /** 在 HTTP server 关闭前撤销升级监听并排空 pending/active WebSocket。 */
  beforeApplicationShutdown(): Promise<void> {
    if (this.#shutdownPromise === undefined) {
      this.#shutdownPromise = this.#shutdown();
    }
    return this.#shutdownPromise;
  }

  async #shutdown(): Promise<void> {
    this.#shuttingDown = true;
    if (this.#httpServer !== undefined) {
      this.#httpServer.off("upgrade", this.#handleUpgrade);
      this.#httpServer = undefined;
    }
    this.connections.closeAllByKernelLifecycle();
    for (const socket of this.#pendingUpgradeSockets) {
      socket.destroy();
    }
    this.#pendingUpgradeSockets.clear();
    for (const socket of this.#server.clients) {
      if (socket.readyState < WebSocket.CLOSING) {
        socket.close(1001, "server-shutdown");
      }
    }
    await this.#closeWebSocketServer();
  }

  /** 认证并登记浏览器升级请求，随后由独立激活流程完成授权复验和上游握手。 */
  readonly #handleUpgrade = (
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ): void => {
    if (this.#shuttingDown || socket.destroyed) {
      socket.destroy();
      return;
    }
    const pathname = new URL(
      request.url ?? "/",
      "https://gateway.invalid",
    ).pathname;
    if (
      this.configuration.collaborationEnabled &&
      pathname === COLLABORATION_WEBSOCKET_PATH
    ) {
      return;
    }
    const requestId = randomUUID();
    this.#logger.debug({
      event: "kernel.route",
      outcome: "websocket-upgrade-received",
      requestId,
      url: request.url,
    });
    this.#pendingUpgradeSockets.add(socket);
    void this.#authorizeUpgrade(request, requestId)
      .then(({ session, target }) => {
        if (this.#shuttingDown || socket.destroyed) {
          return;
        }
        this.#server.handleUpgrade(request, socket, head, (browser) => {
          this.#server.emit("connection", browser, request);
          let handle: SpaceConnectionHandle;
          try {
            handle = this.connections.registerPending({
              authSessionId: session.authSessionId,
              closeBrowser: (code, reason) => browser.close(code, reason),
              connectionId: randomUUID(),
              documentId: target.identity.documentId,
              organizationId: target.organizationId,
              notebookId: target.identity.notebookId,
              requestId,
              sendBrowser: (data, binary) => {
                if (browser.readyState === WebSocket.OPEN) {
                  browser.send(data, { binary });
                }
              },
              spaceId: target.spaceId,
              userId: session.userId,
            });
          } catch (error) {
            this.#logger.error({
              ...kernelErrorContext(
                error,
                "Kernel WebSocket registration failed",
              ),
              event: "kernel.route",
              outcome: "websocket-registration-failed",
              requestId,
              spaceId: target.spaceId,
            });
            browser.close(1011, "service-unavailable");
            return;
          }
          browser.on("error", (error) => {
            this.#logger.warn({
              ...kernelErrorContext(error, "Browser WebSocket failed"),
              connectionId: handle.connectionId,
              event: "kernel.route",
              outcome: "browser-websocket-failed",
              requestId,
              spaceId: target.spaceId,
            });
            handle.browserClosed();
          });
          browser.on("close", () => handle.browserClosed());
          browser.on("message", () => handle.clientMessageReceived());
          void this.#activate(handle, target, session, requestId).catch((error) => {
            this.#logger.error({
              ...kernelErrorContext(error, "Kernel WebSocket activation failed"),
              connectionId: handle.connectionId,
              event: "kernel.route",
              outcome: "websocket-activation-failed",
              requestId,
              spaceId: target.spaceId,
            });
            handle.reject("kernel-unavailable");
          });
        });
      })
      .catch((error: unknown) => {
        if (this.#shuttingDown || socket.destroyed) {
          return;
        }
        const status =
          error instanceof KernelGatewayAdmissionError
            ? error.status
            : error instanceof ApiProblemError
              ? error.status
              : 503;
        const code =
          status === 401
            ? "unauthenticated"
            : status === 403
              ? "forbidden"
              : status === 404
                ? "not-found"
                : status === 400
                  ? "validation-failed"
                  : "service-unavailable";
        this.#logger.warn({
          ...kernelErrorContext(error, "Kernel WebSocket upgrade failed"),
          event: "kernel.route",
          outcome: "websocket-upgrade-rejected",
          requestId,
          status,
        });
        this.#rejectUpgrade(socket, status, code, requestId);
      })
      .finally(() => this.#pendingUpgradeSockets.delete(socket));
  };

  /** 校验同源、路由策略和浏览器会话，返回后续激活所需的最小身份。 */
  async #authorizeUpgrade(request: IncomingMessage, requestId: string) {
    if (!this.connections.available) {
      throw new ApiProblemError("service-unavailable", 503);
    }
    if (request.headers.origin !== this.configuration.publicOrigin) {
      throw new ApiProblemError("forbidden", 403);
    }
    const target = parseKernelWebSocketTarget(request.url ?? "/");
    if (target === null) {
      throw new ApiProblemError("not-found", 404);
    }
    const policy = this.policies.resolve("GET", target.upstreamPath);
    if (policy.contentMode !== "websocket" || policy.identity !== "content") {
      throw new ApiProblemError("forbidden", 403);
    }
    const cookies = fastifyCookie.parse(request.headers.cookie ?? "");
    const session = await this.identity.authenticate(
      cookies[AUTH_SESSION_COOKIE_NAME],
      requestId,
    );
    return { session, target };
  }

  /** 重新检查空间授权、绑定期限与 mTLS 上游；任何迟到状态都关闭连接而不发送数据。 */
  async #activate(
    handle: SpaceConnectionHandle,
    target: KernelWebSocketTarget,
    session: { readonly authSessionId: string; readonly userId: string },
    requestId: string,
  ): Promise<void> {
    try {
      await this.documentAccess.requireDocumentRole(
        {
          actorUserId: session.userId,
          documentId: target.identity.documentId,
          notebookId: target.identity.notebookId,
          organizationId: target.organizationId,
          spaceId: target.spaceId,
        },
        "viewer",
      );
    } catch (error) {
      this.#logger.warn({
        ...kernelErrorContext(error, "Document ACL rejected WebSocket activation"),
        connectionId: handle.connectionId,
        event: "kernel.route",
        outcome: "document-access-rejected",
        requestId,
        spaceId: target.spaceId,
      });
      handle.reject("forbidden");
      return;
    }
    const authorization = await this.access.revalidateConnection({
      action: "read",
      authSessionId: session.authSessionId,
      organizationId: target.organizationId,
      requestId,
      spaceId: target.spaceId,
      userId: session.userId,
    });
    if (authorization.result !== "authorized") {
      handle.reject(authorization.result);
      return;
    }
    if (!handle.activate(
      authorization.expiresAt,
      authorization.target.deployment.kernelInstanceId,
    )) {
      return;
    }

    let upstream: WebSocket;
    try {
      upstream = await this.upstream.connect({
        deployment: authorization.target.deployment,
        onClose: (error) => {
          if (error !== undefined && !handle.signal.aborted) {
            this.#logger.warn({
              ...kernelErrorContext(error, "Kernel upstream WebSocket failed"),
              connectionId: handle.connectionId,
              event: "kernel.route",
              kernelInstanceId:
                authorization.target.deployment.kernelInstanceId,
              outcome: "upstream-websocket-failed",
              requestId,
              spaceId: target.spaceId,
            });
          }
          handle.upstreamClosed();
        },
        onMessage: (data, binary) => handle.upstreamMessage(data, binary),
        path: target.upstreamPath,
        requestId,
        signal: handle.signal,
      });
    } catch (error) {
      this.#logger.warn({
        ...kernelErrorContext(error, "Kernel upstream WebSocket connect failed"),
        connectionId: handle.connectionId,
        event: "kernel.route",
        kernelInstanceId: authorization.target.deployment.kernelInstanceId,
        outcome: "upstream-connect-failed",
        requestId,
        spaceId: target.spaceId,
      });
      handle.reject("kernel-unavailable");
      return;
    }
    if (!handle.bindUpstream(() => upstream.terminate())) {
      return;
    }
    this.#logger.log({
      connectionId: handle.connectionId,
      event: "kernel.route",
      kernelInstanceId: authorization.target.deployment.kernelInstanceId,
      outcome: "websocket-active",
      requestId,
      spaceId: target.spaceId,
    });
  }

  #closeWebSocketServer(): Promise<void> {
    return new Promise((resolve) => {
      let settled = false;
      // 关闭超时由 finish 闭包读取，先声明再赋值以覆盖同步 close 回调。
      // eslint-disable-next-line prefer-const
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const finish = (error?: Error): void => {
        if (settled) {
          return;
        }
        settled = true;
        if (timeout !== undefined) {
          clearTimeout(timeout);
        }
        if (
          error !== undefined &&
          error.message !== "The server is not running"
        ) {
          this.#logger.warn({
            ...kernelErrorContext(error, "Kernel WebSocket server close failed"),
            event: "kernel.route",
            outcome: "websocket-server-close-failed",
          });
        }
        resolve();
      };
      timeout = setTimeout(() => {
        for (const socket of this.#server.clients) {
          socket.terminate();
        }
        finish();
      }, WEBSOCKET_SHUTDOWN_GRACE_MILLISECONDS);
      timeout.unref();
      try {
        this.#server.close(finish);
      } catch (error) {
        for (const socket of this.#server.clients) {
          socket.terminate();
        }
        finish(
          error instanceof Error
            ? error
            : new Error("Kernel WebSocket server close failed", {
                cause: error,
              }),
        );
      }
    });
  }

  #rejectUpgrade(
    socket: Duplex,
    status: number,
    code: string,
    requestId: string,
  ): void {
    if (socket.destroyed || !socket.writable) {
      return;
    }
    const body = JSON.stringify({ code, requestId, status });
    socket.end(
      `HTTP/1.1 ${String(status)} ${statusText(status)}\r\n` +
        "Cache-Control: no-store\r\n" +
        "Connection: close\r\n" +
        "Content-Type: application/problem+json; charset=utf-8\r\n" +
        `Content-Length: ${String(Buffer.byteLength(body))}\r\n` +
        `X-Request-Id: ${requestId}\r\n\r\n` +
        body,
    );
  }
}
