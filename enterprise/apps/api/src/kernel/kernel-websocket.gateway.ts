import { randomUUID } from "node:crypto";
import type { IncomingMessage, Server as HttpServer } from "node:http";
import type { Duplex } from "node:stream";

import { fastifyCookie } from "@fastify/cookie";
import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationShutdown,
} from "@nestjs/common";
import { AUTH_SESSION_COOKIE_NAME } from "@singularity/contracts";
import {
  KernelPrivateWebSocketClient,
  KernelRoutePolicyRegistry,
} from "@singularity/kernel-client";
import WebSocket, {
  WebSocketServer,
} from "ws";

import type { ApiConfiguration } from "../configuration.js";
import { IdentityService } from "../identity/identity.service.js";
import { ApiProblemError } from "../problem.js";
import { API_CONFIGURATION } from "../tokens.js";
import {
  KernelGatewayAdmissionError,
  parseKernelWebSocketTarget,
  type KernelWebSocketTarget,
} from "./gateway-path.js";
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

@Injectable()
export class KernelWebSocketGateway implements OnApplicationShutdown {
  readonly #logger = new Logger("KernelWebSocketGateway");
  readonly #server = new WebSocketServer({
    clientTracking: true,
    maxPayload: 8 * 1_024 * 1_024,
    noServer: true,
    perMessageDeflate: false,
  });
  #httpServer: HttpServer | undefined;
  readonly #pendingUpgradeSockets = new Set<Duplex>();
  #shuttingDown = false;

  constructor(
    private readonly access: KernelAccessService,
    @Inject(API_CONFIGURATION)
    private readonly configuration: ApiConfiguration,
    private readonly connections: SpaceConnectionRegistry,
    private readonly identity: IdentityService,
    private readonly policies: KernelRoutePolicyRegistry,
    private readonly upstream: KernelPrivateWebSocketClient,
  ) {}

  attach(server: HttpServer): void {
    if (this.#httpServer !== undefined || this.#shuttingDown) {
      throw new Error("Kernel WebSocket gateway is already attached");
    }
    this.#httpServer = server;
    server.on("upgrade", this.#handleUpgrade);
  }

  onApplicationShutdown(): void {
    if (this.#shuttingDown) {
      return;
    }
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
      socket.close(1001, "server-shutdown");
    }
    this.#server.close();
  }

  readonly #handleUpgrade = (
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ): void => {
    if (this.#shuttingDown || socket.destroyed) {
      socket.destroy();
      return;
    }
    const requestId = randomUUID();
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
              organizationId: target.organizationId,
              requestId,
              sendBrowser: (data, binary) => {
                if (browser.readyState === WebSocket.OPEN) {
                  browser.send(data, { binary });
                }
              },
              spaceId: target.spaceId,
              userId: session.userId,
            });
          } catch {
            browser.close(1011, "service-unavailable");
            return;
          }
          browser.on("error", () => handle.browserClosed());
          browser.on("close", () => handle.browserClosed());
          browser.on("message", () => handle.clientMessageReceived());
          void this.#activate(handle, target, session, requestId).catch(() => {
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
        this.#rejectUpgrade(socket, status, code, requestId);
      })
      .finally(() => this.#pendingUpgradeSockets.delete(socket));
  };

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

  async #activate(
    handle: SpaceConnectionHandle,
    target: KernelWebSocketTarget,
    session: { readonly authSessionId: string; readonly userId: string },
    requestId: string,
  ): Promise<void> {
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
        onClose: () => handle.upstreamClosed(),
        onMessage: (data, binary) => handle.upstreamMessage(data, binary),
        path: target.upstreamPath,
        requestId,
        signal: handle.signal,
      });
    } catch {
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
