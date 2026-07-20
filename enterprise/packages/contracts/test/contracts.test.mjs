import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { spaceRoles } from "@singularity/authorization";

import {
  ACCESS_OPERATION_INPUT_MAX_BYTES,
  ACCEPT_LOCAL_ORGANIZATION_INVITATION_REQUEST_OPENAPI_SCHEMA,
  AUDIT_EVENT_OPENAPI_SCHEMA,
  API_PROBLEM_OPENAPI_SCHEMA_BY_STATUS,
  AUTHORIZED_SPACES_PATH,
  AUTH_LOGIN_PATH,
  ENTERPRISE_MANAGEMENT_ACCESS_PATH,
  INVITATION_TOKEN_OPENAPI_SCHEMA,
  ORGANIZATION_MEMBER_SUMMARY_OPENAPI_SCHEMA,
  ORGANIZATION_AUDIT_EVENTS_CONTROLLER_PATH,
  ORGANIZATION_SPACE_BACKUPS_CONTROLLER_PATH,
  ORGANIZATION_SPACE_RESTORES_CONTROLLER_PATH,
  ORGANIZATION_SPACE_OBSERVABILITY_CONTROLLER_PATH,
  ORGANIZATION_SPACE_SHARES_CONTROLLER_PATH,
  PUBLIC_SHARE_CONTROLLER_PATH,
  CHANGE_DOCUMENT_SHARE_PASSWORD_REQUEST_OPENAPI_SCHEMA,
  CREATE_DOCUMENT_SHARE_REQUEST_OPENAPI_SCHEMA,
  CREATE_ORGANIZATION_INVITATION_REQUEST_OPENAPI_SCHEMA,
  CREATE_SHARE_CHALLENGE_REQUEST_OPENAPI_SCHEMA,
  SHARED_DOCUMENT_PAYLOAD_OPENAPI_SCHEMA,
  SPACE_RUNTIME_BOOTSTRAP_OPENAPI_SCHEMA,
  SPACE_RUNTIME_CONTROLLER_PATH,
  SPACE_RUNTIME_PATH_TEMPLATE,
  UPDATE_ORGANIZATION_MEMBER_REQUEST_OPENAPI_SCHEMA,
  UPDATE_SPACE_REQUEST_OPENAPI_SCHEMA,
  UPDATE_USER_GROUP_REQUEST_OPENAPI_SCHEMA,
  USER_GROUP_SUMMARY_OPENAPI_SCHEMA,
  accessOperationExitCodeByOutcome,
  accessOperationNames,
  accessOperationRejectionOutcomes,
  accessOperationResultSchemaByOperation,
  accessOperationSchema,
  apiProblemSchema,
  auditEventsQuerySchema,
  auditEventsResponseSchema,
  auditOutcomes,
  auditTargetTypes,
  authorizedSpacesResponseSchema,
  buildSpaceRuntimePath,
  createDocumentShareRequestSchema,
  createOrganizationInvitationRequestSchema,
  enterpriseManagementAccessResponseSchema,
  invitationTokenSchema,
  kernelInstanceStates,
  loginRequestSchema,
  managedDocumentSharesResponseSchema,
  organizationMemberSummarySchema,
  organizationManagementCapabilities,
  spaceBackupSchema,
  spaceManagementCapabilities,
  spaceObservabilitySchema,
  spaceRestoreSchema,
  spaceRestoresResponseSchema,
  spaceRuntimeBootstrapSchema,
  sharedDocumentPayloadSchema,
  updateOrganizationMemberRequestSchema,
  updateSpaceRequestSchema,
  updateUserGroupRequestSchema,
  unactivatedSpaceRestoreStatuses,
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

  test("aligns organization invitation normalization and expiry limits with OpenAPI", () => {
    const canonicalToken = "A".repeat(43);
    const noncanonicalToken = `${"A".repeat(42)}B`;
    assert.deepEqual(
      createOrganizationInvitationRequestSchema.parse({
        expiresInHours: 24,
        loginIdentifier: "  Ａlice@Example.COM  ",
        role: "member",
      }),
      {
        expiresInHours: 24,
        loginIdentifier: "alice@example.com",
        role: "member",
      },
    );
    assert.equal(
      createOrganizationInvitationRequestSchema.safeParse({
        expiresInHours: 0,
        loginIdentifier: "alice@example.com",
        role: "member",
      }).success,
      false,
    );
    assert.equal(
      createOrganizationInvitationRequestSchema.safeParse({
        expiresInHours: 721,
        loginIdentifier: "alice@example.com",
        role: "member",
      }).success,
      false,
    );
    assert.equal(invitationTokenSchema.safeParse(canonicalToken).success, true);
    assert.equal(
      invitationTokenSchema.safeParse(noncanonicalToken).success,
      false,
    );
    assert.deepEqual(
      CREATE_ORGANIZATION_INVITATION_REQUEST_OPENAPI_SCHEMA.properties
        .expiresInHours,
      { maximum: 720, minimum: 1, type: "integer" },
    );
    assert.deepEqual(
      CREATE_ORGANIZATION_INVITATION_REQUEST_OPENAPI_SCHEMA.properties
        .loginIdentifier,
      { maxLength: 254, minLength: 3, type: "string" },
    );
    assert.equal(
      new RegExp(INVITATION_TOKEN_OPENAPI_SCHEMA.pattern).test(canonicalToken),
      true,
    );
    assert.equal(
      new RegExp(INVITATION_TOKEN_OPENAPI_SCHEMA.pattern).test(
        noncanonicalToken,
      ),
      false,
    );
  });

  test("aligns management patch and member projection schemas with OpenAPI", () => {
    const patchContracts = [
      [
        updateOrganizationMemberRequestSchema,
        UPDATE_ORGANIZATION_MEMBER_REQUEST_OPENAPI_SCHEMA,
      ],
      [updateUserGroupRequestSchema, UPDATE_USER_GROUP_REQUEST_OPENAPI_SCHEMA],
      [updateSpaceRequestSchema, UPDATE_SPACE_REQUEST_OPENAPI_SCHEMA],
    ];
    for (const [runtimeSchema, openApiSchema] of patchContracts) {
      assert.equal(runtimeSchema.safeParse({}).success, false);
      assert.equal(openApiSchema.minProperties, 1);
    }

    assert.deepEqual(
      organizationMemberSummarySchema.parse({
        accountStatus: "disabled",
        loginIdentifier: "disabled@example.test",
        role: "member",
        status: "active",
        userId,
      }),
      {
        accountStatus: "disabled",
        loginIdentifier: "disabled@example.test",
        role: "member",
        status: "active",
        userId,
      },
    );
    assert.deepEqual(
      ORGANIZATION_MEMBER_SUMMARY_OPENAPI_SCHEMA.properties.accountStatus,
      { enum: ["active", "disabled"], type: "string" },
    );
    assert.deepEqual(USER_GROUP_SUMMARY_OPENAPI_SCHEMA.properties.memberCount, {
      minimum: 0,
      type: "integer",
    });
    assert.deepEqual(
      ACCEPT_LOCAL_ORGANIZATION_INVITATION_REQUEST_OPENAPI_SCHEMA.properties
        .password,
      { maxLength: 128, minLength: 12, type: "string" },
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

  test("publishes explicit enterprise management capabilities without role inference fields", () => {
    const access = {
      organizations: [
        {
          organizationCapabilities: [...organizationManagementCapabilities],
          organizationId,
          organizationName: "Singularity",
          spaces: [
            {
              capabilities: [...spaceManagementCapabilities],
              spaceId,
              spaceName: "Primary space",
            },
          ],
        },
      ],
    };
    assert.deepEqual(enterpriseManagementAccessResponseSchema.parse(access), access);
    assert.equal(
      enterpriseManagementAccessResponseSchema.safeParse({
        organizations: [
          {
            ...access.organizations[0],
            organizationRole: "owner",
          },
        ],
      }).success,
      false,
    );
    assert.equal(
      ENTERPRISE_MANAGEMENT_ACCESS_PATH,
      "/api/v1/enterprise-management-access",
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

  test("publishes one strict document-share request and response contract", () => {
    const expiresAt = "2026-08-18T00:00:00.000Z";
    assert.deepEqual(
      createDocumentShareRequestSchema.parse({
        documentId: "20260718010101-abcdefg",
        expiresAt,
        notebookId: "20260718010102-hijklmn",
        password: null,
      }),
      {
        documentId: "20260718010101-abcdefg",
        expiresAt,
        notebookId: "20260718010102-hijklmn",
        password: null,
      },
    );
    assert.equal(
      createDocumentShareRequestSchema.safeParse({
        documentId: "20260718010101-abcdefg",
        expiresAt,
        notebookId: "20260718010102-hijklmn",
        snapshot: true,
      }).success,
      false,
    );
    assert.equal(
      managedDocumentSharesResponseSchema.safeParse({
        shares: [
          {
            createdAt: "2026-07-18T00:00:00.000Z",
            documentId: "20260718010101-abcdefg",
            expiresAt,
            hasPassword: false,
            notebookId: "20260718010102-hijklmn",
            organizationId,
            revokedAt: null,
            shareId: operationId,
            spaceId,
          },
        ],
      }).success,
      true,
    );
    const publicDocument = {
      assets: [],
      html: "<p>Shared content</p>",
      title: "Shared document",
    };
    assert.deepEqual(
      sharedDocumentPayloadSchema.parse(publicDocument),
      publicDocument,
    );
    assert.equal(
      sharedDocumentPayloadSchema.safeParse({
        assets: [],
        documentId: "20260718010101-abcdefg",
        html: "<p>Shared content</p>",
        title: "Shared document",
      }).success,
      false,
    );
    assert.equal(
      "documentId" in SHARED_DOCUMENT_PAYLOAD_OPENAPI_SCHEMA.properties,
      false,
    );
    assert.equal(
      ORGANIZATION_SPACE_SHARES_CONTROLLER_PATH,
      "/api/v1/organizations/:organizationId/spaces/:spaceId/shares",
    );
    assert.equal(PUBLIC_SHARE_CONTROLLER_PATH, "/api/v1/shares/:shareToken");
    assert.equal(
      CREATE_DOCUMENT_SHARE_REQUEST_OPENAPI_SCHEMA.properties.password.minLength,
      12,
    );
    assert.equal(
      CHANGE_DOCUMENT_SHARE_PASSWORD_REQUEST_OPENAPI_SCHEMA.properties.password.maxLength,
      128,
    );
    assert.equal(
      CREATE_SHARE_CHALLENGE_REQUEST_OPENAPI_SCHEMA.properties.password.minLength,
      12,
    );
  });

  test("normalizes audit pagination and exposes every target and outcome", () => {
    assert.deepEqual(auditEventsQuerySchema.parse({}), {
      beforeSequence: null,
      limit: 50,
    });
    assert.deepEqual(
      auditEventsQuerySchema.parse({ beforeSequence: "42", limit: "200" }),
      { beforeSequence: 42n, limit: 200 },
    );
    assert.equal(
      auditEventsQuerySchema.safeParse({ beforeSequence: "0" }).success,
      false,
    );
    assert.equal(
      auditEventsResponseSchema.safeParse({
        events: [
          {
            action: "permission.change",
            actorUserId: userId,
            auditEventId: operationId,
            keyVersion: "audit-v1",
            mac: "a".repeat(64),
            occurredAt: "2026-07-18T00:00:00.000Z",
            organizationId,
            outcome: "succeeded",
            previousMac: null,
            requestId,
            sequence: "1",
            spaceId: null,
            targetId: operationId,
            targetType: "group",
          },
        ],
      }).success,
      true,
    );
    assert.deepEqual(
      AUDIT_EVENT_OPENAPI_SCHEMA.properties.targetType.enum,
      [...auditTargetTypes],
    );
    assert.deepEqual(
      AUDIT_EVENT_OPENAPI_SCHEMA.properties.outcome.enum,
      [...auditOutcomes],
    );
    assert.equal(
      auditEventsResponseSchema.safeParse({
        events: [
          {
            action: "content.edit",
            actorUserId: userId,
            auditEventId: operationId,
            keyVersion: "audit-v1",
            mac: "b".repeat(64),
            occurredAt: "2026-07-18T00:00:00.000Z",
            organizationId,
            outcome: "indeterminate",
            previousMac: "a".repeat(64),
            requestId,
            sequence: "2",
            spaceId,
            targetId: "20260718010101-abcdefg",
            targetType: "document",
          },
        ],
      }).success,
      true,
    );
    assert.equal(
      ORGANIZATION_AUDIT_EVENTS_CONTROLLER_PATH,
      "/api/v1/organizations/:organizationId/audit-events",
    );
  });

  test("keeps backup and restore lifecycle states explicit", () => {
    assert.equal(
      spaceBackupSchema.safeParse({
        backupId: operationId,
        completedAt: null,
        createdAt: "2026-07-18T00:00:00.000Z",
        formatVersion: null,
        kernelVersion: null,
        organizationId,
        sha256: null,
        sizeBytes: null,
        sourceSpaceId: spaceId,
        status: "queued",
      }).success,
      true,
    );
    assert.equal(
      spaceRestoreSchema.safeParse({
        activatedAt: null,
        backupId: operationId,
        createdAt: "2026-07-18T00:00:00.000Z",
        organizationId,
        restoreId: requestId,
        sourceSpaceId: spaceId,
        status: "ready-for-activation",
        targetSpaceId: userId,
      }).success,
      true,
    );
    assert.equal(
      ORGANIZATION_SPACE_BACKUPS_CONTROLLER_PATH,
      "/api/v1/organizations/:organizationId/spaces/:spaceId/backups",
    );
    assert.deepEqual(unactivatedSpaceRestoreStatuses, [
      "queued",
      "restoring",
      "ready-for-activation",
    ]);
    assert.equal(
      spaceRestoresResponseSchema.safeParse({
        restores: [
          {
            activatedAt: null,
            backupId: operationId,
            createdAt: "2026-07-18T00:00:00.000Z",
            organizationId,
            restoreId: requestId,
            sourceSpaceId: spaceId,
            status: "ready-for-activation",
            targetSpaceId: userId,
          },
        ],
      }).success,
      true,
    );
    assert.equal(
      ORGANIZATION_SPACE_RESTORES_CONTROLLER_PATH,
      "/api/v1/organizations/:organizationId/spaces/:spaceId/restores",
    );
  });

  test("requires observability responses to distinguish fresh, stale, and unavailable", () => {
    const sampledAt = "2026-07-18T00:00:00.000Z";
    assert.equal(
      spaceObservabilitySchema.safeParse({
        capacity: {
          assetBytes: "2",
          dataBytes: "10",
          fileCount: "3",
          sampleDurationMilliseconds: 4,
          sampledAt,
          status: "fresh",
        },
        health: {
          kernelVersion: "3.7.2",
          sampledAt,
          status: "ready",
        },
        organizationId,
        spaceId,
      }).success,
      true,
    );
    assert.equal(
      spaceObservabilitySchema.safeParse({
        capacity: { status: "unavailable" },
        health: { reason: "no-sample", status: "unavailable" },
        organizationId,
        spaceId,
      }).success,
      false,
    );
    assert.equal(
      spaceObservabilitySchema.safeParse({
        capacity: { reason: "sample-failed", status: "unavailable" },
        health: { reason: "no-sample", status: "unavailable" },
        organizationId,
        spaceId,
      }).success,
      false,
    );
    assert.equal(
      spaceObservabilitySchema.safeParse({
        capacity: {
          reason: "sample-failed",
          sampledAt,
          status: "unavailable",
        },
        health: { reason: "no-sample", status: "unavailable" },
        organizationId,
        spaceId,
      }).success,
      true,
    );
    assert.equal(
      spaceObservabilitySchema.safeParse({
        capacity: { reason: "no-sample", status: "unavailable" },
        health: { reason: "kernel-unavailable", status: "unavailable" },
        organizationId,
        spaceId,
      }).success,
      true,
    );
    assert.equal(
      ORGANIZATION_SPACE_OBSERVABILITY_CONTROLLER_PATH,
      "/api/v1/organizations/:organizationId/spaces/:spaceId/observability",
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
