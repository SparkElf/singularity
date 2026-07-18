import {
  applyDecorators,
  createParamDecorator,
  Inject,
  Injectable,
  SetMetadata,
  UseGuards,
  type CanActivate,
  type ExecutionContext,
} from "@nestjs/common";
import { ApiCookieAuth, ApiHeader, ApiResponse } from "@nestjs/swagger";
import {
  API_PROBLEM_OPENAPI_SCHEMA_BY_STATUS,
  AUTH_SESSION_COOKIE_NAME,
  CSRF_HEADER_NAME,
  CSRF_TOKEN_OPENAPI_SCHEMA,
  type ApiProblemStatus,
} from "@singularity/contracts";

import type { ApiConfiguration } from "../configuration.js";
import type {
  HttpReplyBoundary,
  HttpRequestBoundary,
} from "../http-boundary.js";
import { singleHeader } from "../http-boundary.js";
import { ApiProblemError, forbidden } from "../problem.js";
import { API_CONFIGURATION } from "../tokens.js";
import {
  IdentityService,
  type AuthenticatedSession,
} from "./identity.service.js";
import { SESSION_COOKIE_OPTIONS } from "./session-crypto.js";

export type { AuthenticatedSession };

const HTTP_ACCESS_METADATA = Symbol("singularity.http-access");

type HttpAccessMode = "origin" | "authenticated" | "mutation";

const ORIGIN_HEADER_OPENAPI = {
  name: "Origin",
  required: true,
  schema: { type: "string" as const, format: "uri" },
};

const CSRF_HEADER_OPENAPI = {
  name: CSRF_HEADER_NAME,
  required: true,
  schema: CSRF_TOKEN_OPENAPI_SCHEMA,
};

export function ApiProblemResponses(
  ...statuses: readonly ApiProblemStatus[]
): MethodDecorator {
  return applyDecorators(
    ...statuses.map((status) =>
      ApiResponse({
        status,
        schema: API_PROBLEM_OPENAPI_SCHEMA_BY_STATUS[status],
      }),
    ),
  );
}

interface AuthenticatedRequest extends HttpRequestBoundary {
  authenticatedSession?: AuthenticatedSession;
}

function accessDecorator(mode: HttpAccessMode) {
  const decorators: Array<MethodDecorator> = [
    SetMetadata(HTTP_ACCESS_METADATA, mode),
    UseGuards(HttpAccessGuard),
  ];
  if (mode !== "origin") {
    decorators.push(ApiCookieAuth(AUTH_SESSION_COOKIE_NAME));
  }
  if (mode === "origin" || mode === "mutation") {
    decorators.push(ApiHeader(ORIGIN_HEADER_OPENAPI));
  }
  if (mode === "mutation") {
    decorators.push(ApiHeader(CSRF_HEADER_OPENAPI));
  }
  return applyDecorators(...decorators);
}

export function SameOrigin(): MethodDecorator {
  return accessDecorator("origin");
}

export function Authenticated(): MethodDecorator {
  return accessDecorator("authenticated");
}

export function SessionMutation(): MethodDecorator {
  return accessDecorator("mutation");
}

export const CurrentSession = createParamDecorator(
  (_data: unknown, context: ExecutionContext): AuthenticatedSession => {
    const request = context
      .switchToHttp()
      .getRequest<AuthenticatedRequest>();
    if (request.authenticatedSession === undefined) {
      throw new Error("Authenticated session metadata is unavailable");
    }
    return request.authenticatedSession;
  },
);

@Injectable()
export class HttpAccessGuard implements CanActivate {
  constructor(
    private readonly identity: IdentityService,
    @Inject(API_CONFIGURATION)
    private readonly configuration: ApiConfiguration,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context
      .switchToHttp()
      .getRequest<AuthenticatedRequest>();
    const reply = context
      .switchToHttp()
      .getResponse<HttpReplyBoundary>();
    const mode = Reflect.getMetadata(
      HTTP_ACCESS_METADATA,
      context.getHandler(),
    ) as HttpAccessMode | undefined;
    if (mode === undefined) {
      throw new Error("HTTP access metadata is missing");
    }
    if (
      (mode === "origin" || mode === "mutation") &&
      singleHeader(request.headers.origin) !== this.configuration.publicOrigin
    ) {
      throw forbidden();
    }
    if (mode === "origin") {
      return true;
    }
    try {
      request.authenticatedSession =
        mode === "mutation"
          ? await this.identity.authenticateWithCsrf(
              request.cookies[AUTH_SESSION_COOKIE_NAME],
              singleHeader(request.headers[CSRF_HEADER_NAME.toLowerCase()]),
              request.id,
            )
          : await this.identity.authenticate(
              request.cookies[AUTH_SESSION_COOKIE_NAME],
              request.id,
            );
      return true;
    } catch (error) {
      if (
        error instanceof ApiProblemError &&
        error.code === "unauthenticated"
      ) {
        reply.clearCookie(AUTH_SESSION_COOKIE_NAME, SESSION_COOKIE_OPTIONS);
      }
      throw error;
    }
  }
}
