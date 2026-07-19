import { randomUUID } from "node:crypto";

import {
  AUTH_LOGIN_PATH,
  CSRF_HEADER_NAME,
  ORGANIZATION_SPACE_BACKUP_RESTORES_PATH_TEMPLATE,
  ORGANIZATION_SPACE_BACKUPS_PATH_TEMPLATE,
  ORGANIZATION_SPACE_OBSERVABILITY_PATH_TEMPLATE,
  ORGANIZATION_SPACE_RESTORES_PATH_TEMPLATE,
  ORGANIZATION_SPACE_RESTORE_ACTIVATION_PATH_TEMPLATE,
  apiProblemSchema,
  loginResponseSchema,
  spaceBackupSchema,
  spaceBackupsResponseSchema,
  spaceObservabilitySchema,
  spaceRestoreSchema,
  spaceRestoresResponseSchema,
} from "@singularity/contracts";
import { DatabaseRuntime, Prisma, type DatabaseClient } from "@singularity/database";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";

import type { Clock } from "../src/identity/clock.js";
import { PasswordHasher } from "../src/identity/password-hasher.js";
import { truncateTestDatabase } from "./support/database.js";
import {
  startTestApiApplication,
  TEST_PUBLIC_ORIGIN,
  type TestApiApplication,
} from "./support/test-app.js";

const USER_PASSWORD = "correct horse battery staple";
const INITIAL_TIME = new Date("2026-07-18T00:00:00.000Z");

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

interface AuthenticatedGraph {
  cookie: string;
  csrfToken: string;
  organizationId: string;
  spaceId: string;
  userId: string;
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
    throw new Error("Response cookie is unavailable");
  }
  return pair;
}

function mutationHeaders(graph: AuthenticatedGraph): Record<string, string> {
  return {
    [CSRF_HEADER_NAME]: graph.csrfToken,
    "Content-Type": "application/json",
    Cookie: graph.cookie,
    Origin: TEST_PUBLIC_ORIGIN,
  };
}

describe("sharing and operations HTTP contracts with PostgreSQL", () => {
  let clock: MutableClock;
  let database: DatabaseClient;
  let passwordDigest: string;
  let testApi: TestApiApplication;

  beforeAll(async () => {
    passwordDigest = await new PasswordHasher().hashPassword(USER_PASSWORD);
    clock = new MutableClock(INITIAL_TIME);
    testApi = await startTestApiApplication({ clock });
    database = testApi.app.get(DatabaseRuntime).client;
  });

  afterEach(async () => {
    clock.set(INITIAL_TIME);
    await truncateTestDatabase(database);
  });

  afterAll(async () => {
    await testApi.dispose();
  });

  async function createAuthenticatedGraph(): Promise<AuthenticatedGraph> {
    const userId = randomUUID();
    const organizationId = randomUUID();
    const spaceId = randomUUID();
    const loginIdentifier = `ops-${randomUUID()}@example.test`;
    await database.user.create({
      data: {
        id: userId,
        loginIdentifier,
        passwordDigest,
        status: "active",
      },
    });
    await database.organization.create({
      data: { id: organizationId, name: "Operations", status: "active" },
    });
    await database.organizationMembership.create({
      data: {
        organizationId,
        role: "owner",
        status: "active",
        userId,
      },
    });
    await database.space.create({
      data: { id: spaceId, name: "Source space", organizationId, status: "active" },
    });
    await database.spaceMembership.create({
      data: {
        organizationId,
        role: "admin",
        spaceId,
        status: "active",
        userId,
      },
    });
    await database.kernelInstance.create({
      data: {
        deploymentHandle: `kernel-${randomUUID()}`,
        spaceId,
        status: "ready",
        version: "3.7.2",
      },
    });

    const login = await fetch(`${testApi.baseUrl}${AUTH_LOGIN_PATH}`, {
      body: JSON.stringify({ loginIdentifier, password: USER_PASSWORD }),
      headers: {
        "Content-Type": "application/json",
        Origin: TEST_PUBLIC_ORIGIN,
      },
      method: "POST",
    });
    expect(login.status).toBe(200);
    const { csrfToken } = loginResponseSchema.parse(await login.json());
    return {
      cookie: cookiePair(login),
      csrfToken,
      organizationId,
      spaceId,
      userId,
    };
  }

  async function insertSucceededBackup(
    graph: AuthenticatedGraph,
  ): Promise<string> {
    const backupId = randomUUID();
    await database.$executeRaw(
      Prisma.sql`
        INSERT INTO "space_backups" (
          "id", "organization_id", "source_space_id", "status", "object_key",
          "format_version", "kernel_version", "sha256", "size_bytes",
          "created_by_user_id", "created_at", "completed_at"
        ) VALUES (
          ${backupId}::uuid, ${graph.organizationId}::uuid, ${graph.spaceId}::uuid,
          'succeeded', ${"B".repeat(43)}, 1, '3.7.2', ${"a".repeat(64)}, 128,
          ${graph.userId}::uuid, ${clock.now()}, ${clock.now()}
        )
      `,
    );
    return backupId;
  }

  async function insertObservationRows(
    graph: AuthenticatedGraph,
    sampledAt: Date,
    options: { failed: boolean },
  ): Promise<void> {
    const kernel = await database.kernelInstance.findUniqueOrThrow({
      where: { spaceId: graph.spaceId },
      select: { id: true },
    });
    await database.$executeRaw(
      Prisma.sql`
        INSERT INTO "kernel_health_observations" (
          "id", "kernel_instance_id", "status", "kernel_version", "sampled_at", "error_code"
        ) VALUES (
          gen_random_uuid(), ${kernel.id}::uuid,
          ${options.failed ? "unavailable" : "ready"}::"kernel_observation_status",
          '3.7.2', ${sampledAt}, ${options.failed ? "kernel-timeout" : null}
        )
      `,
    );
    await database.$executeRaw(
      Prisma.sql`
        INSERT INTO "space_capacity_observations" (
          "id", "kernel_instance_id", "space_id", "data_bytes", "asset_bytes",
          "file_count", "sample_duration_milliseconds", "sampled_at", "error_code"
        ) VALUES (
          gen_random_uuid(), ${kernel.id}::uuid, ${graph.spaceId}::uuid,
          100, 20, 4, 12, ${sampledAt}, ${options.failed ? "sample-timeout" : null}
        )
      `,
    );
  }

  test("queues and lists a backup with a worker job and audit event", async () => {
    const graph = await createAuthenticatedGraph();
    const path = buildPath(ORGANIZATION_SPACE_BACKUPS_PATH_TEMPLATE, {
      organizationId: graph.organizationId,
      spaceId: graph.spaceId,
    });
    const response = await fetch(`${testApi.baseUrl}${path}`, {
      headers: mutationHeaders(graph),
      method: "POST",
    });
    expect(response.status).toBe(201);
    const backup = spaceBackupSchema.parse(await response.json());
    expect(backup.status).toBe("queued");
    expect(backup.completedAt).toBeNull();
    expect(response.headers.get("x-request-id")).toMatch(
      /^[0-9a-f-]{36}$/,
    );

    const listed = await fetch(`${testApi.baseUrl}${path}`, {
      headers: { Cookie: graph.cookie },
    });
    expect(listed.status).toBe(200);
    expect(spaceBackupsResponseSchema.parse(await listed.json())).toEqual({
      backups: [backup],
    });

    const jobs = await database.$queryRaw<
      Array<{ kind: string; payload: Record<string, unknown> }>
    >(
      Prisma.sql`
        SELECT "kind", "payload"
        FROM "worker_jobs"
        WHERE "organization_id" = ${graph.organizationId}::uuid
          AND "kind" = 'backup-space'
      `,
    );
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.payload).toEqual({
      backupId: backup.backupId,
      spaceId: graph.spaceId,
    });

    const audit = await database.$queryRaw<Array<{ action: string }>>(
      Prisma.sql`
        SELECT "action"
        FROM "audit_events"
        WHERE "organization_id" = ${graph.organizationId}::uuid
        ORDER BY "sequence" ASC
      `,
    );
    expect(audit.map((event) => event.action)).toEqual([
      "authentication.login",
      "backup.create",
    ]);
  });

  test("creates an isolated restore target and queues its worker job", async () => {
    const graph = await createAuthenticatedGraph();
    const backupId = await insertSucceededBackup(graph);
    const path = buildPath(ORGANIZATION_SPACE_BACKUP_RESTORES_PATH_TEMPLATE, {
      backupId,
      organizationId: graph.organizationId,
      spaceId: graph.spaceId,
    });
    const response = await fetch(`${testApi.baseUrl}${path}`, {
      body: JSON.stringify({ targetSpaceName: "Restored copy" }),
      headers: mutationHeaders(graph),
      method: "POST",
    });
    expect(response.status).toBe(201);
    const restore = spaceRestoreSchema.parse(await response.json());
    expect(restore.status).toBe("queued");
    expect(restore.targetSpaceId).not.toBeNull();
    expect(restore.targetSpaceId).not.toBe(graph.spaceId);

    const target = await database.space.findUniqueOrThrow({
      where: { id: restore.targetSpaceId ?? "" },
      select: { organizationId: true, status: true },
    });
    expect(target).toEqual({ organizationId: graph.organizationId, status: "archived" });
    const targetKernel = await database.kernelInstance.findUniqueOrThrow({
      where: { spaceId: restore.targetSpaceId ?? "" },
      select: { deploymentHandle: true, status: true },
    });
    expect(targetKernel).toEqual({ deploymentHandle: null, status: "starting" });

    const jobs = await database.$queryRaw<Array<{ payload: Record<string, unknown> }>>(
      Prisma.sql`
        SELECT "payload"
        FROM "worker_jobs"
        WHERE "organization_id" = ${graph.organizationId}::uuid
          AND "kind" = 'restore-space'
      `,
    );
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.payload).toMatchObject({
      backupId,
      restoreId: restore.restoreId,
      sourceSpaceId: graph.spaceId,
      targetSpaceId: restore.targetSpaceId,
    });

    const duplicateResponse = await fetch(`${testApi.baseUrl}${path}`, {
      body: JSON.stringify({ targetSpaceName: "Second restored copy" }),
      headers: mutationHeaders(graph),
      method: "POST",
    });
    expect(duplicateResponse.status).toBe(409);

    const listed = await fetch(
      `${testApi.baseUrl}${buildPath(ORGANIZATION_SPACE_RESTORES_PATH_TEMPLATE, {
        organizationId: graph.organizationId,
        spaceId: graph.spaceId,
      })}`,
      { headers: { Cookie: graph.cookie } },
    );
    expect(listed.status).toBe(200);
    expect(spaceRestoresResponseSchema.parse(await listed.json())).toEqual({
      restores: [restore],
    });
    const audit = await database.$queryRaw<
      Array<{ action: string; spaceId: string; targetId: string; targetType: string }>
    >(
      Prisma.sql`
        SELECT "action", "space_id" AS "spaceId", "target_id" AS "targetId", "target_type" AS "targetType"
        FROM "audit_events"
        WHERE "organization_id" = ${graph.organizationId}::uuid
        ORDER BY "sequence" DESC
        LIMIT 1
      `,
    );
    expect(audit[0]).toEqual({
      action: "restore.create",
      spaceId: graph.spaceId,
      targetId: restore.restoreId,
      targetType: "restore",
    });
  });

  test("activates only a ready-for-activation isolated restore", async () => {
    const graph = await createAuthenticatedGraph();
    const backupId = await insertSucceededBackup(graph);
    const target = await database.space.create({
      data: {
        name: "Validated copy",
        organizationId: graph.organizationId,
        status: "archived",
      },
    });
    await database.spaceMembership.create({
      data: {
        organizationId: graph.organizationId,
        role: "admin",
        spaceId: target.id,
        status: "active",
        userId: graph.userId,
      },
    });
    const kernel = await database.kernelInstance.create({
      data: {
        deploymentHandle: "validated-kernel",
        spaceId: target.id,
        status: "ready",
        version: "3.7.2",
      },
    });
    const restoreId = randomUUID();
    const completedAt = new Date(clock.now().getTime() - 1_000);
    await database.$executeRaw(
      Prisma.sql`
        INSERT INTO "space_restore_jobs" (
          "id", "organization_id", "backup_id", "source_space_id", "target_space_id",
          "status", "created_by_user_id", "created_at", "completed_at"
        ) VALUES (
          ${restoreId}::uuid, ${graph.organizationId}::uuid, ${backupId}::uuid,
          ${graph.spaceId}::uuid, ${target.id}::uuid, 'ready-for-activation',
          ${graph.userId}::uuid, ${completedAt}, ${completedAt}
        )
      `,
    );

    const path = buildPath(ORGANIZATION_SPACE_RESTORE_ACTIVATION_PATH_TEMPLATE, {
      organizationId: graph.organizationId,
      restoreId,
      spaceId: target.id,
    });
    const response = await fetch(`${testApi.baseUrl}${path}`, {
      headers: mutationHeaders(graph),
      method: "POST",
    });
    expect(response.status).toBe(200);
    const restore = spaceRestoreSchema.parse(await response.json());
    expect(restore.status).toBe("activated");
    expect(restore.targetSpaceId).toBe(target.id);
    expect(restore.activatedAt).toBe(INITIAL_TIME.toISOString());
    expect(kernel.status).toBe("ready");

    const targetState = await database.space.findUniqueOrThrow({
      where: { id: target.id },
      select: { status: true },
    });
    expect(targetState.status).toBe("active");
    const audit = await database.$queryRaw<Array<{ action: string }>>(
      Prisma.sql`
        SELECT "action"
        FROM "audit_events"
        WHERE "organization_id" = ${graph.organizationId}::uuid
        ORDER BY "sequence" DESC
      `,
    );
    expect(audit[0]?.action).toBe("restore.activate");
  });

  test("reports fresh persisted health and capacity samples", async () => {
    const graph = await createAuthenticatedGraph();
    await insertObservationRows(graph, new Date(clock.now().getTime() - 60_000), {
      failed: false,
    });
    const path = buildPath(ORGANIZATION_SPACE_OBSERVABILITY_PATH_TEMPLATE, {
      organizationId: graph.organizationId,
      spaceId: graph.spaceId,
    });
    const response = await fetch(`${testApi.baseUrl}${path}`, {
      headers: { Cookie: graph.cookie },
    });
    expect(response.status).toBe(200);
    expect(spaceObservabilitySchema.parse(await response.json())).toEqual({
      capacity: {
        assetBytes: "20",
        dataBytes: "100",
        fileCount: "4",
        sampleDurationMilliseconds: 12,
        sampledAt: new Date(clock.now().getTime() - 60_000).toISOString(),
        status: "fresh",
      },
      health: {
        kernelVersion: "3.7.2",
        sampledAt: new Date(clock.now().getTime() - 60_000).toISOString(),
        status: "ready",
      },
      organizationId: graph.organizationId,
      spaceId: graph.spaceId,
    });
  });

  test("reports stale persisted samples without recalculating capacity", async () => {
    const graph = await createAuthenticatedGraph();
    const sampledAt = new Date(clock.now().getTime() - 6 * 60_000);
    await insertObservationRows(graph, sampledAt, { failed: false });
    const path = buildPath(ORGANIZATION_SPACE_OBSERVABILITY_PATH_TEMPLATE, {
      organizationId: graph.organizationId,
      spaceId: graph.spaceId,
    });
    const response = await fetch(`${testApi.baseUrl}${path}`, {
      headers: { Cookie: graph.cookie },
    });
    expect(response.status).toBe(200);
    const view = spaceObservabilitySchema.parse(await response.json());
    expect(view.capacity).toMatchObject({ status: "stale", sampledAt: sampledAt.toISOString() });
    expect(view.health).toMatchObject({ status: "stale", sampledAt: sampledAt.toISOString() });
  });

  test("reports explicit no-sample state", async () => {
    const graph = await createAuthenticatedGraph();
    const path = buildPath(ORGANIZATION_SPACE_OBSERVABILITY_PATH_TEMPLATE, {
      organizationId: graph.organizationId,
      spaceId: graph.spaceId,
    });
    const response = await fetch(`${testApi.baseUrl}${path}`, {
      headers: { Cookie: graph.cookie },
    });
    expect(response.status).toBe(200);
    expect(spaceObservabilitySchema.parse(await response.json())).toEqual({
      capacity: { reason: "no-sample", status: "unavailable" },
      health: { reason: "no-sample", status: "unavailable" },
      organizationId: graph.organizationId,
      spaceId: graph.spaceId,
    });
  });

  test("reports sample-failed state and preserves the last sampled time", async () => {
    const graph = await createAuthenticatedGraph();
    const sampledAt = new Date(clock.now().getTime() - 30_000);
    await insertObservationRows(graph, sampledAt, { failed: true });
    const path = buildPath(ORGANIZATION_SPACE_OBSERVABILITY_PATH_TEMPLATE, {
      organizationId: graph.organizationId,
      spaceId: graph.spaceId,
    });
    const response = await fetch(`${testApi.baseUrl}${path}`, {
      headers: { Cookie: graph.cookie },
    });
    expect(response.status).toBe(200);
    expect(spaceObservabilitySchema.parse(await response.json())).toEqual({
      capacity: {
        reason: "sample-failed",
        sampledAt: sampledAt.toISOString(),
        status: "unavailable",
      },
      health: {
        reason: "sample-failed",
        sampledAt: sampledAt.toISOString(),
        status: "unavailable",
      },
      organizationId: graph.organizationId,
      spaceId: graph.spaceId,
    });
  });

  test("returns a structured problem for an unknown restore", async () => {
    const graph = await createAuthenticatedGraph();
    const path = buildPath(ORGANIZATION_SPACE_RESTORE_ACTIVATION_PATH_TEMPLATE, {
      organizationId: graph.organizationId,
      restoreId: randomUUID(),
      spaceId: graph.spaceId,
    });
    const response = await fetch(`${testApi.baseUrl}${path}`, {
      headers: mutationHeaders(graph),
      method: "POST",
    });
    expect(response.status).toBe(409);
    expect(apiProblemSchema.parse(await response.json()).code).toBe("conflict");
  });
});
