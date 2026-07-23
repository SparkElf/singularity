import { randomUUID } from "node:crypto";

import {
  AUTH_LOGIN_PATH,
  AUTH_SESSION_COOKIE_NAME,
  CSRF_HEADER_NAME,
  ORGANIZATION_SPACE_GOVERNANCE_TEMPLATES_PATH_TEMPLATE,
  ORGANIZATION_SPACE_GOVERNANCE_TEMPLATE_DOCUMENTS_PATH_TEMPLATE,
  ORGANIZATION_SPACE_GOVERNANCE_TEMPLATE_PUBLISH_PATH_TEMPLATE,
  apiProblemSchema,
  governanceTemplateSchema,
  loginResponseSchema,
  documentIdentitySchema,
} from "@singularity/contracts";
import { DatabaseRuntime, type DatabaseClient } from "@singularity/database";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";

import { PasswordHasher } from "../src/identity/password-hasher.js";
import { truncateTestDatabase } from "./support/database.js";
import {
  startTestKernelGateway,
  type TestKernelGateway,
  type TestKernelRequest,
  type TestKernelResponse,
} from "./support/kernel-gateway.js";
import {
  startTestApiApplication,
  TEST_PUBLIC_ORIGIN,
  type TestApiApplication,
} from "./support/test-app.js";

const PASSWORD = "correct horse battery staple";

interface Installation {
  readonly cookie: string;
  readonly csrfToken: string;
  readonly loginIdentifier: string;
  readonly organizationId: string;
  readonly spaceId: string;
}

function path(template: string, parameters: Readonly<Record<string, string>>): string {
  return Object.entries(parameters).reduce(
    (result, [name, value]) => result.replace(`{${name}}`, encodeURIComponent(value)),
    template,
  );
}

function jsonResponse(body: unknown, status = 200): TestKernelResponse {
  return {
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
    status,
  };
}

function createDocumentKernelResponse(request: TestKernelRequest): TestKernelResponse {
  if (request.path !== "/api/filetree/createDocWithMd") {
    return { status: 404 };
  }
  return jsonResponse({ code: 0, data: request.headers["x-singularity-document-id"], msg: "" });
}

describe("governance template document HTTP contract", () => {
  let database: DatabaseClient;
  let kernel: TestKernelGateway;
  let testApi: TestApiApplication;

  beforeAll(async () => {
    kernel = await startTestKernelGateway({ handler: createDocumentKernelResponse });
    try {
      testApi = await startTestApiApplication({ kernelGateway: kernel.configuration });
      database = testApi.app.get(DatabaseRuntime).client;
    } catch (error) {
      await kernel.dispose();
      throw error;
    }
  });

  afterEach(async () => {
    await truncateTestDatabase(database);
  });

  afterAll(async () => {
    try {
      await testApi.dispose();
    } finally {
      await kernel.dispose();
    }
  });

  async function initialize(): Promise<Installation> {
    const userId = randomUUID();
    const organizationId = randomUUID();
    const loginIdentifier = `template-${randomUUID()}@example.test`;
    const spaceId = kernel.deployment.spaceId;
    const passwordDigest = await testApi.app.get(PasswordHasher).hashPassword(PASSWORD);
    await database.$transaction(async (transaction) => {
      await transaction.systemInstallation.create({ data: { id: 1, initializedAt: new Date() } });
      await transaction.user.create({ data: { id: userId, loginIdentifier, passwordDigest, status: "active" } });
      await transaction.organization.create({ data: { id: organizationId, name: "Template Org", status: "active" } });
      await transaction.organizationMembership.create({ data: { organizationId, role: "owner", status: "active", userId } });
      await transaction.space.create({ data: { id: spaceId, name: "Template Space", organizationId, status: "active" } });
      await transaction.spaceMembership.create({ data: { organizationId, role: "admin", spaceId, status: "active", userId } });
      await transaction.kernelInstance.create({ data: { deploymentHandle: kernel.deployment.handle, id: kernel.deployment.kernelInstanceId, spaceId, status: "ready", version: "test" } });
    });
    const response = await fetch(`${testApi.baseUrl}${AUTH_LOGIN_PATH}`, {
      body: JSON.stringify({ loginIdentifier, password: PASSWORD }),
      headers: { "Content-Type": "application/json", Origin: TEST_PUBLIC_ORIGIN },
      method: "POST",
    });
    expect(response.status).toBe(200);
    const login = loginResponseSchema.parse(await response.json());
    const cookie = response.headers.get("set-cookie")?.split(";", 1)[0];
    if (cookie === undefined || !cookie.startsWith(`${AUTH_SESSION_COOKIE_NAME}=`)) {
      throw new Error("Template test login did not issue a session cookie");
    }
    return { cookie, csrfToken: login.csrfToken, loginIdentifier, organizationId, spaceId };
  }

  function mutationHeaders(installation: Installation): Record<string, string> {
    return {
      [CSRF_HEADER_NAME]: installation.csrfToken,
      "Content-Type": "application/json",
      Cookie: installation.cookie,
      Origin: TEST_PUBLIC_ORIGIN,
    };
  }

  test("creates a Kernel document from a published template with explicit identity", async () => {
    const installation = await initialize();
    const templatesPath = path(ORGANIZATION_SPACE_GOVERNANCE_TEMPLATES_PATH_TEMPLATE, { ...installation });
    const createTemplate = await fetch(`${testApi.baseUrl}${templatesPath}`, {
      body: JSON.stringify({ defaultClassification: "confidential", initialContent: { markdown: "# Runbook\n\nBody" }, name: "Runbook", verificationIntervalDays: 30 }),
      headers: mutationHeaders(installation),
      method: "POST",
    });
    const template = governanceTemplateSchema.parse(await createTemplate.json());
    const publishPath = path(ORGANIZATION_SPACE_GOVERNANCE_TEMPLATE_PUBLISH_PATH_TEMPLATE, { ...installation, templateId: template.templateId });
    expect((await fetch(`${testApi.baseUrl}${publishPath}`, { headers: mutationHeaders(installation), method: "POST" })).status).toBe(201);

    const documentPath = path(ORGANIZATION_SPACE_GOVERNANCE_TEMPLATE_DOCUMENTS_PATH_TEMPLATE, { ...installation, templateId: template.templateId });
    const created = await fetch(`${testApi.baseUrl}${documentPath}`, {
      body: JSON.stringify({ notebookId: "20260723090000-l4book1", title: "Runbook" }),
      headers: mutationHeaders(installation),
      method: "POST",
    });
    const identity = documentIdentitySchema.parse(await created.json());
    expect(identity).toMatchObject({ notebookId: "20260723090000-l4book1", organizationId: installation.organizationId, spaceId: installation.spaceId });
    const request = kernel.requests.at(-1);
    expect(request?.path).toBe("/api/filetree/createDocWithMd");
    expect(request?.headers["x-singularity-organization-id"]).toBe(installation.organizationId);
    expect(request?.headers["x-singularity-space-id"]).toBe(installation.spaceId);
    expect(request?.headers["x-singularity-notebook-id"]).toBe("20260723090000-l4book1");
    expect(JSON.parse(request?.body.toString("utf8") ?? "{}")).toMatchObject({ markdown: "# Runbook\n\nBody", notebook: "20260723090000-l4book1", path: "/Runbook.sy" });
    expect(await database.documentGovernance.findUnique({ where: { organizationId_spaceId_notebookId_documentId: { documentId: identity.documentId, notebookId: identity.notebookId, organizationId: identity.organizationId, spaceId: identity.spaceId } } })).toMatchObject({ classification: "confidential", verification: "needs_review" });
  });

  test("rejects an unpublished template before contacting Kernel", async () => {
    const installation = await initialize();
    const templatesPath = path(ORGANIZATION_SPACE_GOVERNANCE_TEMPLATES_PATH_TEMPLATE, { ...installation });
    const createTemplate = await fetch(`${testApi.baseUrl}${templatesPath}`, {
      body: JSON.stringify({ defaultClassification: "internal", initialContent: { markdown: "draft" }, name: "Draft", verificationIntervalDays: 30 }),
      headers: mutationHeaders(installation),
      method: "POST",
    });
    const template = governanceTemplateSchema.parse(await createTemplate.json());
    const documentPath = path(ORGANIZATION_SPACE_GOVERNANCE_TEMPLATE_DOCUMENTS_PATH_TEMPLATE, { ...installation, templateId: template.templateId });
    const before = kernel.requests.length;
    const response = await fetch(`${testApi.baseUrl}${documentPath}`, {
      body: JSON.stringify({ notebookId: "20260723090000-l4book1", title: "Draft" }),
      headers: mutationHeaders(installation),
      method: "POST",
    });
    expect(apiProblemSchema.parse(await response.json())).toMatchObject({ code: "not-found", status: 404 });
    expect(kernel.requests).toHaveLength(before);
  });
});
