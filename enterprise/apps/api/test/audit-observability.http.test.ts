import { randomUUID } from "node:crypto";

import {
  AUTH_LOGIN_PATH,
  ORGANIZATION_AUDIT_EVENTS_PATH_TEMPLATE,
  ORGANIZATION_SPACE_AUDIT_EVENTS_PATH_TEMPLATE,
  ORGANIZATION_SPACE_OBSERVABILITY_PATH_TEMPLATE,
  apiProblemSchema,
  auditEventsResponseSchema,
  loginResponseSchema,
  spaceObservabilitySchema,
  type AuditAction,
} from "@singularity/contracts";
import { DatabaseRuntime, type DatabaseClient } from "@singularity/database";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";

import type { Clock } from "../src/identity/clock.js";
import { AuditWriter } from "../src/audit/audit-writer.service.js";
import { PasswordHasher } from "../src/identity/password-hasher.js";
import { truncateTestDatabase } from "./support/database.js";
import {
  startTestApiApplication,
  TEST_PUBLIC_ORIGIN,
  type TestApiApplication,
} from "./support/test-app.js";

const USER_PASSWORD = "correct horse battery staple";
const INITIAL_TIME = new Date("2026-07-19T00:00:00.000Z");

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
  loginIdentifier: string;
  userId: string;
}

interface TestGraph {
  organizationAId: string;
  organizationBId: string;
  ownerA: AuthenticatedUser;
  ownerB: AuthenticatedUser;
  spaceA1Id: string;
  spaceA2Id: string;
  spaceAdminA: AuthenticatedUser;
  viewerA: AuthenticatedUser;
  spaceBId: string;
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
  const pair = response.headers.get("set-cookie")?.split(";", 1)[0];
  if (pair === undefined || pair.length === 0) {
    throw new Error("Login response cookie is unavailable");
  }
  return pair;
}

describe("audit and observability HTTP contracts with PostgreSQL", () => {
  let auditWriter: AuditWriter;
  let clock: MutableClock;
  let database: DatabaseClient;
  let passwordDigest: string;
  let testApi: TestApiApplication;

  beforeAll(async () => {
    clock = new MutableClock(INITIAL_TIME);
    testApi = await startTestApiApplication({ clock });
    database = testApi.app.get(DatabaseRuntime).client;
    auditWriter = testApi.app.get(AuditWriter);
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

  async function createUser(prefix: string): Promise<AuthenticatedUser> {
    const loginIdentifier = `${prefix}-${randomUUID()}@example.test`;
    const user = await database.user.create({
      data: {
        loginIdentifier,
        passwordDigest,
        status: "active",
      },
      select: { id: true },
    });
    const response = await fetch(`${testApi.baseUrl}${AUTH_LOGIN_PATH}`, {
      body: JSON.stringify({
        loginIdentifier,
        password: USER_PASSWORD,
      }),
      headers: {
        "Content-Type": "application/json",
        Origin: TEST_PUBLIC_ORIGIN,
      },
      method: "POST",
    });
    expect(response.status).toBe(200);
    loginResponseSchema.parse(await response.json());
    return {
      cookie: cookiePair(response),
      loginIdentifier,
      userId: user.id,
    };
  }

  async function createGraph(): Promise<TestGraph> {
    const organizationAId = randomUUID();
    const organizationBId = randomUUID();
    const spaceA1Id = randomUUID();
    const spaceA2Id = randomUUID();
    const spaceBId = randomUUID();
    await database.organization.createMany({
      data: [
        { id: organizationAId, name: "Audit A", status: "active" },
        { id: organizationBId, name: "Audit B", status: "active" },
      ],
    });
    await database.space.createMany({
      data: [
        { id: spaceA1Id, name: "A one", organizationId: organizationAId, status: "active" },
        { id: spaceA2Id, name: "A two", organizationId: organizationAId, status: "active" },
        { id: spaceBId, name: "B one", organizationId: organizationBId, status: "active" },
      ],
    });

    const ownerA = await createUser("audit-owner-a");
    const spaceAdminA = await createUser("audit-space-admin");
    const viewerA = await createUser("audit-viewer");
    const ownerB = await createUser("audit-owner-b");
    await database.organizationMembership.createMany({
      data: [
        {
          organizationId: organizationAId,
          role: "owner",
          status: "active",
          userId: ownerA.userId,
        },
        {
          organizationId: organizationAId,
          role: "member",
          status: "active",
          userId: spaceAdminA.userId,
        },
        {
          organizationId: organizationAId,
          role: "member",
          status: "active",
          userId: viewerA.userId,
        },
        {
          organizationId: organizationBId,
          role: "owner",
          status: "active",
          userId: ownerB.userId,
        },
      ],
    });
    await database.spaceMembership.createMany({
      data: [
        {
          organizationId: organizationAId,
          role: "admin",
          spaceId: spaceA1Id,
          status: "active",
          userId: spaceAdminA.userId,
        },
        {
          organizationId: organizationAId,
          role: "viewer",
          spaceId: spaceA1Id,
          status: "active",
          userId: viewerA.userId,
        },
      ],
    });
    await database.kernelInstance.create({
      data: {
        deploymentHandle: `audit-${randomUUID()}`,
        spaceId: spaceA1Id,
        status: "ready",
        version: "3.7.2",
      },
    });
    return {
      organizationAId,
      organizationBId,
      ownerA,
      ownerB,
      spaceA1Id,
      spaceA2Id,
      spaceAdminA,
      viewerA,
      spaceBId,
    };
  }

  async function appendEvent(input: {
    action: AuditAction;
    actorUserId: string;
    organizationId: string;
    spaceId: string | null;
    targetId: string;
    targetType: "document" | "organization";
  }): Promise<void> {
    await database.$transaction((transaction) =>
      auditWriter.append(transaction, {
        ...input,
        occurredAt: clock.now(),
        outcome: "succeeded",
        requestId: randomUUID(),
      }),
    );
  }

  test("keeps organization audit pages isolated, ordered, and chain-linked", async () => {
    const graph = await createGraph();
    await appendEvent({
      action: "permission.change",
      actorUserId: graph.ownerA.userId,
      organizationId: graph.organizationAId,
      spaceId: null,
      targetId: graph.organizationAId,
      targetType: "organization",
    });
    await appendEvent({
      action: "content.edit",
      actorUserId: graph.ownerA.userId,
      organizationId: graph.organizationAId,
      spaceId: graph.spaceA1Id,
      targetId: randomUUID(),
      targetType: "document",
    });
    await appendEvent({
      action: "content.delete",
      actorUserId: graph.ownerA.userId,
      organizationId: graph.organizationAId,
      spaceId: graph.spaceA2Id,
      targetId: randomUUID(),
      targetType: "document",
    });
    await appendEvent({
      action: "content.export",
      actorUserId: graph.ownerA.userId,
      organizationId: graph.organizationAId,
      spaceId: graph.spaceA1Id,
      targetId: randomUUID(),
      targetType: "document",
    });
    await appendEvent({
      action: "content.edit",
      actorUserId: graph.ownerB.userId,
      organizationId: graph.organizationBId,
      spaceId: graph.spaceBId,
      targetId: randomUUID(),
      targetType: "document",
    });

    const path = buildPath(ORGANIZATION_AUDIT_EVENTS_PATH_TEMPLATE, {
      organizationId: graph.organizationAId,
    });
    const firstResponse = await fetch(`${testApi.baseUrl}${path}?limit=2`, {
      headers: { Cookie: graph.ownerA.cookie },
    });
    expect(firstResponse.status).toBe(200);
    expect(firstResponse.headers.get("cache-control")).toBe("no-store");
    const first = auditEventsResponseSchema.parse(await firstResponse.json());
    expect(first.events).toHaveLength(2);
    expect(first.events[0]!.organizationId).toBe(graph.organizationAId);
    expect(BigInt(first.events[0]!.sequence)).toBeGreaterThan(
      BigInt(first.events[1]!.sequence),
    );
    expect(first.events[0]!.previousMac).toBe(first.events[1]!.mac);

    const cursor = first.events[1]!.sequence;
    const secondResponse = await fetch(
      `${testApi.baseUrl}${path}?beforeSequence=${cursor}&limit=2`,
      { headers: { Cookie: graph.ownerA.cookie } },
    );
    expect(secondResponse.status).toBe(200);
    const second = auditEventsResponseSchema.parse(await secondResponse.json());
    expect(second.events).toHaveLength(2);
    expect(BigInt(second.events[0]!.sequence)).toBeLessThan(BigInt(cursor));
    const firstEventIds = new Set(
      first.events.map((event) => event.auditEventId),
    );
    expect(
      second.events.filter((event) => firstEventIds.has(event.auditEventId)),
    ).toEqual([]);
    expect(first.events[1]!.previousMac).toBe(second.events[0]!.mac);
    expect(second.events.every((event) => event.organizationId === graph.organizationAId)).toBe(
      true,
    );
    expect(second.events.some((event) => event.spaceId === graph.spaceBId)).toBe(false);
  });

  test("limits space audit access to the managed space and rejects broader members", async () => {
    const graph = await createGraph();
    await appendEvent({
      action: "content.edit",
      actorUserId: graph.ownerA.userId,
      organizationId: graph.organizationAId,
      spaceId: graph.spaceA1Id,
      targetId: randomUUID(),
      targetType: "document",
    });
    await appendEvent({
      action: "content.delete",
      actorUserId: graph.ownerA.userId,
      organizationId: graph.organizationAId,
      spaceId: graph.spaceA2Id,
      targetId: randomUUID(),
      targetType: "document",
    });

    const organizationPath = buildPath(ORGANIZATION_AUDIT_EVENTS_PATH_TEMPLATE, {
      organizationId: graph.organizationAId,
    });
    const organizationDenied = await fetch(
      `${testApi.baseUrl}${organizationPath}`,
      { headers: { Cookie: graph.spaceAdminA.cookie } },
    );
    expect(organizationDenied.status).toBe(403);
    expect(apiProblemSchema.parse(await organizationDenied.json()).code).toBe(
      "forbidden",
    );

    const spacePath = buildPath(ORGANIZATION_SPACE_AUDIT_EVENTS_PATH_TEMPLATE, {
      organizationId: graph.organizationAId,
      spaceId: graph.spaceA1Id,
    });
    const managed = await fetch(`${testApi.baseUrl}${spacePath}`, {
      headers: { Cookie: graph.spaceAdminA.cookie },
    });
    expect(managed.status).toBe(200);
    const managedEvents = auditEventsResponseSchema.parse(await managed.json()).events;
    expect(managedEvents.length).toBeGreaterThan(0);
    expect(managedEvents.every((event) => event.spaceId === graph.spaceA1Id)).toBe(true);

    const memberDenied = await fetch(`${testApi.baseUrl}${spacePath}`, {
      headers: { Cookie: graph.viewerA.cookie },
    });
    expect(memberDenied.status).toBe(403);
    expect(apiProblemSchema.parse(await memberDenied.json()).code).toBe("forbidden");

    const crossOrganizationPath = buildPath(
      ORGANIZATION_SPACE_AUDIT_EVENTS_PATH_TEMPLATE,
      { organizationId: graph.organizationAId, spaceId: graph.spaceBId },
    );
    const crossOrganization = await fetch(
      `${testApi.baseUrl}${crossOrganizationPath}`,
      { headers: { Cookie: graph.spaceAdminA.cookie } },
    );
    expect(crossOrganization.status).toBe(404);
  });

  test("reads only persisted observations after space authorization", async () => {
    const graph = await createGraph();
    const kernel = await database.kernelInstance.findUniqueOrThrow({
      where: { spaceId: graph.spaceA1Id },
      select: { id: true },
    });
    const sampledAt = new Date(clock.now().getTime() - 60_000);
    await database.kernelHealthObservation.create({
      data: {
        kernelInstanceId: kernel.id,
        kernelVersion: "3.7.2",
        sampledAt,
        status: "ready",
      },
    });
    await database.spaceCapacityObservation.create({
      data: {
        assetBytes: 20n,
        dataBytes: 100n,
        fileCount: 4n,
        kernelInstanceId: kernel.id,
        sampleDurationMilliseconds: 12,
        sampledAt,
        spaceId: graph.spaceA1Id,
      },
    });

    const path = buildPath(ORGANIZATION_SPACE_OBSERVABILITY_PATH_TEMPLATE, {
      organizationId: graph.organizationAId,
      spaceId: graph.spaceA1Id,
    });
    const response = await fetch(`${testApi.baseUrl}${path}`, {
      headers: { Cookie: graph.spaceAdminA.cookie },
    });
    expect(response.status).toBe(200);
    expect(spaceObservabilitySchema.parse(await response.json())).toEqual({
      capacity: {
        assetBytes: "20",
        dataBytes: "100",
        fileCount: "4",
        sampleDurationMilliseconds: 12,
        sampledAt: sampledAt.toISOString(),
        status: "fresh",
      },
      health: {
        kernelVersion: "3.7.2",
        sampledAt: sampledAt.toISOString(),
        status: "ready",
      },
      organizationId: graph.organizationAId,
      spaceId: graph.spaceA1Id,
    });

    const denied = await fetch(`${testApi.baseUrl}${path}`, {
      headers: { Cookie: graph.viewerA.cookie },
    });
    expect(denied.status).toBe(403);
    expect(apiProblemSchema.parse(await denied.json()).code).toBe("forbidden");
  });
});
