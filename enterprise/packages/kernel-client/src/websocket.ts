import { isIP } from "node:net";
import type { RequestOptions as HttpsRequestOptions } from "node:https";

import WebSocket, { type RawData } from "ws";

import { KernelCredentialService } from "./credentials.js";
import type {
  KernelDeploymentIdentity,
  KernelDeploymentRegistry,
} from "./deployment.js";
import { KernelTransportError } from "./errors.js";
import { KernelRoutePolicyRegistry } from "./policy.js";

export interface KernelPrivateWebSocketRequest {
  readonly deployment: KernelDeploymentIdentity;
  readonly onClose: () => void;
  readonly onMessage: (data: Buffer, binary: boolean) => void;
  readonly path: string;
  readonly requestId: string;
  readonly signal?: AbortSignal;
}

function rawDataBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) {
    return data;
  }
  if (Array.isArray(data)) {
    return Buffer.concat(data);
  }
  return Buffer.from(data);
}

export interface KernelPrivateWebSocketClientOptions {
  readonly credentials: KernelCredentialService;
  readonly deployments: KernelDeploymentRegistry;
  readonly maximumPayloadBytes?: number;
  readonly policies: KernelRoutePolicyRegistry;
  readonly timeoutMilliseconds?: number;
}

export class KernelPrivateWebSocketClient {
  readonly #credentials: KernelCredentialService;
  readonly #deployments: KernelDeploymentRegistry;
  readonly #maximumPayloadBytes: number;
  readonly #policies: KernelRoutePolicyRegistry;
  readonly #timeoutMilliseconds: number;

  constructor(options: KernelPrivateWebSocketClientOptions) {
    this.#credentials = options.credentials;
    this.#deployments = options.deployments;
    this.#maximumPayloadBytes = options.maximumPayloadBytes ?? 64 * 1_024 * 1_024;
    this.#policies = options.policies;
    this.#timeoutMilliseconds = options.timeoutMilliseconds ?? 15_000;
    if (
      !Number.isInteger(this.#maximumPayloadBytes) ||
      this.#maximumPayloadBytes < 1 ||
      !Number.isInteger(this.#timeoutMilliseconds) ||
      this.#timeoutMilliseconds < 1 ||
      this.#timeoutMilliseconds > 60_000
    ) {
      throw new Error("Kernel WebSocket client configuration is unavailable");
    }
  }

  connect(input: KernelPrivateWebSocketRequest): Promise<WebSocket> {
    const policy = this.#policies.resolve("GET", input.path);
    if (policy.contentMode !== "websocket") {
      throw new Error("Kernel WebSocket route is unavailable");
    }
    const deployment = this.#deployments.resolve(input.deployment);
    const serviceToken = this.#credentials.sign({
      kernelInstanceId: deployment.kernelInstanceId,
      requestId: input.requestId,
      spaceId: deployment.spaceId,
    });
    const authority =
      isIP(deployment.hostname) === 6
        ? `[${deployment.hostname}]`
        : deployment.hostname;
    const address = new URL(
      input.path,
      `wss://${authority}:${String(deployment.port)}`,
    );

    return new Promise((resolve, reject) => {
      const socketOptions: WebSocket.ClientOptions & HttpsRequestOptions = {
        ca: deployment.tls.caCertificate,
        cert: deployment.tls.clientCertificate,
        followRedirects: false,
        handshakeTimeout: this.#timeoutMilliseconds,
        headers: {
          "X-Singularity-Request-Id": input.requestId,
          "X-Singularity-Service-Token": serviceToken,
        },
        key: deployment.tls.clientPrivateKey,
        maxPayload: this.#maximumPayloadBytes,
        minVersion: "TLSv1.3",
        perMessageDeflate: false,
        rejectUnauthorized: true,
        servername: deployment.serverName,
      };
      const socket = new WebSocket(address, socketOptions);
      let settled = false;
      const fail = (error: unknown) => {
        const pending = !settled;
        settled = true;
        socket.terminate();
        if (pending) {
          reject(
            error instanceof KernelTransportError
              ? error
              : new KernelTransportError("unavailable", { cause: error }),
          );
        }
      };
      socket.on("message", (data, binary) =>
        input.onMessage(rawDataBuffer(data), binary),
      );
      socket.on("close", () => {
        if (!settled) {
          fail(new KernelTransportError("unavailable"));
        } else {
          input.onClose();
        }
      });
      socket.once("open", () => {
        if (settled) {
          return;
        }
        settled = true;
        resolve(socket);
      });
      socket.on("error", fail);
      socket.once("unexpected-response", (_request, response) => {
        response.resume();
        fail(new KernelTransportError("unavailable"));
      });

      if (input.signal) {
        if (input.signal.aborted) {
          fail(input.signal.reason);
        } else {
          input.signal.addEventListener("abort", () => fail(input.signal?.reason), {
            once: true,
          });
        }
      }
    });
  }
}
