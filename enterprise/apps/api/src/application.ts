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
  parsePublicOrigin,
  parseTrustedProxyCidrs,
} from "./configuration.js";
import { SystemClock, type Clock } from "./identity/clock.js";
import { ApiProblemFilter } from "./problem.js";

export interface CreateApiApplicationOptions {
  clock?: Clock;
  databaseUrl: string | undefined;
  logger?: LoggerService;
  publicOrigin: string | undefined;
  trustedProxyCidrs?: string | undefined;
}

export async function createApiApplication(
  options: CreateApiApplicationOptions,
): Promise<NestFastifyApplication> {
  const configuration = {
    publicOrigin: parsePublicOrigin(options.publicOrigin),
    trustedProxyCidrs: parseTrustedProxyCidrs(options.trustedProxyCidrs),
  };
  const adapter = new FastifyAdapter({
    bodyLimit: 16 * 1_024,
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
      clock: options.clock ?? new SystemClock(),
      configuration,
      databaseUrl: options.databaseUrl,
    }),
    adapter,
    options.logger === undefined ? {} : { logger: options.logger },
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
  return app;
}
