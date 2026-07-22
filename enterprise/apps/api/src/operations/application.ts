import "reflect-metadata";

import type { Writable } from "node:stream";

import {
  Logger,
  type INestApplicationContext,
  type LoggerService,
} from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import type { AuditConfiguration } from "@singularity/database";

import { CoreModule } from "../core.module.js";
import { DEFAULT_CONTENT_AUDIT_INDETERMINATE_AFTER_MILLISECONDS } from "../configuration.js";
import { SystemClock } from "../identity/clock.js";
import { AccessOperationsService } from "./access-operations.service.js";
import type { AccessOperationInput } from "./runner.js";
import {
  runAccessOperation,
  writeFailedAccessOperation,
} from "./runner.js";

export interface AccessOperationsApplicationOptions {
  auditConfiguration: AuditConfiguration;
  databaseUrl: string | undefined;
  stderr: Writable;
  stdin: AccessOperationInput;
  stdout: Writable;
  restoreLogger?: LoggerService;
}

type LoggerMethod =
  | "debug"
  | "error"
  | "fatal"
  | "log"
  | "verbose"
  | "warn";

// 创建访问操作子进程使用的日志门面，并把非操作诊断转回主应用日志上下文。
function createOperationsLogger(
  stderr: Writable,
  delegate: LoggerService | undefined,
): LoggerService {
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

  const writeOrForward = (
    method: LoggerMethod,
    message: unknown,
    optionalParams: unknown[],
  ): void => {
    if (
      typeof message === "object" &&
      message !== null &&
      "event" in message &&
      message.event === "access.operation"
    ) {
      writeAccessOperationDiagnostic(message);
      return;
    }
    const handler = delegate?.[method] as
      | ((
          this: LoggerService,
          message: unknown,
          ...optionalParams: unknown[]
        ) => unknown)
      | undefined;
    if (delegate !== undefined && typeof handler === "function") {
      handler.call(delegate, message, ...optionalParams);
    }
  };

  return {
    debug: (message, ...optionalParams) =>
      writeOrForward("debug", message, optionalParams),
    error: (message, ...optionalParams) =>
      writeOrForward("error", message, optionalParams),
    fatal: (message, ...optionalParams) =>
      writeOrForward("fatal", message, optionalParams),
    log: (message, ...optionalParams) =>
      writeOrForward("log", message, optionalParams),
    verbose: (message, ...optionalParams) =>
      writeOrForward("verbose", message, optionalParams),
    warn: (message, ...optionalParams) =>
      writeOrForward("warn", message, optionalParams),
  };
}

// 启动一次隔离的访问操作上下文，完成标准输入处理后关闭所有 Nest 资源并恢复主日志器。
export async function runAccessOperationsApplication(
  options: AccessOperationsApplicationOptions,
): Promise<0 | 1 | 2> {
  let context: INestApplicationContext;
  try {
    context = await NestFactory.createApplicationContext(
      CoreModule.register({
        auditConfiguration: options.auditConfiguration,
        clock: new SystemClock(),
        configuration: {
          collaborationEnabled: false,
          contentAuditIndeterminateAfterMilliseconds:
            DEFAULT_CONTENT_AUDIT_INDETERMINATE_AFTER_MILLISECONDS,
          oidcClientSecretBindings: [],
          publicOrigin: "https://operations.invalid",
          trustedProxyCidrs: [],
        },
        databaseUrl: options.databaseUrl,
        initializeDummyPasswordHash: false,
      }),
      {
        abortOnError: false,
        logger: createOperationsLogger(options.stderr, options.restoreLogger),
      },
    );
  } catch (error) {
    console.error("[access-operation] application bootstrap failed", error);
    return writeFailedAccessOperation(options.stdout, options.stderr);
  }

  try {
    return await runAccessOperation({
      service: context.get(AccessOperationsService),
      stderr: options.stderr,
      stdin: options.stdin,
      stdout: options.stdout,
    });
  } catch (error) {
    console.error("[access-operation] execution boundary failed", error);
    return await writeFailedAccessOperation(options.stdout, options.stderr);
  } finally {
    try {
      await context.close();
    } catch (error) {
      console.error("[access-operation] application shutdown failed", error);
      options.stderr.write("access-operation shutdown failed\n");
    }
    if (options.restoreLogger !== undefined) {
      Logger.overrideLogger(options.restoreLogger);
    }
  }
}
