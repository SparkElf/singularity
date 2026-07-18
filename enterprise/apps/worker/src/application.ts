import "reflect-metadata";

import type {
  DynamicModule,
  INestApplicationContext,
  LoggerService,
  Type,
} from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import type { DatabaseRuntime } from "@singularity/database";

import type { WorkerConfiguration } from "./configuration.js";
import { WorkerApplication } from "./worker-application.js";
import { WorkerModule } from "./worker.module.js";

export interface CreateWorkerApplicationOptions {
  readonly configuration: WorkerConfiguration;
  readonly database: DatabaseRuntime;
  readonly logger?: LoggerService | false;
  readonly restorePlatformModule: DynamicModule | Type<unknown>;
}

export async function createWorkerApplication(
  options: CreateWorkerApplicationOptions,
): Promise<INestApplicationContext> {
  return NestFactory.createApplicationContext(
    WorkerModule.register(options),
    {
      abortOnError: false,
      ...(options.logger === undefined ? {} : { logger: options.logger }),
    },
  );
}

export async function runWorkerApplication(
  options: CreateWorkerApplicationOptions & { readonly signal: AbortSignal },
): Promise<void> {
  const context = await createWorkerApplication(options);
  try {
    await context.get(WorkerApplication).run(options.signal);
  } finally {
    await context.close();
  }
}
