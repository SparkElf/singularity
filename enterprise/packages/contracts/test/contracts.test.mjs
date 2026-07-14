import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { spaceRoles } from "@singularity/authorization";

import {
  ACCESS_OPERATION_INPUT_MAX_BYTES,
  API_PROBLEM_OPENAPI_SCHEMA_BY_STATUS,
  AUTHORIZED_SPACES_PATH,
  AUTH_LOGIN_PATH,
  SPACE_RUNTIME_BOOTSTRAP_OPENAPI_SCHEMA,
  SPACE_RUNTIME_CONTROLLER_PATH,
  SPACE_RUNTIME_PATH_TEMPLATE,
  accessOperationExitCodeByOutcome,
  accessOperationNames,
  accessOperationRejectionOutcomes,
  accessOperationResultSchemaByOperation,
  accessOperationSchema,
  apiProblemSchema,
  authorizedSpacesResponseSchema,
  buildSpaceRuntimePath,
  kernelInstanceStates,
  loginRequestSchema,
  spaceRuntimeBootstrapSchema,
} from "../dist/index.js";

const organizationId = "11111111-1111-4111-8111-111111111111";
const spaceId = "22222222-2222-4222-8222-222222222222";
const userId = "33333333-3333-4333-8333-333333333333";
const operationId = "44444444-4444-4444-8444-444444444444";
const requestId = "55555555-5555-4555-8555-555555555555";
const password = "correct horse battery staple";

describe("HTTP contracts", () => {
  test("normalizes a login identifier and rejects unknown request fields", () => {
    assert.deepEqual(
      loginRequestSchema.parse({
        loginIdentifier: "  Ａlice@Example.COM  ",
        password,
      }),
      {
        loginIdentifier: "alice@example.com",
        password,
      },
    );

    assert.equal(
      loginRequestSchema.safeParse({
        loginIdentifier: "alice@example.com",
        password,
        returnTo: "/spaces",
      }).success,
      false,
    );
  });

  test("counts Unicode password characters without rejecting valid astral input", () => {
    assert.equal(
      loginRequestSchema.safeParse({
        loginIdentifier: "alice@example.com",
        password: "😀".repeat(12),
      }).success,
      true,
    );
    assert.equal(
      loginRequestSchema.safeParse({
        loginIdentifier: "alice@example.com",
        password: "😀".repeat(11),
      }).success,
      false,
    );
  });

  test("binds each Problem code to its approved HTTP status", () => {
    assert.equal(
      apiProblemSchema.safeParse({
        code: "rate-limited",
        status: 429,
        requestId,
      }).success,
      true,
    );
    assert.equal(
      apiProblemSchema.safeParse({
        code: "rate-limited",
        status: 401,
        requestId,
      }).success,
      false,
    );

    const openApiCodesByStatus = {
      400: "validation-failed",
      401: "unauthenticated",
      403: "forbidden",
      404: "not-found",
      409: "conflict",
      422: "validation-failed",
      429: "rate-limited",
      502: "service-unavailable",
      503: "service-unavailable",
      504: "service-unavailable",
    };
    assert.deepEqual(
      Object.fromEntries(
        Object.entries(API_PROBLEM_OPENAPI_SCHEMA_BY_STATUS).map(
          ([status, schema]) => [
            status,
            {
              code: schema.properties.code.enum[0],
              status: schema.properties.status.enum[0],
            },
          ],
        ),
      ),
      Object.fromEntries(
        Object.entries(openApiCodesByStatus).map(([status, code]) => [
          status,
          { code, status: Number(status) },
        ]),
      ),
    );
    assert.equal(
      apiProblemSchema.safeParse({
        code: "not-found",
        status: 404,
        requestId,
        resource: "space",
      }).success,
      false,
    );
  });

  test("keeps authorization and runtime responses free of deployment fields", () => {
    const spaces = {
      spaces: spaceRoles.map((role, index) => ({
        organizationId,
        organizationName: "Singularity",
        spaceId:
          index === 0
            ? spaceId
            : `${index + 2}2222222-2222-4222-8222-222222222222`,
        spaceName: `Space ${index + 1}`,
        role,
      })),
    };
    assert.equal(authorizedSpacesResponseSchema.safeParse(spaces).success, true);

    assert.equal(
      spaceRuntimeBootstrapSchema.safeParse({
        organizationId,
        spaceId,
        role: "viewer",
        kernelState: "ready",
        deploymentHandle: "kernel.internal",
      }).success,
      false,
    );
  });

  test("derives path and OpenAPI enums from the public contract constants", () => {
    assert.equal(AUTH_LOGIN_PATH, "/api/v1/auth/login");
    assert.equal(AUTHORIZED_SPACES_PATH, "/api/v1/spaces");
    assert.equal(
      SPACE_RUNTIME_PATH_TEMPLATE,
      "/api/v1/organizations/{organizationId}/spaces/{spaceId}/runtime",
    );
    assert.equal(
      SPACE_RUNTIME_CONTROLLER_PATH,
      "/api/v1/organizations/:organizationId/spaces/:spaceId/runtime",
    );
    assert.equal(
      buildSpaceRuntimePath({ organizationId, spaceId }),
      `/api/v1/organizations/${organizationId}/spaces/${spaceId}/runtime`,
    );
    assert.deepEqual(
      SPACE_RUNTIME_BOOTSTRAP_OPENAPI_SCHEMA.properties.role.enum,
      [...spaceRoles],
    );
    assert.deepEqual(
      SPACE_RUNTIME_BOOTSTRAP_OPENAPI_SCHEMA.properties.kernelState.enum,
      [...kernelInstanceStates],
    );
  });
});

describe("controlled access operation contracts", () => {
  test("parses every approved operation and normalizes boundary text", () => {
    const operations = [
      {
        operation: "initialize",
        loginIdentifier: "  OWNER@EXAMPLE.COM ",
        password,
        organizationName: "  Singularity  ",
        spaceName: "  Research  ",
      },
      {
        operation: "create-user",
        organizationId,
        loginIdentifier: "EDITOR@EXAMPLE.COM",
        password,
      },
      {
        operation: "create-space",
        organizationId,
        name: "Operations",
        adminUserId: userId,
      },
      { operation: "set-kernel-state", spaceId, kernelState: "starting" },
      {
        operation: "set-kernel-state",
        spaceId,
        kernelState: "ready",
        deploymentHandle: "kernel-01.prod",
        version: "3.2.1+enterprise",
      },
      {
        operation: "set-kernel-state",
        spaceId,
        kernelState: "unavailable",
        deploymentHandle: "kernel-01.prod",
        version: "3.2.1+enterprise",
      },
      {
        operation: "set-space-member",
        spaceId,
        userId,
        role: "editor",
      },
      { operation: "revoke-space-member", spaceId, userId },
      { operation: "disable-organization", organizationId },
      { operation: "disable-space", spaceId },
      { operation: "revoke-organization-member", organizationId, userId },
      { operation: "disable-user", userId },
      { operation: "revoke-user-sessions", userId },
    ];

    const parsed = operations.map((operation) =>
      accessOperationSchema.parse(operation),
    );
    assert.equal(parsed.length, 13);
    assert.equal(parsed[0].loginIdentifier, "owner@example.com");
    assert.equal(parsed[0].organizationName, "Singularity");
    assert.equal(parsed[0].spaceName, "Research");
    assert.equal(ACCESS_OPERATION_INPUT_MAX_BYTES, 16_384);
  });

  test("enforces the Kernel state deployment-field invariant", () => {
    assert.equal(
      accessOperationSchema.safeParse({
        operation: "set-kernel-state",
        spaceId,
        kernelState: "starting",
        deploymentHandle: "must-not-survive",
        version: "1.0.0",
      }).success,
      false,
    );
    assert.equal(
      accessOperationSchema.safeParse({
        operation: "set-kernel-state",
        spaceId,
        kernelState: "ready",
      }).success,
      false,
    );
    assert.equal(
      accessOperationSchema.safeParse({
        operation: "set-kernel-state",
        spaceId,
        kernelState: "unavailable",
        deploymentHandle: "https://kernel.internal",
        version: "1.0.0",
      }).success,
      false,
    );
  });

  test("rejects caller-supplied duplicate ownership and sensitive result fields", () => {
    assert.equal(
      accessOperationSchema.safeParse({
        operation: "set-space-member",
        organizationId,
        spaceId,
        userId,
        role: "viewer",
      }).success,
      false,
    );
    assert.equal(
      accessOperationResultSchemaByOperation["set-kernel-state"].safeParse({
        operationId,
        outcome: "updated",
        deploymentHandle: "kernel-01.prod",
      }).success,
      false,
    );
  });

  test("maps every operation to its exact successes and business rejections", () => {
    const cases = [
      {
        operation: "initialize",
        successes: [
          {
            operationId,
            outcome: "created",
            userId,
            organizationId,
            spaceId,
          },
        ],
        rejections: ["already-initialized", "conflict"],
      },
      {
        operation: "create-user",
        successes: [{ operationId, outcome: "created", userId }],
        rejections: ["conflict", "not-found"],
      },
      {
        operation: "create-space",
        successes: [{ operationId, outcome: "created", spaceId }],
        rejections: ["conflict", "not-found"],
      },
      {
        operation: "set-kernel-state",
        successes: [{ operationId, outcome: "updated" }],
        rejections: ["conflict", "not-found"],
      },
      {
        operation: "set-space-member",
        successes: [
          { operationId, outcome: "created" },
          { operationId, outcome: "updated" },
        ],
        rejections: ["conflict", "not-found"],
      },
      {
        operation: "revoke-space-member",
        successes: [{ operationId, outcome: "revoked" }],
        rejections: ["not-found"],
      },
      {
        operation: "disable-organization",
        successes: [{ operationId, outcome: "updated" }],
        rejections: ["not-found"],
      },
      {
        operation: "disable-space",
        successes: [{ operationId, outcome: "updated" }],
        rejections: ["not-found"],
      },
      {
        operation: "revoke-organization-member",
        successes: [{ operationId, outcome: "revoked" }],
        rejections: ["conflict", "not-found"],
      },
      {
        operation: "disable-user",
        successes: [{ operationId, outcome: "updated" }],
        rejections: ["conflict", "not-found"],
      },
      {
        operation: "revoke-user-sessions",
        successes: [{ operationId, outcome: "revoked" }],
        rejections: ["not-found"],
      },
    ];

    assert.deepEqual(
      cases.map(({ operation }) => operation),
      [...accessOperationNames],
    );
    assert.deepEqual(Object.keys(accessOperationResultSchemaByOperation), [
      ...accessOperationNames,
    ]);

    for (const { operation, successes, rejections } of cases) {
      const schema = accessOperationResultSchemaByOperation[operation];
      for (const result of successes) {
        assert.equal(
          schema.safeParse(result).success,
          true,
          `${operation} must accept ${result.outcome}`,
        );
      }
      for (const outcome of accessOperationRejectionOutcomes) {
        assert.equal(
          schema.safeParse({ operationId, outcome }).success,
          rejections.includes(outcome),
          `${operation} rejection ${outcome}`,
        );
      }
      assert.equal(
        schema.safeParse({ operationId, outcome: "failed" }).success,
        true,
        `${operation} must accept failed`,
      );
    }

    const memberCreated = { operationId, outcome: "created" };
    assert.equal(
      accessOperationResultSchemaByOperation["set-space-member"].safeParse(
        memberCreated,
      ).success,
      true,
    );
    for (const operation of ["initialize", "create-user", "create-space"]) {
      assert.equal(
        accessOperationResultSchemaByOperation[operation].safeParse(memberCreated)
          .success,
        false,
      );
    }
  });

  test("fixes operation outcomes to their process exit codes", () => {
    const cases = [
      {
        operation: "initialize",
        result: {
          operationId,
          outcome: "created",
          userId,
          organizationId,
          spaceId,
        },
      },
      {
        operation: "set-space-member",
        result: { operationId, outcome: "created" },
      },
      {
        operation: "disable-space",
        result: { operationId, outcome: "updated" },
      },
      {
        operation: "revoke-space-member",
        result: { operationId, outcome: "revoked" },
      },
      {
        operation: "initialize",
        result: { operationId, outcome: "already-initialized" },
      },
      {
        operation: "disable-user",
        result: { operationId, outcome: "conflict" },
      },
      {
        operation: "disable-space",
        result: { operationId, outcome: "not-found" },
      },
      {
        operation: "revoke-user-sessions",
        result: { operationId, outcome: "failed" },
      },
    ];

    for (const { operation, result } of cases) {
      const parsed =
        accessOperationResultSchemaByOperation[operation].parse(result);
      assert.equal(
        accessOperationExitCodeByOutcome[parsed.outcome],
        parsed.outcome === "failed"
          ? 1
          : ["already-initialized", "conflict", "not-found"].includes(
                parsed.outcome,
              )
            ? 2
            : 0,
      );
    }
  });
});
