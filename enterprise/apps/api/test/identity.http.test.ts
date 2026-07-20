import {
  createHash,
  generateKeyPairSync,
  randomUUID,
  sign,
  type KeyObject,
} from "node:crypto";

import {
  AUTH_CSRF_PATH,
  AUTH_INVITATION_ACCEPT_LOCAL_PATH,
  AUTH_LOGIN_PATH,
  AUTH_LOGOUT_PATH,
  AUTH_OIDC_CALLBACK_PATH,
  AUTH_OIDC_PROVIDERS_PATH,
  AUTH_OIDC_START_PATH,
  AUTH_SESSION_COOKIE_NAME,
  CSRF_HEADER_NAME,
  ORGANIZATION_OIDC_PROVIDERS_PATH_TEMPLATE,
  ORGANIZATION_OIDC_PROVIDER_PATH_TEMPLATE,
  type ApiProblemCode,
  apiProblemSchema,
  csrfTokenSchema,
  managedOidcProviderSchema,
  managedOidcProvidersResponseSchema,
  oidcProvidersResponseSchema,
  oidcStartResponseSchema,
  sessionTokenSchema,
} from "@singularity/contracts";
import {
  DatabaseRuntime,
  Prisma,
  type DatabaseClient,
} from "@singularity/database";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from "vitest";

import type { Clock } from "../src/identity/clock.js";
import { PasswordHasher } from "../src/identity/password-hasher.js";
import { sessionTokenFromValue } from "../src/identity/session-crypto.js";
import { AccessOperationsService } from "../src/operations/access-operations.service.js";
import { OrganizationManagementService } from "../src/organizations/organization-management.service.js";
import { CapturingLogger } from "./support/capturing-logger.js";
import { truncateTestDatabase } from "./support/database.js";
import {
  startTestApiApplication,
  TEST_PUBLIC_ORIGIN,
  type TestApiApplication,
} from "./support/test-app.js";

const password = "correct horse battery staple";
const initialTime = new Date("2026-07-15T00:00:00.000Z");
const oidcClientId = "singularity-enterprise";
const oidcFlowCookieName = "__Host-singularity_oidc_flow";
const oidcKeyId = "singularity-http-contract-key";
const trustedOidcKey = generateKeyPairSync("ec", { namedCurve: "P-256" });
const forgedOidcKey = generateKeyPairSync("ec", { namedCurve: "P-256" });

type OidcIdTokenMode = "valid" | "forged-signature" | "wrong-nonce";
type OidcJwksMode = "available" | "malformed" | "unavailable";

interface OidcTokenExchange {
  authorization: string | null;
  body: URLSearchParams;
}

interface ConfiguredOidcIdToken {
  mode: OidcIdTokenMode;
  nonce: string;
  subject: string;
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    headers: { "Content-Type": "application/json" },
    status,
  });
}

function fetchInputUrl(input: string | URL | Request): string {
  if (typeof input === "string") {
    return input;
  }
  return input instanceof URL ? input.toString() : input.url;
}

function signedIdToken(
  privateKey: KeyObject,
  claims: Readonly<Record<string, unknown>>,
): string {
  const header = Buffer.from(
    JSON.stringify({ alg: "ES256", kid: oidcKeyId, typ: "JWT" }),
    "utf8",
  ).toString("base64url");
  const payload = Buffer.from(JSON.stringify(claims), "utf8").toString(
    "base64url",
  );
  const signingInput = Buffer.from(`${header}.${payload}`, "ascii");
  const signature = sign("sha256", signingInput, {
    dsaEncoding: "ieee-p1363",
    key: privateKey,
  }).toString("base64url");
  return `${header}.${payload}.${signature}`;
}

class OidcProviderBoundary {
  readonly issuer = `https://identity.example.test/${randomUUID()}`;
  readonly authorizationEndpoint = `${this.issuer}/authorize`;
  readonly tokenEndpoint = `${this.issuer}/token`;
  readonly jwksUri = `${this.issuer}/jwks`;
  readonly tokenExchanges: OidcTokenExchange[] = [];
  jwksRequests = 0;

  #discoveryMalformed = false;
  #idToken: ConfiguredOidcIdToken | undefined;
  readonly #idTokensByAuthorizationCode = new Map<
    string,
    ConfiguredOidcIdToken
  >();
  #jwksMode: OidcJwksMode = "available";

  constructor(private readonly now: () => Date) {}

  configureIdToken(input: {
    code?: string;
    mode?: OidcIdTokenMode;
    nonce: string;
    subject: string;
  }): void {
    const configured: ConfiguredOidcIdToken = {
      mode: input.mode ?? "valid",
      nonce: input.nonce,
      subject: input.subject,
    };
    if (input.code === undefined) {
      this.#idToken = configured;
    } else {
      this.#idTokensByAuthorizationCode.set(input.code, configured);
    }
  }

  makeJwksUnavailable(): void {
    this.#jwksMode = "unavailable";
  }

  makeJwksMalformed(): void {
    this.#jwksMode = "malformed";
  }

  makeDiscoveryMalformed(): void {
    this.#discoveryMalformed = true;
  }

  install(): void {
    const nativeFetch = globalThis.fetch.bind(globalThis);
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = fetchInputUrl(input);
      if (!url.startsWith(`${this.issuer}/`)) {
        return nativeFetch(input, init);
      }
      if (url === `${this.issuer}/.well-known/openid-configuration`) {
        if (this.#discoveryMalformed) {
          return new Response("{", {
            headers: { "Content-Type": "application/json" },
          });
        }
        return jsonResponse({
          authorization_endpoint: this.authorizationEndpoint,
          issuer: this.issuer,
          jwks_uri: this.jwksUri,
          token_endpoint: this.tokenEndpoint,
        });
      }
      if (url === this.tokenEndpoint) {
        const request = new Request(input, init);
        const body = new URLSearchParams(await request.text());
        const authorizationCode = body.get("code");
        const idToken =
          (authorizationCode === null
            ? undefined
            : this.#idTokensByAuthorizationCode.get(authorizationCode)) ??
          this.#idToken;
        if (idToken === undefined) {
          throw new Error("The external OIDC identity was not configured");
        }
        this.tokenExchanges.push({
          authorization: request.headers.get("authorization"),
          body,
        });
        const nowSeconds = Math.floor(this.now().getTime() / 1_000);
        const nonce =
          idToken.mode === "wrong-nonce"
            ? Buffer.alloc(32, 0xa5).toString("base64url")
            : idToken.nonce;
        const signingKey =
          idToken.mode === "forged-signature"
            ? forgedOidcKey.privateKey
            : trustedOidcKey.privateKey;
        return jsonResponse({
          id_token: signedIdToken(signingKey, {
            aud: oidcClientId,
            email: `oidc-${idToken.subject}@example.test`,
            email_verified: true,
            exp: nowSeconds + 5 * 60,
            iat: nowSeconds,
            iss: this.issuer,
            nonce,
            sub: idToken.subject,
          }),
        });
      }
      if (url === this.jwksUri) {
        this.jwksRequests += 1;
        if (this.#jwksMode === "unavailable") {
          return jsonResponse({ code: "jwks-unavailable" }, 503);
        }
        if (this.#jwksMode === "malformed") {
          return new Response("{", {
            headers: { "Content-Type": "application/json" },
          });
        }
        return jsonResponse({
          keys: [
            {
              ...trustedOidcKey.publicKey.export({ format: "jwk" }),
              alg: "ES256",
              kid: oidcKeyId,
              use: "sig",
            },
          ],
        });
      }
      return jsonResponse({ code: "not-found" }, 404);
    });
  }
}

class MutableClock implements Clock {
  #milliseconds: number;

  constructor(value: Date) {
    this.#milliseconds = value.getTime();
  }

  now(): Date {
    return new Date(this.#milliseconds);
  }

  set(value: Date): void {
    this.#milliseconds = value.getTime();
  }
}

async function expectProblem(
  response: Response,
  status: number,
  code: ApiProblemCode,
): Promise<void> {
  expect(response.status).toBe(status);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(apiProblemSchema.parse(await response.json())).toMatchObject({
    code,
    status,
  });
}

function requireSetCookie(response: Response): string {
  const setCookie = response.headers.get("set-cookie");
  if (setCookie === null) {
    throw new Error("The HTTP response did not set a session cookie");
  }
  return setCookie;
}

function requireNamedSetCookie(response: Response, name: string): string {
  const setCookie = response.headers
    .getSetCookie()
    .find((value) => value.startsWith(`${name}=`));
  if (setCookie === undefined) {
    throw new Error(`The HTTP response did not set the ${name} cookie`);
  }
  return setCookie;
}

function cookiePair(setCookie: string): string {
  const pair = setCookie.split(";", 1)[0];
  if (pair === undefined) {
    throw new Error("The Set-Cookie header is malformed");
  }
  return pair;
}

function cookieValue(pair: string): string {
  const prefix = `${AUTH_SESSION_COOKIE_NAME}=`;
  if (!pair.startsWith(prefix)) {
    throw new Error("The session cookie has an unexpected name");
  }
  return pair.slice(prefix.length);
}

function expectProductionCookieAttributes(setCookie: string): void {
  expect(setCookie).toContain(`${AUTH_SESSION_COOKIE_NAME}=`);
  expect(setCookie).toContain("Path=/");
  expect(setCookie).toContain("HttpOnly");
  expect(setCookie).toContain("Secure");
  expect(setCookie).toContain("SameSite=Lax");
  expect(setCookie).not.toMatch(/(?:^|;)\s*Domain=/i);
}

function expectOidcFlowCookieAttributes(setCookie: string): void {
  expect(setCookie).toContain(`${oidcFlowCookieName}=`);
  expect(setCookie).toContain("Path=/");
  expect(setCookie).toContain("HttpOnly");
  expect(setCookie).toContain("Secure");
  expect(setCookie).toContain("SameSite=Lax");
  expect(setCookie).not.toMatch(/(?:^|;)\s*Domain=/i);
}

function requireSearchParameter(url: URL, name: string): string {
  const value = url.searchParams.get(name);
  if (value === null) {
    throw new Error(`The OIDC authorization URL is missing ${name}`);
  }
  return value;
}

function loginRequest(
  baseUrl: string,
  input: { loginIdentifier: string; password: string },
  options: { cookie?: string; forwardedFor?: string; origin?: string } = {},
): Promise<Response> {
  const headers = new Headers({ "Content-Type": "application/json" });
  if (options.cookie !== undefined) {
    headers.set("Cookie", options.cookie);
  }
  if (options.origin !== undefined) {
    headers.set("Origin", options.origin);
  }
  if (options.forwardedFor !== undefined) {
    headers.set("X-Forwarded-For", options.forwardedFor);
  }
  return fetch(`${baseUrl}${AUTH_LOGIN_PATH}`, {
    body: JSON.stringify(input),
    headers,
    method: "POST",
  });
}

function csrfRequest(baseUrl: string, cookie: string): Promise<Response> {
  return fetch(`${baseUrl}${AUTH_CSRF_PATH}`, {
    headers: { Cookie: cookie },
  });
}

function acceptLocalInvitationRequest(
  baseUrl: string,
  input: { invitationToken: string; password: string },
): Promise<Response> {
  return fetch(`${baseUrl}${AUTH_INVITATION_ACCEPT_LOCAL_PATH}`, {
    body: JSON.stringify(input),
    headers: {
      "Content-Type": "application/json",
      Origin: TEST_PUBLIC_ORIGIN,
    },
    method: "POST",
  });
}

function oidcStartRequest(
  baseUrl: string,
  input: { invitationToken?: string; providerId: string; returnTo?: string },
): Promise<Response> {
  return fetch(`${baseUrl}${AUTH_OIDC_START_PATH}`, {
    body: JSON.stringify(input),
    headers: {
      "Content-Type": "application/json",
      Origin: TEST_PUBLIC_ORIGIN,
    },
    method: "POST",
  });
}

function oidcCallbackRequest(
  baseUrl: string,
  input: {
    code: string;
    cookie: string;
    extra?: Record<string, string>;
    state: string;
  },
): Promise<Response> {
  const callback = new URL(AUTH_OIDC_CALLBACK_PATH, baseUrl);
  callback.search = new URLSearchParams({
    code: input.code,
    ...input.extra,
    state: input.state,
  }).toString();
  return fetch(callback, {
    headers: { Cookie: input.cookie },
    redirect: "manual",
  });
}

async function holdUserRowLock(
  database: DatabaseClient,
  userId: string,
): Promise<{ completed: Promise<void>; lockerPid: number; release(): void }> {
  let resolveLocked!: (pid: number) => void;
  let rejectLocked!: (reason?: unknown) => void;
  const locked = new Promise<number>((resolve, reject) => {
    resolveLocked = resolve;
    rejectLocked = reject;
  });
  let resolveRelease!: () => void;
  const released = new Promise<void>((resolve) => {
    resolveRelease = resolve;
  });
  let didRelease = false;
  const release = (): void => {
    if (!didRelease) {
      didRelease = true;
      resolveRelease();
    }
  };
  const completed = database.$transaction(
    async (transaction) => {
      const rows = await transaction.$queryRaw<Array<{ pid: number }>>(
        Prisma.sql`
          SELECT pg_backend_pid() AS "pid"
          FROM "users"
          WHERE "id" = ${userId}
          FOR UPDATE
        `,
      );
      const backend = rows[0];
      if (backend === undefined) {
        throw new Error("The session user row lock target does not exist");
      }
      resolveLocked(backend.pid);
      await released;
    },
    { maxWait: 2_000, timeout: 10_000 },
  );
  void completed.catch(rejectLocked);
  try {
    return { completed, lockerPid: await locked, release };
  } catch (error) {
    release();
    await Promise.allSettled([completed]);
    throw error;
  }
}

async function waitForUserLockWaiter(
  database: DatabaseClient,
  lockerPid: number,
): Promise<void> {
  const deadline = Date.now() + 3_000;
  for (;;) {
    const rows = await database.$queryRaw<Array<{ pid: number }>>(
      Prisma.sql`
        SELECT activity.pid AS "pid"
        FROM pg_stat_activity AS activity
        WHERE ${lockerPid} = ANY(pg_blocking_pids(activity.pid))
          AND activity.wait_event_type = 'Lock'
      `,
    );
    if (rows.length > 0) {
      return;
    }
    if (Date.now() >= deadline) {
      throw new Error("The session renewal did not wait for the user row lock");
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

describe("identity HTTP contract with PostgreSQL", () => {
  let database: DatabaseClient;
  let passwordDigest: string;
  let testApi: TestApiApplication;
  let clock: MutableClock;
  let logger: CapturingLogger;

  beforeAll(async () => {
    passwordDigest = await new PasswordHasher().hashPassword(password);
  });

  beforeEach(async () => {
    clock = new MutableClock(initialTime);
    logger = new CapturingLogger();
    testApi = await startTestApiApplication({ clock, logger });
    database = testApi.app.get(DatabaseRuntime).client;
  });

  afterEach(async () => {
    try {
      await truncateTestDatabase(database);
    } finally {
      try {
        await testApi.dispose();
      } finally {
        vi.restoreAllMocks();
        vi.useRealTimers();
      }
    }
  });

  async function createUser(loginIdentifier: string): Promise<string> {
    const user = await database.user.create({
      data: { loginIdentifier, passwordDigest, status: "active" },
      select: { id: true },
    });
    return user.id;
  }

  async function createOidcIdentityGraph(
    providerBoundary: OidcProviderBoundary,
  ): Promise<{
    organizationId: string;
    providerId: string;
    subject: string;
    userId: string;
  }> {
    const organizationId = randomUUID();
    const subject = randomUUID();
    const userId = await createUser(
      `oidc-existing-${randomUUID()}@example.test`,
    );
    await database.organization.create({
      data: {
        id: organizationId,
        name: "OIDC HTTP contract",
        status: "active",
      },
    });
    await database.organizationMembership.create({
      data: {
        organizationId,
        role: "member",
        status: "active",
        userId,
      },
    });
    const provider = await database.oidcProvider.create({
      data: {
        clientId: oidcClientId,
        issuer: providerBoundary.issuer,
        name: "Enterprise identity",
        organizationId,
        status: "active",
      },
      select: { id: true },
    });
    await database.oidcIdentity.create({
      data: {
        organizationId,
        providerId: provider.id,
        subject,
        userId,
      },
    });
    return {
      organizationId,
      providerId: provider.id,
      subject,
      userId,
    };
  }

  async function restartApplication(trustedProxyCidrs?: string): Promise<void> {
    await testApi.dispose();
    logger = new CapturingLogger();
    testApi = await startTestApiApplication({
      clock,
      logger,
      ...(trustedProxyCidrs === undefined ? {} : { trustedProxyCidrs }),
    });
    database = testApi.app.get(DatabaseRuntime).client;
  }

  test("rotates only the presented session and enforces Origin, Cookie, and CSRF", async () => {
    const loginIdentifier = `identity-${randomUUID()}@example.test`;
    const userId = await createUser(loginIdentifier);
    for (const origin of [undefined, "https://attacker.invalid"] as const) {
      const rejected = await loginRequest(
        testApi.baseUrl,
        { loginIdentifier, password },
        origin === undefined ? {} : { origin },
      );
      await expectProblem(rejected, 403, "forbidden");
      expect(rejected.headers.get("access-control-allow-origin")).toBeNull();
      expect(rejected.headers.get("set-cookie")).toBeNull();
    }

    const firstLogin = await loginRequest(
      testApi.baseUrl,
      { loginIdentifier: `  ${loginIdentifier.toUpperCase()}  `, password },
      { origin: TEST_PUBLIC_ORIGIN },
    );
    expect(firstLogin.status).toBe(200);
    expect(firstLogin.headers.get("cache-control")).toBe("no-store");
    expect(firstLogin.headers.get("access-control-allow-origin")).toBeNull();
    const firstSetCookie = requireSetCookie(firstLogin);
    expectProductionCookieAttributes(firstSetCookie);
    const firstCookie = cookiePair(firstSetCookie);
    expect(sessionTokenSchema.parse(cookieValue(firstCookie))).toHaveLength(43);
    const firstBody = (await firstLogin.json()) as { csrfToken: string };
    expect(csrfTokenSchema.parse(firstBody.csrfToken)).toHaveLength(43);

    const secondLogin = await loginRequest(
      testApi.baseUrl,
      { loginIdentifier, password },
      { origin: TEST_PUBLIC_ORIGIN },
    );
    expect(secondLogin.status).toBe(200);
    const secondCookie = cookiePair(requireSetCookie(secondLogin));
    const secondBody = (await secondLogin.json()) as { csrfToken: string };
    expect(secondCookie).not.toBe(firstCookie);
    expect(secondBody.csrfToken).not.toBe(firstBody.csrfToken);
    const firstStillActive = await csrfRequest(testApi.baseUrl, firstCookie);
    expect(firstStillActive.status).toBe(200);
    await expect(firstStillActive.json()).resolves.toEqual(firstBody);

    const rotatingLogin = await loginRequest(
      testApi.baseUrl,
      { loginIdentifier, password },
      { cookie: firstCookie, origin: TEST_PUBLIC_ORIGIN },
    );
    expect(rotatingLogin.status).toBe(200);
    const rotatedCookie = cookiePair(requireSetCookie(rotatingLogin));
    const rotatedBody = (await rotatingLogin.json()) as { csrfToken: string };
    expect(rotatedCookie).not.toBe(firstCookie);
    expect(rotatedCookie).not.toBe(secondCookie);

    const rotatedToken = sessionTokenFromValue(cookieValue(rotatedCookie));
    if (rotatedToken === undefined) {
      throw new Error("The rotated session token was not canonical");
    }
    const beforeRejectedRequests = await database.authSession.findUniqueOrThrow({
      where: { tokenDigest: rotatedToken.tokenDigest },
    });
    clock.set(new Date(initialTime.getTime() + 10 * 60 * 1_000));

    const rotatedAway = await csrfRequest(testApi.baseUrl, firstCookie);
    await expectProblem(rotatedAway, 401, "unauthenticated");
    expectProductionCookieAttributes(requireSetCookie(rotatedAway));
    const otherDevice = await csrfRequest(testApi.baseUrl, secondCookie);
    expect(otherDevice.status).toBe(200);
    await expect(otherDevice.json()).resolves.toEqual(secondBody);

    const wrongOriginLogout = await fetch(
      `${testApi.baseUrl}${AUTH_LOGOUT_PATH}`,
      {
        headers: {
          Cookie: rotatedCookie,
          Origin: "https://attacker.invalid",
          [CSRF_HEADER_NAME]: rotatedBody.csrfToken,
        },
        method: "POST",
      },
    );
    await expectProblem(wrongOriginLogout, 403, "forbidden");
    const missingCsrfLogout = await fetch(
      `${testApi.baseUrl}${AUTH_LOGOUT_PATH}`,
      {
        headers: { Cookie: rotatedCookie, Origin: TEST_PUBLIC_ORIGIN },
        method: "POST",
      },
    );
    await expectProblem(missingCsrfLogout, 403, "forbidden");
    const malformedCsrfLogout = await fetch(
      `${testApi.baseUrl}${AUTH_LOGOUT_PATH}`,
      {
        headers: {
          Cookie: rotatedCookie,
          Origin: TEST_PUBLIC_ORIGIN,
          [CSRF_HEADER_NAME]: "not-a-canonical-csrf-token".repeat(32),
        },
        method: "POST",
      },
    );
    await expectProblem(malformedCsrfLogout, 403, "forbidden");
    const afterRejectedRequests = await database.authSession.findUniqueOrThrow({
      where: { tokenDigest: rotatedToken.tokenDigest },
    });
    expect(afterRejectedRequests.idleExpiresAt).toEqual(
      beforeRejectedRequests.idleExpiresAt,
    );
    expect((await csrfRequest(testApi.baseUrl, rotatedCookie)).status).toBe(200);

    const logout = await fetch(`${testApi.baseUrl}${AUTH_LOGOUT_PATH}`, {
      headers: {
        Cookie: rotatedCookie,
        Origin: TEST_PUBLIC_ORIGIN,
        [CSRF_HEADER_NAME]: rotatedBody.csrfToken,
      },
      method: "POST",
    });
    expect(logout.status).toBe(204);
    expect(logout.headers.get("cache-control")).toBe("no-store");
    expectProductionCookieAttributes(requireSetCookie(logout));
    const loggedOut = await csrfRequest(testApi.baseUrl, rotatedCookie);
    await expectProblem(loggedOut, 401, "unauthenticated");
    expect((await csrfRequest(testApi.baseUrl, secondCookie)).status).toBe(200);
    expect(
      await database.authSession.count({
        where: { userId, revokedAt: { not: null } },
      }),
    ).toBe(2);
    expect(
      await database.authSession.count({ where: { userId, revokedAt: null } }),
    ).toBe(1);
    expect(logger.output).toContain("auth.session");
    expect(logger.output).toContain("csrf-rejected");
    expect(logger.output).toContain("revoked");
    expect(logger.output).not.toContain(password);
    expect(logger.output).not.toContain(loginIdentifier);
    expect(logger.output).not.toContain(cookieValue(rotatedCookie));
  });

  test("rejects a canonical CSRF token from another session without renewal or revocation", async () => {
    const loginIdentifier = `cross-session-csrf-${randomUUID()}@example.test`;
    const userId = await createUser(loginIdentifier);
    const firstLogin = await loginRequest(
      testApi.baseUrl,
      { loginIdentifier, password },
      { origin: TEST_PUBLIC_ORIGIN },
    );
    const firstCookie = cookiePair(requireSetCookie(firstLogin));
    const firstToken = sessionTokenFromValue(cookieValue(firstCookie));
    if (firstToken === undefined) {
      throw new Error("The first session token was not canonical");
    }
    const secondLogin = await loginRequest(
      testApi.baseUrl,
      { loginIdentifier, password },
      { origin: TEST_PUBLIC_ORIGIN },
    );
    const secondBody = (await secondLogin.json()) as { csrfToken: string };
    const before = await database.authSession.findUniqueOrThrow({
      where: { tokenDigest: firstToken.tokenDigest },
    });
    clock.set(new Date(initialTime.getTime() + 10 * 60 * 1_000));

    const response = await fetch(`${testApi.baseUrl}${AUTH_LOGOUT_PATH}`, {
      headers: {
        Cookie: firstCookie,
        Origin: TEST_PUBLIC_ORIGIN,
        [CSRF_HEADER_NAME]: secondBody.csrfToken,
      },
      method: "POST",
    });

    await expectProblem(response, 403, "forbidden");
    expect(response.headers.get("set-cookie")).toBeNull();
    const after = await database.authSession.findUniqueOrThrow({
      where: { id: before.id },
    });
    expect(after.idleExpiresAt).toEqual(before.idleExpiresAt);
    expect(after.revokedAt).toBeNull();
    expect(
      await database.authSession.count({ where: { userId, revokedAt: null } }),
    ).toBe(2);
  });

  test("returns one unauthenticated problem for unknown, incorrect, disabled, and malformed credentials", async () => {
    const loginIdentifier = `rejected-${randomUUID()}@example.test`;
    const userId = await createUser(loginIdentifier);
    const rejectedLogins = [
      { loginIdentifier: `unknown-${randomUUID()}@example.test`, password },
      { loginIdentifier, password: "incorrect password value" },
    ];
    for (const input of rejectedLogins) {
      const response = await loginRequest(testApi.baseUrl, input, {
        origin: TEST_PUBLIC_ORIGIN,
      });
      await expectProblem(response, 401, "unauthenticated");
      expect(response.headers.get("set-cookie")).toBeNull();
    }

    await database.user.update({
      where: { id: userId },
      data: { status: "disabled" },
    });
    const disabled = await loginRequest(
      testApi.baseUrl,
      { loginIdentifier, password },
      { origin: TEST_PUBLIC_ORIGIN },
    );
    await expectProblem(disabled, 401, "unauthenticated");
    expect(disabled.headers.get("set-cookie")).toBeNull();

    const malformedCookie = await csrfRequest(
      testApi.baseUrl,
      `${AUTH_SESSION_COOKIE_NAME}=not-a-canonical-session-token`,
    );
    await expectProblem(malformedCookie, 401, "unauthenticated");
    expectProductionCookieAttributes(requireSetCookie(malformedCookie));
  });

  test("returns rate-limited when the real KDF admission queue is full", async () => {
    await testApi.app.get(PasswordHasher).verifyDummy(password);
    const responses = await Promise.all(
      Array.from({ length: 30 }, (_, index) =>
        loginRequest(
          testApi.baseUrl,
          {
            loginIdentifier: `kdf-${String(index)}-${randomUUID()}@example.test`,
            password,
          },
          { origin: TEST_PUBLIC_ORIGIN },
        ),
      ),
    );
    expect(
      responses.every(
        (response) => response.status === 401 || response.status === 429,
      ),
    ).toBe(true);
    const rateLimited = responses.find((response) => response.status === 429);
    if (rateLimited === undefined) {
      throw new Error("The KDF admission request was not rate limited");
    }
    expect(Number(rateLimited.headers.get("retry-after"))).toBeGreaterThanOrEqual(
      1,
    );
    await expectProblem(rateLimited, 429, "rate-limited");
    expect(logger.output).toContain("auth.rate-limit");
    expect(logger.output).toContain("kdf");
  });

  test("rate limits one normalized account and recovers after the fixed window", async () => {
    const loginIdentifier = `limited-${randomUUID()}@example.test`;
    await createUser(loginIdentifier);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(initialTime);
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const response = await loginRequest(
        testApi.baseUrl,
        {
          loginIdentifier:
            attempt % 2 === 0
              ? loginIdentifier.toUpperCase()
              : `  ${loginIdentifier}  `,
          password: "incorrect password value",
        },
        { origin: TEST_PUBLIC_ORIGIN },
      );
      await expectProblem(response, 401, "unauthenticated");
    }

    const rateLimited = await loginRequest(
      testApi.baseUrl,
      { loginIdentifier, password },
      { origin: TEST_PUBLIC_ORIGIN },
    );
    expect(Number(rateLimited.headers.get("retry-after"))).toBeGreaterThanOrEqual(
      1,
    );
    await expectProblem(rateLimited, 429, "rate-limited");
    expect(logger.output).toContain("account");

    vi.setSystemTime(new Date(initialTime.getTime() + 15 * 60 * 1_000 + 1));
    const recovered = await loginRequest(
      testApi.baseUrl,
      { loginIdentifier, password },
      { origin: TEST_PUBLIC_ORIGIN },
    );
    expect(recovered.status).toBe(200);
  });

  test("ignores forged forwarding headers and applies one direct source bucket", async () => {
    const realLoginIdentifier = `real-source-${randomUUID()}@example.test`;
    await createUser(realLoginIdentifier);
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const response = await loginRequest(
        testApi.baseUrl,
        {
          loginIdentifier: `direct-${String(attempt)}-${randomUUID()}@example.test`,
          password,
        },
        {
          forwardedFor: `198.51.100.${String((attempt % 200) + 1)}`,
          origin: TEST_PUBLIC_ORIGIN,
        },
      );
      await expectProblem(response, 401, "unauthenticated");
    }

    const realAccount = await loginRequest(
      testApi.baseUrl,
      { loginIdentifier: realLoginIdentifier, password },
      { forwardedFor: "203.0.113.10", origin: TEST_PUBLIC_ORIGIN },
    );
    const unknownAccount = await loginRequest(
      testApi.baseUrl,
      {
        loginIdentifier: `unknown-source-${randomUUID()}@example.test`,
        password,
      },
      { forwardedFor: "203.0.113.11", origin: TEST_PUBLIC_ORIGIN },
    );
    const realProblem = apiProblemSchema.parse(await realAccount.json());
    const unknownProblem = apiProblemSchema.parse(await unknownAccount.json());
    expect(realAccount.status).toBe(429);
    expect(unknownAccount.status).toBe(429);
    expect({ code: realProblem.code, status: realProblem.status }).toEqual({
      code: unknownProblem.code,
      status: unknownProblem.status,
    });
    expect(Number(realAccount.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
    expect(Number(unknownAccount.headers.get("retry-after"))).toBeGreaterThanOrEqual(
      1,
    );
    expect(logger.output).toContain("source");
    expect(logger.output).not.toContain(realLoginIdentifier);
    expect(logger.output).not.toContain("203.0.113.10");
  });

  test("isolates source buckets behind an explicitly trusted proxy", async () => {
    await restartApplication("127.0.0.1");
    const firstClient = "198.51.100.21";
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const response = await loginRequest(
        testApi.baseUrl,
        {
          loginIdentifier: `proxied-${String(attempt)}-${randomUUID()}@example.test`,
          password,
        },
        { forwardedFor: firstClient, origin: TEST_PUBLIC_ORIGIN },
      );
      await expectProblem(response, 401, "unauthenticated");
    }

    const exhausted = await loginRequest(
      testApi.baseUrl,
      {
        loginIdentifier: `proxied-exhausted-${randomUUID()}@example.test`,
        password,
      },
      { forwardedFor: firstClient, origin: TEST_PUBLIC_ORIGIN },
    );
    await expectProblem(exhausted, 429, "rate-limited");

    const independent = await loginRequest(
      testApi.baseUrl,
      {
        loginIdentifier: `proxied-independent-${randomUUID()}@example.test`,
        password,
      },
      { forwardedFor: "198.51.100.22", origin: TEST_PUBLIC_ORIGIN },
    );
    await expectProblem(independent, 401, "unauthenticated");
    expect(logger.output).toContain("source");
    expect(logger.output).not.toContain(firstClient);
  });

  test("renews idle expiry atomically and rejects the exact expiry boundary", async () => {
    const loginIdentifier = `idle-${randomUUID()}@example.test`;
    const userId = await createUser(loginIdentifier);
    const login = await loginRequest(
      testApi.baseUrl,
      { loginIdentifier, password },
      { origin: TEST_PUBLIC_ORIGIN },
    );
    const cookie = cookiePair(requireSetCookie(login));

    clock.set(new Date(initialTime.getTime() + 29 * 60 * 1_000));
    expect((await csrfRequest(testApi.baseUrl, cookie)).status).toBe(200);
    const renewed = await database.authSession.findFirstOrThrow({
      where: { userId },
    });
    expect(renewed.idleExpiresAt).toEqual(
      new Date(initialTime.getTime() + 59 * 60 * 1_000),
    );

    clock.set(new Date(initialTime.getTime() + 59 * 60 * 1_000));
    const expired = await csrfRequest(testApi.baseUrl, cookie);
    await expectProblem(expired, 401, "unauthenticated");
  });

  test("does not renew a session that expires while authentication waits for its user lock", async () => {
    const loginIdentifier = `idle-lock-${randomUUID()}@example.test`;
    const userId = await createUser(loginIdentifier);
    const login = await loginRequest(
      testApi.baseUrl,
      { loginIdentifier, password },
      { origin: TEST_PUBLIC_ORIGIN },
    );
    const cookie = cookiePair(requireSetCookie(login));
    const initialSession = await database.authSession.findFirstOrThrow({
      where: { userId },
      select: { idleExpiresAt: true },
    });
    const lock = await holdUserRowLock(database, userId);
    let renewal: Promise<Response> | undefined;
    try {
      clock.set(new Date(initialTime.getTime() + 29 * 60 * 1_000));
      renewal = csrfRequest(testApi.baseUrl, cookie);
      await waitForUserLockWaiter(database, lock.lockerPid);
      clock.set(initialSession.idleExpiresAt);
      lock.release();
      await lock.completed;

      await expectProblem(await renewal, 401, "unauthenticated");
      await expect(
        database.authSession.findFirstOrThrow({
          where: { userId },
          select: { idleExpiresAt: true },
        }),
      ).resolves.toEqual(initialSession);
    } finally {
      lock.release();
      await Promise.allSettled([lock.completed]);
      if (renewal !== undefined) {
        await Promise.allSettled([renewal]);
      }
    }
  });

  test("caps repeated idle renewal at the twelve-hour absolute expiry", async () => {
    const loginIdentifier = `absolute-${randomUUID()}@example.test`;
    await createUser(loginIdentifier);
    const login = await loginRequest(
      testApi.baseUrl,
      { loginIdentifier, password },
      { origin: TEST_PUBLIC_ORIGIN },
    );
    const cookie = cookiePair(requireSetCookie(login));
    for (let minutes = 29; minutes < 12 * 60; minutes += 29) {
      clock.set(new Date(initialTime.getTime() + minutes * 60 * 1_000));
      expect((await csrfRequest(testApi.baseUrl, cookie)).status).toBe(200);
    }

    clock.set(new Date(initialTime.getTime() + 12 * 60 * 60 * 1_000));
    const expired = await csrfRequest(testApi.baseUrl, cookie);
    await expectProblem(expired, 401, "unauthenticated");
  });

  test("turns all-session revocation and user disable into immediate HTTP 401", async () => {
    const loginIdentifier = `revoked-${randomUUID()}@example.test`;
    const userId = await createUser(loginIdentifier);
    const operations = testApi.app.get(AccessOperationsService);
    const firstLogin = await loginRequest(
      testApi.baseUrl,
      { loginIdentifier, password },
      { origin: TEST_PUBLIC_ORIGIN },
    );
    const firstCookie = cookiePair(requireSetCookie(firstLogin));

    await expect(
      operations.execute({ operation: "revoke-user-sessions", userId }),
    ).resolves.toMatchObject({ outcome: "revoked" });
    await expectProblem(
      await csrfRequest(testApi.baseUrl, firstCookie),
      401,
      "unauthenticated",
    );

    const secondLogin = await loginRequest(
      testApi.baseUrl,
      { loginIdentifier, password },
      { origin: TEST_PUBLIC_ORIGIN },
    );
    const secondCookie = cookiePair(requireSetCookie(secondLogin));
    await expect(
      operations.execute({ operation: "disable-user", userId }),
    ).resolves.toMatchObject({ outcome: "updated" });
    await expectProblem(
      await csrfRequest(testApi.baseUrl, secondCookie),
      401,
      "unauthenticated",
    );
    await expectProblem(
      await loginRequest(
        testApi.baseUrl,
        { loginIdentifier, password },
        { origin: TEST_PUBLIC_ORIGIN },
      ),
      401,
      "unauthenticated",
    );
  });

  test("rolls back a local invitation when session persistence fails", async () => {
    const organizationId = randomUUID();
    const ownerId = await createUser(
      `local-rollback-owner-${randomUUID()}@example.test`,
    );
    const loginIdentifier = `local-rollback-${randomUUID()}@example.test`;
    await database.organization.create({
      data: {
        id: organizationId,
        name: "Local invitation rollback",
        status: "active",
      },
    });
    await database.organizationMembership.create({
      data: {
        organizationId,
        role: "owner",
        status: "active",
        userId: ownerId,
      },
    });
    const invitation = await testApi.app
      .get(OrganizationManagementService)
      .createInvitation({
        actorUserId: ownerId,
        expiresInHours: 24,
        loginIdentifier,
        organizationId,
        requestId: randomUUID(),
        role: "member",
      });
    await database.$executeRawUnsafe(`
      CREATE FUNCTION reject_identity_session_insert()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $body$
      BEGIN
        RAISE EXCEPTION 'identity-session-insert-failure';
      END
      $body$
    `);
    try {
      await database.$executeRawUnsafe(`
        CREATE TRIGGER reject_identity_session_insert
        BEFORE INSERT ON auth_sessions
        FOR EACH ROW
        EXECUTE FUNCTION reject_identity_session_insert()
      `);
      await expectProblem(
        await acceptLocalInvitationRequest(testApi.baseUrl, {
          invitationToken: invitation.invitationToken,
          password,
        }),
        503,
        "service-unavailable",
      );
    } finally {
      try {
        await database.$executeRawUnsafe(
          "DROP TRIGGER IF EXISTS reject_identity_session_insert ON auth_sessions",
        );
      } finally {
        await database.$executeRawUnsafe(
          "DROP FUNCTION IF EXISTS reject_identity_session_insert()",
        );
      }
    }

    await expect(
      database.user.findUnique({ where: { loginIdentifier } }),
    ).resolves.toBeNull();
    await expect(
      database.organizationInvitation.findUniqueOrThrow({
        where: { id: invitation.invitationId },
        select: { acceptedAt: true, acceptedByUserId: true },
      }),
    ).resolves.toEqual({ acceptedAt: null, acceptedByUserId: null });
    await expect(
      database.authSession.count({ where: { user: { loginIdentifier } } }),
    ).resolves.toBe(0);
  });

  test("manages organization OIDC providers through owner HTTP routes and hides disabled providers", async () => {
    const organizationId = randomUUID();
    const loginIdentifier = `oidc-owner-${randomUUID()}@example.test`;
    const userId = await createUser(loginIdentifier);
    await database.organization.create({
      data: {
        id: organizationId,
        name: "OIDC provider management",
        status: "active",
      },
    });
    await database.organizationMembership.create({
      data: {
        organizationId,
        role: "owner",
        status: "active",
        userId,
      },
    });
    const login = await loginRequest(
      testApi.baseUrl,
      { loginIdentifier, password },
      { origin: TEST_PUBLIC_ORIGIN },
    );
    expect(login.status).toBe(200);
    const ownerCookie = cookiePair(requireSetCookie(login));
    const loginBody = (await login.json()) as { csrfToken: unknown };
    const csrfToken = csrfTokenSchema.parse(loginBody.csrfToken);
    const providersPath = ORGANIZATION_OIDC_PROVIDERS_PATH_TEMPLATE.replace(
      "{organizationId}",
      organizationId,
    );
    const mutationHeaders = {
      [CSRF_HEADER_NAME]: csrfToken,
      "Content-Type": "application/json",
      Cookie: ownerCookie,
      Origin: TEST_PUBLIC_ORIGIN,
    };
    const issuer = "https://identity.example.test/corporate";

    const createdResponse = await fetch(`${testApi.baseUrl}${providersPath}`, {
      body: JSON.stringify({
        clientId: oidcClientId,
        clientSecretReference: "corporate-oidc",
        issuer,
        name: " Corporate SSO ",
      }),
      headers: mutationHeaders,
      method: "POST",
    });
    expect(createdResponse.status).toBe(201);
    expect(createdResponse.headers.get("cache-control")).toBe("no-store");
    const created = managedOidcProviderSchema.parse(
      await createdResponse.json(),
    );
    expect(created).toEqual({
      clientId: oidcClientId,
      clientSecretReference: "corporate-oidc",
      issuer,
      name: "Corporate SSO",
      organizationId,
      providerId: expect.any(String),
      status: "active",
    });

    const managedResponse = await fetch(`${testApi.baseUrl}${providersPath}`, {
      headers: { Cookie: ownerCookie },
    });
    expect(managedResponse.status).toBe(200);
    expect(
      managedOidcProvidersResponseSchema.parse(await managedResponse.json()),
    ).toEqual({ providers: [created] });
    const publicResponse = await fetch(
      `${testApi.baseUrl}${AUTH_OIDC_PROVIDERS_PATH}`,
    );
    expect(publicResponse.status).toBe(200);
    expect(
      oidcProvidersResponseSchema.parse(await publicResponse.json()),
    ).toEqual({
      providers: [{ name: "Corporate SSO", providerId: created.providerId }],
    });

    const secondProvider = await database.oidcProvider.create({
      data: {
        clientId: "other-client",
        issuer: "https://identity.example.test/other",
        name: "Other SSO",
        organizationId,
        status: "disabled",
      },
      select: { id: true },
    });
    const duplicateNameResponse = await fetch(
      `${testApi.baseUrl}${
        ORGANIZATION_OIDC_PROVIDER_PATH_TEMPLATE
          .replace("{organizationId}", organizationId)
          .replace("{providerId}", secondProvider.id)
      }`,
      {
        body: JSON.stringify({ name: "Corporate SSO" }),
        headers: mutationHeaders,
        method: "PATCH",
      },
    );
    await expectProblem(duplicateNameResponse, 409, "conflict");

    const providerPath = ORGANIZATION_OIDC_PROVIDER_PATH_TEMPLATE.replace(
      "{organizationId}",
      organizationId,
    ).replace("{providerId}", created.providerId);
    const disabledResponse = await fetch(`${testApi.baseUrl}${providerPath}`, {
      body: JSON.stringify({
        clientSecretReference: null,
        name: "Corporate SSO disabled",
        status: "disabled",
      }),
      headers: mutationHeaders,
      method: "PATCH",
    });
    expect(disabledResponse.status).toBe(200);
    expect(
      managedOidcProviderSchema.parse(await disabledResponse.json()),
    ).toEqual({
      clientId: oidcClientId,
      issuer,
      name: "Corporate SSO disabled",
      organizationId,
      providerId: created.providerId,
      status: "disabled",
    });
    const publicAfterDisable = await fetch(
      `${testApi.baseUrl}${AUTH_OIDC_PROVIDERS_PATH}`,
    );
    expect(publicAfterDisable.status).toBe(200);
    expect(
      oidcProvidersResponseSchema.parse(await publicAfterDisable.json()),
    ).toEqual({ providers: [] });
    await expect(
      database.auditEvent.count({
        where: {
          organizationId,
          targetId: created.providerId,
          targetType: "oidc-provider",
        },
      }),
    ).resolves.toBe(2);
  });

  test("completes a signed OIDC HTTP flow with state, nonce, PKCE, JWKS, and a usable session", async () => {
    const providerBoundary = new OidcProviderBoundary(() => clock.now());
    const graph = await createOidcIdentityGraph(providerBoundary);
    providerBoundary.install();
    const returnTo = "/spaces?source=oidc";

    const start = await oidcStartRequest(testApi.baseUrl, {
      providerId: graph.providerId,
      returnTo,
    });
    expect(start.status).toBe(200);
    expect(start.headers.get("cache-control")).toBe("no-store");
    const flowSetCookie = requireNamedSetCookie(start, oidcFlowCookieName);
    expectOidcFlowCookieAttributes(flowSetCookie);
    const flowCookie = cookiePair(flowSetCookie);
    const { authorizationUrl } = oidcStartResponseSchema.parse(
      await start.json(),
    );
    const authorization = new URL(authorizationUrl);
    expect(`${authorization.origin}${authorization.pathname}`).toBe(
      providerBoundary.authorizationEndpoint,
    );
    expect(authorization.searchParams.get("client_id")).toBe(oidcClientId);
    expect(authorization.searchParams.get("code_challenge_method")).toBe(
      "S256",
    );
    expect(authorization.searchParams.get("redirect_uri")).toBe(
      `${TEST_PUBLIC_ORIGIN}${AUTH_OIDC_CALLBACK_PATH}`,
    );
    expect(authorization.searchParams.get("response_type")).toBe("code");
    expect(authorization.searchParams.get("scope")).toBe("openid email");
    const codeChallenge = sessionTokenSchema.parse(
      requireSearchParameter(authorization, "code_challenge"),
    );
    const nonce = sessionTokenSchema.parse(
      requireSearchParameter(authorization, "nonce"),
    );
    const state = sessionTokenSchema.parse(
      requireSearchParameter(authorization, "state"),
    );
    providerBoundary.configureIdToken({ nonce, subject: graph.subject });
    vi.spyOn(Date, "now").mockReturnValue(
      initialTime.getTime() + 30 * 24 * 60 * 60 * 1_000,
    );

    const callback = await oidcCallbackRequest(testApi.baseUrl, {
      code: "accepted-authorization-code",
      cookie: flowCookie,
      extra: {
        authuser: "0",
        iss: providerBoundary.issuer,
        prompt: "login",
        scope: "openid email",
      },
      state,
    });
    expect(callback.status).toBe(303);
    expect(callback.headers.get("cache-control")).toBe("no-store");
    expect(callback.headers.get("location")).toBe(returnTo);
    const clearedFlowCookie = requireNamedSetCookie(
      callback,
      oidcFlowCookieName,
    );
    expect(cookiePair(clearedFlowCookie)).toBe(`${oidcFlowCookieName}=`);
    const sessionSetCookie = requireNamedSetCookie(
      callback,
      AUTH_SESSION_COOKIE_NAME,
    );
    expectProductionCookieAttributes(sessionSetCookie);
    const sessionCookie = cookiePair(sessionSetCookie);
    expect(sessionTokenSchema.parse(cookieValue(sessionCookie))).toHaveLength(43);

    expect(providerBoundary.tokenExchanges).toHaveLength(1);
    const exchange = providerBoundary.tokenExchanges[0];
    if (exchange === undefined) {
      throw new Error("The OIDC token exchange was not captured");
    }
    expect(exchange.authorization).toBeNull();
    expect(exchange.body.get("client_id")).toBe(oidcClientId);
    expect(exchange.body.get("code")).toBe("accepted-authorization-code");
    expect(exchange.body.get("grant_type")).toBe("authorization_code");
    expect(exchange.body.get("redirect_uri")).toBe(
      `${TEST_PUBLIC_ORIGIN}${AUTH_OIDC_CALLBACK_PATH}`,
    );
    const codeVerifier = sessionTokenSchema.parse(
      exchange.body.get("code_verifier"),
    );
    expect(
      createHash("sha256")
        .update(codeVerifier, "ascii")
        .digest("base64url"),
    ).toBe(codeChallenge);
    expect(providerBoundary.jwksRequests).toBe(1);

    const authenticated = await csrfRequest(testApi.baseUrl, sessionCookie);
    expect(authenticated.status).toBe(200);
    const authenticatedBody = (await authenticated.json()) as {
      csrfToken: unknown;
    };
    expect(csrfTokenSchema.parse(authenticatedBody.csrfToken)).toHaveLength(43);
    await expect(
      database.authSession.findFirstOrThrow({
        where: { userId: graph.userId },
        select: { revokedAt: true, userId: true },
      }),
    ).resolves.toEqual({ revokedAt: null, userId: graph.userId });
    await expect(
      database.oidcAuthorizationAttempt.findFirstOrThrow({
        where: { providerId: graph.providerId },
        select: { consumedAt: true },
      }),
    ).resolves.toEqual({ consumedAt: initialTime });
  });

  test("accepts an organization invitation through OIDC and creates one active identity session", async () => {
    const providerBoundary = new OidcProviderBoundary(() => clock.now());
    const organizationId = randomUUID();
    const ownerId = await createUser(`oidc-inviter-${randomUUID()}@example.test`);
    await database.organization.create({
      data: { id: organizationId, name: "OIDC invitation", status: "active" },
    });
    await database.organizationMembership.create({
      data: {
        organizationId,
        role: "owner",
        status: "active",
        userId: ownerId,
      },
    });
    const provider = await database.oidcProvider.create({
      data: {
        clientId: oidcClientId,
        issuer: providerBoundary.issuer,
        name: "Invited identity",
        organizationId,
        status: "active",
      },
      select: { id: true },
    });
    const subject = randomUUID();
    const loginIdentifier = `oidc-${subject}@example.test`;
    const invitation = await testApi.app
      .get(OrganizationManagementService)
      .createInvitation({
        actorUserId: ownerId,
        expiresInHours: 24,
        loginIdentifier,
        organizationId,
        requestId: randomUUID(),
        role: "member",
      });
    providerBoundary.install();

    const start = await oidcStartRequest(testApi.baseUrl, {
      invitationToken: invitation.invitationToken,
      providerId: provider.id,
    });
    expect(start.status).toBe(200);
    const flowCookie = cookiePair(
      requireNamedSetCookie(start, oidcFlowCookieName),
    );
    const authorization = new URL(
      oidcStartResponseSchema.parse(await start.json()).authorizationUrl,
    );
    const nonce = requireSearchParameter(authorization, "nonce");
    const state = requireSearchParameter(authorization, "state");
    providerBoundary.configureIdToken({ nonce, subject });

    const callback = await oidcCallbackRequest(testApi.baseUrl, {
      code: "invitation-code",
      cookie: flowCookie,
      state,
    });
    expect(callback.status).toBe(303);
    const user = await database.user.findUniqueOrThrow({
      where: { loginIdentifier },
      select: { id: true, passwordDigest: true, status: true },
    });
    expect(user).toEqual({
      id: expect.any(String),
      passwordDigest: null,
      status: "active",
    });
    await expect(
      database.organizationMembership.findUniqueOrThrow({
        where: {
          organizationId_userId: { organizationId, userId: user.id },
        },
        select: { role: true, status: true },
      }),
    ).resolves.toEqual({ role: "member", status: "active" });
    await expect(
      database.organizationInvitation.findUniqueOrThrow({
        where: { id: invitation.invitationId },
        select: { acceptedAt: true, acceptedByUserId: true },
      }),
    ).resolves.toEqual({
      acceptedAt: initialTime,
      acceptedByUserId: user.id,
    });
    await expect(
      database.oidcIdentity.findUniqueOrThrow({
        where: { providerId_subject: { providerId: provider.id, subject } },
        select: { organizationId: true, userId: true },
      }),
    ).resolves.toEqual({ organizationId, userId: user.id });
    await expect(
      database.authSession.count({ where: { revokedAt: null, userId: user.id } }),
    ).resolves.toBe(1);
  });

  test("returns one conflict when first-identity OIDC callbacks race for one invitation", async () => {
    const providerBoundary = new OidcProviderBoundary(() => clock.now());
    const organizationId = randomUUID();
    const ownerId = await createUser(
      `oidc-first-race-owner-${randomUUID()}@example.test`,
    );
    await database.organization.create({
      data: {
        id: organizationId,
        name: "OIDC first identity race",
        status: "active",
      },
    });
    await database.organizationMembership.create({
      data: {
        organizationId,
        role: "owner",
        status: "active",
        userId: ownerId,
      },
    });
    const provider = await database.oidcProvider.create({
      data: {
        clientId: oidcClientId,
        issuer: providerBoundary.issuer,
        name: "First identity race",
        organizationId,
        status: "active",
      },
      select: { id: true },
    });
    const subject = randomUUID();
    const loginIdentifier = `oidc-${subject}@example.test`;
    const invitation = await testApi.app
      .get(OrganizationManagementService)
      .createInvitation({
        actorUserId: ownerId,
        expiresInHours: 24,
        loginIdentifier,
        organizationId,
        requestId: randomUUID(),
        role: "member",
      });
    providerBoundary.install();

    const starts = await Promise.all([
      oidcStartRequest(testApi.baseUrl, {
        invitationToken: invitation.invitationToken,
        providerId: provider.id,
      }),
      oidcStartRequest(testApi.baseUrl, {
        invitationToken: invitation.invitationToken,
        providerId: provider.id,
      }),
    ]);
    expect(starts.map((response) => response.status)).toEqual([200, 200]);
    const flows = await Promise.all(
      starts.map(async (response) => {
        const flowCookie = cookiePair(
          requireNamedSetCookie(response, oidcFlowCookieName),
        );
        const authorization = new URL(
          oidcStartResponseSchema.parse(await response.json()).authorizationUrl,
        );
        return {
          flowCookie,
          nonce: requireSearchParameter(authorization, "nonce"),
          state: requireSearchParameter(authorization, "state"),
        };
      }),
    );
    const [firstFlow, secondFlow] = flows;
    if (firstFlow === undefined || secondFlow === undefined) {
      throw new Error("Both first-identity OIDC attempts must be available");
    }
    const firstCode = "first-identity-race-one";
    const secondCode = "first-identity-race-two";
    providerBoundary.configureIdToken({
      code: firstCode,
      nonce: firstFlow.nonce,
      subject,
    });
    providerBoundary.configureIdToken({
      code: secondCode,
      nonce: secondFlow.nonce,
      subject,
    });

    const callbacks = await Promise.all([
      oidcCallbackRequest(testApi.baseUrl, {
        code: firstCode,
        cookie: firstFlow.flowCookie,
        state: firstFlow.state,
      }),
      oidcCallbackRequest(testApi.baseUrl, {
        code: secondCode,
        cookie: secondFlow.flowCookie,
        state: secondFlow.state,
      }),
    ]);
    const accepted = callbacks.find((response) => response.status === 303);
    const conflicted = callbacks.find((response) => response.status === 409);
    if (accepted === undefined || conflicted === undefined) {
      throw new Error("Exactly one first-identity callback must succeed");
    }
    await expectProblem(conflicted, 409, "conflict");
    const user = await database.user.findUniqueOrThrow({
      where: { loginIdentifier },
      select: { id: true },
    });
    await expect(
      database.user.count({ where: { loginIdentifier } }),
    ).resolves.toBe(1);
    await expect(
      database.oidcIdentity.count({
        where: { providerId: provider.id, subject, userId: user.id },
      }),
    ).resolves.toBe(1);
    await expect(
      database.organizationMembership.findUniqueOrThrow({
        where: {
          organizationId_userId: { organizationId, userId: user.id },
        },
        select: { role: true, status: true },
      }),
    ).resolves.toEqual({ role: "member", status: "active" });
    await expect(
      database.authSession.count({ where: { revokedAt: null, userId: user.id } }),
    ).resolves.toBe(1);
    await expect(
      database.auditEvent.count({
        where: {
          organizationId,
          targetId: user.id,
          targetType: "membership",
        },
      }),
    ).resolves.toBe(1);
  });

  test("consumes one invitation when existing-identity OIDC callbacks race", async () => {
    const providerBoundary = new OidcProviderBoundary(() => clock.now());
    const graph = await createOidcIdentityGraph(providerBoundary);
    const existingUser = await database.user.findUniqueOrThrow({
      where: { id: graph.userId },
      select: { loginIdentifier: true },
    });
    await database.organizationMembership.update({
      where: {
        organizationId_userId: {
          organizationId: graph.organizationId,
          userId: graph.userId,
        },
      },
      data: { status: "inactive" },
    });
    const ownerId = await createUser(`oidc-race-owner-${randomUUID()}@example.test`);
    await database.organizationMembership.create({
      data: {
        organizationId: graph.organizationId,
        role: "owner",
        status: "active",
        userId: ownerId,
      },
    });
    const invitation = await testApi.app
      .get(OrganizationManagementService)
      .createInvitation({
        actorUserId: ownerId,
        expiresInHours: 24,
        loginIdentifier: existingUser.loginIdentifier,
        organizationId: graph.organizationId,
        requestId: randomUUID(),
        role: "admin",
      });
    providerBoundary.install();

    const starts = await Promise.all([
      oidcStartRequest(testApi.baseUrl, {
        invitationToken: invitation.invitationToken,
        providerId: graph.providerId,
      }),
      oidcStartRequest(testApi.baseUrl, {
        invitationToken: invitation.invitationToken,
        providerId: graph.providerId,
      }),
    ]);
    expect(starts.map((response) => response.status)).toEqual([200, 200]);
    const flows = await Promise.all(
      starts.map(async (response) => {
        const flowCookie = cookiePair(
          requireNamedSetCookie(response, oidcFlowCookieName),
        );
        const authorization = new URL(
          oidcStartResponseSchema.parse(await response.json()).authorizationUrl,
        );
        return {
          flowCookie,
          nonce: requireSearchParameter(authorization, "nonce"),
          state: requireSearchParameter(authorization, "state"),
        };
      }),
    );
    const [firstFlow, secondFlow] = flows;
    if (firstFlow === undefined || secondFlow === undefined) {
      throw new Error("Both OIDC authorization attempts must be available");
    }
    const firstCode = "existing-invitation-race-one";
    const secondCode = "existing-invitation-race-two";
    providerBoundary.configureIdToken({
      code: firstCode,
      nonce: firstFlow.nonce,
      subject: graph.subject,
    });
    providerBoundary.configureIdToken({
      code: secondCode,
      nonce: secondFlow.nonce,
      subject: graph.subject,
    });

    const callbacks = await Promise.all([
      oidcCallbackRequest(testApi.baseUrl, {
        code: firstCode,
        cookie: firstFlow.flowCookie,
        state: firstFlow.state,
      }),
      oidcCallbackRequest(testApi.baseUrl, {
        code: secondCode,
        cookie: secondFlow.flowCookie,
        state: secondFlow.state,
      }),
    ]);
    const accepted = callbacks.find((response) => response.status === 303);
    const conflicted = callbacks.find((response) => response.status === 409);
    if (accepted === undefined || conflicted === undefined) {
      throw new Error("Exactly one OIDC callback must consume the invitation");
    }
    expect(accepted.headers.get("location")).toBe("/spaces");
    await expectProblem(conflicted, 409, "conflict");
    expect(providerBoundary.tokenExchanges).toHaveLength(2);
    await expect(
      database.organizationMembership.findUniqueOrThrow({
        where: {
          organizationId_userId: {
            organizationId: graph.organizationId,
            userId: graph.userId,
          },
        },
        select: { role: true, status: true },
      }),
    ).resolves.toEqual({ role: "admin", status: "active" });
    await expect(
      database.organizationInvitation.findUniqueOrThrow({
        where: { id: invitation.invitationId },
        select: { acceptedAt: true, acceptedByUserId: true },
      }),
    ).resolves.toEqual({
      acceptedAt: initialTime,
      acceptedByUserId: graph.userId,
    });
    await expect(
      database.authSession.count({
        where: { revokedAt: null, userId: graph.userId },
      }),
    ).resolves.toBe(1);
    await expect(
      database.auditEvent.count({
        where: {
          organizationId: graph.organizationId,
          targetId: graph.userId,
          targetType: "membership",
        },
      }),
    ).resolves.toBe(1);
  });

  test("keeps an unknown OIDC state unused and rejects replay before a second token exchange", async () => {
    const providerBoundary = new OidcProviderBoundary(() => clock.now());
    const graph = await createOidcIdentityGraph(providerBoundary);
    providerBoundary.install();
    const start = await oidcStartRequest(testApi.baseUrl, {
      providerId: graph.providerId,
    });
    expect(start.status).toBe(200);
    const flowCookie = cookiePair(
      requireNamedSetCookie(start, oidcFlowCookieName),
    );
    const { authorizationUrl } = oidcStartResponseSchema.parse(
      await start.json(),
    );
    const authorization = new URL(authorizationUrl);
    const nonce = requireSearchParameter(authorization, "nonce");
    const state = requireSearchParameter(authorization, "state");
    providerBoundary.configureIdToken({ nonce, subject: graph.subject });

    const unknownState = Buffer.alloc(32, 0x5a).toString("base64url");
    expect(unknownState).not.toBe(state);
    const unknown = await oidcCallbackRequest(testApi.baseUrl, {
      code: "wrong-state-code",
      cookie: flowCookie,
      state: unknownState,
    });
    await expectProblem(unknown, 401, "unauthenticated");
    expect(unknown.headers.getSetCookie()).toEqual([]);
    expect(providerBoundary.tokenExchanges).toHaveLength(0);
    await expect(
      database.oidcAuthorizationAttempt.findFirstOrThrow({
        where: { providerId: graph.providerId },
        select: { consumedAt: true },
      }),
    ).resolves.toEqual({ consumedAt: null });

    const accepted = await oidcCallbackRequest(testApi.baseUrl, {
      code: "single-use-code",
      cookie: flowCookie,
      state,
    });
    expect(accepted.status).toBe(303);
    expect(providerBoundary.tokenExchanges).toHaveLength(1);
    await expectProblem(
      await oidcCallbackRequest(testApi.baseUrl, {
        code: "replayed-code",
        cookie: flowCookie,
        state,
      }),
      401,
      "unauthenticated",
    );
    expect(providerBoundary.tokenExchanges).toHaveLength(1);
  });

  test.each([
    {
      label: "a nonce that does not match the authorization request",
      mode: "wrong-nonce" as const,
    },
    {
      label: "an ID Token signature that does not match the advertised JWKS",
      mode: "forged-signature" as const,
    },
  ])("rejects $label and consumes the one-time state", async ({ mode }) => {
    const providerBoundary = new OidcProviderBoundary(() => clock.now());
    const graph = await createOidcIdentityGraph(providerBoundary);
    providerBoundary.install();
    const start = await oidcStartRequest(testApi.baseUrl, {
      providerId: graph.providerId,
    });
    expect(start.status).toBe(200);
    const flowCookie = cookiePair(
      requireNamedSetCookie(start, oidcFlowCookieName),
    );
    const { authorizationUrl } = oidcStartResponseSchema.parse(
      await start.json(),
    );
    const authorization = new URL(authorizationUrl);
    const nonce = requireSearchParameter(authorization, "nonce");
    const state = requireSearchParameter(authorization, "state");
    providerBoundary.configureIdToken({
      mode,
      nonce,
      subject: graph.subject,
    });

    const rejected = await oidcCallbackRequest(testApi.baseUrl, {
      code: "untrusted-token-code",
      cookie: flowCookie,
      state,
    });
    await expectProblem(rejected, 401, "unauthenticated");
    expect(
      rejected.headers
        .getSetCookie()
        .some((value) => value.startsWith(`${oidcFlowCookieName}=`)),
    ).toBe(true);
    expect(providerBoundary.tokenExchanges).toHaveLength(1);
    expect(providerBoundary.jwksRequests).toBe(1);
    await expect(
      database.authSession.count({ where: { userId: graph.userId } }),
    ).resolves.toBe(0);
    await expect(
      database.oidcAuthorizationAttempt.findFirstOrThrow({
        where: { providerId: graph.providerId },
        select: { consumedAt: true },
      }),
    ).resolves.toEqual({ consumedAt: initialTime });

    await expectProblem(
      await oidcCallbackRequest(testApi.baseUrl, {
        code: "retry-after-untrusted-token",
        cookie: flowCookie,
        state,
      }),
      401,
      "unauthenticated",
    );
    expect(providerBoundary.tokenExchanges).toHaveLength(1);
    expect(providerBoundary.jwksRequests).toBe(1);
  });

  test("removes expired OIDC attempts without deleting active flows before starting a new one", async () => {
    const providerBoundary = new OidcProviderBoundary(() => clock.now());
    const graph = await createOidcIdentityGraph(providerBoundary);
    const digest = (value: string) =>
      createHash("sha256").update(value, "utf8").digest("hex");
    await database.oidcAuthorizationAttempt.createMany({
      data: [
        {
          browserBindingDigest: digest("expired-browser"),
          codeVerifier: "expired-verifier",
          expiresAt: new Date(initialTime.getTime() - 1),
          nonceDigest: digest("expired-nonce"),
          organizationId: graph.organizationId,
          providerId: graph.providerId,
          returnTo: "/spaces",
          stateDigest: digest("expired-state"),
        },
        {
          browserBindingDigest: digest("active-browser"),
          codeVerifier: "active-verifier",
          expiresAt: new Date(initialTime.getTime() + 60_000),
          nonceDigest: digest("active-nonce"),
          organizationId: graph.organizationId,
          providerId: graph.providerId,
          returnTo: "/spaces",
          stateDigest: digest("active-state"),
        },
      ],
    });
    providerBoundary.install();

    const response = await oidcStartRequest(testApi.baseUrl, {
      providerId: graph.providerId,
    });

    expect(response.status).toBe(200);
    await expect(
      database.oidcAuthorizationAttempt.count({
        where: {
          expiresAt: { lte: initialTime },
          providerId: graph.providerId,
        },
      }),
    ).resolves.toBe(0);
    await expect(
      database.oidcAuthorizationAttempt.count({
        where: { providerId: graph.providerId },
      }),
    ).resolves.toBe(2);
  });

  test("rate-limits repeated public OIDC starts before creating another attempt", async () => {
    const providerBoundary = new OidcProviderBoundary(() => clock.now());
    const graph = await createOidcIdentityGraph(providerBoundary);
    providerBoundary.install();

    for (let index = 0; index < 30; index += 1) {
      const accepted = await oidcStartRequest(testApi.baseUrl, {
        providerId: graph.providerId,
      });
      expect(accepted.status).toBe(200);
    }
    const limited = await oidcStartRequest(testApi.baseUrl, {
      providerId: graph.providerId,
    });

    await expectProblem(limited, 429, "rate-limited");
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
    await expect(
      database.oidcAuthorizationAttempt.count({
        where: { providerId: graph.providerId },
      }),
    ).resolves.toBe(30);
  });

  test("maps malformed OIDC discovery bytes to 503 without creating an authorization attempt", async () => {
    const providerBoundary = new OidcProviderBoundary(() => clock.now());
    const graph = await createOidcIdentityGraph(providerBoundary);
    providerBoundary.makeDiscoveryMalformed();
    providerBoundary.install();

    await expectProblem(
      await oidcStartRequest(testApi.baseUrl, {
        providerId: graph.providerId,
      }),
      503,
      "service-unavailable",
    );
    await expect(
      database.oidcAuthorizationAttempt.count({
        where: { providerId: graph.providerId },
      }),
    ).resolves.toBe(0);
  });

  test.each([
    {
      configure: (boundary: OidcProviderBoundary) =>
        boundary.makeJwksUnavailable(),
      label: "unavailable",
    },
    {
      configure: (boundary: OidcProviderBoundary) => boundary.makeJwksMalformed(),
      label: "malformed",
    },
  ])("maps $label OIDC JWKS to 503 and does not retry a consumed state", async ({
    configure,
  }) => {
    const providerBoundary = new OidcProviderBoundary(() => clock.now());
    const graph = await createOidcIdentityGraph(providerBoundary);
    providerBoundary.install();
    const start = await oidcStartRequest(testApi.baseUrl, {
      providerId: graph.providerId,
    });
    expect(start.status).toBe(200);
    const flowCookie = cookiePair(
      requireNamedSetCookie(start, oidcFlowCookieName),
    );
    const { authorizationUrl } = oidcStartResponseSchema.parse(
      await start.json(),
    );
    const authorization = new URL(authorizationUrl);
    const nonce = requireSearchParameter(authorization, "nonce");
    const state = requireSearchParameter(authorization, "state");
    providerBoundary.configureIdToken({ nonce, subject: graph.subject });
    configure(providerBoundary);

    await expectProblem(
      await oidcCallbackRequest(testApi.baseUrl, {
        code: "jwks-outage-code",
        cookie: flowCookie,
        state,
      }),
      503,
      "service-unavailable",
    );
    expect(providerBoundary.tokenExchanges).toHaveLength(1);
    expect(providerBoundary.jwksRequests).toBe(1);
    await expect(
      database.authSession.count({ where: { userId: graph.userId } }),
    ).resolves.toBe(0);
    await expect(
      database.oidcAuthorizationAttempt.findFirstOrThrow({
        where: { providerId: graph.providerId },
        select: { consumedAt: true },
      }),
    ).resolves.toEqual({ consumedAt: initialTime });

    await expectProblem(
      await oidcCallbackRequest(testApi.baseUrl, {
        code: "retry-after-jwks-outage",
        cookie: flowCookie,
        state,
      }),
      401,
      "unauthenticated",
    );
    expect(providerBoundary.tokenExchanges).toHaveLength(1);
    expect(providerBoundary.jwksRequests).toBe(1);
  });
});
