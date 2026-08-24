import "reflect-metadata";

import { randomUUID } from "node:crypto";
import type { ServerOptions as HttpsServerOptions } from "node:https";

import type {
  LoggerService,
  NestApplicationOptions,
} from "@nestjs/common";
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
import type { AuditConfiguration } from "@singularity/database";

import { AppModule } from "./app.module.js";
import {
  parseContentAuditIndeterminateAfterMilliseconds,
  parseBooleanFlag,
  parsePasswordResetFrom,
  parsePasswordResetSmtpUrl,
  parsePublicOrigin,
  parseTrustedProxyCidrs,
} from "./configuration.js";
import { SystemClock, type Clock } from "./identity/clock.js";
import type { LoginRateLimiter } from "./identity/login-rate-limiter.js";
import type { KernelGatewayRuntimeConfiguration } from "./kernel/configuration.js";
import {
  installKernelGatewayHttpBoundary,
  KERNEL_GATEWAY_MAXIMUM_BODY_BYTES,
} from "./kernel/install-http-boundary.js";
import { KernelGatewayAdmission } from "./kernel/kernel-gateway-admission.js";
import { KernelWebSocketGateway } from "./kernel/kernel-websocket.gateway.js";
import { RealtimeCollaborationWebSocketGateway } from "./collaboration/realtime-websocket.gateway.js";
import { ApiProblemFilter } from "./problem.js";

export interface CreateApiApplicationOptions {
  auditConfiguration: AuditConfiguration;
  clock?: Clock;
  contentAuditIndeterminateAfterMilliseconds?: string | undefined;
  databaseUrl: string | undefined;
  https?: HttpsServerOptions;
  kernelGateway: KernelGatewayRuntimeConfiguration;
  loginRateLimiter?: LoginRateLimiter;
  logger?: LoggerService;
  passwordResetMailer?: import("./identity/password-reset-mailer.js").PasswordResetMailer;
  publicOrigin: string | undefined;
  trustedProxyCidrs?: string | undefined;
}

export async function createApiApplication(
  options: CreateApiApplicationOptions,
): Promise<NestFastifyApplication> {
  const configuration = {
    contentAuditIndeterminateAfterMilliseconds:
      parseContentAuditIndeterminateAfterMilliseconds(
        options.contentAuditIndeterminateAfterMilliseconds,
      ),
    collaborationEnabled: parseBooleanFlag(
      process.env.SINGULARITY_COLLABORATION_ENABLED,
    ),
    passwordResetFrom: parsePasswordResetFrom(
      process.env.SINGULARITY_PASSWORD_RESET_FROM,
    ),
    passwordResetSmtpUrl: parsePasswordResetSmtpUrl(
      process.env.SINGULARITY_PASSWORD_RESET_SMTP_URL,
    ),
    publicOrigin: parsePublicOrigin(options.publicOrigin),
    trustedProxyCidrs: parseTrustedProxyCidrs(options.trustedProxyCidrs),
  };
  const adapter = new FastifyAdapter({
    bodyLimit: KERNEL_GATEWAY_MAXIMUM_BODY_BYTES,
    genReqId: () => randomUUID(),
    routerOptions: { maxParamLength: 256 },
    requestIdHeader: false,
    ...(options.https === undefined ? {} : { https: options.https }),
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
      ...(options.loginRateLimiter === undefined
        ? {}
        : { loginRateLimiter: options.loginRateLimiter }),
      ...(options.passwordResetMailer === undefined
        ? {}
        : { passwordResetMailer: options.passwordResetMailer }),
    }),
    adapter,
    {
      ...(options.https === undefined
        ? {}
        : {
            httpsOptions: options.https as NonNullable<
              NestApplicationOptions["httpsOptions"]
            >,
          }),
      ...(options.logger === undefined ? {} : { logger: options.logger }),
    },
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
  installKernelGatewayHttpBoundary(
    adapter.getInstance(),
    app.get(KernelGatewayAdmission),
  );
  app.get(KernelWebSocketGateway).attach(app.getHttpServer());
  if (configuration.collaborationEnabled) {
    app.get(RealtimeCollaborationWebSocketGateway).attach(app.getHttpServer());
  }
  return app;
}
