import {
  API_PROBLEM_OPENAPI_SCHEMA_BY_STATUS,
  AUTHORIZED_SPACES_PATH,
  AUTH_CSRF_PATH,
  AUTH_LOGIN_PATH,
  AUTH_LOGOUT_PATH,
  AUTH_SESSION_COOKIE_NAME,
  CSRF_HEADER_NAME,
  CSRF_TOKEN_OPENAPI_SCHEMA,
  DATABASE_READINESS_PATH,
  DATABASE_READY_OPENAPI_SCHEMA,
  DATABASE_UNAVAILABLE_OPENAPI_SCHEMA,
  OPENAPI_DOCUMENT_PATH,
  SPACE_RUNTIME_PATH_TEMPLATE,
} from "@singularity/contracts";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import {
  startTestApiApplication,
  type TestApiApplication,
} from "./support/test-app.js";

type HttpMethod = "get" | "post";

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
      [
        AUTHORIZED_SPACES_PATH,
        AUTH_CSRF_PATH,
        AUTH_LOGIN_PATH,
        AUTH_LOGOUT_PATH,
        DATABASE_READINESS_PATH,
        SPACE_RUNTIME_PATH_TEMPLATE,
      ].sort(),
    );

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

    for (const [path, method] of [
      [AUTH_CSRF_PATH, "get"],
      [AUTH_LOGOUT_PATH, "post"],
      [AUTHORIZED_SPACES_PATH, "get"],
      [SPACE_RUNTIME_PATH_TEMPLATE, "get"],
    ] as const) {
      expect(operation(document, path, method).security).toEqual([
        { [AUTH_SESSION_COOKIE_NAME]: [] },
      ]);
    }
    expect(operation(document, AUTH_LOGIN_PATH, "post").security).toBeUndefined();
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
