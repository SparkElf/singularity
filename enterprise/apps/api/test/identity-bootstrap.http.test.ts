import {
  AUTH_REGISTER_PATH,
  AUTH_SETUP_PATH,
  AUTH_SESSION_COOKIE_NAME,
  apiProblemSchema,
  loginResponseSchema,
  setupStatusResponseSchema,
} from "@singularity/contracts";
import { DatabaseRuntime, type DatabaseClient } from "@singularity/database";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";

import { AccessOperationsService } from "../src/operations/access-operations.service.js";
import {
  INITIAL_ADMIN_LOGIN_IDENTIFIER,
  IdentityProvisioningService,
} from "../src/identity/identity-provisioning.service.js";
import { truncateTestDatabase } from "./support/database.js";
import {
  startTestApiApplication,
  TEST_PUBLIC_ORIGIN,
  type TestApiApplication,
} from "./support/test-app.js";

const PASSWORD = "correct horse battery staple";

function cookiePair(response: Response): string {
  const pair = response.headers.get("set-cookie")?.split(";", 1)[0];
  if (!pair?.startsWith(`${AUTH_SESSION_COOKIE_NAME}=`)) {
    throw new Error("The provisioning response did not set a session cookie");
  }
  return pair;
}

describe("identity bootstrap and registration HTTP contract", () => {
  let database: DatabaseClient;
  let databaseRuntime: DatabaseRuntime;
  let testApi: TestApiApplication;

  beforeAll(async () => {
    testApi = await startTestApiApplication();
    databaseRuntime = testApi.app.get(DatabaseRuntime);
    database = databaseRuntime.client;
  });

  afterEach(async () => {
    await truncateTestDatabase(database);
  });

  afterAll(async () => {
    await testApi.dispose();
  });

  test("generates one fixed admin credential set for the first deployment", async () => {
    const provisioning = testApi.app.get(IdentityProvisioningService);
    const created = await provisioning.ensureInitialInstallation();
    const repeated = await provisioning.ensureInitialInstallation();
    const status = await fetch(`${testApi.baseUrl}${AUTH_SETUP_PATH}`);

    expect(created).toMatchObject({
      created: true,
      loginIdentifier: INITIAL_ADMIN_LOGIN_IDENTIFIER,
    });
    expect(created.password).toEqual(expect.stringMatching(/^[A-Za-z0-9_-]{43}$/));
    expect(repeated).toEqual({
      created: false,
      loginIdentifier: INITIAL_ADMIN_LOGIN_IDENTIFIER,
    });
    expect(setupStatusResponseSchema.parse(await status.json())).toEqual({
      initialized: true,
    });
    expect(await database.user.count({ where: { loginIdentifier: "admin" } })).toBe(1);
    expect(await database.organization.count()).toBe(1);
    expect(await database.space.count()).toBe(1);
    expect(await database.kernelInstance.count()).toBe(1);
  });

  test("always creates only a local user after installation", async () => {
    const operations = testApi.app.get(AccessOperationsService);
    const initialized = await operations.execute({
      operation: "initialize",
      loginIdentifier: "owner@example.com",
      organizationName: "既有组织",
      password: PASSWORD,
      spaceName: "既有空间",
    });
    expect(initialized.outcome).toBe("created");

    const response = await fetch(`${testApi.baseUrl}${AUTH_REGISTER_PATH}`, {
        body: JSON.stringify({
          loginIdentifier: "new-user@example.com",
          password: PASSWORD,
        }),
        headers: { "Content-Type": "application/json", Origin: TEST_PUBLIC_ORIGIN },
        method: "POST",
      });
      expect(response.status).toBe(200);
      loginResponseSchema.parse(await response.json());
      cookiePair(response);

    const user = await databaseRuntime.client.user.findUnique({
      where: { loginIdentifier: "new-user@example.com" },
      include: { organizationMemberships: true },
    });
    expect(user?.organizationMemberships).toHaveLength(0);
    expect(await databaseRuntime.client.organization.count()).toBe(1);
    expect(await databaseRuntime.client.space.count()).toBe(1);

    const duplicate = await fetch(`${testApi.baseUrl}${AUTH_REGISTER_PATH}`, {
        body: JSON.stringify({
          loginIdentifier: "new-user@example.com",
          password: PASSWORD,
        }),
        headers: { "Content-Type": "application/json", Origin: TEST_PUBLIC_ORIGIN },
        method: "POST",
      });
    expect(duplicate.status).toBe(409);
    expect(apiProblemSchema.parse(await duplicate.json())).toMatchObject({
      code: "conflict",
      status: 409,
    });
    expect(await databaseRuntime.client.user.count()).toBe(2);
  });
});
