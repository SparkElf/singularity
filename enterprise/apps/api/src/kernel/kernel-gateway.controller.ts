import type { IncomingHttpHeaders, IncomingMessage } from "node:http";

import { All, Controller, Inject, Req, Res } from "@nestjs/common";
import { ApiExcludeController } from "@nestjs/swagger";
import { AUTH_SESSION_COOKIE_NAME, CSRF_HEADER_NAME } from "@singularity/contracts";

import type { ApiConfiguration } from "../configuration.js";
import type { HttpReplyBoundary } from "../http-boundary.js";
import { singleHeader } from "../http-boundary.js";
import { bindHttpRequestAbortSignal } from "../http-request-signal.js";
import {
  IdentityService,
  type AuthenticatedSession,
} from "../identity/identity.service.js";
import { SESSION_COOKIE_OPTIONS } from "../identity/session-crypto.js";
import { ApiProblemError, forbidden } from "../problem.js";
import { API_CONFIGURATION } from "../tokens.js";
import { KernelGatewayAdmission } from "./kernel-gateway-admission.js";
import {
  KernelGatewayService,
  type KernelGatewayProxyReply,
} from "./kernel-gateway.service.js";

const GATEWAY_CONTROLLER_PATHS: string[] = [
  "/api/v1/organizations/:organizationId/spaces/:spaceId/kernel/api/*",
  "/api/v1/organizations/:organizationId/spaces/:spaceId/assets/*",
  "/api/v1/organizations/:organizationId/spaces/:spaceId/emojis/*",
  "/api/v1/organizations/:organizationId/spaces/:spaceId/upload",
  "/api/v1/organizations/:organizationId/spaces/:spaceId/exports/*",
];

interface KernelGatewayHttpRequest {
  readonly body: unknown;
  readonly cookies: Record<string, string | undefined>;
  readonly headers: IncomingHttpHeaders;
  readonly id: string;
  readonly method: string;
  readonly raw: IncomingMessage;
}

interface KernelGatewayHttpReply
  extends HttpReplyBoundary,
    KernelGatewayProxyReply {}

@ApiExcludeController()
@Controller()
export class KernelGatewayController {
  constructor(
    private readonly admission: KernelGatewayAdmission,
    private readonly gateway: KernelGatewayService,
    private readonly identity: IdentityService,
    @Inject(API_CONFIGURATION)
    private readonly configuration: ApiConfiguration,
  ) {}

  @All(GATEWAY_CONTROLLER_PATHS)
  async proxy(
    @Req() request: KernelGatewayHttpRequest,
    @Res() reply: KernelGatewayHttpReply,
  ): Promise<void> {
    const target = this.admission.consume(request.raw);
    const session = await this.#authenticate(request, reply);
    const abortScope = bindHttpRequestAbortSignal(request.raw);
    try {
      await this.gateway.proxy(
        {
          body: request.body,
          headers: request.headers,
          requestId: request.id,
          signal: abortScope.signal,
          target,
          userId: session.userId,
        },
        reply,
      );
    } finally {
      abortScope.dispose();
    }
  }

  async #authenticate(
    request: KernelGatewayHttpRequest,
    reply: KernelGatewayHttpReply,
  ): Promise<AuthenticatedSession> {
    const unsafe = !["GET", "HEAD", "OPTIONS"].includes(request.method);
    try {
      if (unsafe) {
        if (
          singleHeader(request.headers.origin) !== this.configuration.publicOrigin
        ) {
          throw forbidden();
        }
        return await this.identity.authenticateWithCsrf(
          request.cookies[AUTH_SESSION_COOKIE_NAME],
          singleHeader(request.headers[CSRF_HEADER_NAME.toLowerCase()]),
          request.id,
        );
      }
      return await this.identity.authenticate(
        request.cookies[AUTH_SESSION_COOKIE_NAME],
        request.id,
      );
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
