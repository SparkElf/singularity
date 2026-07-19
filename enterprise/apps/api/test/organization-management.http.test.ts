import { randomUUID } from "node:crypto";

import {
  AUTH_INVITATION_ACCEPT_LOCAL_PATH,
  AUTH_INVITATION_ACCEPT_PATH,
  AUTH_LOGIN_PATH,
  CSRF_HEADER_NAME,
  ORGANIZATION_AUDIT_EVENTS_PATH_TEMPLATE,
  ORGANIZATION_GROUP_MEMBER_PATH_TEMPLATE,
  ORGANIZATION_GROUP_MEMBERS_PATH_TEMPLATE,
  ORGANIZATION_GROUP_PATH_TEMPLATE,
  ORGANIZATION_GROUPS_PATH_TEMPLATE,
  ORGANIZATION_INVITATION_PATH_TEMPLATE,
  ORGANIZATION_INVITATIONS_PATH_TEMPLATE,
  ORGANIZATION_MEMBER_PATH_TEMPLATE,
  ORGANIZATION_MEMBER_SESSIONS_PATH_TEMPLATE,
  ORGANIZATION_MEMBERS_PATH_TEMPLATE,
  ORGANIZATION_OWNERSHIP_PATH_TEMPLATE,
  apiProblemSchema,
  auditEventsResponseSchema,
  createdOrganizationInvitationSchema,
  loginResponseSchema,
  organizationMemberSummarySchema,
  organizationInvitationsResponseSchema,
  organizationMembersResponseSchema,
  userGroupMembersResponseSchema,
  userGroupsResponseSchema,
  userGroupSummarySchema,
} from "@singularity/contracts";
import { DatabaseRuntime, type DatabaseClient } from "@singularity/database";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";

import type { Clock } from "../src/identity/clock.js";
import { PasswordHasher } from "../src/identity/password-hasher.js";
import { ACCESS_CHANGE_CHANNEL } from "../src/kernel/access-changed.js";
import { truncateTestDatabase } from "./support/database.js";
import {
  startTestApiApplication,
  TEST_PUBLIC_ORIGIN,
  type TestApiApplication,
} from "./support/test-app.js";

const USER_PASSWORD = "correct horse battery staple";
const INITIAL_TIME = new Date("2026-07-19T00:00:00.000Z");
const NOTIFICATION_TIMEOUT_MS = 5_000;

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

interface AuthenticatedUser {
  cookie: string;
  csrfToken: string;
  loginIdentifier: string;
  userId: string;
}

interface OrganizationGraph {
  organizationId: string;
  owner: AuthenticatedUser;
}

function buildPath(
  template: string,
  parameters: Readonly<Record<string, string>>,
): string {
  let path = template;
  for (const [name, value] of Object.entries(parameters)) {
    path = path.replace(`{${name}}`, encodeURIComponent(value));
  }
  if (path.includes("{")) {
    throw new Error("Test API path parameters are incomplete");
  }
  return path;
}

function cookiePair(response: Response): string {
  const setCookie = response.headers.get("set-cookie");
  const pair = setCookie?.split(";", 1)[0];
  if (pair === undefined || pair.length === 0) {
    throw new Error("Login response cookie is unavailable");
  }
  return pair;
}

function mutationHeaders(user: AuthenticatedUser): Record<string, string> {
  return {
    [CSRF_HEADER_NAME]: user.csrfToken,
    "Content-Type": "application/json",
    Cookie: user.cookie,
    Origin: TEST_PUBLIC_ORIGIN,
  };
}

describe("organization membership, invitation, and group HTTP contracts with PostgreSQL", () => {
  let clock: MutableClock;
  let database: DatabaseClient;
  let passwordDigest: string;
  let testApi: TestApiApplication;

  beforeAll(async () => {
    clock = new MutableClock(INITIAL_TIME);
    testApi = await startTestApiApplication({ clock });
    database = testApi.app.get(DatabaseRuntime).client;
    passwordDigest = await testApi.app
      .get(PasswordHasher)
      .hashPassword(USER_PASSWORD);
  });

  afterEach(async () => {
    clock.set(INITIAL_TIME);
    await truncateTestDatabase(database);
  });

  afterAll(async () => {
    await testApi.dispose();
  });

  async function createUser(loginIdentifier: string): Promise<string> {
    const user = await database.user.create({
      data: { loginIdentifier, passwordDigest, status: "active" },
      select: { id: true },
    });
    return user.id;
  }

  async function login(
    userId: string,
    loginIdentifier: string,
  ): Promise<AuthenticatedUser> {
    const response = await fetch(`${testApi.baseUrl}${AUTH_LOGIN_PATH}`, {
      body: JSON.stringify({ loginIdentifier, password: USER_PASSWORD }),
      headers: {
        "Content-Type": "application/json",
        Origin: TEST_PUBLIC_ORIGIN,
      },
      method: "POST",
    });
    expect(response.status).toBe(200);
    const { csrfToken } = loginResponseSchema.parse(await response.json());
    return {
      cookie: cookiePair(response),
      csrfToken,
      loginIdentifier,
      userId,
    };
  }

  async function createOrganizationGraph(): Promise<OrganizationGraph> {
    const organizationId = randomUUID();
    const loginIdentifier = `owner-${randomUUID()}@example.test`;
    const userId = await createUser(loginIdentifier);
    await database.organization.create({
      data: { id: organizationId, name: "Organization management", status: "active" },
    });
    await database.organizationMembership.create({
      data: { organizationId, role: "owner", status: "active", userId },
    });
    return { organizationId, owner: await login(userId, loginIdentifier) };
  }

  test("revokes an invitation durably and prevents the revoked token from creating an account", async () => {
    const graph = await createOrganizationGraph();
    const loginIdentifier = `revoked-${randomUUID()}@example.test`;
    const invitationsPath = buildPath(ORGANIZATION_INVITATIONS_PATH_TEMPLATE, {
      organizationId: graph.organizationId,
    });
    const createdResponse = await fetch(`${testApi.baseUrl}${invitationsPath}`, {
      body: JSON.stringify({ expiresInHours: 24, loginIdentifier, role: "member" }),
      headers: mutationHeaders(graph.owner),
      method: "POST",
    });
    expect(createdResponse.status).toBe(201);
    const invitation = createdOrganizationInvitationSchema.parse(
      await createdResponse.json(),
    );

    const invitationPath = buildPath(ORGANIZATION_INVITATION_PATH_TEMPLATE, {
      invitationId: invitation.invitationId,
      organizationId: graph.organizationId,
    });
    const revoked = await fetch(`${testApi.baseUrl}${invitationPath}`, {
      headers: mutationHeaders(graph.owner),
      method: "DELETE",
    });
    expect(revoked.status).toBe(204);

    const listed = await fetch(`${testApi.baseUrl}${invitationsPath}`, {
      headers: { Cookie: graph.owner.cookie },
    });
    expect(listed.status).toBe(200);
    expect(
      organizationInvitationsResponseSchema.parse(await listed.json()),
    ).toEqual({
      invitations: [
        expect.objectContaining({
          invitationId: invitation.invitationId,
          loginIdentifier,
          revokedAt: INITIAL_TIME.toISOString(),
        }),
      ],
    });

    const rejectedAcceptance = await fetch(
      `${testApi.baseUrl}${AUTH_INVITATION_ACCEPT_LOCAL_PATH}`,
      {
        body: JSON.stringify({
          invitationToken: invitation.invitationToken,
          password: USER_PASSWORD,
        }),
        headers: {
          "Content-Type": "application/json",
          Origin: TEST_PUBLIC_ORIGIN,
        },
        method: "POST",
      },
    );
    expect(rejectedAcceptance.status).toBe(404);
    expect(apiProblemSchema.parse(await rejectedAcceptance.json()).code).toBe(
      "not-found",
    );
    await expect(
      database.user.findUnique({ where: { loginIdentifier } }),
    ).resolves.toBeNull();

    const invitationState = await database.organizationInvitation.findUniqueOrThrow({
      where: { id: invitation.invitationId },
      select: { acceptedAt: true, revokedAt: true },
    });
    expect(invitationState).toEqual({
      acceptedAt: null,
      revokedAt: INITIAL_TIME,
    });
    const audit = await fetch(
      `${testApi.baseUrl}${buildPath(ORGANIZATION_AUDIT_EVENTS_PATH_TEMPLATE, {
        organizationId: graph.organizationId,
      })}`,
      { headers: { Cookie: graph.owner.cookie } },
    );
    expect(audit.status).toBe(200);
    const invitationEvents = auditEventsResponseSchema
      .parse(await audit.json())
      .events.filter((event) => event.targetId === invitation.invitationId);
    expect(invitationEvents).toEqual([
      expect.objectContaining({
        action: "permission.change",
        targetType: "invitation",
      }),
      expect.objectContaining({
        action: "permission.change",
        targetType: "invitation",
      }),
    ]);
  });

  test("accepts an authenticated invitation into the assigned organization role", async () => {
    const graph = await createOrganizationGraph();
    const loginIdentifier = `invitee-${randomUUID()}@example.test`;
    const userId = await createUser(loginIdentifier);
    const invitationsPath = buildPath(ORGANIZATION_INVITATIONS_PATH_TEMPLATE, {
      organizationId: graph.organizationId,
    });
    const createdResponse = await fetch(`${testApi.baseUrl}${invitationsPath}`, {
      body: JSON.stringify({ expiresInHours: 24, loginIdentifier, role: "admin" }),
      headers: mutationHeaders(graph.owner),
      method: "POST",
    });
    expect(createdResponse.status).toBe(201);
    const invitation = createdOrganizationInvitationSchema.parse(
      await createdResponse.json(),
    );
    const invitee = await login(userId, loginIdentifier);

    const accepted = await fetch(`${testApi.baseUrl}${AUTH_INVITATION_ACCEPT_PATH}`, {
      body: JSON.stringify({ invitationToken: invitation.invitationToken }),
      headers: mutationHeaders(invitee),
      method: "POST",
    });
    expect(accepted.status).toBe(204);

    const members = await fetch(
      `${testApi.baseUrl}${buildPath(ORGANIZATION_MEMBERS_PATH_TEMPLATE, {
        organizationId: graph.organizationId,
      })}`,
      { headers: { Cookie: graph.owner.cookie } },
    );
    expect(members.status).toBe(200);
    expect(
      organizationMembersResponseSchema.parse(await members.json()).members,
    ).toContainEqual({
      loginIdentifier,
      role: "admin",
      status: "active",
      userId,
    });

    const membership = await database.organizationMembership.findUniqueOrThrow({
      where: { organizationId_userId: { organizationId: graph.organizationId, userId } },
      select: { role: true, status: true },
    });
    expect(membership).toEqual({ role: "admin", status: "active" });
    const invitationState = await database.organizationInvitation.findUniqueOrThrow({
      where: { id: invitation.invitationId },
      select: { acceptedAt: true, acceptedByUserId: true, revokedAt: true },
    });
    expect(invitationState).toEqual({
      acceptedAt: INITIAL_TIME,
      acceptedByUserId: userId,
      revokedAt: null,
    });
    const audit = await fetch(
      `${testApi.baseUrl}${buildPath(ORGANIZATION_AUDIT_EVENTS_PATH_TEMPLATE, {
        organizationId: graph.organizationId,
      })}`,
      { headers: { Cookie: graph.owner.cookie } },
    );
    expect(audit.status).toBe(200);
    expect(
      auditEventsResponseSchema
        .parse(await audit.json())
        .events.filter(
          (event) =>
            event.targetId === userId && event.targetType === "membership",
        ),
    ).toEqual([
      expect.objectContaining({ action: "permission.change" }),
    ]);
  });

  test("publishes one organization-and-user close event when acceptance updates an active membership", async () => {
    const graph = await createOrganizationGraph();
    const loginIdentifier = `active-invitee-${randomUUID()}@example.test`;
    const userId = await createUser(loginIdentifier);
    await database.organizationMembership.create({
      data: {
        organizationId: graph.organizationId,
        role: "member",
        status: "inactive",
        userId,
      },
    });
    const invitationsPath = buildPath(ORGANIZATION_INVITATIONS_PATH_TEMPLATE, {
      organizationId: graph.organizationId,
    });
    const createdResponse = await fetch(`${testApi.baseUrl}${invitationsPath}`, {
      body: JSON.stringify({ expiresInHours: 24, loginIdentifier, role: "admin" }),
      headers: mutationHeaders(graph.owner),
      method: "POST",
    });
    expect(createdResponse.status).toBe(201);
    const invitation = createdOrganizationInvitationSchema.parse(
      await createdResponse.json(),
    );

    await database.organizationMembership.update({
      where: {
        organizationId_userId: { organizationId: graph.organizationId, userId },
      },
      data: { status: "active" },
    });
    const invitee = await login(userId, loginIdentifier);

    const closeEvents: unknown[] = [];
    let resolveClose!: (event: unknown) => void;
    let rejectClose!: (error: unknown) => void;
    const closeEvent = new Promise<unknown>((resolve, reject) => {
      resolveClose = resolve;
      rejectClose = reject;
    });
    const subscription = await testApi.app.get(DatabaseRuntime).listen(
      ACCESS_CHANGE_CHANNEL,
      (payload) => {
        let decoded: unknown;
        try {
          decoded = JSON.parse(payload) as unknown;
        } catch (error) {
          rejectClose(error);
          return;
        }
        if (
          typeof decoded === "object" &&
          decoded !== null &&
          "kind" in decoded &&
          (decoded as { kind?: unknown }).kind === "close"
        ) {
          closeEvents.push(decoded);
          resolveClose(decoded);
        }
      },
      rejectClose,
    );
    let notificationTimeout: ReturnType<typeof setTimeout> | undefined;

    try {
      const accepted = await fetch(`${testApi.baseUrl}${AUTH_INVITATION_ACCEPT_PATH}`, {
        body: JSON.stringify({ invitationToken: invitation.invitationToken }),
        headers: mutationHeaders(invitee),
        method: "POST",
      });
      expect(accepted.status).toBe(204);
      const event = await Promise.race([
        closeEvent,
        new Promise<never>((_, reject) => {
          notificationTimeout = setTimeout(
            () => reject(new Error("active-membership close event was not delivered")),
            NOTIFICATION_TIMEOUT_MS,
          );
        }),
      ]);
      expect(event).toEqual({
        kind: "close",
        reason: "forbidden",
        requestId: expect.any(String),
        selectors: [
          { kind: "organization", value: graph.organizationId },
          { kind: "user", value: userId },
        ],
      });
      expect(closeEvents).toHaveLength(1);
      await expect(
        database.organizationMembership.findUniqueOrThrow({
          where: {
            organizationId_userId: { organizationId: graph.organizationId, userId },
          },
          select: { role: true, status: true },
        }),
      ).resolves.toEqual({ role: "admin", status: "active" });
    } finally {
      if (notificationTimeout !== undefined) {
        clearTimeout(notificationTimeout);
      }
      await subscription.close();
    }
  });

  test("updates a member role and status with durable access removal and audit", async () => {
    const graph = await createOrganizationGraph();
    const loginIdentifier = `managed-member-${randomUUID()}@example.test`;
    const userId = await createUser(loginIdentifier);
    await database.organizationMembership.create({
      data: {
        organizationId: graph.organizationId,
        role: "member",
        status: "active",
        userId,
      },
    });
    const space = await database.space.create({
      data: {
        name: "Managed member space",
        organizationId: graph.organizationId,
        status: "active",
      },
    });
    await database.spaceMembership.create({
      data: {
        organizationId: graph.organizationId,
        role: "editor",
        spaceId: space.id,
        status: "active",
        userId,
      },
    });

    const updated = await fetch(
      `${testApi.baseUrl}${buildPath(ORGANIZATION_MEMBER_PATH_TEMPLATE, {
        organizationId: graph.organizationId,
        userId,
      })}`,
      {
        body: JSON.stringify({ role: "admin", status: "inactive" }),
        headers: mutationHeaders(graph.owner),
        method: "PATCH",
      },
    );
    expect(updated.status).toBe(200);
    expect(organizationMemberSummarySchema.parse(await updated.json())).toEqual({
      loginIdentifier,
      role: "admin",
      status: "inactive",
      userId,
    });
    await expect(
      database.organizationMembership.findUniqueOrThrow({
        where: {
          organizationId_userId: {
            organizationId: graph.organizationId,
            userId,
          },
        },
        select: { role: true, status: true },
      }),
    ).resolves.toEqual({ role: "admin", status: "inactive" });
    await expect(
      database.spaceMembership.findUniqueOrThrow({
        where: { spaceId_userId: { spaceId: space.id, userId } },
        select: { status: true },
      }),
    ).resolves.toEqual({ status: "inactive" });

    const audit = await fetch(
      `${testApi.baseUrl}${buildPath(ORGANIZATION_AUDIT_EVENTS_PATH_TEMPLATE, {
        organizationId: graph.organizationId,
      })}`,
      { headers: { Cookie: graph.owner.cookie } },
    );
    expect(audit.status).toBe(200);
    expect(
      auditEventsResponseSchema
        .parse(await audit.json())
        .events.filter((event) => event.targetId === userId),
    ).toEqual([
      expect.objectContaining({
        action: "permission.change",
        actorUserId: graph.owner.userId,
        organizationId: graph.organizationId,
        outcome: "succeeded",
        spaceId: null,
        targetType: "membership",
      }),
    ]);
  });

  test("lets an administrator revoke every member session and records the revocation", async () => {
    const graph = await createOrganizationGraph();
    const adminLoginIdentifier = `admin-${randomUUID()}@example.test`;
    const adminUserId = await createUser(adminLoginIdentifier);
    await database.organizationMembership.create({
      data: {
        organizationId: graph.organizationId,
        role: "admin",
        status: "active",
        userId: adminUserId,
      },
    });
    const admin = await login(adminUserId, adminLoginIdentifier);
    const memberLoginIdentifier = `session-member-${randomUUID()}@example.test`;
    const memberUserId = await createUser(memberLoginIdentifier);
    await database.organizationMembership.create({
      data: {
        organizationId: graph.organizationId,
        role: "member",
        status: "active",
        userId: memberUserId,
      },
    });
    const member = await login(memberUserId, memberLoginIdentifier);
    await login(memberUserId, memberLoginIdentifier);

    const revoked = await fetch(
      `${testApi.baseUrl}${buildPath(ORGANIZATION_MEMBER_SESSIONS_PATH_TEMPLATE, {
        organizationId: graph.organizationId,
        userId: memberUserId,
      })}`,
      { headers: mutationHeaders(admin), method: "POST" },
    );
    expect(revoked.status).toBe(204);
    await expect(
      database.authSession.count({
        where: { revokedAt: INITIAL_TIME, userId: memberUserId },
      }),
    ).resolves.toBe(2);
    await expect(
      database.authSession.count({
        where: { revokedAt: null, userId: adminUserId },
      }),
    ).resolves.toBe(1);

    const rejectedSession = await fetch(
      `${testApi.baseUrl}${buildPath(ORGANIZATION_MEMBERS_PATH_TEMPLATE, {
        organizationId: graph.organizationId,
      })}`,
      { headers: { Cookie: member.cookie } },
    );
    expect(rejectedSession.status).toBe(401);
    expect(apiProblemSchema.parse(await rejectedSession.json()).code).toBe(
      "unauthenticated",
    );

    const audit = await fetch(
      `${testApi.baseUrl}${buildPath(ORGANIZATION_AUDIT_EVENTS_PATH_TEMPLATE, {
        organizationId: graph.organizationId,
      })}`,
      { headers: { Cookie: graph.owner.cookie } },
    );
    expect(audit.status).toBe(200);
    expect(
      auditEventsResponseSchema
        .parse(await audit.json())
        .events.filter((event) => event.targetId === memberUserId),
    ).toEqual([
      expect.objectContaining({
        action: "permission.change",
        actorUserId: adminUserId,
        organizationId: graph.organizationId,
        outcome: "succeeded",
        spaceId: null,
        targetType: "session",
      }),
    ]);
  });

  test("transfers ownership atomically and applies the new owner-only authorization", async () => {
    const graph = await createOrganizationGraph();
    const loginIdentifier = `new-owner-${randomUUID()}@example.test`;
    const userId = await createUser(loginIdentifier);
    await database.organizationMembership.create({
      data: {
        organizationId: graph.organizationId,
        role: "member",
        status: "active",
        userId,
      },
    });
    const newOwner = await login(userId, loginIdentifier);
    const ownershipPath = buildPath(ORGANIZATION_OWNERSHIP_PATH_TEMPLATE, {
      organizationId: graph.organizationId,
    });

    const transferred = await fetch(`${testApi.baseUrl}${ownershipPath}`, {
      body: JSON.stringify({ newOwnerUserId: userId }),
      headers: mutationHeaders(graph.owner),
      method: "POST",
    });
    expect(transferred.status).toBe(204);
    await expect(
      database.organizationMembership.findMany({
        orderBy: { userId: "asc" },
        select: { role: true, userId: true },
        where: { organizationId: graph.organizationId },
      }),
    ).resolves.toEqual(
      [
        { role: "admin", userId: graph.owner.userId },
        { role: "owner", userId },
      ].sort((left, right) => left.userId.localeCompare(right.userId)),
    );

    const formerOwnerRejected = await fetch(`${testApi.baseUrl}${ownershipPath}`, {
      body: JSON.stringify({ newOwnerUserId: graph.owner.userId }),
      headers: mutationHeaders(graph.owner),
      method: "POST",
    });
    expect(formerOwnerRejected.status).toBe(403);
    expect(apiProblemSchema.parse(await formerOwnerRejected.json()).code).toBe(
      "forbidden",
    );

    const audit = await fetch(
      `${testApi.baseUrl}${buildPath(ORGANIZATION_AUDIT_EVENTS_PATH_TEMPLATE, {
        organizationId: graph.organizationId,
      })}`,
      { headers: { Cookie: newOwner.cookie } },
    );
    expect(audit.status).toBe(200);
    expect(
      auditEventsResponseSchema
        .parse(await audit.json())
        .events.filter((event) => event.targetId === userId),
    ).toEqual([
      expect.objectContaining({
        action: "permission.change",
        actorUserId: graph.owner.userId,
        organizationId: graph.organizationId,
        outcome: "succeeded",
        spaceId: null,
        targetType: "membership",
      }),
    ]);
  });

  test("keeps the current owner when they consume an invitation created before ownership transfer", async () => {
    const graph = await createOrganizationGraph();
    const loginIdentifier = `stale-owner-invitation-${randomUUID()}@example.test`;
    const userId = await createUser(loginIdentifier);
    await database.organizationMembership.create({
      data: {
        organizationId: graph.organizationId,
        role: "member",
        status: "inactive",
        userId,
      },
    });
    const invitationsPath = buildPath(ORGANIZATION_INVITATIONS_PATH_TEMPLATE, {
      organizationId: graph.organizationId,
    });
    const createdResponse = await fetch(`${testApi.baseUrl}${invitationsPath}`, {
      body: JSON.stringify({
        expiresInHours: 24,
        loginIdentifier,
        role: "member",
      }),
      headers: mutationHeaders(graph.owner),
      method: "POST",
    });
    expect(createdResponse.status).toBe(201);
    const invitation = createdOrganizationInvitationSchema.parse(
      await createdResponse.json(),
    );

    const activated = await fetch(
      `${testApi.baseUrl}${buildPath(ORGANIZATION_MEMBER_PATH_TEMPLATE, {
        organizationId: graph.organizationId,
        userId,
      })}`,
      {
        body: JSON.stringify({ status: "active" }),
        headers: mutationHeaders(graph.owner),
        method: "PATCH",
      },
    );
    expect(activated.status).toBe(200);
    const newOwner = await login(userId, loginIdentifier);
    const transferred = await fetch(
      `${testApi.baseUrl}${buildPath(ORGANIZATION_OWNERSHIP_PATH_TEMPLATE, {
        organizationId: graph.organizationId,
      })}`,
      {
        body: JSON.stringify({ newOwnerUserId: userId }),
        headers: mutationHeaders(graph.owner),
        method: "POST",
      },
    );
    expect(transferred.status).toBe(204);

    const rejectedAcceptance = await fetch(
      `${testApi.baseUrl}${AUTH_INVITATION_ACCEPT_PATH}`,
      {
        body: JSON.stringify({ invitationToken: invitation.invitationToken }),
        headers: mutationHeaders(newOwner),
        method: "POST",
      },
    );
    expect(rejectedAcceptance.status).toBe(409);
    expect(apiProblemSchema.parse(await rejectedAcceptance.json()).code).toBe(
      "conflict",
    );
    await expect(
      database.organizationMembership.findMany({
        orderBy: { userId: "asc" },
        select: { role: true, userId: true },
        where: { organizationId: graph.organizationId },
      }),
    ).resolves.toEqual(
      [
        { role: "admin", userId: graph.owner.userId },
        { role: "owner", userId },
      ].sort((left, right) => left.userId.localeCompare(right.userId)),
    );
    await expect(
      database.organizationInvitation.findUniqueOrThrow({
        where: { id: invitation.invitationId },
        select: { acceptedAt: true, acceptedByUserId: true },
      }),
    ).resolves.toEqual({ acceptedAt: null, acceptedByUserId: null });
  });

  test("rejects organization members before they can create a group", async () => {
    const graph = await createOrganizationGraph();
    const loginIdentifier = `member-${randomUUID()}@example.test`;
    const userId = await createUser(loginIdentifier);
    await database.organizationMembership.create({
      data: {
        organizationId: graph.organizationId,
        role: "member",
        status: "active",
        userId,
      },
    });
    const member = await login(userId, loginIdentifier);
    const groupsPath = buildPath(ORGANIZATION_GROUPS_PATH_TEMPLATE, {
      organizationId: graph.organizationId,
    });

    const rejected = await fetch(`${testApi.baseUrl}${groupsPath}`, {
      body: JSON.stringify({ name: "Unauthorized" }),
      headers: mutationHeaders(member),
      method: "POST",
    });
    expect(rejected.status).toBe(403);
    expect(apiProblemSchema.parse(await rejected.json()).code).toBe("forbidden");
    await expect(
      database.userGroup.count({ where: { organizationId: graph.organizationId } }),
    ).resolves.toBe(0);
  });

  test("creates a group, changes its membership, disables it, and records each permission change", async () => {
    const graph = await createOrganizationGraph();
    const loginIdentifier = `group-member-${randomUUID()}@example.test`;
    const userId = await createUser(loginIdentifier);
    await database.organizationMembership.create({
      data: {
        organizationId: graph.organizationId,
        role: "member",
        status: "active",
        userId,
      },
    });
    const groupsPath = buildPath(ORGANIZATION_GROUPS_PATH_TEMPLATE, {
      organizationId: graph.organizationId,
    });
    const createdResponse = await fetch(`${testApi.baseUrl}${groupsPath}`, {
      body: JSON.stringify({ name: "Design" }),
      headers: mutationHeaders(graph.owner),
      method: "POST",
    });
    expect(createdResponse.status).toBe(201);
    const group = userGroupSummarySchema.parse(await createdResponse.json());

    const memberPath = buildPath(ORGANIZATION_GROUP_MEMBER_PATH_TEMPLATE, {
      groupId: group.groupId,
      organizationId: graph.organizationId,
      userId,
    });
    const added = await fetch(`${testApi.baseUrl}${memberPath}`, {
      headers: mutationHeaders(graph.owner),
      method: "PUT",
    });
    expect(added.status).toBe(204);
    const repeatedAdd = await fetch(`${testApi.baseUrl}${memberPath}`, {
      headers: mutationHeaders(graph.owner),
      method: "PUT",
    });
    expect(repeatedAdd.status).toBe(204);
    const membersPath = buildPath(ORGANIZATION_GROUP_MEMBERS_PATH_TEMPLATE, {
      groupId: group.groupId,
      organizationId: graph.organizationId,
    });
    const listedMembers = await fetch(`${testApi.baseUrl}${membersPath}`, {
      headers: { Cookie: graph.owner.cookie },
    });
    expect(listedMembers.status).toBe(200);
    expect(
      userGroupMembersResponseSchema.parse(await listedMembers.json()),
    ).toEqual({ members: [{ loginIdentifier, userId }] });

    const removed = await fetch(`${testApi.baseUrl}${memberPath}`, {
      headers: mutationHeaders(graph.owner),
      method: "DELETE",
    });
    expect(removed.status).toBe(204);
    const groupPath = buildPath(ORGANIZATION_GROUP_PATH_TEMPLATE, {
      groupId: group.groupId,
      organizationId: graph.organizationId,
    });
    const disabledResponse = await fetch(`${testApi.baseUrl}${groupPath}`, {
      body: JSON.stringify({ status: "disabled" }),
      headers: mutationHeaders(graph.owner),
      method: "PATCH",
    });
    expect(disabledResponse.status).toBe(200);
    expect(userGroupSummarySchema.parse(await disabledResponse.json())).toEqual({
      groupId: group.groupId,
      memberCount: 0,
      name: "Design",
      organizationId: graph.organizationId,
      status: "disabled",
    });

    const listedGroups = await fetch(`${testApi.baseUrl}${groupsPath}`, {
      headers: { Cookie: graph.owner.cookie },
    });
    expect(listedGroups.status).toBe(200);
    expect(userGroupsResponseSchema.parse(await listedGroups.json())).toEqual({
      groups: [
        {
          groupId: group.groupId,
          memberCount: 0,
          name: "Design",
          organizationId: graph.organizationId,
          status: "disabled",
        },
      ],
    });
    await expect(
      database.userGroupMembership.count({
        where: { groupId: group.groupId, userId },
      }),
    ).resolves.toBe(0);
    await expect(
      database.userGroup.findUniqueOrThrow({
        where: { id: group.groupId },
        select: { status: true },
      }),
    ).resolves.toEqual({ status: "disabled" });

    const audit = await fetch(
      `${testApi.baseUrl}${buildPath(ORGANIZATION_AUDIT_EVENTS_PATH_TEMPLATE, {
        organizationId: graph.organizationId,
      })}`,
      { headers: { Cookie: graph.owner.cookie } },
    );
    expect(audit.status).toBe(200);
    const events = auditEventsResponseSchema.parse(await audit.json()).events;
    expect(
      events.filter((event) => event.targetId === group.groupId),
    ).toEqual([
      expect.objectContaining({
        action: "permission.change",
        targetType: "group",
      }),
      expect.objectContaining({
        action: "permission.change",
        targetType: "group",
      }),
    ]);
    expect(
      events.filter(
        (event) =>
          event.targetId === userId && event.targetType === "membership",
      ),
    ).toEqual([
      expect.objectContaining({ action: "permission.change" }),
      expect.objectContaining({ action: "permission.change" }),
    ]);
  });
});
