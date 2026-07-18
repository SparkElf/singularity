import {
  createHash,
  createPublicKey,
  randomBytes,
  timingSafeEqual,
  verify,
  type JsonWebKey,
} from "node:crypto";
import { readFile } from "node:fs/promises";

import { Inject, Injectable } from "@nestjs/common";
import {
  AUTH_OIDC_CALLBACK_PATH,
  type CreateOidcProviderRequest,
  type ManagedOidcProvider,
  type OidcProviderSummary,
  type OidcStartRequest,
  type OidcStartResponse,
  type UpdateOidcProviderRequest,
} from "@singularity/contracts";
import { DatabaseRuntime, Prisma } from "@singularity/database";

import { AuditWriter } from "../audit/audit-writer.service.js";
import type { ApiConfiguration } from "../configuration.js";
import { OrganizationManagementService } from "../organizations/organization-management.service.js";
import { conflict, notFound, serviceUnavailable, unauthenticated } from "../problem.js";
import {
  API_CONFIGURATION,
  OIDC_CLIENT_SECRET_RESOLVER,
  OIDC_PROVIDER_CLIENT,
} from "../tokens.js";
import type { Clock } from "./clock.js";
import { CLOCK } from "../tokens.js";
import { IdentityService, type LoginResult } from "./identity.service.js";
import {
  decodeOpaqueToken,
  isMatchingDigest,
} from "./session-crypto.js";

const OIDC_ATTEMPT_MILLISECONDS = 10 * 60 * 1_000;
const OIDC_DIGEST_SEPARATOR = Buffer.from([0]);
const STATE_DIGEST_DOMAIN = Buffer.from("singularity.oidc-state.v1", "utf8");
const NONCE_DIGEST_DOMAIN = Buffer.from("singularity.oidc-nonce.v1", "utf8");
const BROWSER_BINDING_DIGEST_DOMAIN = Buffer.from(
  "singularity.oidc-browser-binding.v1",
  "utf8",
);
const INVALID_DIGEST = "0".repeat(64);

export const OIDC_FLOW_COOKIE_NAME = "__Host-singularity_oidc_flow";
export const OIDC_FLOW_COOKIE_OPTIONS = {
  httpOnly: true,
  path: "/",
  sameSite: "lax",
  secure: true,
} as const;

interface OidcStartResult extends OidcStartResponse {
  flowToken: string;
}

interface OidcProviderConfiguration {
  clientId: string;
  clientSecretReference: string | null;
  issuer: string;
}

interface OidcDiscoveryDocument {
  authorizationEndpoint: string;
  issuer: string;
  jwksUri: string;
  tokenEndpoint: string;
}

export interface VerifiedOidcIdentity {
  email: string | null;
  emailVerified: boolean;
  nonce: string;
  subject: string;
}

export interface OidcProviderClient {
  createAuthorizationUrl(
    provider: OidcProviderConfiguration,
    input: {
      codeChallenge: string;
      nonce: string;
      redirectUri: string;
      state: string;
    },
  ): Promise<string>;
  exchangeAuthorizationCode(
    provider: OidcProviderConfiguration,
    input: {
      code: string;
      codeVerifier: string;
      redirectUri: string;
    },
  ): Promise<VerifiedOidcIdentity>;
}

export interface OidcClientSecretResolver {
  resolve(reference: string): Promise<string>;
}

export class FileOidcClientSecretResolver
  implements OidcClientSecretResolver
{
  constructor(private readonly files: Readonly<Record<string, string>>) {}

  async resolve(reference: string): Promise<string> {
    const path = this.files[reference];
    if (path === undefined) {
      throw serviceUnavailable();
    }
    const value = await readFile(path, { encoding: "utf8" });
    const secret = value.endsWith("\n")
      ? value.slice(0, value.endsWith("\r\n") ? -2 : -1)
      : value;
    if (secret.length === 0 || Buffer.byteLength(secret, "utf8") > 16_384) {
      throw serviceUnavailable();
    }
    return secret;
  }
}

function domainDigest(domain: Buffer, value: string): string {
  return createHash("sha256")
    .update(domain)
    .update(OIDC_DIGEST_SEPARATOR)
    .update(value, "utf8")
    .digest("hex");
}

function decodeJsonSegment(value: string): unknown {
  try {
    return JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  } catch {
    throw unauthenticated();
  }
}

function stringProperty(
  value: Record<string, unknown>,
  key: string,
): string | null {
  const property = value[key];
  return typeof property === "string" ? property : null;
}

function trustedEndpoint(issuer: URL, value: unknown): string {
  if (typeof value !== "string") {
    throw serviceUnavailable();
  }
  const endpoint = new URL(value);
  if (
    endpoint.protocol !== "https:" ||
    endpoint.origin !== issuer.origin ||
    endpoint.username.length > 0 ||
    endpoint.password.length > 0 ||
    endpoint.hash.length > 0
  ) {
    throw serviceUnavailable();
  }
  return endpoint.toString();
}

@Injectable()
export class FetchOidcProviderClient implements OidcProviderClient {
  constructor(
    @Inject(OIDC_CLIENT_SECRET_RESOLVER)
    private readonly secrets: OidcClientSecretResolver,
  ) {}

  async createAuthorizationUrl(
    provider: OidcProviderConfiguration,
    input: {
      codeChallenge: string;
      nonce: string;
      redirectUri: string;
      state: string;
    },
  ): Promise<string> {
    const discovery = await this.discover(provider.issuer);
    const authorizationUrl = new URL(discovery.authorizationEndpoint);
    authorizationUrl.search = new URLSearchParams({
      client_id: provider.clientId,
      code_challenge: input.codeChallenge,
      code_challenge_method: "S256",
      nonce: input.nonce,
      redirect_uri: input.redirectUri,
      response_type: "code",
      scope: "openid email",
      state: input.state,
    }).toString();
    return authorizationUrl.toString();
  }

  async exchangeAuthorizationCode(
    provider: OidcProviderConfiguration,
    input: { code: string; codeVerifier: string; redirectUri: string },
  ): Promise<VerifiedOidcIdentity> {
    const discovery = await this.discover(provider.issuer);
    const body = new URLSearchParams({
      client_id: provider.clientId,
      code: input.code,
      code_verifier: input.codeVerifier,
      grant_type: "authorization_code",
      redirect_uri: input.redirectUri,
    });
    const headers: Record<string, string> = {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
    };
    if (provider.clientSecretReference !== null) {
      const secret = await this.secrets.resolve(provider.clientSecretReference);
      headers.Authorization = `Basic ${Buffer.from(`${provider.clientId}:${secret}`, "utf8").toString("base64")}`;
    }
    const response = await fetch(discovery.tokenEndpoint, {
      body,
      headers,
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      throw unauthenticated();
    }
    const tokenPayload: unknown = await response.json();
    if (
      typeof tokenPayload !== "object" ||
      tokenPayload === null ||
      !("id_token" in tokenPayload) ||
      typeof tokenPayload.id_token !== "string"
    ) {
      throw unauthenticated();
    }
    return this.verifyIdToken(
      tokenPayload.id_token,
      provider,
      discovery,
    );
  }

  async discover(issuerValue: string): Promise<OidcDiscoveryDocument> {
    const issuer = new URL(issuerValue);
    const discoveryUrl = new URL(issuer.toString());
    discoveryUrl.pathname = `${discoveryUrl.pathname.replace(/\/$/, "")}/.well-known/openid-configuration`;
    const response = await fetch(discoveryUrl, {
      headers: { Accept: "application/json" },
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      throw serviceUnavailable();
    }
    const document: unknown = await response.json();
    if (typeof document !== "object" || document === null) {
      throw serviceUnavailable();
    }
    const record = document as Record<string, unknown>;
    if (record.issuer !== issuerValue) {
      throw serviceUnavailable();
    }
    return {
      authorizationEndpoint: trustedEndpoint(issuer, record.authorization_endpoint),
      issuer: issuerValue,
      jwksUri: trustedEndpoint(issuer, record.jwks_uri),
      tokenEndpoint: trustedEndpoint(issuer, record.token_endpoint),
    };
  }

  async verifyIdToken(
    idToken: string,
    provider: OidcProviderConfiguration,
    discovery: OidcDiscoveryDocument,
  ): Promise<VerifiedOidcIdentity> {
    const segments = idToken.split(".");
    if (segments.length !== 3) {
      throw unauthenticated();
    }
    const [headerSegment, payloadSegment, signatureSegment] = segments;
    if (
      headerSegment === undefined ||
      payloadSegment === undefined ||
      signatureSegment === undefined
    ) {
      throw unauthenticated();
    }
    const headerValue = decodeJsonSegment(headerSegment);
    const claimsValue = decodeJsonSegment(payloadSegment);
    if (
      typeof headerValue !== "object" ||
      headerValue === null ||
      typeof claimsValue !== "object" ||
      claimsValue === null
    ) {
      throw unauthenticated();
    }
    const header = headerValue as Record<string, unknown>;
    const claims = claimsValue as Record<string, unknown>;
    const algorithm = stringProperty(header, "alg");
    const keyId = stringProperty(header, "kid");
    if ((algorithm !== "RS256" && algorithm !== "ES256") || keyId === null) {
      throw unauthenticated();
    }
    const jwksResponse = await fetch(discovery.jwksUri, {
      headers: { Accept: "application/json" },
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
    if (!jwksResponse.ok) {
      throw serviceUnavailable();
    }
    const jwksValue: unknown = await jwksResponse.json();
    if (
      typeof jwksValue !== "object" ||
      jwksValue === null ||
      !("keys" in jwksValue) ||
      !Array.isArray(jwksValue.keys)
    ) {
      throw serviceUnavailable();
    }
    const jwk = jwksValue.keys.find(
      (candidate): candidate is Record<string, unknown> =>
        typeof candidate === "object" &&
        candidate !== null &&
        candidate.kid === keyId &&
        (candidate.alg === undefined || candidate.alg === algorithm) &&
        (candidate.use === undefined || candidate.use === "sig"),
    );
    if (jwk === undefined) {
      throw unauthenticated();
    }
    const publicKey = createPublicKey({ key: jwk as JsonWebKey, format: "jwk" });
    const signingInput = Buffer.from(`${headerSegment}.${payloadSegment}`, "ascii");
    const signature = Buffer.from(signatureSegment, "base64url");
    const validSignature =
      algorithm === "ES256"
        ? verify(
            "sha256",
            signingInput,
            { dsaEncoding: "ieee-p1363", key: publicKey },
            signature,
          )
        : verify("sha256", signingInput, publicKey, signature);
    if (!validSignature) {
      throw unauthenticated();
    }
    const issuer = stringProperty(claims, "iss");
    const subject = stringProperty(claims, "sub");
    const nonce = stringProperty(claims, "nonce");
    const audience = claims.aud;
    const authorizedParty = stringProperty(claims, "azp");
    const expiration = claims.exp;
    const issuedAt = claims.iat;
    const nowSeconds = Math.floor(Date.now() / 1_000);
    const audiences =
      typeof audience === "string"
        ? [audience]
        : Array.isArray(audience) &&
            audience.every((value): value is string => typeof value === "string")
          ? audience
          : null;
    const audienceMatches =
      audiences !== null &&
      audiences.includes(provider.clientId) &&
      (audiences.length === 1
        ? authorizedParty === null || authorizedParty === provider.clientId
        : authorizedParty === provider.clientId);
    if (
      issuer !== discovery.issuer ||
      subject === null ||
      nonce === null ||
      !audienceMatches ||
      typeof expiration !== "number" ||
      expiration <= nowSeconds ||
      typeof issuedAt !== "number" ||
      issuedAt > nowSeconds + 60
    ) {
      throw unauthenticated();
    }
    return {
      email: stringProperty(claims, "email"),
      emailVerified: claims.email_verified === true,
      nonce,
      subject,
    };
  }
}

@Injectable()
export class OidcService {
  constructor(
    private readonly database: DatabaseRuntime,
    private readonly identity: IdentityService,
    private readonly organizations: OrganizationManagementService,
    @Inject(CLOCK)
    private readonly clock: Clock,
    @Inject(API_CONFIGURATION)
    private readonly configuration: ApiConfiguration,
    @Inject(OIDC_PROVIDER_CLIENT)
    private readonly providerClient: OidcProviderClient,
    private readonly audit: AuditWriter,
  ) {}

  async listPublicProviders(): Promise<OidcProviderSummary[]> {
    const providers = await this.database.client.oidcProvider.findMany({
      where: { status: "active", organization: { status: "active" } },
      select: { id: true, name: true },
      orderBy: [{ name: "asc" }, { id: "asc" }],
    });
    return providers.map((provider) => ({
      name: provider.name,
      providerId: provider.id,
    }));
  }

  async start(input: OidcStartRequest): Promise<OidcStartResult> {
    const provider = await this.database.client.oidcProvider.findFirst({
      where: {
        id: input.providerId,
        status: "active",
        organization: { status: "active" },
      },
      select: {
        clientId: true,
        clientSecretReference: true,
        id: true,
        issuer: true,
        organizationId: true,
      },
    });
    if (provider === null) {
      throw notFound();
    }
    const invitation =
      input.invitationToken === undefined
        ? null
        : await this.organizations.findAvailableInvitation(input.invitationToken);
    if (
      input.invitationToken !== undefined &&
      (invitation === null || invitation.organizationId !== provider.organizationId)
    ) {
      throw notFound();
    }
    const state = randomBytes(32).toString("base64url");
    const nonce = randomBytes(32).toString("base64url");
    const codeVerifier = randomBytes(32).toString("base64url");
    const flowToken = randomBytes(32).toString("base64url");
    const codeChallenge = createHash("sha256")
      .update(codeVerifier, "ascii")
      .digest("base64url");
    const redirectUri = `${this.configuration.publicOrigin}${AUTH_OIDC_CALLBACK_PATH}`;
    const authorizationUrl = await this.providerClient.createAuthorizationUrl(
      provider,
      { codeChallenge, nonce, redirectUri, state },
    );
    const now = this.clock.now();
    await this.database.client.oidcAuthorizationAttempt.create({
      data: {
        browserBindingDigest: domainDigest(
          BROWSER_BINDING_DIGEST_DOMAIN,
          flowToken,
        ),
        codeVerifier,
        expiresAt: new Date(now.getTime() + OIDC_ATTEMPT_MILLISECONDS),
        ...(invitation === null ? {} : { invitationId: invitation.id }),
        nonceDigest: domainDigest(NONCE_DIGEST_DOMAIN, nonce),
        organizationId: provider.organizationId,
        providerId: provider.id,
        returnTo: input.returnTo ?? "/spaces",
        stateDigest: domainDigest(STATE_DIGEST_DOMAIN, state),
      },
    });
    return { authorizationUrl, flowToken };
  }

  async callback(input: {
    code: string;
    currentTokenValue: string | undefined;
    flowTokenValue: string | undefined;
    requestId: string;
    state: string;
  }): Promise<LoginResult & { returnTo: string }> {
    const now = this.clock.now();
    const stateDigest = domainDigest(STATE_DIGEST_DOMAIN, input.state);
    const browserBindingDigest =
      input.flowTokenValue !== undefined &&
      decodeOpaqueToken(input.flowTokenValue) !== undefined
        ? domainDigest(BROWSER_BINDING_DIGEST_DOMAIN, input.flowTokenValue)
        : INVALID_DIGEST;
    const attempt = await this.database.client.$transaction(async (transaction) => {
      await transaction.$queryRaw(
        Prisma.sql`SELECT "id" FROM "oidc_authorization_attempts" WHERE "state_digest" = ${stateDigest} FOR UPDATE`,
      );
      const current = await transaction.oidcAuthorizationAttempt.findUnique({
        where: { stateDigest },
        include: { provider: true },
      });
      if (
        current === null ||
        current.consumedAt !== null ||
        current.expiresAt.getTime() <= now.getTime() ||
        current.provider.status !== "active" ||
        !isMatchingDigest(
          browserBindingDigest,
          current.browserBindingDigest,
        )
      ) {
        throw unauthenticated();
      }
      await transaction.oidcAuthorizationAttempt.update({
        where: { id: current.id },
        data: { consumedAt: now },
      });
      return current;
    });
    const verified = await this.providerClient.exchangeAuthorizationCode(
      attempt.provider,
      {
        code: input.code,
        codeVerifier: attempt.codeVerifier,
        redirectUri: `${this.configuration.publicOrigin}${AUTH_OIDC_CALLBACK_PATH}`,
      },
    );
    const actualNonceDigest = domainDigest(NONCE_DIGEST_DOMAIN, verified.nonce);
    if (
      !timingSafeEqual(
        Buffer.from(actualNonceDigest, "hex"),
        Buffer.from(attempt.nonceDigest, "hex"),
      )
    ) {
      throw unauthenticated();
    }
    const userId = await this.database.client.$transaction(async (transaction) => {
      await transaction.$queryRaw(
        Prisma.sql`SELECT "id" FROM "organizations" WHERE "id" = ${attempt.organizationId} FOR SHARE`,
      );
      await transaction.$queryRaw(
        Prisma.sql`SELECT "id" FROM "oidc_providers" WHERE "id" = ${attempt.providerId} AND "organization_id" = ${attempt.organizationId} FOR SHARE`,
      );
      const currentProvider = await transaction.oidcProvider.findFirst({
        where: {
          id: attempt.providerId,
          organizationId: attempt.organizationId,
          status: "active",
          organization: { status: "active" },
        },
        select: {
          clientId: true,
          clientSecretReference: true,
          issuer: true,
        },
      });
      if (
        currentProvider === null ||
        currentProvider.clientId !== attempt.provider.clientId ||
        currentProvider.clientSecretReference !==
          attempt.provider.clientSecretReference ||
        currentProvider.issuer !== attempt.provider.issuer
      ) {
        throw unauthenticated();
      }
      const existingIdentity = await transaction.oidcIdentity.findUnique({
        where: {
          providerId_subject: {
            providerId: attempt.providerId,
            subject: verified.subject,
          },
        },
        select: {
          organizationId: true,
          organizationMembership: { select: { status: true } },
          userId: true,
          user: { select: { status: true } },
        },
      });
      if (existingIdentity !== null) {
        if (
          existingIdentity.organizationId !== attempt.organizationId ||
          existingIdentity.organizationMembership.status !== "active" ||
          existingIdentity.user.status !== "active"
        ) {
          throw unauthenticated();
        }
        return existingIdentity.userId;
      }
      if (
        attempt.invitationId === null ||
        !verified.emailVerified ||
        verified.email === null
      ) {
        throw unauthenticated();
      }
      const normalizedEmail = verified.email.trim().normalize("NFKC").toLowerCase();
      const invitation = await transaction.organizationInvitation.findUnique({
        where: { id: attempt.invitationId },
        select: { loginIdentifier: true },
      });
      if (invitation?.loginIdentifier !== normalizedEmail) {
        throw unauthenticated();
      }
      let user = await transaction.user.findUnique({
        where: { loginIdentifier: normalizedEmail },
        select: { id: true, status: true },
      });
      if (user === null) {
        user = await transaction.user.create({
          data: {
            loginIdentifier: normalizedEmail,
            passwordDigest: null,
            status: "active",
          },
          select: { id: true, status: true },
        });
      }
      if (user.status !== "active") {
        throw unauthenticated();
      }
      await this.organizations.acceptOidcInvitationInTransaction(
        transaction,
        attempt.invitationId,
        user.id,
        now,
        input.requestId,
      );
      await transaction.oidcIdentity.create({
        data: {
          providerId: attempt.providerId,
          organizationId: attempt.organizationId,
          subject: verified.subject,
          userId: user.id,
        },
      });
      return user.id;
    });
    const session = await this.identity.issueSessionForUser({
      currentTokenValue: input.currentTokenValue,
      requestId: input.requestId,
      userId,
    });
    return { ...session, returnTo: attempt.returnTo };
  }

  async listManagedProviders(
    actorUserId: string,
    organizationId: string,
  ): Promise<ManagedOidcProvider[]> {
    await this.organizations.requireManager(actorUserId, organizationId, true);
    const providers = await this.database.client.oidcProvider.findMany({
      where: { organizationId },
      orderBy: [{ name: "asc" }, { id: "asc" }],
    });
    return providers.map((provider) => ({
      clientId: provider.clientId,
      ...(provider.clientSecretReference === null
        ? {}
        : { clientSecretReference: provider.clientSecretReference }),
      issuer: provider.issuer,
      name: provider.name,
      organizationId: provider.organizationId,
      providerId: provider.id,
      status: provider.status,
    }));
  }

  async createProvider(
    actorUserId: string,
    organizationId: string,
    input: CreateOidcProviderRequest,
    requestId: string,
  ): Promise<ManagedOidcProvider> {
    try {
      return await this.database.client.$transaction(async (transaction) => {
        await this.organizations.requireManagerInTransaction(
          transaction,
          actorUserId,
          organizationId,
          true,
        );
        const provider = await transaction.oidcProvider.create({
          data: {
            clientId: input.clientId,
            ...(input.clientSecretReference === undefined
              ? {}
              : { clientSecretReference: input.clientSecretReference }),
            issuer: input.issuer,
            name: input.name,
            organizationId,
            status: "active",
          },
        });
        await this.audit.appendPermissionChange(transaction, {
          actorUserId,
          occurredAt: this.clock.now(),
          organizationId,
          requestId,
          spaceId: null,
          targetId: provider.id,
          targetType: "oidc-provider",
        });
        return {
          clientId: provider.clientId,
          ...(provider.clientSecretReference === null
            ? {}
            : { clientSecretReference: provider.clientSecretReference }),
          issuer: provider.issuer,
          name: provider.name,
          organizationId: provider.organizationId,
          providerId: provider.id,
          status: provider.status,
        };
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2002"
      ) {
        throw conflict();
      }
      throw error;
    }
  }

  async updateProvider(
    actorUserId: string,
    organizationId: string,
    providerId: string,
    input: UpdateOidcProviderRequest,
    requestId: string,
  ): Promise<ManagedOidcProvider> {
    return this.database.client.$transaction(async (transaction) => {
      await this.organizations.requireManagerInTransaction(
        transaction,
        actorUserId,
        organizationId,
        true,
      );
      const existing = await transaction.oidcProvider.findFirst({
        where: { id: providerId, organizationId },
        select: { id: true },
      });
      if (existing === null) {
        throw notFound();
      }
      const provider = await transaction.oidcProvider.update({
        where: { id: providerId },
        data: {
          ...(input.clientId === undefined ? {} : { clientId: input.clientId }),
          ...(input.clientSecretReference === undefined
            ? {}
            : { clientSecretReference: input.clientSecretReference }),
          ...(input.issuer === undefined ? {} : { issuer: input.issuer }),
          ...(input.name === undefined ? {} : { name: input.name }),
          ...(input.status === undefined ? {} : { status: input.status }),
        },
      });
      await this.audit.appendPermissionChange(transaction, {
        actorUserId,
        occurredAt: this.clock.now(),
        organizationId,
        requestId,
        spaceId: null,
        targetId: providerId,
        targetType: "oidc-provider",
      });
      return {
        clientId: provider.clientId,
        ...(provider.clientSecretReference === null
          ? {}
          : { clientSecretReference: provider.clientSecretReference }),
        issuer: provider.issuer,
        name: provider.name,
        organizationId: provider.organizationId,
        providerId: provider.id,
        status: provider.status,
      };
    });
  }
}
