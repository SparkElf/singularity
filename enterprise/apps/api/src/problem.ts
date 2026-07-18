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
  ) {
    super(code);
    this.name = "ApiProblemError";
  }
}

class RuntimeAccessLostError extends ApiProblemError {
  constructor() {
    super("not-found", 404);
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

  catch(exception: unknown, host: ArgumentsHost): void {
    const context = host.switchToHttp();
    const request = context.getRequest<HttpRequestBoundary>();
    const reply = context.getResponse<HttpReplyBoundary>();

    if (
      request.url.split("?", 1)[0] === DATABASE_READINESS_PATH &&
      exception instanceof HttpException &&
      exception.getStatus() === 503
    ) {
      reply
        .status(503)
        .header("Cache-Control", "no-store")
        .send(DATABASE_UNAVAILABLE_RESPONSE);
      return;
    }

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

    const logContext = { code, requestId: request.id, status };
    if (status >= 500) {
      this.#logger.error(logContext);
    } else {
      this.#logger.warn(logContext);
    }

    reply.status(status).header("Cache-Control", "no-store");
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

export function unauthenticated(): ApiProblemError {
  return new ApiProblemError("unauthenticated", 401);
}

export function forbidden(): ApiProblemError {
  return new ApiProblemError("forbidden", 403);
}

export function notFound(): ApiProblemError {
  return new ApiProblemError("not-found", 404);
}

export function runtimeAccessLost(): ApiProblemError {
  return new RuntimeAccessLostError();
}

export function validationFailed(): ApiProblemError {
  return new ApiProblemError("validation-failed", 400);
}

export function conflict(): ApiProblemError {
  return new ApiProblemError("conflict", 409);
}

export function serviceUnavailable(): ApiProblemError {
  return new ApiProblemError("service-unavailable", 503);
}
