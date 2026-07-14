import type { LoggerService } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";

import { CoreModule } from "../core.module.js";
import { SystemClock } from "../identity/clock.js";
import { AccessOperationsService } from "./access-operations.service.js";
import {
  runAccessOperation,
  writeFailedAccessOperation,
} from "./runner.js";

function writeAccessOperationDiagnostic(message: unknown): void {
  if (
    typeof message !== "object" ||
    message === null ||
    !("event" in message) ||
    message.event !== "access.operation"
  ) {
    return;
  }
  process.stderr.write(`${JSON.stringify(message)}\n`);
}

const operationsLogger: LoggerService = {
  error: writeAccessOperationDiagnostic,
  log: writeAccessOperationDiagnostic,
  warn: writeAccessOperationDiagnostic,
};

async function main(): Promise<0 | 1 | 2> {
  let context;
  try {
    context = await NestFactory.createApplicationContext(
      CoreModule.register({
        clock: new SystemClock(),
        configuration: {
          publicOrigin: "https://operations.invalid",
          trustedProxyCidrs: [],
        },
        databaseUrl: process.env.DATABASE_URL,
        initializeDummyPasswordHash: false,
      }),
      { logger: operationsLogger },
    );
  } catch {
    return writeFailedAccessOperation(process.stdout, process.stderr);
  }

  try {
    return await runAccessOperation({
      service: context.get(AccessOperationsService),
      stderr: process.stderr,
      stdin: process.stdin,
      stdout: process.stdout,
    });
  } catch {
    return await writeFailedAccessOperation(process.stdout, process.stderr);
  } finally {
    try {
      await context.close();
    } catch {
      process.stderr.write("access-operation shutdown failed\n");
    }
  }
}

process.exitCode = await main();
