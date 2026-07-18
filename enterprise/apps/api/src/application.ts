import "reflect-metadata";

import { randomUUID } from "node:crypto";

import type { LoggerService } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from "@nestjs/platform-fastify";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
import cookie from "@fastify/cookie";
import {
  AUTH_SESSION_COOKIE_NAME,
  OPENAPI_DOCUMENT_PATH,
} from "@singularity/contracts";

import { AppModule } from "./app.module.js";
import {
  parseOidcClientSecretFiles,
  parsePublicOrigin,
  parseTrustedProxyCidrs,
} from "./configuration.js";
import type { AuditConfiguration } from "./audit/audit-writer.service.js";
import { SystemClock, type Clock } from "./identity/clock.js";
import type { KernelGatewayRuntimeConfiguration } from "./kernel/configuration.js";
import {
  installKernelGatewayHttpBoundary,
  KERNEL_GATEWAY_MAXIMUM_BODY_BYTES,
} from "./kernel/install-http-boundary.js";
import { KernelGatewayAdmission } from "./kernel/kernel-gateway-admission.js";
import { KernelWebSocketGateway } from "./kernel/kernel-websocket.gateway.js";
import { ApiProblemFilter } from "./problem.js";

export interface CreateApiApplicationOptions {
  auditConfiguration: AuditConfiguration;
  clock?: Clock;
  databaseUrl: string | undefined;
  kernelGateway: KernelGatewayRuntimeConfiguration;
  logger?: LoggerService;
  oidcClientSecretFiles?: string | undefined;
  publicOrigin: string | undefined;
  trustedProxyCidrs?: string | undefined;
}

export async function createApiApplication(
  options: CreateApiApplicationOptions,
): Promise<NestFastifyApplication> {
  const configuration = {
    oidcClientSecretFiles: parseOidcClientSecretFiles(
      options.oidcClientSecretFiles,
    ),
    publicOrigin: parsePublicOrigin(options.publicOrigin),
    trustedProxyCidrs: parseTrustedProxyCidrs(options.trustedProxyCidrs),
  };
  const adapter = new FastifyAdapter({
    bodyLimit: KERNEL_GATEWAY_MAXIMUM_BODY_BYTES,
    genReqId: () => randomUUID(),
    requestIdHeader: false,
    ...(configuration.trustedProxyCidrs.length === 0
      ? {}
      : { trustProxy: [...configuration.trustedProxyCidrs] }),
  });

  adapter.getInstance().addHook("onRequest", async (request, reply) => {
    reply.header("X-Request-Id", request.id);
  });

  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule.register({
      auditConfiguration: options.auditConfiguration,
      clock: options.clock ?? new SystemClock(),
      configuration,
      databaseUrl: options.databaseUrl,
      kernelGateway: options.kernelGateway,
    }),
    adapter,
    options.logger === undefined ? {} : { logger: options.logger },
  );
  installKernelGatewayHttpBoundary(
    adapter.getInstance(),
    app.get(KernelGatewayAdmission),
  );
  await app.register(cookie);
  app.useGlobalFilters(new ApiProblemFilter());

  const openApi = SwaggerModule.createDocument(
    app,
    new DocumentBuilder()
      .setTitle("Singularity Enterprise API")
      .setVersion("0.1.0")
      .addCookieAuth(
        AUTH_SESSION_COOKIE_NAME,
        {
          type: "apiKey",
          in: "cookie",
          name: AUTH_SESSION_COOKIE_NAME,
        },
        AUTH_SESSION_COOKIE_NAME,
      )
      .build(),
  );
  openApi.openapi = "3.1.0";

  SwaggerModule.setup("api/openapi", app, openApi, {
    jsonDocumentUrl: OPENAPI_DOCUMENT_PATH,
    raw: ["json"],
    ui: false,
  });

  await app.init();
  app.get(KernelWebSocketGateway).attach(app.getHttpServer());
  return app;
}
