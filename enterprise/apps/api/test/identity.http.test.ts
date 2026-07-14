import { randomUUID } from "node:crypto";

import {
  AUTH_CSRF_PATH,
  AUTH_LOGIN_PATH,
  AUTH_LOGOUT_PATH,
  AUTH_SESSION_COOKIE_NAME,
  CSRF_HEADER_NAME,
  type ApiProblemCode,
  apiProblemSchema,
  csrfTokenSchema,
  sessionTokenSchema,
} from "@singularity/contracts";
import { DatabaseRuntime, type DatabaseClient } from "@singularity/database";
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
import { CapturingLogger } from "./support/capturing-logger.js";
import {
  startTestApiApplication,
  TEST_PUBLIC_ORIGIN,
  type TestApiApplication,
} from "./support/test-app.js";

const password = "correct horse battery staple";
const initialTime = new Date("2026-07-15T00:00:00.000Z");

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

async function cleanDatabase(database: DatabaseClient): Promise<void> {
  await database.$transaction(async (transaction) => {
    await transaction.kernelInstance.deleteMany();
    await transaction.authSession.deleteMany();
    await transaction.spaceMembership.deleteMany();
    await transaction.space.deleteMany();
    await transaction.organizationMembership.deleteMany();
    await transaction.organization.deleteMany();
    await transaction.user.deleteMany();
    await transaction.systemInstallation.deleteMany();
  });
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
      await cleanDatabase(database);
    } finally {
      try {
        await testApi.dispose();
      } finally {
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
});
