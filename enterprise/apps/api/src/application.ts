import "reflect-metadata";

import { randomUUID } from "node:crypto";

import type { LoggerService } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from "@nestjs/platform-fastify";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
import { OPENAPI_DOCUMENT_PATH } from "@singularity/contracts";

import { AppModule, type AppModuleOptions } from "./app.module.js";

export interface CreateApiApplicationOptions extends AppModuleOptions {
  logger?: LoggerService;
}

export async function createApiApplication(
  options: CreateApiApplicationOptions,
): Promise<NestFastifyApplication> {
  const adapter = new FastifyAdapter({
    genReqId: () => randomUUID(),
    requestIdHeader: false,
  });

  adapter.getInstance().addHook("onRequest", async (request, reply) => {
    reply.header("X-Request-Id", request.id);
  });

  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule.register({ databaseUrl: options.databaseUrl }),
    adapter,
    options.logger === undefined ? {} : { logger: options.logger },
  );

  const openApi = SwaggerModule.createDocument(
    app,
    new DocumentBuilder()
      .setTitle("Singularity Enterprise API")
      .setVersion("0.1.0")
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
