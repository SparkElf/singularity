import { generateKeyPairSync, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type {
  IncomingHttpHeaders,
  IncomingMessage,
  ServerResponse,
} from "node:http";
import { createServer } from "node:https";
import { TLSSocket } from "node:tls";

import {
  KernelCredentialService,
  RuntimeKernelDeploymentRegistry,
  type KernelDeploymentIdentity,
} from "@singularity/kernel-client";
import WebSocket, { type RawData, WebSocketServer } from "ws";

import type { KernelGatewayRuntimeConfiguration } from "../../src/kernel/configuration.js";

const { privateKey } = generateKeyPairSync("ed25519");
export const TEST_TLS_CERTIFICATE = readFileSync(
  new URL("../fixtures/kernel-gateway.crt", import.meta.url),
);
export const TEST_TLS_PRIVATE_KEY = readFileSync(
  new URL("../fixtures/kernel-gateway.key", import.meta.url),
);

const MAXIMUM_TEST_KERNEL_BODY_BYTES = 32 * 1_024 * 1_024;

export interface TestKernelRequest {
  authorized: boolean;
  body: Buffer;
  headers: IncomingHttpHeaders;
  method: string;
  path: string;
}

export interface TestKernelResponse {
  body?: Uint8Array | string;
  headers?: Readonly<Record<string, number | string>>;
  status: number;
}

export interface TestKernelGatewayOptions {
  deploymentHandle?: string;
  handler?: (request: TestKernelRequest) =>
    | Promise<TestKernelResponse>
    | TestKernelResponse;
  kernelInstanceId?: string;
  spaceId?: string;
  websocket?: {
    onConnection?: (socket: WebSocket, path: string) => void;
  };
}

export interface TestKernelWebSocket {
  readonly connections: readonly {
    readonly headers: IncomingHttpHeaders;
    readonly path: string;
  }[];
  readonly connectionCount: number;
  readonly messages: readonly Buffer[];
  broadcast(data: Buffer | string): void;
  nextConnection(): Promise<WebSocket>;
}

export interface TestKernelGateway {
  configuration: KernelGatewayRuntimeConfiguration;
  deployment: KernelDeploymentIdentity;
  dispose(): Promise<void>;
  readonly requests: readonly TestKernelRequest[];
  readonly websocket: TestKernelWebSocket;
}

export function testKernelGatewayConfiguration():
  KernelGatewayRuntimeConfiguration {
  return {
    credentials: new KernelCredentialService({
      keyId: "singularity-test",
      privateKey,
    }),
    deployments: new RuntimeKernelDeploymentRegistry([]),
    runtimeDeployment: {
      tls: {
        caCertificate: TEST_TLS_CERTIFICATE,
        clientCertificate: TEST_TLS_CERTIFICATE,
        clientPrivateKey: TEST_TLS_PRIVATE_KEY,
      },
      tlsProfile: "test-runtime",
    },
  };
}

async function requestBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let sizeBytes = 0;
  for await (const rawChunk of request) {
    const chunk = Buffer.isBuffer(rawChunk)
      ? rawChunk
      : Buffer.from(rawChunk);
    sizeBytes += chunk.byteLength;
    if (sizeBytes > MAXIMUM_TEST_KERNEL_BODY_BYTES) {
      request.destroy();
      throw new Error("Test Kernel request body is too large");
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function websocketDataBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) {
    return data;
  }
  if (Array.isArray(data)) {
    return Buffer.concat(data);
  }
  return Buffer.from(data);
}

function sendResponse(
  reply: ServerResponse,
  response: TestKernelResponse,
): void {
  reply.statusCode = response.status;
  for (const [name, value] of Object.entries(response.headers ?? {})) {
    reply.setHeader(name, value);
  }
  reply.end(response.body);
}

export async function startTestKernelGateway(
  options: TestKernelGatewayOptions = {},
): Promise<TestKernelGateway> {
  const kernelInstanceId = options.kernelInstanceId ?? randomUUID();
  const spaceId = options.spaceId ?? randomUUID();
  const requests: TestKernelRequest[] = [];
  const handler = options.handler ?? (() => ({ status: 404 }));
  const webSocketServer = new WebSocketServer({
    clientTracking: true,
    noServer: true,
    perMessageDeflate: false,
  });
  const websocketMessages: Buffer[] = [];
  const websocketConnections: Array<{
    readonly headers: IncomingHttpHeaders;
    readonly path: string;
  }> = [];
  const server = createServer(
    {
      ca: TEST_TLS_CERTIFICATE,
      cert: TEST_TLS_CERTIFICATE,
      key: TEST_TLS_PRIVATE_KEY,
      minVersion: "TLSv1.3",
      rejectUnauthorized: true,
      requestCert: true,
    },
    async (request, reply) => {
      try {
        const captured: TestKernelRequest = {
          authorized:
            request.socket instanceof TLSSocket && request.socket.authorized,
          body: await requestBody(request),
          headers: request.headers,
          method: request.method ?? "",
          path: request.url ?? "/",
        };
        requests.push(captured);
        sendResponse(reply, await handler(captured));
      } catch {
        if (!reply.headersSent) {
          sendResponse(reply, { status: 500 });
        } else {
          reply.destroy();
        }
      }
    },
  );
  webSocketServer.on("connection", (socket, request) => {
    websocketConnections.push({
      headers: request.headers,
      path: request.url ?? "/",
    });
    socket.on("message", (data) => {
      websocketMessages.push(websocketDataBuffer(data));
    });
    options.websocket?.onConnection?.(socket, request.url ?? "/");
  });
  server.on("upgrade", (request, socket, head) => {
    webSocketServer.handleUpgrade(request, socket, head, (client) => {
      webSocketServer.emit("connection", client, request);
    });
  });
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => reject(error);
    server.once("error", onError);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", onError);
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw new Error("Test Kernel did not expose a TCP address");
  }
  const { privateKey: servicePrivateKey } = generateKeyPairSync("ed25519");
  const handle = options.deploymentHandle ?? "test-kernel";
  let disposed = false;
  let connectionCount = 0;
  const connectionWaiters: Array<(socket: WebSocket) => void> = [];
  const queuedConnections: WebSocket[] = [];
  webSocketServer.on("connection", (socket) => {
    connectionCount += 1;
    const waiter = connectionWaiters.shift();
    if (waiter !== undefined) {
      waiter(socket);
    } else {
      queuedConnections.push(socket);
    }
  });
  const websocket: TestKernelWebSocket = {
    get connections() {
      return [...websocketConnections];
    },
    get connectionCount(): number {
      return connectionCount;
    },
    get messages(): readonly Buffer[] {
      return [...websocketMessages];
    },
    broadcast(data): void {
      for (const client of webSocketServer.clients) {
        if (client.readyState === WebSocket.OPEN) {
          client.send(data);
        }
      }
    },
    nextConnection(): Promise<WebSocket> {
      const queued = queuedConnections.shift();
      if (queued !== undefined) {
        return Promise.resolve(queued);
      }
      return new Promise((resolve) => connectionWaiters.push(resolve));
    },
  };
  return {
    configuration: {
      credentials: new KernelCredentialService({
        keyId: "singularity-test-kernel",
        privateKey: servicePrivateKey,
      }),
      deployments: new RuntimeKernelDeploymentRegistry([
        {
          handle,
          hostname: "127.0.0.1",
          kernelInstanceId,
          port: address.port,
          serverName: "kernel.test",
          spaceId,
          tls: {
            caCertificate: TEST_TLS_CERTIFICATE,
            clientCertificate: TEST_TLS_CERTIFICATE,
            clientPrivateKey: TEST_TLS_PRIVATE_KEY,
          },
        },
      ]),
      runtimeDeployment: {
        tls: {
          caCertificate: TEST_TLS_CERTIFICATE,
          clientCertificate: TEST_TLS_CERTIFICATE,
          clientPrivateKey: TEST_TLS_PRIVATE_KEY,
        },
        tlsProfile: "test-runtime",
      },
    },
    deployment: { handle, kernelInstanceId, spaceId },
    websocket,
    async dispose(): Promise<void> {
      if (disposed) {
        return;
      }
      disposed = true;
      for (const client of webSocketServer.clients) {
        client.terminate();
      }
      connectionWaiters.splice(0);
      queuedConnections.splice(0);
      await new Promise<void>((resolve) => webSocketServer.close(() => resolve()));
      await new Promise<void>((resolve, reject) => {
        server.close((error) =>
          error === undefined ? resolve() : reject(error),
        );
      });
    },
    requests,
  };
}
