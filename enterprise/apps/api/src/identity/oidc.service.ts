import {
  createHash,
  createPublicKey,
  randomBytes,
  timingSafeEqual,
  verify,
  type JsonWebKey,
} from "node:crypto";
import { readFile } from "node:fs/promises";
import { TextDecoder } from "node:util";

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
import { AuditWriter, DatabaseRuntime, Prisma } from "@singularity/database";

import type {
  ApiConfiguration,
  OidcClientSecretBinding,
} from "../configuration.js";
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
  SecureOidcHttpTransport,
  type OidcHttpResponse,
  type OidcHttpTransport,
} from "./oidc-http-transport.js";
import { OidcStartAdmission } from "./oidc-start-admission.js";
import {
  decodeOpaqueToken,
  isMatchingDigest,
} from "./session-crypto.js";

const OIDC_ATTEMPT_MILLISECONDS = 10 * 60 * 1_000;
const OIDC_DISCOVERY_MAXIMUM_BODY_BYTES = 64 * 1_024;
const OIDC_JWKS_MAXIMUM_BODY_BYTES = 1_024 * 1_024;
const OIDC_TOKEN_MAXIMUM_BODY_BYTES = 128 * 1_024;
const OIDC_HTTP_TIMEOUT_MILLISECONDS = 10_000;
const OIDC_CLOCK_SKEW_SECONDS = 60;
const OIDC_SUBJECT_PATTERN = /^[\x20-\x7e]{1,255}$/;
const OIDC_DIGEST_SEPARATOR = Buffer.from([0]);
const STATE_DIGEST_DOMAIN = Buffer.from("singularity.oidc-state.v1", "utf8");
const NONCE_DIGEST_DOMAIN = Buffer.from("singularity.oidc-nonce.v1", "utf8");
const BROWSER_BINDING_DIGEST_DOMAIN = Buffer.from(
  "singularity.oidc-browser-binding.v1",
  "utf8",
);
const INVALID_DIGEST = "0".repeat(64);
const consumedFlowErrors = new WeakSet<object>();

export const OIDC_FLOW_COOKIE_NAME = "__Host-singularity_oidc_flow";
export const OIDC_FLOW_COOKIE_OPTIONS = {
  httpOnly: true,
  path: "/",
  sameSite: "lax",
  secure: true,
} as const;

export function didConsumeOidcFlow(error: unknown): boolean {
  return (
    (typeof error === "object" && error !== null) ||
    typeof error === "function"
  ) && consumedFlowErrors.has(error);
}

function markOidcFlowConsumed(error: unknown): unknown {
  if (
    (typeof error === "object" && error !== null) ||
    typeof error === "function"
  ) {
    consumedFlowErrors.add(error);
    return error;
  }
  const wrapped = serviceUnavailable({ cause: error });
  consumedFlowErrors.add(wrapped);
  return wrapped;
}

interface OidcStartResult extends OidcStartResponse {
  flowToken: string;
}

export interface OidcProviderConfiguration {
  clientId: string;
  clientSecretReference: string | null;
  issuer: string;
  organizationId: string;
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
  assertConfigured(provider: OidcProviderConfiguration): void;
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
      currentTime: () => Date;
      redirectUri: string;
    },
  ): Promise<VerifiedOidcIdentity>;
}

export interface OidcClientSecretResolver {
  assertBound(provider: OidcProviderConfiguration): void;
  resolve(provider: OidcProviderConfiguration): Promise<string>;
}

export class FileOidcClientSecretResolver
  implements OidcClientSecretResolver
{
  readonly #bindings: ReadonlyMap<string, OidcClientSecretBinding>;

  constructor(bindings: readonly OidcClientSecretBinding[]) {
    this.#bindings = new Map(
      bindings.map((binding) => [binding.reference, binding]),
    );
  }

  /** 校验数据库提供商只能引用部署时绑定的组织、issuer 和 clientId，不允许运行时重绑定秘密。 */
  assertBound(provider: OidcProviderConfiguration): void {
    const reference = provider.clientSecretReference;
    if (reference === null) {
      return;
    }
    let issuer: string;
    try {
      issuer = new URL(provider.issuer).toString();
    } catch (error) {
      throw serviceUnavailable({ cause: error });
    }
    const binding = this.#bindings.get(reference);
    if (
      binding === undefined ||
      binding.organizationId !== provider.organizationId ||
      binding.issuer !== issuer ||
      binding.clientId !== provider.clientId
    ) {
      throw serviceUnavailable({
        cause: new Error("OIDC deployment secret binding is unavailable"),
      });
    }
  }

  /** 在已确认绑定关系后读取部署秘密文件；文件内容只留在本次 token 请求生命周期内。 */
  async resolve(provider: OidcProviderConfiguration): Promise<string> {
    this.assertBound(provider);
    const reference = provider.clientSecretReference;
    if (reference === null) {
      throw serviceUnavailable({
        cause: new Error("OIDC client secret reference is unavailable"),
      });
    }
    const binding = this.#bindings.get(reference);
    if (binding === undefined) {
      throw serviceUnavailable({
        cause: new Error("OIDC deployment secret binding is unavailable"),
      });
    }
    let value: string;
    try {
      value = await readFile(binding.secretFile, { encoding: "utf8" });
    } catch (error) {
      throw serviceUnavailable({ cause: error });
    }
    const secret = value.endsWith("\n")
      ? value.slice(0, value.endsWith("\r\n") ? -2 : -1)
      : value;
    if (secret.length === 0 || Buffer.byteLength(secret, "utf8") > 16_384) {
      throw serviceUnavailable({
        cause: new Error("OIDC client secret file is invalid"),
      });
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
    const bytes = Buffer.from(value, "base64url");
    if (bytes.toString("base64url") !== value) {
      throw new Error("OIDC ID token segment is not canonical base64url");
    }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (error) {
    throw unauthenticated({ cause: error });
  }
}

function stringProperty(
  value: Record<string, unknown>,
  key: string,
): string | null {
  const property = value[key];
  return typeof property === "string" ? property : null;
}

function formEncodeOAuthCredential(value: string): string {
  return new URLSearchParams({ value }).toString().slice("value=".length);
}

function keyAllowsVerification(value: Record<string, unknown>): boolean {
  return (
    value.key_ops === undefined ||
    (Array.isArray(value.key_ops) &&
      value.key_ops.every((operation) => typeof operation === "string") &&
      value.key_ops.includes("verify"))
  );
}

function rsaModulusHasAtLeast2048Bits(value: unknown): boolean {
  if (typeof value !== "string") {
    return false;
  }
  const bytes = Buffer.from(value, "base64url");
  if (bytes.length === 0 || bytes.toString("base64url") !== value) {
    return false;
  }
  const first = bytes[0];
  if (first === undefined || first === 0) {
    return false;
  }
  const bitLength = (bytes.length - 1) * 8 + (32 - Math.clz32(first));
  return bitLength >= 2_048;
}

function keyMatchesAlgorithm(
  value: Record<string, unknown>,
  algorithm: "ES256" | "RS256",
): boolean {
  if (!keyAllowsVerification(value)) {
    return false;
  }
  if (algorithm === "ES256") {
    return (
      value.kty === "EC" &&
      value.crv === "P-256" &&
      typeof value.x === "string" &&
      typeof value.y === "string"
    );
  }
  return (
    value.kty === "RSA" &&
    typeof value.e === "string" &&
    rsaModulusHasAtLeast2048Bits(value.n)
  );
}

function oidcUnavailable(reason: string): Error {
  return serviceUnavailable({ cause: new Error(reason) });
}

function oidcRejected(reason: string): Error {
  return unauthenticated({ cause: new Error(reason) });
}

function trustedEndpoint(issuer: URL, value: unknown): string {
  if (typeof value !== "string") {
    throw oidcUnavailable("OIDC discovery endpoint is missing");
  }
  let endpoint: URL;
  try {
    endpoint = new URL(value);
  } catch (error) {
    throw serviceUnavailable({ cause: error });
  }
  if (
    endpoint.protocol !== "https:" ||
    endpoint.origin !== issuer.origin ||
    endpoint.username.length > 0 ||
    endpoint.password.length > 0 ||
    endpoint.hash.length > 0
  ) {
    throw oidcUnavailable("OIDC discovery endpoint is not trusted");
  }
  return endpoint.toString();
}

function parseOidcJson(
  response: OidcHttpResponse,
  invalidResponse: (options?: ErrorOptions) => Error,
): unknown {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(response.body);
    return JSON.parse(text);
  } catch (error) {
    throw invalidResponse({ cause: error });
  }
}

export type { OidcHttpTransport } from "./oidc-http-transport.js";

@Injectable()
export class FetchOidcProviderClient implements OidcProviderClient {
  constructor(
    @Inject(OIDC_CLIENT_SECRET_RESOLVER)
    private readonly secrets: OidcClientSecretResolver,
    private readonly http: OidcHttpTransport = new SecureOidcHttpTransport(),
  ) {}

  /** 在任何发现或 token 外连前确认 provider 的客户端秘密绑定合同。 */
  assertConfigured(provider: OidcProviderConfiguration): void {
    this.secrets.assertBound(provider);
  }

  /** 通过受限 discovery 生成带 PKCE、nonce 和 state 的授权地址。 */
  async createAuthorizationUrl(
    provider: OidcProviderConfiguration,
    input: {
      codeChallenge: string;
      nonce: string;
      redirectUri: string;
      state: string;
    },
  ): Promise<string> {
    this.assertConfigured(provider);
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

  /** 交换授权码并完成 ID Token 的签名、issuer、audience、nonce 与时间校验。 */
  async exchangeAuthorizationCode(
    provider: OidcProviderConfiguration,
    input: {
      code: string;
      codeVerifier: string;
      currentTime: () => Date;
      redirectUri: string;
    },
  ): Promise<VerifiedOidcIdentity> {
    this.assertConfigured(provider);
    const discovery = await this.discover(provider.issuer);
    const body = new URLSearchParams({
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
      const secret = await this.secrets.resolve(provider);
      const clientId = formEncodeOAuthCredential(provider.clientId);
      const clientSecret = formEncodeOAuthCredential(secret);
      headers.Authorization = `Basic ${Buffer.from(`${clientId}:${clientSecret}`, "utf8").toString("base64")}`;
    } else {
      body.set("client_id", provider.clientId);
    }
    const response = await this.#request(discovery.tokenEndpoint, {
      body: body.toString(),
      headers,
      maximumBodyBytes: OIDC_TOKEN_MAXIMUM_BODY_BYTES,
      method: "POST",
    });
    if (response.status < 200 || response.status >= 300) {
      if (response.status === 400) {
        throw oidcRejected("OIDC token endpoint rejected the authorization code");
      }
      throw oidcUnavailable("OIDC token endpoint is unavailable");
    }
    const tokenPayload = parseOidcJson(response, unauthenticated);
    if (
      typeof tokenPayload !== "object" ||
      tokenPayload === null ||
      !("id_token" in tokenPayload) ||
      typeof tokenPayload.id_token !== "string"
    ) {
      throw oidcRejected("OIDC token response is missing an ID token");
    }
    return this.verifyIdToken(
      tokenPayload.id_token,
      provider,
      discovery,
      input.currentTime,
    );
  }

  /** 读取并校验同源 OIDC discovery 文档，所有后续端点必须保持 issuer origin。 */
  async discover(issuerValue: string): Promise<OidcDiscoveryDocument> {
    let issuer: URL;
    try {
      issuer = new URL(issuerValue);
    } catch (error) {
      throw serviceUnavailable({ cause: error });
    }
    const discoveryUrl = new URL(issuer.toString());
    discoveryUrl.pathname = `${discoveryUrl.pathname.replace(/\/$/, "")}/.well-known/openid-configuration`;
    const response = await this.#request(discoveryUrl, {
      headers: { Accept: "application/json" },
      maximumBodyBytes: OIDC_DISCOVERY_MAXIMUM_BODY_BYTES,
      method: "GET",
    });
    if (response.status < 200 || response.status >= 300) {
      throw oidcUnavailable("OIDC discovery endpoint is unavailable");
    }
    const document = parseOidcJson(response, serviceUnavailable);
    if (typeof document !== "object" || document === null) {
      throw oidcUnavailable("OIDC discovery response is invalid");
    }
    const record = document as Record<string, unknown>;
    if (record.issuer !== issuerValue) {
      throw oidcUnavailable("OIDC discovery issuer does not match configuration");
    }
    return {
      authorizationEndpoint: trustedEndpoint(issuer, record.authorization_endpoint),
      issuer: issuerValue,
      jwksUri: trustedEndpoint(issuer, record.jwks_uri),
      tokenEndpoint: trustedEndpoint(issuer, record.token_endpoint),
    };
  }

  /** 用匹配算法和 key material 验证 ID Token，并返回最小可信身份投影。 */
  async verifyIdToken(
    idToken: string,
    provider: OidcProviderConfiguration,
    discovery: OidcDiscoveryDocument,
    currentTime: () => Date,
  ): Promise<VerifiedOidcIdentity> {
    const segments = idToken.split(".");
    if (segments.length !== 3) {
      throw oidcRejected("OIDC ID token compact serialization is invalid");
    }
    const [headerSegment, payloadSegment, signatureSegment] = segments;
    if (
      headerSegment === undefined ||
      payloadSegment === undefined ||
      signatureSegment === undefined
    ) {
      throw oidcRejected("OIDC ID token compact serialization is incomplete");
    }
    const headerValue = decodeJsonSegment(headerSegment);
    const claimsValue = decodeJsonSegment(payloadSegment);
    if (
      typeof headerValue !== "object" ||
      headerValue === null ||
      typeof claimsValue !== "object" ||
      claimsValue === null
    ) {
      throw oidcRejected("OIDC ID token JSON is invalid");
    }
    const header = headerValue as Record<string, unknown>;
    const claims = claimsValue as Record<string, unknown>;
    const algorithm = stringProperty(header, "alg");
    const keyId = stringProperty(header, "kid");
    if (
      (algorithm !== "RS256" && algorithm !== "ES256") ||
      keyId === null ||
      Object.hasOwn(header, "crit") ||
      Object.hasOwn(header, "b64")
    ) {
      throw oidcRejected("OIDC ID token header is not supported");
    }
    const jwksResponse = await this.#request(discovery.jwksUri, {
      headers: { Accept: "application/json" },
      maximumBodyBytes: OIDC_JWKS_MAXIMUM_BODY_BYTES,
      method: "GET",
    });
    if (jwksResponse.status < 200 || jwksResponse.status >= 300) {
      throw oidcUnavailable("OIDC JWKS endpoint is unavailable");
    }
    const jwksValue = parseOidcJson(jwksResponse, serviceUnavailable);
    if (
      typeof jwksValue !== "object" ||
      jwksValue === null ||
      !("keys" in jwksValue) ||
      !Array.isArray(jwksValue.keys)
    ) {
      throw oidcUnavailable("OIDC JWKS response is invalid");
    }
    const matchingKeys = jwksValue.keys.filter(
      (candidate): candidate is Record<string, unknown> => {
        if (typeof candidate !== "object" || candidate === null) {
          return false;
        }
        const key = candidate as Record<string, unknown>;
        return (
          key.kid === keyId &&
          (key.alg === undefined || key.alg === algorithm) &&
          (key.use === undefined || key.use === "sig") &&
          keyMatchesAlgorithm(key, algorithm)
        );
      },
    );
    if (matchingKeys.length !== 1) {
      throw oidcRejected("OIDC signing key selection is ambiguous or invalid");
    }
    const jwk = matchingKeys[0];
    if (jwk === undefined) {
      throw oidcRejected("OIDC signing key is unavailable");
    }
    let publicKey: ReturnType<typeof createPublicKey>;
    try {
      publicKey = createPublicKey({ key: jwk as JsonWebKey, format: "jwk" });
    } catch (error) {
      throw serviceUnavailable({ cause: error });
    }
    const signingInput = Buffer.from(`${headerSegment}.${payloadSegment}`, "ascii");
    let validSignature: boolean;
    try {
      const signature = Buffer.from(signatureSegment, "base64url");
      if (signature.toString("base64url") !== signatureSegment) {
        throw new Error("OIDC ID token signature is not canonical base64url");
      }
      validSignature =
        algorithm === "ES256"
          ? verify(
              "sha256",
              signingInput,
              { dsaEncoding: "ieee-p1363", key: publicKey },
              signature,
            )
          : verify("sha256", signingInput, publicKey, signature);
    } catch (error) {
      throw unauthenticated({ cause: error });
    }
    if (!validSignature) {
      throw oidcRejected("OIDC ID token signature is invalid");
    }
    const issuer = stringProperty(claims, "iss");
    const subject = stringProperty(claims, "sub");
    const nonce = stringProperty(claims, "nonce");
    const audience = claims.aud;
    const authorizedParty = stringProperty(claims, "azp");
    const authorizedPartyIsInvalid =
      Object.hasOwn(claims, "azp") && authorizedParty === null;
    const expiration = claims.exp;
    const issuedAt = claims.iat;
    const notBefore = claims.nbf;
    const nowSeconds = Math.floor(currentTime().getTime() / 1_000);
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
      !OIDC_SUBJECT_PATTERN.test(subject) ||
      nonce === null ||
      authorizedPartyIsInvalid ||
      !audienceMatches ||
      typeof expiration !== "number" ||
      !Number.isFinite(expiration) ||
      expiration <= nowSeconds ||
      typeof issuedAt !== "number" ||
      !Number.isFinite(issuedAt) ||
      issuedAt > nowSeconds + OIDC_CLOCK_SKEW_SECONDS ||
      (Object.hasOwn(claims, "nbf") &&
        (typeof notBefore !== "number" ||
          !Number.isFinite(notBefore) ||
          notBefore > nowSeconds + OIDC_CLOCK_SKEW_SECONDS))
    ) {
      throw oidcRejected("OIDC ID token claims are invalid");
    }
    return {
      email: stringProperty(claims, "email"),
      emailVerified: claims.email_verified === true,
      nonce,
      subject,
    };
  }

  async #request(
    url: string | URL,
    input: {
      body?: string;
      headers: Readonly<Record<string, string>>;
      maximumBodyBytes: number;
      method: "GET" | "POST";
    },
  ): Promise<OidcHttpResponse> {
    try {
      return await this.http.request({
        ...input,
        timeoutMilliseconds: OIDC_HTTP_TIMEOUT_MILLISECONDS,
        url,
      });
    } catch (error) {
      throw serviceUnavailable({ cause: error });
    }
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
    private readonly startAdmission: OidcStartAdmission,
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

  /** 通过来源/provider 限流后创建一次性授权尝试，并返回浏览器授权地址。 */
  start(
    input: OidcStartRequest,
    context: { requestId: string; sourceAddress: string },
  ): Promise<OidcStartResult> {
    return this.startAdmission.run(
      {
        providerId: input.providerId,
        requestId: context.requestId,
        sourceAddress: context.sourceAddress,
      },
      () => this.#start(input),
    );
  }

  async #start(input: OidcStartRequest): Promise<OidcStartResult> {
    await this.#deleteExpiredAttempts(this.clock.now());
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
    this.providerClient.assertConfigured(provider);
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

  async #deleteExpiredAttempts(now: Date): Promise<void> {
    await this.database.client.$executeRaw(
      Prisma.sql`
        WITH expired AS (
          SELECT "id"
          FROM "oidc_authorization_attempts"
          WHERE "expires_at" <= ${now}
          ORDER BY "expires_at", "id"
          LIMIT 100
          FOR UPDATE SKIP LOCKED
        )
        DELETE FROM "oidc_authorization_attempts" AS attempt
        USING expired
        WHERE attempt."id" = expired."id"
      `,
    );
  }

  /** 原子消费授权尝试，再完成外部交换和本地 identity/session 事务。 */
  async callback(input: {
    code: string;
    currentTokenValue: string | undefined;
    flowTokenValue: string | undefined;
    requestId: string;
    state: string;
  }): Promise<LoginResult & { returnTo: string }> {
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
      const now = this.clock.now();
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
    try {
      const verified = await this.providerClient.exchangeAuthorizationCode(
        attempt.provider,
        {
          code: input.code,
          codeVerifier: attempt.codeVerifier,
          currentTime: () => this.clock.now(),
          redirectUri: `${this.configuration.publicOrigin}${AUTH_OIDC_CALLBACK_PATH}`,
        },
      );
      const actualNonceDigest = domainDigest(
        NONCE_DIGEST_DOMAIN,
        verified.nonce,
      );
      if (
        !timingSafeEqual(
          Buffer.from(actualNonceDigest, "hex"),
          Buffer.from(attempt.nonceDigest, "hex"),
        )
      ) {
        throw unauthenticated();
      }
      const userId = await this.database.client
        .$transaction(async (transaction) => {
          const identityReference = await transaction.oidcIdentity.findUnique({
            where: {
              providerId_subject: {
                providerId: attempt.providerId,
                subject: verified.subject,
              },
            },
            select: {
              organizationId: true,
              user: { select: { loginIdentifier: true } },
              userId: true,
            },
          });
          let currentUserId: string;
          let createIdentity = false;
          if (identityReference !== null) {
            if (identityReference.organizationId !== attempt.organizationId) {
              throw unauthenticated();
            }
            currentUserId = identityReference.userId;
            if (attempt.invitationId === null) {
              await transaction.$queryRaw(
                Prisma.sql`SELECT "id" FROM "organizations" WHERE "id" = ${attempt.organizationId} FOR SHARE`,
              );
              await transaction.$queryRaw(
                Prisma.sql`SELECT "id" FROM "users" WHERE "id" = ${currentUserId} FOR SHARE`,
              );
              await transaction.$queryRaw(
                Prisma.sql`
                  SELECT "id"
                  FROM "organization_memberships"
                  WHERE "organization_id" = ${attempt.organizationId}
                    AND "user_id" = ${currentUserId}
                  FOR SHARE
                `,
              );
            } else {
              const invitation =
                await transaction.organizationInvitation.findUnique({
                  where: { id: attempt.invitationId },
                  select: { loginIdentifier: true },
                });
              if (
                invitation?.loginIdentifier !==
                identityReference.user.loginIdentifier
              ) {
                throw unauthenticated();
              }
              await this.organizations.acceptOidcInvitationInTransaction(
                transaction,
                attempt.invitationId,
                attempt.organizationId,
                currentUserId,
                input.requestId,
              );
            }
          } else {
            if (
              attempt.invitationId === null ||
              !verified.emailVerified ||
              verified.email === null
            ) {
              throw unauthenticated();
            }
            const normalizedEmail = verified.email
              .trim()
              .normalize("NFKC")
              .toLowerCase();
            const invitation =
              await transaction.organizationInvitation.findUnique({
                where: { id: attempt.invitationId },
                select: { loginIdentifier: true },
              });
            if (invitation?.loginIdentifier !== normalizedEmail) {
              throw unauthenticated();
            }
            let user = await transaction.user.findUnique({
              where: { loginIdentifier: normalizedEmail },
              select: { id: true },
            });
            if (user === null) {
              user = await transaction.user.create({
                data: {
                  loginIdentifier: normalizedEmail,
                  passwordDigest: null,
                  status: "active",
                },
                select: { id: true },
              });
            }
            currentUserId = user.id;
            await this.organizations.acceptOidcInvitationInTransaction(
              transaction,
              attempt.invitationId,
              attempt.organizationId,
              currentUserId,
              input.requestId,
            );
            createIdentity = true;
          }

          await transaction.$queryRaw(
            Prisma.sql`
              SELECT "id"
              FROM "oidc_providers"
              WHERE "id" = ${attempt.providerId}
                AND "organization_id" = ${attempt.organizationId}
              FOR SHARE
            `,
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
          const currentUser = await transaction.user.findUnique({
            where: { id: currentUserId },
            select: { status: true },
          });
          const currentMembership =
            await transaction.organizationMembership.findUnique({
              where: {
                organizationId_userId: {
                  organizationId: attempt.organizationId,
                  userId: currentUserId,
                },
              },
              select: { status: true },
            });
          const currentIdentity = createIdentity
            ? null
            : await transaction.oidcIdentity.findUnique({
                where: {
                  providerId_subject: {
                    providerId: attempt.providerId,
                    subject: verified.subject,
                  },
                },
                select: { organizationId: true, userId: true },
              });
          if (
            currentProvider === null ||
            currentProvider.clientId !== attempt.provider.clientId ||
            currentProvider.clientSecretReference !==
              attempt.provider.clientSecretReference ||
            currentProvider.issuer !== attempt.provider.issuer ||
            currentUser?.status !== "active" ||
            currentMembership?.status !== "active" ||
            (!createIdentity &&
              (currentIdentity?.organizationId !== attempt.organizationId ||
                currentIdentity.userId !== currentUserId))
          ) {
            throw unauthenticated();
          }
          if (createIdentity) {
            await transaction.oidcIdentity.create({
              data: {
                providerId: attempt.providerId,
                organizationId: attempt.organizationId,
                subject: verified.subject,
                userId: currentUserId,
              },
            });
          }
          return currentUserId;
        })
        .catch((error: unknown) => {
          if (
            error instanceof Prisma.PrismaClientKnownRequestError &&
            error.code === "P2002"
          ) {
            throw conflict({ cause: error });
          }
          throw error;
        });
      const session = await this.identity.issueSessionForUser({
        currentTokenValue: input.currentTokenValue,
        requestId: input.requestId,
        userId,
      });
      return { ...session, returnTo: attempt.returnTo };
    } catch (error) {
      throw markOidcFlowConsumed(error);
    }
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
        this.providerClient.assertConfigured({
          clientId: input.clientId,
          clientSecretReference: input.clientSecretReference ?? null,
          issuer: input.issuer,
          organizationId,
        });
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
        throw conflict({ cause: error });
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
    try {
      return await this.database.client.$transaction(async (transaction) => {
        await this.organizations.requireManagerInTransaction(
          transaction,
          actorUserId,
          organizationId,
          true,
        );
        const existing = await transaction.oidcProvider.findFirst({
          where: { id: providerId, organizationId },
          select: {
            clientId: true,
            clientSecretReference: true,
            id: true,
            issuer: true,
          },
        });
        if (existing === null) {
          throw notFound();
        }
        this.providerClient.assertConfigured({
          clientId: input.clientId ?? existing.clientId,
          clientSecretReference:
            input.clientSecretReference === undefined
              ? existing.clientSecretReference
              : input.clientSecretReference,
          issuer: input.issuer ?? existing.issuer,
          organizationId,
        });
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
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2002"
      ) {
        throw conflict({ cause: error });
      }
      throw error;
    }
  }
}
