import {
  Catch,
  HttpException,
  Logger,
  type ArgumentsHost,
  type ExceptionFilter,
} from "@nestjs/common";
import {
  type ApiProblemCode,
  DATABASE_READINESS_PATH,
  DATABASE_UNAVAILABLE_RESPONSE,
  RUNTIME_ACCESS_LOST_HEADER_NAME,
  RUNTIME_ACCESS_LOST_HEADER_VALUE,
} from "@singularity/contracts";

import { KdfAdmissionError } from "./identity/password-hasher.js";
import { LoginRateLimitError } from "./identity/login-rate-limiter.js";

export class ApiProblemError extends Error {
  constructor(
    readonly code: ApiProblemCode,
    readonly status: number,
    readonly retryAfter?: number,
    options?: ErrorOptions,
  ) {
    super(code, options);
    this.name = "ApiProblemError";
  }
}

interface LoggedError {
  readonly message: string;
  readonly name: string;
  readonly stack?: string;
}

/** 将异常及其 cause 链投影为可检索日志字段，同时保留原始 Error 对象和完整堆栈。 */
function loggedErrorContext(exception: unknown): {
  readonly error: Error;
  readonly errors: readonly LoggedError[];
} {
  const first =
    exception instanceof Error
      ? exception
      : new Error("Non-Error exception reached the HTTP boundary", {
          cause: exception,
        });
  const chain: LoggedError[] = [];
  const visited = new Set<Error>();
  let current: Error | undefined = first;
  while (current !== undefined && !visited.has(current)) {
    visited.add(current);
    chain.push({
      message: current.message,
      name: current.name,
      ...(current.stack === undefined ? {} : { stack: current.stack }),
    });
    current = current.cause instanceof Error ? current.cause : undefined;
  }
  return { error: first, errors: chain };
}

class RuntimeAccessLostError extends ApiProblemError {
  constructor(options?: ErrorOptions) {
    super("not-found", 404, undefined, options);
    this.name = "RuntimeAccessLostError";
  }
}

interface HttpRequestBoundary {
  id: string;
  url: string;
}

interface HttpReplyBoundary {
  header(name: string, value: string | number): HttpReplyBoundary;
  send(payload?: unknown): unknown;
  status(code: number): HttpReplyBoundary;
}

function codeForStatus(status: number): ApiProblemCode {
  if (status === 401) {
    return "unauthenticated";
  }
  if (status === 403) {
    return "forbidden";
  }
  if (status === 404) {
    return "not-found";
  }
  if (status === 409) {
    return "conflict";
  }
  if (status === 429) {
    return "rate-limited";
  }
  if (status >= 400 && status < 500) {
    return "validation-failed";
  }
  return "service-unavailable";
}

@Catch()
export class ApiProblemFilter implements ExceptionFilter {
  readonly #logger = new Logger("ApiProblemFilter");

  /** 把框架异常统一映射为公开 Problem 响应，并在响应前记录原始异常链。 */
  catch(exception: unknown, host: ArgumentsHost): void {
    const context = host.switchToHttp();
    const request = context.getRequest<HttpRequestBoundary>();
    const reply = context.getResponse<HttpReplyBoundary>();

    const databaseReadinessFailure =
      request.url.split("?", 1)[0] === DATABASE_READINESS_PATH &&
      exception instanceof HttpException &&
      exception.getStatus() === 503;

    let status: number;
    let code: ApiProblemCode;
    let retryAfter: number | undefined;
    if (exception instanceof ApiProblemError) {
      ({ code, retryAfter, status } = exception);
    } else if (
      exception instanceof KdfAdmissionError ||
      exception instanceof LoginRateLimitError
    ) {
      status = 429;
      code = "rate-limited";
      retryAfter = exception.retryAfter;
    } else if (exception instanceof HttpException) {
      const exceptionStatus = exception.getStatus();
      code = codeForStatus(exceptionStatus);
      status =
        code === "service-unavailable"
          ? 503
          : code === "validation-failed"
            ? exceptionStatus === 422
              ? 422
              : 400
            : exceptionStatus;
    } else if (
      typeof exception === "object" &&
      exception !== null &&
      "statusCode" in exception &&
      typeof exception.statusCode === "number"
    ) {
      code = codeForStatus(exception.statusCode);
      status =
        code === "service-unavailable"
          ? 503
          : code === "validation-failed"
            ? exception.statusCode === 422
              ? 422
              : 400
            : exception.statusCode;
    } else {
      status = 503;
      code = "service-unavailable";
    }

    const logContext = {
      code,
      ...loggedErrorContext(exception),
      requestId: request.id,
      status,
    };
    if (status >= 500) {
      this.#logger.error(logContext);
    } else {
      this.#logger.warn(logContext);
    }

    reply.status(status).header("Cache-Control", "no-store");
    if (databaseReadinessFailure) {
      reply.send(DATABASE_UNAVAILABLE_RESPONSE);
      return;
    }
    reply.header("Content-Type", "application/problem+json; charset=utf-8");
    if (exception instanceof RuntimeAccessLostError) {
      reply.header(
        RUNTIME_ACCESS_LOST_HEADER_NAME,
        RUNTIME_ACCESS_LOST_HEADER_VALUE,
      );
    }
    if (retryAfter !== undefined) {
      reply.header("Retry-After", Math.max(1, Math.ceil(retryAfter)));
    }
    reply.send({ code, requestId: request.id, status });
  }
}

export function unauthenticated(options?: ErrorOptions): ApiProblemError {
  return new ApiProblemError("unauthenticated", 401, undefined, options);
}

export function forbidden(options?: ErrorOptions): ApiProblemError {
  return new ApiProblemError("forbidden", 403, undefined, options);
}

export function notFound(options?: ErrorOptions): ApiProblemError {
  return new ApiProblemError("not-found", 404, undefined, options);
}

export function runtimeAccessLost(options?: ErrorOptions): ApiProblemError {
  return new RuntimeAccessLostError(options);
}

export function validationFailed(options?: ErrorOptions): ApiProblemError {
  return new ApiProblemError("validation-failed", 400, undefined, options);
}

export function conflict(options?: ErrorOptions): ApiProblemError {
  return new ApiProblemError("conflict", 409, undefined, options);
}

export function serviceUnavailable(options?: ErrorOptions): ApiProblemError {
  return new ApiProblemError("service-unavailable", 503, undefined, options);
}
