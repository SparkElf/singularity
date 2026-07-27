import {
  AUTH_CSRF_PATH,
  AUTH_LOGIN_PATH,
  AUTH_PASSWORD_RESET_PATH,
  AUTH_PASSWORD_RESET_REQUEST_PATH,
  AUTH_SESSION_COOKIE_NAME,
  apiProblemSchema,
  loginResponseSchema,
  passwordResetRequestedResponseSchema,
} from "@singularity/contracts";
import { DatabaseRuntime, type DatabaseClient } from "@singularity/database";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";

import type { PasswordResetMailer } from "../src/identity/password-reset-mailer.js";
import { AccessOperationsService } from "../src/operations/access-operations.service.js";
import { truncateTestDatabase } from "./support/database.js";
import {
  startTestApiApplication,
  TEST_PUBLIC_ORIGIN,
  type TestApiApplication,
} from "./support/test-app.js";

const OLD_PASSWORD = "correct horse battery staple";
const NEW_PASSWORD = "a different secure password";

class CapturingPasswordResetMailer implements PasswordResetMailer {
  configured = true;
  readonly messages: Array<{ recipient: string; resetUrl: string }> = [];

  async send(input: { recipient: string; resetUrl: string }): Promise<void> {
    this.messages.push(input);
  }
}

function cookiePair(response: Response): string {
  const pair = response.headers.get("set-cookie")?.split(";", 1)[0];
  if (!pair?.startsWith(`${AUTH_SESSION_COOKIE_NAME}=`)) {
    throw new Error("The response did not set a session cookie");
  }
  return pair;
}

describe("password reset HTTP contract", () => {
  let database: DatabaseClient;
  let testApi: TestApiApplication;
  let mailer: CapturingPasswordResetMailer;

  beforeAll(async () => {
    mailer = new CapturingPasswordResetMailer();
    testApi = await startTestApiApplication({ passwordResetMailer: mailer });
    database = testApi.app.get(DatabaseRuntime).client;
  });

  afterEach(async () => {
    mailer.configured = true;
    mailer.messages.length = 0;
    await truncateTestDatabase(database);
  });

  afterAll(async () => {
    await testApi.dispose();
  });

  test("uses one accepted response for known and unknown email addresses", async () => {
    await testApi.app.get(AccessOperationsService).execute({
      operation: "initialize",
      loginIdentifier: "member@example.com",
      organizationName: "测试组织",
      password: OLD_PASSWORD,
      spaceName: "测试空间",
    });

    const request = async (email: string) =>
      fetch(`${testApi.baseUrl}${AUTH_PASSWORD_RESET_REQUEST_PATH}`, {
        body: JSON.stringify({ email }),
        headers: {
          "Content-Type": "application/json",
          Origin: TEST_PUBLIC_ORIGIN,
        },
        method: "POST",
      });
    const known = await request("member@example.com");
    const unknown = await request("unknown@example.com");

    expect(known.status).toBe(202);
    expect(unknown.status).toBe(202);
    expect(passwordResetRequestedResponseSchema.parse(await known.json())).toEqual({
      accepted: true,
    });
    expect(passwordResetRequestedResponseSchema.parse(await unknown.json())).toEqual({
      accepted: true,
    });
    expect(mailer.messages).toHaveLength(1);
    expect(mailer.messages[0]?.recipient).toBe("member@example.com");
    expect(mailer.messages[0]?.resetUrl).toMatch(/\/reset-password\?token=[A-Za-z0-9_-]{43}$/);
  });

  test("consumes a reset link once and revokes the old session", async () => {
    await testApi.app.get(AccessOperationsService).execute({
      operation: "initialize",
      loginIdentifier: "member@example.com",
      organizationName: "测试组织",
      password: OLD_PASSWORD,
      spaceName: "测试空间",
    });
    const login = await fetch(`${testApi.baseUrl}${AUTH_LOGIN_PATH}`, {
      body: JSON.stringify({
        loginIdentifier: "member@example.com",
        password: OLD_PASSWORD,
      }),
      headers: { "Content-Type": "application/json", Origin: TEST_PUBLIC_ORIGIN },
      method: "POST",
    });
    const loginPayload = loginResponseSchema.parse(await login.json());
    const oldCookie = cookiePair(login);

    const request = await fetch(`${testApi.baseUrl}${AUTH_PASSWORD_RESET_REQUEST_PATH}`, {
      body: JSON.stringify({ email: "member@example.com" }),
      headers: { "Content-Type": "application/json", Origin: TEST_PUBLIC_ORIGIN },
      method: "POST",
    });
    expect(request.status).toBe(202);
    const resetUrl = mailer.messages[0]?.resetUrl;
    if (resetUrl === undefined) {
      throw new Error("The reset mail was not captured");
    }
    const token = new URL(resetUrl).searchParams.get("token");
    if (token === null) {
      throw new Error("The reset mail did not contain a token");
    }

    const confirm = await fetch(`${testApi.baseUrl}${AUTH_PASSWORD_RESET_PATH}`, {
      body: JSON.stringify({ password: NEW_PASSWORD, token }),
      headers: { "Content-Type": "application/json", Origin: TEST_PUBLIC_ORIGIN },
      method: "POST",
    });
    expect(confirm.status).toBe(204);

    const oldSession = await fetch(`${testApi.baseUrl}${AUTH_CSRF_PATH}`, {
      headers: { Cookie: oldCookie },
    });
    expect(oldSession.status).toBe(401);

    const newLogin = await fetch(`${testApi.baseUrl}${AUTH_LOGIN_PATH}`, {
      body: JSON.stringify({
        loginIdentifier: "member@example.com",
        password: NEW_PASSWORD,
      }),
      headers: { "Content-Type": "application/json", Origin: TEST_PUBLIC_ORIGIN },
      method: "POST",
    });
    expect(newLogin.status).toBe(200);
    loginResponseSchema.parse(await newLogin.json());

    const replay = await fetch(`${testApi.baseUrl}${AUTH_PASSWORD_RESET_PATH}`, {
      body: JSON.stringify({ password: OLD_PASSWORD, token }),
      headers: { "Content-Type": "application/json", Origin: TEST_PUBLIC_ORIGIN },
      method: "POST",
    });
    expect(replay.status).toBe(400);
    expect(apiProblemSchema.parse(await replay.json())).toMatchObject({
      code: "validation-failed",
      status: 400,
    });
    expect(loginPayload.csrfToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  test("returns service unavailable before looking up an email without SMTP", async () => {
    mailer.configured = false;
    const response = await fetch(`${testApi.baseUrl}${AUTH_PASSWORD_RESET_REQUEST_PATH}`, {
      body: JSON.stringify({ email: "member@example.com" }),
      headers: { "Content-Type": "application/json", Origin: TEST_PUBLIC_ORIGIN },
      method: "POST",
    });

    expect(response.status).toBe(503);
    expect(apiProblemSchema.parse(await response.json())).toMatchObject({
      code: "service-unavailable",
      status: 503,
    });
    expect(await database.user.count()).toBe(0);
    mailer.configured = true;
  });
});
