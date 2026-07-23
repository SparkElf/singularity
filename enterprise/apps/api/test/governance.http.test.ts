import { createHmac, randomUUID } from "node:crypto";

import {
  AUTH_LOGIN_PATH,
  AUTH_MFA_CHALLENGE_VERIFY_PATH,
  AUTH_MFA_FACTORS_PATH,
  AUTH_MFA_VERIFY_PATH,
  AUTH_SESSION_COOKIE_NAME,
  CSRF_HEADER_NAME,
  DOCUMENT_GOVERNANCE_PATH_TEMPLATE,
  DOCUMENT_GOVERNANCE_TRANSITION_PATH_TEMPLATE,
  ORGANIZATION_PERSONAL_SPACE_PATH_TEMPLATE,
  ORGANIZATION_API_KEYS_PATH_TEMPLATE,
  ORGANIZATION_SAML_PROVIDERS_PATH_TEMPLATE,
  ORGANIZATION_SCIM_SYNC_PATH_TEMPLATE,
  ORGANIZATION_SCIM_TOKEN_PATH_TEMPLATE,
  ORGANIZATION_SCIM_TOKENS_PATH_TEMPLATE,
  ORGANIZATION_SPACE_GOVERNANCE_POLICY_PATH_TEMPLATE,
  apiProblemSchema,
  governancePolicyResponseSchema,
  loginResponseSchema,
  mfaLoginChallengeResponseSchema,
  documentGovernanceSchema,
} from "@singularity/contracts";
import { DatabaseRuntime, type DatabaseClient } from "@singularity/database";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";

import { AccessOperationsService } from "../src/operations/access-operations.service.js";
import { truncateTestDatabase } from "./support/database.js";
import { startTestApiApplication, TEST_PUBLIC_ORIGIN, type TestApiApplication } from "./support/test-app.js";

const password = "correct horse battery staple";
const notebookId = "20260723090000-l4book1";
const documentId = "20260723090001-l4doc01";

interface Installation {
  readonly loginIdentifier: string;
  readonly organizationId: string;
  readonly spaceId: string;
  readonly userId: string;
}

interface Session {
  readonly cookie: string;
  readonly csrfToken: string;
}

function path(template: string, parameters: Readonly<Record<string, string>>): string {
  return Object.entries(parameters).reduce(
    (result, [name, value]) => result.replace(`{${name}}`, encodeURIComponent(value)),
    template,
  );
}

function cookiePair(response: Response): string {
  const value = response.headers.get("set-cookie");
  const pair = value?.split(";", 1)[0];
  if (pair === undefined || !pair.startsWith(`${AUTH_SESSION_COOKIE_NAME}=`)) {
    throw new Error("The governance login response did not issue a session cookie");
  }
  return pair;
}

function mutationHeaders(session: Session): Record<string, string> {
  return {
    [CSRF_HEADER_NAME]: session.csrfToken,
    "Content-Type": "application/json",
    Cookie: session.cookie,
    Origin: TEST_PUBLIC_ORIGIN,
  };
}

function totp(secret: string, counter = Math.floor(Date.now() / 30_000)): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const bits = [...secret].map((character) => alphabet.indexOf(character).toString(2).padStart(5, "0")).join("");
  const bytes = Buffer.alloc(Math.floor(bits.length / 8));
  for (let index = 0; index < bytes.length; index += 1) bytes[index] = Number.parseInt(bits.slice(index * 8, index * 8 + 8), 2);
  const counterBytes = Buffer.alloc(8);
  counterBytes.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac("sha1", bytes).update(counterBytes).digest();
  const offset = digest[digest.length - 1]! & 0x0f;
  const value = ((digest[offset]! & 0x7f) << 24) | ((digest[offset + 1]! & 0xff) << 16) | ((digest[offset + 2]! & 0xff) << 8) | (digest[offset + 3]! & 0xff);
  return String(value % 1_000_000).padStart(6, "0");
}

async function expectProblem(response: Response, status: number, code: string): Promise<void> {
  expect(response.status).toBe(status);
  expect(apiProblemSchema.parse(await response.json())).toMatchObject({ code, status });
}

describe("L4 governance HTTP contracts", () => {
  let database: DatabaseClient;
  let operations: AccessOperationsService;
  let testApi: TestApiApplication;

  beforeAll(async () => {
    testApi = await startTestApiApplication();
    database = testApi.app.get(DatabaseRuntime).client;
    operations = testApi.app.get(AccessOperationsService);
  });

  afterEach(async () => {
    await truncateTestDatabase(database);
  });

  afterAll(async () => {
    await testApi.dispose();
  });

  async function initialize(): Promise<Installation> {
    const loginIdentifier = `l4-owner-${randomUUID()}@example.test`;
    const result = await operations.execute({
      operation: "initialize",
      loginIdentifier,
      organizationName: "L4 Governance",
      password,
      spaceName: "Governance Space",
    });
    if (result.outcome !== "created" || !(
      "organizationId" in result && "spaceId" in result && "userId" in result
    )) {
      throw new Error("The governance test installation was not created");
    }
    return { loginIdentifier, organizationId: result.organizationId, spaceId: result.spaceId, userId: result.userId };
  }

  async function login(loginIdentifier: string): Promise<Session> {
    const response = await fetch(`${testApi.baseUrl}${AUTH_LOGIN_PATH}`, {
      body: JSON.stringify({ loginIdentifier, password }),
      headers: { "Content-Type": "application/json", Origin: TEST_PUBLIC_ORIGIN },
      method: "POST",
    });
    expect(response.status).toBe(200);
    const body = loginResponseSchema.parse(await response.json());
    return { cookie: cookiePair(response), csrfToken: body.csrfToken };
  }

  test("keeps approval decisions bound to the current version and policy interval", async () => {
    const installation = await initialize();
    const session = await login(installation.loginIdentifier);
    const policyPath = path(ORGANIZATION_SPACE_GOVERNANCE_POLICY_PATH_TEMPLATE, { ...installation });
    const policy = governancePolicyResponseSchema.parse(await (await fetch(`${testApi.baseUrl}${policyPath}`, { headers: { Cookie: session.cookie } })).json());

    const updatePolicy = await fetch(`${testApi.baseUrl}${policyPath}`, {
      body: JSON.stringify({ ...policy, verificationIntervalDays: 7 }),
      headers: mutationHeaders(session),
      method: "PUT",
    });
    // The public policy write contract does not accept response-only identifiers.
    expect(updatePolicy.status).toBe(400);

    const validPolicyUpdate = await fetch(`${testApi.baseUrl}${policyPath}`, {
      body: JSON.stringify({
        archiveAfterDays: policy.archiveAfterDays,
        defaultClassification: policy.defaultClassification,
        governanceEnabled: policy.governanceEnabled,
        retentionDays: policy.retentionDays,
        verificationGraceDays: policy.verificationGraceDays,
        verificationIntervalDays: 7,
        watermarkEnabled: policy.watermarkEnabled,
      }),
      headers: mutationHeaders(session),
      method: "PUT",
    });
    expect(validPolicyUpdate.status).toBe(200);

    const documentPath = path(DOCUMENT_GOVERNANCE_TRANSITION_PATH_TEMPLATE, {
      ...installation,
      notebookId,
      documentId,
    });
    const submit = await fetch(`${testApi.baseUrl}${documentPath}`, {
      body: JSON.stringify({ action: "submit", versionToken: "v1" }),
      headers: mutationHeaders(session),
      method: "POST",
    });
    expect(documentGovernanceSchema.parse(await submit.json()).lifecycle).toBe("in-review");

    const staleApprove = await fetch(`${testApi.baseUrl}${documentPath}`, {
      body: JSON.stringify({ action: "approve", versionToken: "old-version" }),
      headers: mutationHeaders(session),
      method: "POST",
    });
    await expectProblem(staleApprove, 409, "conflict");

    const approve = await fetch(`${testApi.baseUrl}${documentPath}`, {
      body: JSON.stringify({ action: "approve", versionToken: "v1" }),
      headers: mutationHeaders(session),
      method: "POST",
    });
    expect(documentGovernanceSchema.parse(await approve.json()).lifecycle).toBe("approved");

    const duplicateApprove = await fetch(`${testApi.baseUrl}${documentPath}`, {
      body: JSON.stringify({ action: "approve", versionToken: "v1" }),
      headers: mutationHeaders(session),
      method: "POST",
    });
    await expectProblem(duplicateApprove, 409, "conflict");

    const verify = await fetch(`${testApi.baseUrl}${documentPath}`, {
      body: JSON.stringify({ action: "verify", versionToken: "v1" }),
      headers: mutationHeaders(session),
      method: "POST",
    });
    const verified = documentGovernanceSchema.parse(await verify.json());
    const nextVerificationAt = verified.nextVerificationAt === undefined ? 0 : Date.parse(verified.nextVerificationAt);
    expect(nextVerificationAt - Date.now()).toBeGreaterThan(6 * 86_400_000);
    expect(nextVerificationAt - Date.now()).toBeLessThan(8 * 86_400_000);
  });

  test("initializes a visible document governance record on first read", async () => {
    const installation = await initialize();
    const session = await login(installation.loginIdentifier);
    const documentPath = path(DOCUMENT_GOVERNANCE_PATH_TEMPLATE, {
      ...installation,
      notebookId,
      documentId,
    });

    const first = await fetch(`${testApi.baseUrl}${documentPath}`, {
      headers: { Cookie: session.cookie },
    });
    expect(first.status).toBe(200);
    expect(documentGovernanceSchema.parse(await first.json())).toMatchObject({
      document: { documentId, notebookId, organizationId: installation.organizationId, spaceId: installation.spaceId },
      lifecycle: "draft",
      verification: "needs-review",
    });

    const second = await fetch(`${testApi.baseUrl}${documentPath}`, {
      headers: { Cookie: session.cookie },
    });
    expect(second.status).toBe(200);
    expect(documentGovernanceSchema.parse(await second.json())).toMatchObject({ lifecycle: "draft" });
    expect(await database.documentGovernance.count({ where: { organizationId: installation.organizationId, spaceId: installation.spaceId, notebookId, documentId } })).toBe(1);
  });

  test("does not return an existing personal space after membership revocation", async () => {
    const installation = await initialize();
    const session = await login(installation.loginIdentifier);
    const personalPath = path(ORGANIZATION_PERSONAL_SPACE_PATH_TEMPLATE, { ...installation });
    const first = await fetch(`${testApi.baseUrl}${personalPath}`, {
      headers: mutationHeaders(session),
      method: "POST",
    });
    expect(first.status).toBe(201);

    await database.organizationMembership.update({
      where: { organizationId_userId: { organizationId: installation.organizationId, userId: installation.userId } },
      data: { status: "inactive" },
    });
    const second = await fetch(`${testApi.baseUrl}${personalPath}`, {
      headers: mutationHeaders(session),
      method: "POST",
    });
    await expectProblem(second, 404, "not-found");
  });

  test("keeps MFA encryption failure observable without storing plaintext", async () => {
    const installation = await initialize();
    const session = await login(installation.loginIdentifier);
    const response = await fetch(`${testApi.baseUrl}/api/v1/auth/mfa/factors`, {
      body: JSON.stringify({ label: "primary", secret: "JBSWY3DPEHPK3PXP" }),
      headers: mutationHeaders(session),
      method: "POST",
    });
    await expectProblem(response, 503, "service-unavailable");
    expect(await database.mfaFactor.count({ where: { userId: installation.userId } })).toBe(0);
  });

  test("requires and consumes a login MFA challenge after factor enrollment", async () => {
    const installation = await initialize();
    const session = await login(installation.loginIdentifier);
    const previousKey = process.env.SINGULARITY_MFA_ENCRYPTION_KEY;
    process.env.SINGULARITY_MFA_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString("base64url");
    try {
      const enroll = await fetch(`${testApi.baseUrl}${AUTH_MFA_FACTORS_PATH}`, {
        body: JSON.stringify({ label: "primary", secret: "JBSWY3DPEHPK3PXP" }),
        headers: mutationHeaders(session),
        method: "POST",
      });
      expect(enroll.status).toBe(201);
      const verify = await fetch(`${testApi.baseUrl}${AUTH_MFA_VERIFY_PATH}`, {
        body: JSON.stringify({ code: totp("JBSWY3DPEHPK3PXP"), label: "primary" }),
        headers: mutationHeaders(session),
        method: "POST",
      });
      expect(verify.status).toBe(200);
      const backupEnroll = await fetch(`${testApi.baseUrl}${AUTH_MFA_FACTORS_PATH}`, {
        body: JSON.stringify({ label: "backup", secret: "KRUGS4ZANFZSAYJA" }),
        headers: mutationHeaders(session),
        method: "POST",
      });
      expect(backupEnroll.status).toBe(201);
      const backupVerify = await fetch(`${testApi.baseUrl}${AUTH_MFA_VERIFY_PATH}`, {
        body: JSON.stringify({ code: totp("KRUGS4ZANFZSAYJA"), label: "backup" }),
        headers: mutationHeaders(session),
        method: "POST",
      });
      expect(backupVerify.status).toBe(200);
      const pending = await fetch(`${testApi.baseUrl}${AUTH_LOGIN_PATH}`, {
        body: JSON.stringify({ loginIdentifier: installation.loginIdentifier, password }),
        headers: { "Content-Type": "application/json", Origin: TEST_PUBLIC_ORIGIN },
        method: "POST",
      });
      expect(pending.status).toBe(202);
      const challenge = mfaLoginChallengeResponseSchema.parse(await pending.json());
      const completed = await fetch(`${testApi.baseUrl}${AUTH_MFA_CHALLENGE_VERIFY_PATH}`, {
        body: JSON.stringify({ challengeToken: challenge.challengeToken, code: totp("KRUGS4ZANFZSAYJA") }),
        headers: { "Content-Type": "application/json", Origin: TEST_PUBLIC_ORIGIN },
        method: "POST",
      });
      expect(completed.status).toBe(200);
      expect(loginResponseSchema.parse(await completed.json()).csrfToken).toBeTypeOf("string");
      expect(completed.headers.get("set-cookie")).toContain(AUTH_SESSION_COOKIE_NAME);
    } finally {
      if (previousKey === undefined) delete process.env.SINGULARITY_MFA_ENCRYPTION_KEY;
      else process.env.SINGULARITY_MFA_ENCRYPTION_KEY = previousKey;
    }
  });

  test("binds SCIM bearer credentials to one organization before synchronization", async () => {
    const installation = await initialize();
    const session = await login(installation.loginIdentifier);
    const tokenResponse = await fetch(
      `${testApi.baseUrl}${path(ORGANIZATION_SCIM_TOKENS_PATH_TEMPLATE, { ...installation })}`,
      { body: "{}", headers: mutationHeaders(session), method: "POST" },
    );
    expect(tokenResponse.status).toBe(201);
    const token = (await tokenResponse.json()) as { secret: string; tokenId: string };
    expect(token.secret).toMatch(/^scim_sing_/);

    const syncPath = path(ORGANIZATION_SCIM_SYNC_PATH_TEMPLATE, { ...installation });
    const missingToken = await fetch(`${testApi.baseUrl}${syncPath}`, {
      body: JSON.stringify({ groups: [], users: [] }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    await expectProblem(missingToken, 401, "unauthenticated");

    const sync = await fetch(`${testApi.baseUrl}${syncPath}`, {
      body: JSON.stringify({ groups: [], users: [{ active: true, externalId: "scim-user-1", loginIdentifier: `scim-${randomUUID()}@example.test` }] }),
      headers: { Authorization: `Bearer ${token.secret}`, "Content-Type": "application/json" },
      method: "POST",
    });
    expect(sync.status).toBe(200);
    expect(await sync.json()).toEqual({ groups: 0, users: 1 });

    const revoke = await fetch(`${testApi.baseUrl}${path(ORGANIZATION_SCIM_TOKEN_PATH_TEMPLATE, { ...installation, tokenId: token.tokenId })}`, {
      headers: mutationHeaders(session),
      method: "DELETE",
    });
    expect(revoke.status).toBe(204);
    const revokedSync = await fetch(`${testApi.baseUrl}${syncPath}`, {
      body: JSON.stringify({ groups: [], users: [] }),
      headers: { Authorization: `Bearer ${token.secret}`, "Content-Type": "application/json" },
      method: "POST",
    });
    await expectProblem(revokedSync, 401, "unauthenticated");
  });

  test("lists identity credentials as redacted summaries after creation", async () => {
    const installation = await initialize();
    const session = await login(installation.loginIdentifier);
    const apiKeysPath = path(ORGANIZATION_API_KEYS_PATH_TEMPLATE, { ...installation });
    const createdKey = await fetch(`${testApi.baseUrl}${apiKeysPath}`, {
      body: JSON.stringify({ name: "automation", scopes: ["governance.read"] }),
      headers: mutationHeaders(session),
      method: "POST",
    });
    expect(createdKey.status).toBe(201);
    const keyBody = (await createdKey.json()) as { secret: string };
    expect(keyBody.secret).toMatch(/^sk_sing_/);
    const listedKeys = await fetch(`${testApi.baseUrl}${apiKeysPath}`, { headers: { Cookie: session.cookie } });
    expect(listedKeys.status).toBe(200);
    const listedKey = ((await listedKeys.json()) as { keys: Array<Record<string, unknown>> }).keys[0];
    expect(listedKey).toMatchObject({ name: "automation", scopes: ["governance.read"] });
    expect(listedKey).not.toHaveProperty("secret");

    const samlPath = path(ORGANIZATION_SAML_PROVIDERS_PATH_TEMPLATE, { ...installation });
    const createdProvider = await fetch(`${testApi.baseUrl}${samlPath}`, {
      body: JSON.stringify({ certificatePem: "-----BEGIN CERTIFICATE-----\nfixture\n-----END CERTIFICATE-----", entityId: "https://idp.example.test/entity", name: "Corporate IdP", ssoUrl: "https://idp.example.test/sso" }),
      headers: mutationHeaders(session),
      method: "POST",
    });
    expect(createdProvider.status).toBe(201);
    const listedProviders = await fetch(`${testApi.baseUrl}${samlPath}`, { headers: { Cookie: session.cookie } });
    expect(listedProviders.status).toBe(200);
    expect(await listedProviders.json()).toMatchObject({ providers: [{ certificateConfigured: true, name: "Corporate IdP", status: "disabled" }] });

    const factors = await fetch(`${testApi.baseUrl}${AUTH_MFA_FACTORS_PATH}`, { headers: { Cookie: session.cookie } });
    expect(factors.status).toBe(200);
    expect(await factors.json()).toEqual({ factors: [] });
  });
});
