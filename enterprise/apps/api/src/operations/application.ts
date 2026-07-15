import type { Writable } from "node:stream";

import type { INestApplicationContext, LoggerService } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";

import { CoreModule } from "../core.module.js";
import { SystemClock } from "../identity/clock.js";
import { AccessOperationsService } from "./access-operations.service.js";
import type { AccessOperationInput } from "./runner.js";
import {
  runAccessOperation,
  writeFailedAccessOperation,
} from "./runner.js";

export interface AccessOperationsApplicationOptions {
  databaseUrl: string | undefined;
  stderr: Writable;
  stdin: AccessOperationInput;
  stdout: Writable;
}

function createOperationsLogger(stderr: Writable): LoggerService {
  const writeAccessOperationDiagnostic = (message: unknown): void => {
    if (
      typeof message !== "object" ||
      message === null ||
      !("event" in message) ||
      message.event !== "access.operation"
    ) {
      return;
    }
    stderr.write(`${JSON.stringify(message)}\n`);
  };

  return {
    error: writeAccessOperationDiagnostic,
    log: writeAccessOperationDiagnostic,
    warn: writeAccessOperationDiagnostic,
  };
}

export async function runAccessOperationsApplication(
  options: AccessOperationsApplicationOptions,
): Promise<0 | 1 | 2> {
  let context: INestApplicationContext;
  try {
    context = await NestFactory.createApplicationContext(
      CoreModule.register({
        clock: new SystemClock(),
        configuration: {
          publicOrigin: "https://operations.invalid",
          trustedProxyCidrs: [],
        },
        databaseUrl: options.databaseUrl,
        initializeDummyPasswordHash: false,
      }),
      {
        abortOnError: false,
        logger: createOperationsLogger(options.stderr),
      },
    );
  } catch {
    return writeFailedAccessOperation(options.stdout, options.stderr);
  }

  try {
    return await runAccessOperation({
      service: context.get(AccessOperationsService),
      stderr: options.stderr,
      stdin: options.stdin,
      stdout: options.stdout,
    });
  } catch {
    return await writeFailedAccessOperation(options.stdout, options.stderr);
  } finally {
    try {
      await context.close();
    } catch {
      options.stderr.write("access-operation shutdown failed\n");
    }
  }
}
