import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  Redirect,
  Req,
  Res,
} from "@nestjs/common";
import {
  ApiBody,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from "@nestjs/swagger";
import {
  AUTH_OIDC_CALLBACK_PATH,
  AUTH_OIDC_PROVIDERS_PATH,
  AUTH_OIDC_START_PATH,
  AUTH_SESSION_COOKIE_NAME,
  CREATE_OIDC_PROVIDER_REQUEST_OPENAPI_SCHEMA,
  MANAGED_OIDC_PROVIDERS_RESPONSE_OPENAPI_SCHEMA,
  MANAGED_OIDC_PROVIDER_OPENAPI_SCHEMA,
  OIDC_PROVIDERS_RESPONSE_OPENAPI_SCHEMA,
  OIDC_START_REQUEST_OPENAPI_SCHEMA,
  OIDC_START_RESPONSE_OPENAPI_SCHEMA,
  ORGANIZATION_OIDC_PROVIDERS_CONTROLLER_PATH,
  ORGANIZATION_OIDC_PROVIDER_CONTROLLER_PATH,
  UPDATE_OIDC_PROVIDER_REQUEST_OPENAPI_SCHEMA,
  type ManagedOidcProvider,
  type ManagedOidcProvidersResponse,
  type OidcProvidersResponse,
  type OidcStartResponse,
  type OidcCallbackQuery,
  type OidcStartRequest,
  type CreateOidcProviderRequest,
  type UpdateOidcProviderRequest,
  createOidcProviderRequestSchema,
  oidcCallbackQuerySchema,
  oidcProviderPathParametersSchema,
  oidcStartRequestSchema,
  organizationPathParametersSchema,
  updateOidcProviderRequestSchema,
} from "@singularity/contracts";
import { z } from "zod";

import type {
  HttpReplyBoundary,
  HttpRequestBoundary,
} from "../http-boundary.js";
import {
  Authenticated,
  ApiProblemResponses,
  CurrentSession,
  SameOrigin,
  SessionMutation,
} from "./http-access.js";
import type { AuthenticatedSession } from "./identity.service.js";
import {
  OIDC_FLOW_COOKIE_NAME,
  OIDC_FLOW_COOKIE_OPTIONS,
  OidcService,
} from "./oidc.service.js";
import {
  SESSION_COOKIE_OPTIONS,
} from "./session-crypto.js";
import { ZodValidationPipe } from "./zod-validation.pipe.js";

type OrganizationPathParameters = z.infer<typeof organizationPathParametersSchema>;
type OidcProviderPathParameters = z.infer<typeof oidcProviderPathParametersSchema>;

@ApiTags("oidc")
@Controller()
export class OidcController {
  constructor(
    private readonly oidc: OidcService,
  ) {}

  @Get(AUTH_OIDC_PROVIDERS_PATH)
  @Header("Cache-Control", "no-store")
  @ApiProblemResponses(503)
  @ApiOperation({ summary: "List active OIDC login providers" })
  @ApiOkResponse({ schema: OIDC_PROVIDERS_RESPONSE_OPENAPI_SCHEMA })
  async listPublicProviders(): Promise<OidcProvidersResponse> {
    return { providers: await this.oidc.listPublicProviders() };
  }

  @Post(AUTH_OIDC_START_PATH)
  @Header("Cache-Control", "no-store")
  @SameOrigin()
  @ApiProblemResponses(400, 404, 503)
  @ApiOperation({ summary: "Start an OIDC authorization-code flow" })
  @ApiBody({ schema: OIDC_START_REQUEST_OPENAPI_SCHEMA })
  @ApiOkResponse({ schema: OIDC_START_RESPONSE_OPENAPI_SCHEMA })
  async start(
    @Body(new ZodValidationPipe(oidcStartRequestSchema)) body: OidcStartRequest,
    @Res({ passthrough: true }) reply: HttpReplyBoundary,
  ): Promise<OidcStartResponse> {
    const result = await this.oidc.start(body);
    reply.setCookie(
      OIDC_FLOW_COOKIE_NAME,
      result.flowToken,
      OIDC_FLOW_COOKIE_OPTIONS,
    );
    return { authorizationUrl: result.authorizationUrl };
  }

  @Get(AUTH_OIDC_CALLBACK_PATH)
  @Header("Cache-Control", "no-store")
  @Redirect(undefined, 303)
  @ApiProblemResponses(400, 401, 503)
  @ApiOperation({ summary: "Complete an OIDC authorization-code flow" })
  @ApiResponse({ status: 303, description: "Authenticated same-origin redirect" })
  async callback(
    @Query(new ZodValidationPipe(oidcCallbackQuerySchema))
    query: OidcCallbackQuery,
    @Req() request: HttpRequestBoundary,
    @Res({ passthrough: true }) reply: HttpReplyBoundary,
  ): Promise<{ url: string }> {
    const flowTokenValue = request.cookies[OIDC_FLOW_COOKIE_NAME];
    reply.clearCookie(OIDC_FLOW_COOKIE_NAME, OIDC_FLOW_COOKIE_OPTIONS);
    const result = await this.oidc.callback({
      code: query.code,
      currentTokenValue: request.cookies[AUTH_SESSION_COOKIE_NAME],
      flowTokenValue,
      requestId: request.id,
      state: query.state,
    });
    reply.setCookie(
      AUTH_SESSION_COOKIE_NAME,
      result.tokenValue,
      SESSION_COOKIE_OPTIONS,
    );
    return { url: result.returnTo };
  }

  @Get(ORGANIZATION_OIDC_PROVIDERS_CONTROLLER_PATH)
  @Header("Cache-Control", "no-store")
  @Authenticated()
  @ApiProblemResponses(400, 401, 403, 404, 503)
  @ApiOperation({ summary: "List organization OIDC providers" })
  @ApiOkResponse({ schema: MANAGED_OIDC_PROVIDERS_RESPONSE_OPENAPI_SCHEMA })
  async listManagedProviders(
    @Param(new ZodValidationPipe(organizationPathParametersSchema))
    parameters: OrganizationPathParameters,
    @CurrentSession() session: AuthenticatedSession,
  ): Promise<ManagedOidcProvidersResponse> {
    return {
      providers: await this.oidc.listManagedProviders(
        session.userId,
        parameters.organizationId,
      ),
    };
  }

  @Post(ORGANIZATION_OIDC_PROVIDERS_CONTROLLER_PATH)
  @HttpCode(201)
  @Header("Cache-Control", "no-store")
  @SessionMutation()
  @ApiProblemResponses(400, 401, 403, 404, 409, 503)
  @ApiOperation({ summary: "Create an organization OIDC provider" })
  @ApiBody({ schema: CREATE_OIDC_PROVIDER_REQUEST_OPENAPI_SCHEMA })
  @ApiCreatedResponse({ schema: MANAGED_OIDC_PROVIDER_OPENAPI_SCHEMA })
  async createProvider(
    @Param(new ZodValidationPipe(organizationPathParametersSchema))
    parameters: OrganizationPathParameters,
    @Body(new ZodValidationPipe(createOidcProviderRequestSchema))
    body: CreateOidcProviderRequest,
    @Req() request: HttpRequestBoundary,
    @CurrentSession() session: AuthenticatedSession,
  ): Promise<ManagedOidcProvider> {
    return this.oidc.createProvider(
      session.userId,
      parameters.organizationId,
      body,
      request.id,
    );
  }

  @Patch(ORGANIZATION_OIDC_PROVIDER_CONTROLLER_PATH)
  @Header("Cache-Control", "no-store")
  @SessionMutation()
  @ApiProblemResponses(400, 401, 403, 404, 503)
  @ApiOperation({ summary: "Update an organization OIDC provider" })
  @ApiBody({ schema: UPDATE_OIDC_PROVIDER_REQUEST_OPENAPI_SCHEMA })
  @ApiOkResponse({ schema: MANAGED_OIDC_PROVIDER_OPENAPI_SCHEMA })
  async updateProvider(
    @Param(new ZodValidationPipe(oidcProviderPathParametersSchema))
    parameters: OidcProviderPathParameters,
    @Body(new ZodValidationPipe(updateOidcProviderRequestSchema))
    body: UpdateOidcProviderRequest,
    @Req() request: HttpRequestBoundary,
    @CurrentSession() session: AuthenticatedSession,
  ): Promise<ManagedOidcProvider> {
    return this.oidc.updateProvider(
      session.userId,
      parameters.organizationId,
      parameters.providerId,
      body,
      request.id,
    );
  }
}
