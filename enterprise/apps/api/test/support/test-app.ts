import type { LoggerService } from "@nestjs/common";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { isolatedDatabaseUrl } from "@singularity/database/testing/postgres";

import { createApiApplication } from "../../src/application.js";
import type { Clock } from "../../src/identity/clock.js";

export const TEST_PUBLIC_ORIGIN = "https://singularity.test";

export interface TestApiApplication {
  app: NestFastifyApplication;
  baseUrl: string;
  dispose(): Promise<void>;
}

export interface TestApiApplicationOptions {
  clock?: Clock;
  logger?: LoggerService;
  trustedProxyCidrs?: string;
}

export async function startTestApiApplication(
  options: TestApiApplicationOptions = {},
): Promise<TestApiApplication> {
  const app = await createApiApplication({
    databaseUrl: isolatedDatabaseUrl(),
    ...(options.logger === undefined ? {} : { logger: options.logger }),
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
