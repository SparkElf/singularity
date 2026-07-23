import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  Param,
  Patch,
  Post,
  Put,
  Req,
  UseGuards,
} from "@nestjs/common";
import {
  ApiBody,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from "@nestjs/swagger";
import {
  DOCUMENT_AI_CHAT_CONTROLLER_PATH,
  DOCUMENT_EMBEDDED_OBJECTS_CONTROLLER_PATH,
  DOCUMENT_GOVERNANCE_APPROVALS_CONTROLLER_PATH,
  DOCUMENT_GOVERNANCE_CONTROLLER_PATH,
  DOCUMENT_GOVERNANCE_TRANSITION_CONTROLLER_PATH,
  DOCUMENT_GOVERNANCE_CLASSIFICATION_CONTROLLER_PATH,
  DOCUMENT_GOVERNANCE_LEGAL_HOLD_CONTROLLER_PATH,
  GOVERNANCE_POLICY_OPENAPI_SCHEMA,
  DOCUMENT_GOVERNANCE_OPENAPI_SCHEMA,
  ORGANIZATION_API_KEYS_CONTROLLER_PATH,
  ORGANIZATION_API_KEY_CONTROLLER_PATH,
  ORGANIZATION_GOVERNANCE_DASHBOARD_CONTROLLER_PATH,
  ORGANIZATION_GOVERNANCE_SEARCH_CONTROLLER_PATH,
  ORGANIZATION_PERSONAL_SPACE_CONTROLLER_PATH,
  ORGANIZATION_SAML_PROVIDERS_CONTROLLER_PATH,
  ORGANIZATION_SAML_PROVIDER_CONTROLLER_PATH,
  ORGANIZATION_SCIM_TOKENS_CONTROLLER_PATH,
  ORGANIZATION_SCIM_TOKEN_CONTROLLER_PATH,
  ORGANIZATION_SCIM_SYNC_CONTROLLER_PATH,
  ORGANIZATION_SPACE_GOVERNANCE_POLICY_CONTROLLER_PATH,
  ORGANIZATION_SPACE_GOVERNANCE_TEMPLATES_CONTROLLER_PATH,
  ORGANIZATION_SPACE_GOVERNANCE_TEMPLATE_PUBLISH_CONTROLLER_PATH,
  ORGANIZATION_SPACE_GOVERNANCE_TEMPLATE_DOCUMENTS_CONTROLLER_PATH,
  AUTH_MFA_FACTORS_PATH,
  AUTH_MFA_VERIFY_PATH,
  documentPathParametersSchema,
  governanceEmbeddedObjectRequestSchema,
  governanceClassificationRequestSchema,
  governanceLegalHoldRequestSchema,
  governancePolicySchema,
  governanceSearchRequestSchema,
  governanceTransitionRequestSchema,
  governanceTemplateRequestSchema,
  governanceTemplateDocumentRequestSchema,
  scimSyncRequestSchema,
  mfaFactorRequestSchema,
  mfaVerifyRequestSchema,
  aiChatRequestSchema,
  type AiChatRequest,
  enterpriseApiKeyRequestSchema,
  type GovernanceEmbeddedObjectRequest,
  type GovernanceClassificationRequest,
  type GovernanceLegalHoldRequest,
  type GovernancePolicy,
  type GovernanceSearchRequest,
  type GovernanceTemplateRequest,
  type GovernanceTemplateDocumentRequest,
  type GovernanceTransitionRequest,
  type ScimSyncRequest,
  type MfaFactorRequest,
  type MfaVerifyRequest,
} from "@singularity/contracts";
import { z } from "zod";

import type { IncomingMessage } from "node:http";

import { type HttpRequestBoundary } from "../http-boundary.js";
import { bindHttpRequestAbortSignal } from "../http-request-signal.js";
import {
  ApiProblemResponses,
  Authenticated,
  CurrentSession,
  SessionMutation,
} from "../identity/http-access.js";
import type { AuthenticatedSession } from "../identity/identity.service.js";
import { ZodValidationPipe } from "../identity/zod-validation.pipe.js";
import { EnterpriseGovernanceService } from "./governance.service.js";
import { ScimTokenGuard } from "./scim-token.guard.js";

const organizationSpacePathSchema = z.object({ organizationId: z.string().uuid(), spaceId: z.string().uuid() }).strict();
const organizationPathSchema = z.object({ organizationId: z.string().uuid() }).strict();
const samlProviderRequestSchema = z.object({
  certificatePem: z.string().min(1).max(32_000),
  entityId: z.string().trim().min(1).max(2_048),
  name: z.string().trim().min(1).max(120),
  ssoUrl: z.string().url().max(2_048).refine((value) => new URL(value).protocol === "https:", "SAML SSO URL must use HTTPS"),
}).strict();
const samlProviderStatusSchema = z.object({ status: z.enum(["active", "disabled"]) }).strict();
const scimTokenRequestSchema = z.object({ expiresAt: z.string().datetime({ offset: true }).optional() }).strict();

type OrganizationSpacePath = z.infer<typeof organizationSpacePathSchema>;
type OrganizationPath = z.infer<typeof organizationPathSchema>;
type DocumentPath = z.infer<typeof documentPathParametersSchema>;

interface GovernanceHttpRequest extends HttpRequestBoundary {
  readonly raw: IncomingMessage;
}

@ApiTags("governance")
@Controller()
export class GovernanceController {
  constructor(private readonly governance: EnterpriseGovernanceService) {}

  @Get(AUTH_MFA_FACTORS_PATH)
  @Header("Cache-Control", "no-store")
  @Authenticated()
  @ApiProblemResponses(401, 503)
  @ApiOperation({ summary: "List the current user's MFA factors" })
  async listMfa(@CurrentSession() session: AuthenticatedSession) {
    return this.governance.listMfaFactors(session.userId);
  }

  @Post(AUTH_MFA_FACTORS_PATH)
  @HttpCode(201)
  @Header("Cache-Control", "no-store")
  @SessionMutation()
  @ApiProblemResponses(400, 401, 403, 503)
  @ApiOperation({ summary: "Enroll a TOTP MFA factor" })
  async enrollMfa(
    @Body(new ZodValidationPipe(mfaFactorRequestSchema)) body: MfaFactorRequest,
    @Req() request: HttpRequestBoundary,
    @CurrentSession() session: AuthenticatedSession,
  ) {
    return this.governance.enrollMfa(session.userId, body, request.id);
  }

  @Post(AUTH_MFA_VERIFY_PATH)
  @HttpCode(200)
  @Header("Cache-Control", "no-store")
  @SessionMutation()
  @ApiProblemResponses(400, 401, 403, 404, 503)
  @ApiOperation({ summary: "Verify and enable a TOTP MFA factor" })
  async verifyMfa(
    @Body(new ZodValidationPipe(mfaVerifyRequestSchema)) body: MfaVerifyRequest,
    @Req() request: HttpRequestBoundary,
    @CurrentSession() session: AuthenticatedSession,
  ) {
    return this.governance.verifyMfa(session.userId, body, request.id);
  }

  @Get(ORGANIZATION_SPACE_GOVERNANCE_POLICY_CONTROLLER_PATH)
  @Header("Cache-Control", "no-store")
  @Authenticated()
  @ApiProblemResponses(400, 401, 403, 404, 503)
  @ApiOperation({ summary: "Read a space governance policy" })
  @ApiOkResponse({ schema: GOVERNANCE_POLICY_OPENAPI_SCHEMA })
  async getPolicy(
    @Param(new ZodValidationPipe(organizationSpacePathSchema)) parameters: OrganizationSpacePath,
    @CurrentSession() session: AuthenticatedSession,
  ) {
    return this.governance.getPolicy(session.userId, parameters.organizationId, parameters.spaceId);
  }

  @Put(ORGANIZATION_SPACE_GOVERNANCE_POLICY_CONTROLLER_PATH)
  @Header("Cache-Control", "no-store")
  @SessionMutation()
  @ApiProblemResponses(400, 401, 403, 404, 409, 503)
  @ApiOperation({ summary: "Update a space governance policy" })
  @ApiBody({ schema: GOVERNANCE_POLICY_OPENAPI_SCHEMA })
  @ApiOkResponse({ schema: GOVERNANCE_POLICY_OPENAPI_SCHEMA })
  async updatePolicy(
    @Param(new ZodValidationPipe(organizationSpacePathSchema)) parameters: OrganizationSpacePath,
    @Body(new ZodValidationPipe(governancePolicySchema)) body: GovernancePolicy,
    @Req() request: HttpRequestBoundary,
    @CurrentSession() session: AuthenticatedSession,
  ) {
    return this.governance.updatePolicy(session.userId, parameters.organizationId, parameters.spaceId, body, request.id);
  }

  @Get(DOCUMENT_GOVERNANCE_CONTROLLER_PATH)
  @Header("Cache-Control", "no-store")
  @Authenticated()
  @ApiProblemResponses(400, 401, 403, 404, 503)
  @ApiOperation({ summary: "Read document governance state" })
  @ApiOkResponse({ schema: DOCUMENT_GOVERNANCE_OPENAPI_SCHEMA })
  async getDocument(
    @Param(new ZodValidationPipe(documentPathParametersSchema)) parameters: DocumentPath,
    @CurrentSession() session: AuthenticatedSession,
  ) {
    return this.governance.getDocument(session.userId, parameters);
  }

  @Post(DOCUMENT_GOVERNANCE_TRANSITION_CONTROLLER_PATH)
  @Header("Cache-Control", "no-store")
  @SessionMutation()
  @ApiProblemResponses(400, 401, 403, 404, 409, 503)
  @ApiOperation({ summary: "Transition document governance state" })
  async transition(
    @Param(new ZodValidationPipe(documentPathParametersSchema)) parameters: DocumentPath,
    @Body(new ZodValidationPipe(governanceTransitionRequestSchema)) body: GovernanceTransitionRequest,
    @Req() request: HttpRequestBoundary,
    @CurrentSession() session: AuthenticatedSession,
  ) {
    return this.governance.transition(session.userId, parameters, body, request.id);
  }

  @Put(DOCUMENT_GOVERNANCE_CLASSIFICATION_CONTROLLER_PATH)
  @Header("Cache-Control", "no-store")
  @SessionMutation()
  @ApiProblemResponses(400, 401, 403, 404, 409, 503)
  @ApiOperation({ summary: "Raise a document classification" })
  async setClassification(
    @Param(new ZodValidationPipe(documentPathParametersSchema)) parameters: DocumentPath,
    @Body(new ZodValidationPipe(governanceClassificationRequestSchema)) body: GovernanceClassificationRequest,
    @Req() request: HttpRequestBoundary,
    @CurrentSession() session: AuthenticatedSession,
  ) {
    return this.governance.setClassification(session.userId, parameters, body, request.id);
  }

  @Put(DOCUMENT_GOVERNANCE_LEGAL_HOLD_CONTROLLER_PATH)
  @Header("Cache-Control", "no-store")
  @SessionMutation()
  @ApiProblemResponses(400, 401, 403, 404, 409, 503)
  @ApiOperation({ summary: "Set or release a document legal hold" })
  async setLegalHold(
    @Param(new ZodValidationPipe(documentPathParametersSchema)) parameters: DocumentPath,
    @Body(new ZodValidationPipe(governanceLegalHoldRequestSchema)) body: GovernanceLegalHoldRequest,
    @Req() request: HttpRequestBoundary,
    @CurrentSession() session: AuthenticatedSession,
  ) {
    return this.governance.setLegalHold(session.userId, parameters, body, request.id);
  }

  @Get(DOCUMENT_GOVERNANCE_APPROVALS_CONTROLLER_PATH)
  @Header("Cache-Control", "no-store")
  @Authenticated()
  @ApiProblemResponses(400, 401, 403, 404, 503)
  @ApiOperation({ summary: "List document approval decisions" })
  async approvals(
    @Param(new ZodValidationPipe(documentPathParametersSchema)) parameters: DocumentPath,
    @CurrentSession() session: AuthenticatedSession,
  ) {
    return this.governance.listApprovals(session.userId, parameters);
  }

  @Get(ORGANIZATION_SPACE_GOVERNANCE_TEMPLATES_CONTROLLER_PATH)
  @Header("Cache-Control", "no-store")
  @Authenticated()
  @ApiProblemResponses(400, 401, 403, 404, 503)
  @ApiOperation({ summary: "List governance templates" })
  async templates(
    @Param(new ZodValidationPipe(organizationSpacePathSchema)) parameters: OrganizationSpacePath,
    @CurrentSession() session: AuthenticatedSession,
  ) {
    return this.governance.listTemplates(session.userId, parameters.organizationId, parameters.spaceId);
  }

  @Post(ORGANIZATION_SPACE_GOVERNANCE_TEMPLATES_CONTROLLER_PATH)
  @HttpCode(201)
  @Header("Cache-Control", "no-store")
  @SessionMutation()
  @ApiProblemResponses(400, 401, 403, 404, 409, 503)
  @ApiOperation({ summary: "Create a governance template" })
  @ApiBody({ schema: { type: "object" } })
  @ApiCreatedResponse({ schema: { type: "object" } })
  async createTemplate(
    @Param(new ZodValidationPipe(organizationSpacePathSchema)) parameters: OrganizationSpacePath,
    @Body(new ZodValidationPipe(governanceTemplateRequestSchema)) body: GovernanceTemplateRequest,
    @Req() request: HttpRequestBoundary,
    @CurrentSession() session: AuthenticatedSession,
  ) {
    return this.governance.createTemplate(session.userId, parameters.organizationId, parameters.spaceId, body, request.id);
  }

  @Post(ORGANIZATION_SPACE_GOVERNANCE_TEMPLATE_PUBLISH_CONTROLLER_PATH)
  @Header("Cache-Control", "no-store")
  @SessionMutation()
  @ApiProblemResponses(400, 401, 403, 404, 409, 503)
  @ApiOperation({ summary: "Publish a governance template" })
  async publishTemplate(
    @Param(new ZodValidationPipe(z.object({ organizationId: z.string().uuid(), spaceId: z.string().uuid(), templateId: z.string().uuid() }).strict())) parameters: { organizationId: string; spaceId: string; templateId: string },
    @Req() request: HttpRequestBoundary,
    @CurrentSession() session: AuthenticatedSession,
  ) {
    return this.governance.publishTemplate(session.userId, parameters.organizationId, parameters.spaceId, parameters.templateId, request.id);
  }

  @Post(ORGANIZATION_SPACE_GOVERNANCE_TEMPLATE_DOCUMENTS_CONTROLLER_PATH)
  @HttpCode(201)
  @Header("Cache-Control", "no-store")
  @SessionMutation()
  @ApiProblemResponses(400, 401, 403, 404, 409, 503)
  @ApiOperation({ summary: "Create a document from a published governance template" })
  async createTemplateDocument(
    @Param(new ZodValidationPipe(z.object({ organizationId: z.string().uuid(), spaceId: z.string().uuid(), templateId: z.string().uuid() }).strict())) parameters: { organizationId: string; spaceId: string; templateId: string },
    @Body(new ZodValidationPipe(governanceTemplateDocumentRequestSchema)) body: GovernanceTemplateDocumentRequest,
    @Req() request: GovernanceHttpRequest,
    @CurrentSession() session: AuthenticatedSession,
  ) {
    const abortScope = bindHttpRequestAbortSignal(request.raw);
    try {
      return await this.governance.createDocumentFromTemplate(session.userId, parameters.organizationId, parameters.spaceId, parameters.templateId, body, request.id, abortScope.signal);
    } finally {
      abortScope.dispose();
    }
  }

  @Get(ORGANIZATION_GOVERNANCE_DASHBOARD_CONTROLLER_PATH)
  @Header("Cache-Control", "no-store")
  @Authenticated()
  @ApiProblemResponses(400, 401, 403, 404, 503)
  @ApiOperation({ summary: "Read governance dashboard counters" })
  async dashboard(
    @Param(new ZodValidationPipe(organizationPathSchema)) parameters: OrganizationPath,
    @CurrentSession() session: AuthenticatedSession,
  ) {
    return this.governance.dashboard(session.userId, parameters.organizationId);
  }

  @Post(ORGANIZATION_GOVERNANCE_SEARCH_CONTROLLER_PATH)
  @Header("Cache-Control", "no-store")
  @Authenticated()
  @ApiProblemResponses(400, 401, 403, 404, 503)
  @ApiOperation({ summary: "Search authorized spaces" })
  async search(
    @Param(new ZodValidationPipe(organizationPathSchema)) parameters: OrganizationPath,
    @Body(new ZodValidationPipe(governanceSearchRequestSchema)) body: GovernanceSearchRequest,
    @CurrentSession() session: AuthenticatedSession,
  ) {
    return this.governance.search(session.userId, parameters.organizationId, body);
  }

  @Post(ORGANIZATION_PERSONAL_SPACE_CONTROLLER_PATH)
  @Header("Cache-Control", "no-store")
  @SessionMutation()
  @ApiProblemResponses(400, 401, 403, 404, 409, 503)
  @ApiOperation({ summary: "Get or create the current user's personal space" })
  async personalSpace(
    @Param(new ZodValidationPipe(organizationPathSchema)) parameters: OrganizationPath,
    @CurrentSession() session: AuthenticatedSession,
  ) {
    return this.governance.getOrCreatePersonalSpace(session.userId, parameters.organizationId);
  }

  @Post(ORGANIZATION_API_KEYS_CONTROLLER_PATH)
  @HttpCode(201)
  @Header("Cache-Control", "no-store")
  @SessionMutation()
  @ApiProblemResponses(400, 401, 403, 404, 409, 503)
  @ApiOperation({ summary: "Create a scoped enterprise API key" })
  async createApiKey(
    @Param(new ZodValidationPipe(organizationPathSchema)) parameters: OrganizationPath,
    @Body(new ZodValidationPipe(enterpriseApiKeyRequestSchema)) body: { name: string; scopes: string[]; expiresAt?: string },
    @Req() request: HttpRequestBoundary,
    @CurrentSession() session: AuthenticatedSession,
  ) {
    return this.governance.createApiKey(session.userId, parameters.organizationId, body.name, body.scopes, body.expiresAt, request.id);
  }

  @Get(ORGANIZATION_API_KEYS_CONTROLLER_PATH)
  @Header("Cache-Control", "no-store")
  @Authenticated()
  @ApiProblemResponses(401, 403, 404, 503)
  @ApiOperation({ summary: "List enterprise API key summaries" })
  @ApiOkResponse({ schema: { type: "object", properties: { keys: { type: "array" } } } })
  async listApiKeys(
    @Param(new ZodValidationPipe(organizationPathSchema)) parameters: OrganizationPath,
    @CurrentSession() session: AuthenticatedSession,
  ) {
    return this.governance.listApiKeys(session.userId, parameters.organizationId);
  }

  @Delete(ORGANIZATION_API_KEY_CONTROLLER_PATH)
  @HttpCode(204)
  @Header("Cache-Control", "no-store")
  @SessionMutation()
  @ApiProblemResponses(400, 401, 403, 404, 503)
  @ApiOperation({ summary: "Revoke an enterprise API key" })
  async revokeApiKey(
    @Param(new ZodValidationPipe(z.object({ organizationId: z.string().uuid(), apiKeyId: z.string().uuid() }).strict())) parameters: { organizationId: string; apiKeyId: string },
    @Req() request: HttpRequestBoundary,
    @CurrentSession() session: AuthenticatedSession,
  ): Promise<void> {
    await this.governance.revokeApiKey(session.userId, parameters.organizationId, parameters.apiKeyId, request.id);
  }

  @Post(ORGANIZATION_SAML_PROVIDERS_CONTROLLER_PATH)
  @HttpCode(201)
  @Header("Cache-Control", "no-store")
  @SessionMutation()
  @ApiProblemResponses(400, 401, 403, 404, 409, 503)
  @ApiOperation({ summary: "Configure an enterprise SAML provider" })
  async createSamlProvider(
    @Param(new ZodValidationPipe(organizationPathSchema)) parameters: OrganizationPath,
    @Body(new ZodValidationPipe(samlProviderRequestSchema)) body: z.infer<typeof samlProviderRequestSchema>,
    @Req() request: HttpRequestBoundary,
    @CurrentSession() session: AuthenticatedSession,
  ) {
    return this.governance.createSamlProvider(session.userId, parameters.organizationId, body, request.id);
  }

  @Get(ORGANIZATION_SAML_PROVIDERS_CONTROLLER_PATH)
  @Header("Cache-Control", "no-store")
  @Authenticated()
  @ApiProblemResponses(401, 403, 404, 503)
  @ApiOperation({ summary: "List enterprise SAML provider summaries" })
  async listSamlProviders(
    @Param(new ZodValidationPipe(organizationPathSchema)) parameters: OrganizationPath,
    @CurrentSession() session: AuthenticatedSession,
  ) {
    return this.governance.listSamlProviders(session.userId, parameters.organizationId);
  }

  @Patch(ORGANIZATION_SAML_PROVIDER_CONTROLLER_PATH)
  @Header("Cache-Control", "no-store")
  @SessionMutation()
  @ApiProblemResponses(400, 401, 403, 404, 503)
  @ApiOperation({ summary: "Enable or disable an enterprise SAML provider" })
  async setSamlProviderStatus(
    @Param(new ZodValidationPipe(z.object({ organizationId: z.string().uuid(), providerId: z.string().uuid() }).strict())) parameters: { organizationId: string; providerId: string },
    @Body(new ZodValidationPipe(samlProviderStatusSchema)) body: { status: "active" | "disabled" },
    @Req() request: HttpRequestBoundary,
    @CurrentSession() session: AuthenticatedSession,
  ) {
    return this.governance.setSamlProviderStatus(session.userId, parameters.organizationId, parameters.providerId, body.status, request.id);
  }

  @Post(ORGANIZATION_SCIM_TOKENS_CONTROLLER_PATH)
  @HttpCode(201)
  @Header("Cache-Control", "no-store")
  @SessionMutation()
  @ApiProblemResponses(400, 401, 403, 404, 409, 503)
  @ApiOperation({ summary: "Create a SCIM synchronization token" })
  async createScimToken(
    @Param(new ZodValidationPipe(organizationPathSchema)) parameters: OrganizationPath,
    @Body(new ZodValidationPipe(scimTokenRequestSchema)) body: z.infer<typeof scimTokenRequestSchema>,
    @Req() request: HttpRequestBoundary,
    @CurrentSession() session: AuthenticatedSession,
  ) {
    return this.governance.createScimToken(session.userId, parameters.organizationId, body.expiresAt, request.id);
  }

  @Get(ORGANIZATION_SCIM_TOKENS_CONTROLLER_PATH)
  @Header("Cache-Control", "no-store")
  @Authenticated()
  @ApiProblemResponses(401, 403, 404, 503)
  @ApiOperation({ summary: "List SCIM token summaries" })
  async listScimTokens(
    @Param(new ZodValidationPipe(organizationPathSchema)) parameters: OrganizationPath,
    @CurrentSession() session: AuthenticatedSession,
  ) {
    return this.governance.listScimTokens(session.userId, parameters.organizationId);
  }

  @Delete(ORGANIZATION_SCIM_TOKEN_CONTROLLER_PATH)
  @HttpCode(204)
  @Header("Cache-Control", "no-store")
  @SessionMutation()
  @ApiProblemResponses(400, 401, 403, 404, 503)
  @ApiOperation({ summary: "Revoke a SCIM synchronization token" })
  async revokeScimToken(
    @Param(new ZodValidationPipe(z.object({ organizationId: z.string().uuid(), tokenId: z.string().uuid() }).strict())) parameters: { organizationId: string; tokenId: string },
    @Req() request: HttpRequestBoundary,
    @CurrentSession() session: AuthenticatedSession,
  ): Promise<void> {
    await this.governance.revokeScimToken(session.userId, parameters.organizationId, parameters.tokenId, request.id);
  }

  @Post(ORGANIZATION_SCIM_SYNC_CONTROLLER_PATH)
  @HttpCode(200)
  @Header("Cache-Control", "no-store")
  @UseGuards(ScimTokenGuard)
  @ApiProblemResponses(400, 401, 403, 404, 503)
  @ApiOperation({ summary: "Apply an idempotent SCIM membership sync" })
  async syncScim(
    @Param(new ZodValidationPipe(organizationPathSchema)) parameters: OrganizationPath,
    @Body(new ZodValidationPipe(scimSyncRequestSchema)) body: ScimSyncRequest,
    @Req() request: HttpRequestBoundary,
  ) {
    return this.governance.syncScim(parameters.organizationId, body, request.id);
  }

  @Get(DOCUMENT_EMBEDDED_OBJECTS_CONTROLLER_PATH)
  @Header("Cache-Control", "no-store")
  @Authenticated()
  @ApiProblemResponses(400, 401, 403, 404, 503)
  @ApiOperation({ summary: "List document embeds" })
  async embeds(
    @Param(new ZodValidationPipe(documentPathParametersSchema)) parameters: DocumentPath,
    @CurrentSession() session: AuthenticatedSession,
  ) {
    return this.governance.listEmbeds(session.userId, parameters);
  }

  @Put(DOCUMENT_EMBEDDED_OBJECTS_CONTROLLER_PATH)
  @Header("Cache-Control", "no-store")
  @SessionMutation()
  @ApiProblemResponses(400, 401, 403, 404, 503)
  @ApiOperation({ summary: "Create or update a document embed" })
  async upsertEmbed(
    @Param(new ZodValidationPipe(documentPathParametersSchema)) parameters: DocumentPath,
    @Body(new ZodValidationPipe(governanceEmbeddedObjectRequestSchema)) body: GovernanceEmbeddedObjectRequest,
    @Req() request: HttpRequestBoundary,
    @CurrentSession() session: AuthenticatedSession,
  ) {
    return this.governance.upsertEmbed(session.userId, parameters, body, request.id);
  }

  @Post(DOCUMENT_AI_CHAT_CONTROLLER_PATH)
  @Header("Cache-Control", "no-store")
  @SessionMutation()
  @ApiProblemResponses(400, 401, 403, 404, 503)
  @ApiOperation({ summary: "Ask the authorized AI knowledge assistant" })
  async aiChat(
    @Param(new ZodValidationPipe(documentPathParametersSchema)) parameters: DocumentPath,
    @Body(new ZodValidationPipe(aiChatRequestSchema)) body: AiChatRequest,
    @Req() request: HttpRequestBoundary,
    @CurrentSession() session: AuthenticatedSession,
  ) {
    return this.governance.askAi(session.userId, parameters, body, request.id);
  }
}
