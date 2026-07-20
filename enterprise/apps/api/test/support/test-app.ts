import type { LoggerService } from "@nestjs/common";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { isolatedDatabaseUrl } from "@singularity/database/testing/postgres";

import { createApiApplication } from "../../src/application.js";
import type { KernelGatewayRuntimeConfiguration } from "../../src/kernel/configuration.js";
import type { Clock } from "../../src/identity/clock.js";
import type { LoginRateLimiter } from "../../src/identity/login-rate-limiter.js";
import type {
  OidcClientSecretResolver,
  OidcHttpTransport,
} from "../../src/identity/oidc.service.js";
import { OidcHttpTransportError } from "../../src/identity/oidc-http-transport.js";
import { testAuditConfiguration } from "./audit-configuration.js";
import {
  TEST_TLS_CERTIFICATE,
  TEST_TLS_PRIVATE_KEY,
  testKernelGatewayConfiguration,
} from "./kernel-gateway.js";

export const TEST_PUBLIC_ORIGIN = "https://singularity.test";

export interface TestApiApplication {
  app: NestFastifyApplication;
  baseUrl: string;
  dispose(): Promise<void>;
}

export interface TestApiApplicationOptions {
  clock?: Clock;
  contentAuditIndeterminateAfterMilliseconds?: string;
  https?: boolean;
  kernelGateway?: KernelGatewayRuntimeConfiguration;
  loginRateLimiter?: LoginRateLimiter;
  logger?: LoggerService;
  oidcClientSecretResolver?: OidcClientSecretResolver;
  oidcHttpTransport?: OidcHttpTransport;
  trustedProxyCidrs?: string;
}

const testOidcClientSecretResolver: OidcClientSecretResolver = {
  assertBound: () => undefined,
  resolve: async () => "test-oidc-client-secret",
};

const testOidcHttpTransport: OidcHttpTransport = {
  async request(input) {
    const response = await fetch(input.url, {
      ...(input.body === undefined ? {} : { body: input.body }),
      headers: input.headers,
      method: input.method,
      redirect: "error",
      signal: AbortSignal.timeout(input.timeoutMilliseconds),
    });
    const body = Buffer.from(await response.arrayBuffer());
    if (body.byteLength > input.maximumBodyBytes) {
      throw new OidcHttpTransportError(
        "OIDC response exceeded the byte limit",
      );
    }
    return { body, status: response.status };
  },
};

export async function startTestApiApplication(
  options: TestApiApplicationOptions = {},
): Promise<TestApiApplication> {
  const app = await createApiApplication({
    auditConfiguration: testAuditConfiguration(),
    ...(options.contentAuditIndeterminateAfterMilliseconds === undefined
      ? {}
      : {
          contentAuditIndeterminateAfterMilliseconds:
            options.contentAuditIndeterminateAfterMilliseconds,
        }),
    databaseUrl: isolatedDatabaseUrl(),
    ...(options.https === true
      ? {
          https: {
            cert: TEST_TLS_CERTIFICATE,
            key: TEST_TLS_PRIVATE_KEY,
            minVersion: "TLSv1.3" as const,
          },
        }
      : {}),
    kernelGateway:
      options.kernelGateway ?? testKernelGatewayConfiguration(),
    ...(options.loginRateLimiter === undefined
      ? {}
      : { loginRateLimiter: options.loginRateLimiter }),
    ...(options.logger === undefined ? {} : { logger: options.logger }),
    oidcClientSecretResolver:
      options.oidcClientSecretResolver ?? testOidcClientSecretResolver,
    oidcHttpTransport: options.oidcHttpTransport ?? testOidcHttpTransport,
    publicOrigin: `${TEST_PUBLIC_ORIGIN}/`,
    ...(options.clock === undefined ? {} : { clock: options.clock }),
    ...(options.trustedProxyCidrs === undefined
      ? {}
      : { trustedProxyCidrs: options.trustedProxyCidrs }),
  });

  try {
    await app.listen(0, "127.0.0.1");
  } catch (error) {
    await app.close();
    throw error;
  }

  const baseUrl = await app.getUrl();
  let disposed = false;
  return {
    app,
    baseUrl,
    async dispose(): Promise<void> {
      if (disposed) {
        return;
      }
      disposed = true;
      await app.close();
    },
  };
}
