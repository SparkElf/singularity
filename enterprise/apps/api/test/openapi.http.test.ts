import {
  API_PROBLEM_OPENAPI_SCHEMA_BY_STATUS,
  AUTHORIZED_SPACES_PATH,
  AUTH_CSRF_PATH,
  AUTH_INVITATION_ACCEPT_LOCAL_PATH,
  AUTH_INVITATION_ACCEPT_PATH,
  AUTH_LOGIN_PATH,
  AUTH_LOGOUT_PATH,
  AUTH_OIDC_CALLBACK_PATH,
  AUTH_OIDC_PROVIDERS_PATH,
  AUTH_OIDC_START_PATH,
  AUTH_SESSION_COOKIE_NAME,
  CSRF_HEADER_NAME,
  CSRF_TOKEN_OPENAPI_SCHEMA,
  CONTENT_DIRECTORY_CHILD_DOCUMENTS_PATH_TEMPLATE,
  CONTENT_DIRECTORY_NOTEBOOKS_PATH_TEMPLATE,
  CONTENT_DIRECTORY_ROOT_DOCUMENTS_PATH_TEMPLATE,
  DATABASE_READINESS_PATH,
  DATABASE_READY_OPENAPI_SCHEMA,
  DATABASE_UNAVAILABLE_OPENAPI_SCHEMA,
  OPENAPI_DOCUMENT_PATH,
  ORGANIZATION_AUDIT_EVENTS_PATH_TEMPLATE,
  ORGANIZATION_GROUP_MEMBERS_PATH_TEMPLATE,
  ORGANIZATION_GROUP_MEMBER_PATH_TEMPLATE,
  ORGANIZATION_GROUPS_PATH_TEMPLATE,
  ORGANIZATION_GROUP_PATH_TEMPLATE,
  ORGANIZATION_INVITATIONS_PATH_TEMPLATE,
  ORGANIZATION_INVITATION_PATH_TEMPLATE,
  ORGANIZATION_MEMBER_PATH_TEMPLATE,
  ORGANIZATION_MEMBER_SESSIONS_PATH_TEMPLATE,
  ORGANIZATION_MEMBERS_PATH_TEMPLATE,
  ORGANIZATION_OIDC_PROVIDERS_PATH_TEMPLATE,
  ORGANIZATION_OIDC_PROVIDER_PATH_TEMPLATE,
  ORGANIZATION_OWNERSHIP_PATH_TEMPLATE,
  ORGANIZATION_SPACE_AUDIT_EVENTS_PATH_TEMPLATE,
  ORGANIZATION_SPACE_BACKUPS_PATH_TEMPLATE,
  ORGANIZATION_SPACE_BACKUP_RESTORES_PATH_TEMPLATE,
  ORGANIZATION_SPACE_GROUPS_PATH_TEMPLATE,
  ORGANIZATION_SPACE_GROUP_CANDIDATES_PATH_TEMPLATE,
  ORGANIZATION_SPACE_GROUP_PATH_TEMPLATE,
  ORGANIZATION_SPACE_MEMBER_CANDIDATES_PATH_TEMPLATE,
  ORGANIZATION_SPACE_MEMBER_PATH_TEMPLATE,
  ORGANIZATION_SPACE_MEMBERS_PATH_TEMPLATE,
  ORGANIZATION_SPACE_OBSERVABILITY_PATH_TEMPLATE,
  ORGANIZATION_SPACE_PATH_TEMPLATE,
  ORGANIZATION_SPACES_PATH_TEMPLATE,
  ORGANIZATION_SPACE_RESTORE_ACTIVATION_PATH_TEMPLATE,
  ORGANIZATION_SPACE_RESTORE_PATH_TEMPLATE,
  ORGANIZATION_SPACE_SHARE_PASSWORD_PATH_TEMPLATE,
  ORGANIZATION_SPACE_SHARE_PATH_TEMPLATE,
  ORGANIZATION_SPACE_SHARES_PATH_TEMPLATE,
  PUBLIC_SHARE_ASSET_PATH_TEMPLATE,
  PUBLIC_SHARE_CHALLENGE_PATH_TEMPLATE,
  PUBLIC_SHARE_PATH_TEMPLATE,
  SPACE_RUNTIME_PATH_TEMPLATE,
} from "@singularity/contracts";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import {
  startTestApiApplication,
  type TestApiApplication,
} from "./support/test-app.js";

type HttpMethod = "delete" | "get" | "patch" | "post" | "put";

interface RouteInventoryEntry {
  methods: readonly HttpMethod[];
  path: string;
}

const DOCUMENTED_ROUTE_INVENTORY: readonly RouteInventoryEntry[] = [
  { methods: ["get"], path: DATABASE_READINESS_PATH },
  { methods: ["post"], path: AUTH_INVITATION_ACCEPT_LOCAL_PATH },
  { methods: ["post"], path: AUTH_INVITATION_ACCEPT_PATH },
  { methods: ["post"], path: AUTH_LOGIN_PATH },
  { methods: ["get"], path: AUTH_CSRF_PATH },
  { methods: ["post"], path: AUTH_LOGOUT_PATH },
  { methods: ["get"], path: AUTH_OIDC_PROVIDERS_PATH },
  { methods: ["post"], path: AUTH_OIDC_START_PATH },
  { methods: ["get"], path: AUTH_OIDC_CALLBACK_PATH },
  { methods: ["get"], path: AUTHORIZED_SPACES_PATH },
  { methods: ["get"], path: SPACE_RUNTIME_PATH_TEMPLATE },
  { methods: ["get"], path: CONTENT_DIRECTORY_NOTEBOOKS_PATH_TEMPLATE },
  { methods: ["get"], path: CONTENT_DIRECTORY_ROOT_DOCUMENTS_PATH_TEMPLATE },
  { methods: ["get"], path: CONTENT_DIRECTORY_CHILD_DOCUMENTS_PATH_TEMPLATE },
  { methods: ["get"], path: ORGANIZATION_MEMBERS_PATH_TEMPLATE },
  { methods: ["patch"], path: ORGANIZATION_MEMBER_PATH_TEMPLATE },
  { methods: ["post"], path: ORGANIZATION_MEMBER_SESSIONS_PATH_TEMPLATE },
  { methods: ["post"], path: ORGANIZATION_OWNERSHIP_PATH_TEMPLATE },
  { methods: ["get", "post"], path: ORGANIZATION_INVITATIONS_PATH_TEMPLATE },
  { methods: ["delete"], path: ORGANIZATION_INVITATION_PATH_TEMPLATE },
  { methods: ["get", "post"], path: ORGANIZATION_GROUPS_PATH_TEMPLATE },
  { methods: ["patch"], path: ORGANIZATION_GROUP_PATH_TEMPLATE },
  { methods: ["get"], path: ORGANIZATION_GROUP_MEMBERS_PATH_TEMPLATE },
  {
    methods: ["delete", "put"],
    path: ORGANIZATION_GROUP_MEMBER_PATH_TEMPLATE,
  },
  { methods: ["get", "post"], path: ORGANIZATION_SPACES_PATH_TEMPLATE },
  { methods: ["get", "patch"], path: ORGANIZATION_SPACE_PATH_TEMPLATE },
  { methods: ["get"], path: ORGANIZATION_SPACE_MEMBERS_PATH_TEMPLATE },
  {
    methods: ["get"],
    path: ORGANIZATION_SPACE_MEMBER_CANDIDATES_PATH_TEMPLATE,
  },
  { methods: ["delete", "put"], path: ORGANIZATION_SPACE_MEMBER_PATH_TEMPLATE },
  { methods: ["get"], path: ORGANIZATION_SPACE_GROUPS_PATH_TEMPLATE },
  {
    methods: ["get"],
    path: ORGANIZATION_SPACE_GROUP_CANDIDATES_PATH_TEMPLATE,
  },
  { methods: ["delete", "put"], path: ORGANIZATION_SPACE_GROUP_PATH_TEMPLATE },
  { methods: ["get", "post"], path: ORGANIZATION_OIDC_PROVIDERS_PATH_TEMPLATE },
  { methods: ["patch"], path: ORGANIZATION_OIDC_PROVIDER_PATH_TEMPLATE },
  { methods: ["get"], path: ORGANIZATION_AUDIT_EVENTS_PATH_TEMPLATE },
  { methods: ["get"], path: ORGANIZATION_SPACE_AUDIT_EVENTS_PATH_TEMPLATE },
  { methods: ["get", "post"], path: ORGANIZATION_SPACE_SHARES_PATH_TEMPLATE },
  { methods: ["delete"], path: ORGANIZATION_SPACE_SHARE_PATH_TEMPLATE },
  { methods: ["patch"], path: ORGANIZATION_SPACE_SHARE_PASSWORD_PATH_TEMPLATE },
  { methods: ["get"], path: ORGANIZATION_SPACE_BACKUPS_PATH_TEMPLATE },
  { methods: ["post"], path: ORGANIZATION_SPACE_BACKUPS_PATH_TEMPLATE },
  {
    methods: ["post"],
    path: ORGANIZATION_SPACE_BACKUP_RESTORES_PATH_TEMPLATE,
  },
  { methods: ["get"], path: ORGANIZATION_SPACE_RESTORE_PATH_TEMPLATE },
  {
    methods: ["post"],
    path: ORGANIZATION_SPACE_RESTORE_ACTIVATION_PATH_TEMPLATE,
  },
  { methods: ["get"], path: ORGANIZATION_SPACE_OBSERVABILITY_PATH_TEMPLATE },
  { methods: ["get"], path: PUBLIC_SHARE_PATH_TEMPLATE },
  { methods: ["post"], path: PUBLIC_SHARE_CHALLENGE_PATH_TEMPLATE },
  { methods: ["get"], path: PUBLIC_SHARE_ASSET_PATH_TEMPLATE },
];

type OperationReference = readonly [path: string, method: HttpMethod];

const AUTHENTICATED_OPERATIONS: readonly OperationReference[] = [
  [AUTH_CSRF_PATH, "get"],
  [AUTHORIZED_SPACES_PATH, "get"],
  [SPACE_RUNTIME_PATH_TEMPLATE, "get"],
  [CONTENT_DIRECTORY_NOTEBOOKS_PATH_TEMPLATE, "get"],
  [CONTENT_DIRECTORY_ROOT_DOCUMENTS_PATH_TEMPLATE, "get"],
  [CONTENT_DIRECTORY_CHILD_DOCUMENTS_PATH_TEMPLATE, "get"],
  [ORGANIZATION_MEMBERS_PATH_TEMPLATE, "get"],
  [ORGANIZATION_INVITATIONS_PATH_TEMPLATE, "get"],
  [ORGANIZATION_GROUPS_PATH_TEMPLATE, "get"],
  [ORGANIZATION_GROUP_MEMBERS_PATH_TEMPLATE, "get"],
  [ORGANIZATION_SPACES_PATH_TEMPLATE, "get"],
  [ORGANIZATION_SPACE_PATH_TEMPLATE, "get"],
  [ORGANIZATION_SPACE_MEMBERS_PATH_TEMPLATE, "get"],
  [ORGANIZATION_SPACE_MEMBER_CANDIDATES_PATH_TEMPLATE, "get"],
  [ORGANIZATION_SPACE_GROUPS_PATH_TEMPLATE, "get"],
  [ORGANIZATION_SPACE_GROUP_CANDIDATES_PATH_TEMPLATE, "get"],
  [ORGANIZATION_OIDC_PROVIDERS_PATH_TEMPLATE, "get"],
  [ORGANIZATION_AUDIT_EVENTS_PATH_TEMPLATE, "get"],
  [ORGANIZATION_SPACE_AUDIT_EVENTS_PATH_TEMPLATE, "get"],
  [ORGANIZATION_SPACE_SHARES_PATH_TEMPLATE, "get"],
  [ORGANIZATION_SPACE_BACKUPS_PATH_TEMPLATE, "get"],
  [ORGANIZATION_SPACE_RESTORE_PATH_TEMPLATE, "get"],
  [ORGANIZATION_SPACE_OBSERVABILITY_PATH_TEMPLATE, "get"],
];

const MUTATION_OPERATIONS: readonly OperationReference[] = [
  [AUTH_INVITATION_ACCEPT_PATH, "post"],
  [AUTH_LOGOUT_PATH, "post"],
  [ORGANIZATION_MEMBER_PATH_TEMPLATE, "patch"],
  [ORGANIZATION_MEMBER_SESSIONS_PATH_TEMPLATE, "post"],
  [ORGANIZATION_OWNERSHIP_PATH_TEMPLATE, "post"],
  [ORGANIZATION_INVITATIONS_PATH_TEMPLATE, "post"],
  [ORGANIZATION_INVITATION_PATH_TEMPLATE, "delete"],
  [ORGANIZATION_GROUPS_PATH_TEMPLATE, "post"],
  [ORGANIZATION_GROUP_PATH_TEMPLATE, "patch"],
  [ORGANIZATION_GROUP_MEMBER_PATH_TEMPLATE, "put"],
  [ORGANIZATION_GROUP_MEMBER_PATH_TEMPLATE, "delete"],
  [ORGANIZATION_SPACES_PATH_TEMPLATE, "post"],
  [ORGANIZATION_SPACE_PATH_TEMPLATE, "patch"],
  [ORGANIZATION_SPACE_MEMBER_PATH_TEMPLATE, "put"],
  [ORGANIZATION_SPACE_MEMBER_PATH_TEMPLATE, "delete"],
  [ORGANIZATION_SPACE_GROUP_PATH_TEMPLATE, "put"],
  [ORGANIZATION_SPACE_GROUP_PATH_TEMPLATE, "delete"],
  [ORGANIZATION_OIDC_PROVIDERS_PATH_TEMPLATE, "post"],
  [ORGANIZATION_OIDC_PROVIDER_PATH_TEMPLATE, "patch"],
  [ORGANIZATION_SPACE_SHARES_PATH_TEMPLATE, "post"],
  [ORGANIZATION_SPACE_SHARE_PASSWORD_PATH_TEMPLATE, "patch"],
  [ORGANIZATION_SPACE_SHARE_PATH_TEMPLATE, "delete"],
  [ORGANIZATION_SPACE_BACKUPS_PATH_TEMPLATE, "post"],
  [ORGANIZATION_SPACE_BACKUP_RESTORES_PATH_TEMPLATE, "post"],
  [ORGANIZATION_SPACE_RESTORE_ACTIVATION_PATH_TEMPLATE, "post"],
];

const ORIGIN_ONLY_OPERATIONS: readonly OperationReference[] = [
  [AUTH_INVITATION_ACCEPT_LOCAL_PATH, "post"],
  [AUTH_LOGIN_PATH, "post"],
  [AUTH_OIDC_START_PATH, "post"],
  [PUBLIC_SHARE_CHALLENGE_PATH_TEMPLATE, "post"],
];

interface OpenApiParameter {
  in: string;
  name: string;
  required?: boolean;
  schema?: unknown;
}

interface OpenApiResponse {
  content?: Record<string, { schema: unknown }>;
  headers?: Record<
    string,
    { description?: string; required?: boolean; schema?: unknown }
  >;
}

interface OpenApiOperation {
  parameters?: OpenApiParameter[];
  responses: Record<string, OpenApiResponse>;
  security?: Array<Record<string, unknown[]>>;
}

interface OpenApiDocument {
  components?: {
    securitySchemes?: Record<string, unknown>;
  };
  openapi: string;
  paths: Record<string, Partial<Record<HttpMethod, OpenApiOperation>>>;
}

function operation(
  document: OpenApiDocument,
  path: string,
  method: HttpMethod,
): OpenApiOperation {
  const value = document.paths[path]?.[method];
  if (value === undefined) {
    throw new Error(`OpenAPI operation ${method.toUpperCase()} ${path} is missing`);
  }
  return value;
}

function responseSchema(response: OpenApiResponse | undefined): unknown {
  return response?.content?.["application/json"]?.schema;
}

describe("generated OpenAPI HTTP contract", () => {
  let document: OpenApiDocument;
  let testApi: TestApiApplication;

  beforeAll(async () => {
    testApi = await startTestApiApplication();
    const response = await fetch(`${testApi.baseUrl}${OPENAPI_DOCUMENT_PATH}`);
    expect(response.status).toBe(200);
    document = (await response.json()) as OpenApiDocument;
  });

  afterAll(async () => {
    await testApi.dispose();
  });

  test("publishes the complete HTTP route inventory and readiness schemas", () => {
    expect(document.openapi).toBe("3.1.0");
    expect(Object.keys(document.paths).sort()).toEqual(
      DOCUMENTED_ROUTE_INVENTORY.map(({ path }) => path)
        .filter((path, index, paths) => paths.indexOf(path) === index)
        .sort(),
    );
    for (const { methods, path } of DOCUMENTED_ROUTE_INVENTORY) {
      const declaredMethods = Object.keys(document.paths[path] ?? {})
        .filter((method): method is HttpMethod =>
          ["delete", "get", "patch", "post", "put"].includes(method),
        )
        .sort();
      expect(declaredMethods).toEqual([...methods].sort());
    }

    const readiness = operation(document, DATABASE_READINESS_PATH, "get");
    expect(Object.keys(readiness.responses).sort()).toEqual(["200", "503"]);
    expect(responseSchema(readiness.responses["200"])).toEqual(
      DATABASE_READY_OPENAPI_SCHEMA,
    );
    expect(responseSchema(readiness.responses["503"])).toEqual(
      DATABASE_UNAVAILABLE_OPENAPI_SCHEMA,
    );
  });

  test("declares the session Cookie security scheme on authenticated operations", () => {
    expect(
      document.components?.securitySchemes?.[AUTH_SESSION_COOKIE_NAME],
    ).toEqual({
      in: "cookie",
      name: AUTH_SESSION_COOKIE_NAME,
      type: "apiKey",
    });

    for (const [path, method] of AUTHENTICATED_OPERATIONS) {
      expect(operation(document, path, method).security).toEqual([
        { [AUTH_SESSION_COOKIE_NAME]: [] },
      ]);
    }
    expect(operation(document, AUTH_LOGIN_PATH, "post").security).toBeUndefined();
  });

  test("declares Origin and CSRF headers for every browser mutation", () => {
    for (const [path, method] of MUTATION_OPERATIONS) {
      const current = operation(document, path, method);
      expect(current.security).toEqual([
        { [AUTH_SESSION_COOKIE_NAME]: [] },
      ]);
      expect(current.parameters).toContainEqual({
        in: "header",
        name: "Origin",
        required: true,
        schema: { format: "uri", type: "string" },
      });
      expect(current.parameters).toContainEqual({
        in: "header",
        name: CSRF_HEADER_NAME,
        required: true,
        schema: CSRF_TOKEN_OPENAPI_SCHEMA,
      });
    }

    for (const [path, method] of ORIGIN_ONLY_OPERATIONS) {
      const current = operation(document, path, method);
      expect(current.security).toBeUndefined();
      expect(current.parameters).toContainEqual({
        in: "header",
        name: "Origin",
        required: true,
        schema: { format: "uri", type: "string" },
      });
      expect(current.parameters).not.toContainEqual(
        expect.objectContaining({ name: CSRF_HEADER_NAME }),
      );
    }
  });

  test("declares required Origin, CSRF, and Retry-After headers", () => {
    const login = operation(document, AUTH_LOGIN_PATH, "post");
    expect(login.parameters).toContainEqual({
      in: "header",
      name: "Origin",
      required: true,
      schema: { format: "uri", type: "string" },
    });
    expect(login.responses["429"]?.headers?.["Retry-After"]).toMatchObject({
      required: true,
      schema: { minimum: 1, type: "integer" },
    });

    const logout = operation(document, AUTH_LOGOUT_PATH, "post");
    expect(logout.parameters).toContainEqual({
      in: "header",
      name: "Origin",
      required: true,
      schema: { format: "uri", type: "string" },
    });
    expect(logout.parameters).toContainEqual({
      in: "header",
      name: CSRF_HEADER_NAME,
      required: true,
      schema: CSRF_TOKEN_OPENAPI_SCHEMA,
    });
  });

  test.each([
    {
      method: "post",
      path: AUTH_LOGIN_PATH,
      statuses: [200, 400, 401, 403, 429, 503],
    },
    {
      method: "get",
      path: AUTH_CSRF_PATH,
      statuses: [200, 401, 503],
    },
    {
      method: "post",
      path: AUTH_LOGOUT_PATH,
      statuses: [204, 401, 403, 503],
    },
    {
      method: "get",
      path: AUTHORIZED_SPACES_PATH,
      statuses: [200, 401, 503],
    },
    {
      method: "get",
      path: SPACE_RUNTIME_PATH_TEMPLATE,
      statuses: [200, 400, 401, 404, 503],
    },
  ] as const)(
    "$method $path declares only its real success and Problem statuses",
    ({ method, path, statuses }) => {
      const responses = operation(document, path, method).responses;
      expect(Object.keys(responses).sort()).toEqual(
        statuses.map(String).sort(),
      );
      for (const status of statuses) {
        if (status < 400) {
          continue;
        }
        expect(responseSchema(responses[String(status)])).toEqual(
          API_PROBLEM_OPENAPI_SCHEMA_BY_STATUS[
            status as keyof typeof API_PROBLEM_OPENAPI_SCHEMA_BY_STATUS
          ],
        );
      }
    },
  );
});
