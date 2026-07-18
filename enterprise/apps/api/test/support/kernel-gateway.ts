import { generateKeyPairSync, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type {
  IncomingHttpHeaders,
  IncomingMessage,
  ServerResponse,
} from "node:http";
import {
  createServer,
} from "node:https";
import { TLSSocket } from "node:tls";

import {
  KernelCredentialService,
  RuntimeKernelDeploymentRegistry,
  type KernelDeploymentIdentity,
} from "@singularity/kernel-client";

import type { KernelGatewayRuntimeConfiguration } from "../../src/kernel/configuration.js";

const { privateKey } = generateKeyPairSync("ed25519");
const testCertificate = readFileSync(
  new URL("../fixtures/kernel-gateway.crt", import.meta.url),
);
const testPrivateKey = readFileSync(
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
  handler?: (request: TestKernelRequest) =>
    | Promise<TestKernelResponse>
    | TestKernelResponse;
  kernelInstanceId?: string;
  spaceId?: string;
}

export interface TestKernelGateway {
  configuration: KernelGatewayRuntimeConfiguration;
  deployment: KernelDeploymentIdentity;
  dispose(): Promise<void>;
  readonly requests: readonly TestKernelRequest[];
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
        caCertificate: testCertificate,
        clientCertificate: testCertificate,
        clientPrivateKey: testPrivateKey,
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
  const server = createServer(
    {
      ca: testCertificate,
      cert: testCertificate,
      key: testPrivateKey,
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
  const handle = "test-kernel";
  let disposed = false;
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
            caCertificate: testCertificate,
            clientCertificate: testCertificate,
            clientPrivateKey: testPrivateKey,
          },
        },
      ]),
      runtimeDeployment: {
        tls: {
          caCertificate: testCertificate,
          clientCertificate: testCertificate,
          clientPrivateKey: testPrivateKey,
        },
        tlsProfile: "test-runtime",
      },
    },
    deployment: { handle, kernelInstanceId, spaceId },
    async dispose(): Promise<void> {
      if (disposed) {
        return;
      }
      disposed = true;
      await new Promise<void>((resolve, reject) => {
        server.close((error) =>
          error === undefined ? resolve() : reject(error),
        );
      });
    },
    requests,
  };
}
