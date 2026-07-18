import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  RuntimeKernelDeploymentRegistry,
} from "@singularity/kernel-client";
import { DatabaseRuntime } from "@singularity/database";
import { afterEach, describe, expect, it } from "vitest";

import {
  ProcessRestoreDeployment,
  RestoreDeploymentError,
} from "../src/restore-deployment.js";
import type { RestoreSpaceJob } from "../src/worker.js";
import {
  CapturingWorkerLogger,
  restoreDeploymentConfiguration,
} from "./support/restore-deployment.js";

const roots: string[] = [];

function restoreJob(): RestoreSpaceJob {
  return {
    attempt: 1,
    backupId: randomUUID(),
    id: randomUUID(),
    kind: "restore-space",
    leaseExpiresAt: new Date("2026-07-18T12:00:00.000Z"),
    organizationId: randomUUID(),
    requestId: randomUUID(),
    restoreId: randomUUID(),
    sourceSpaceId: randomUUID(),
    targetKernelInstanceId: randomUUID(),
    targetSpaceId: randomUUID(),
  };
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { force: true, recursive: true })),
  );
});

describe("ProcessRestoreDeployment archive boundary", () => {
  it("rejects a corrupt archive before deployment and removes its isolated target", async () => {
    const root = await mkdtemp(join(tmpdir(), "restore-deployment-"));
    roots.push(root);
    const deployment = new ProcessRestoreDeployment(
      restoreDeploymentConfiguration(root),
      new DatabaseRuntime(undefined),
      new RuntimeKernelDeploymentRegistry([]),
      new CapturingWorkerLogger(),
    );
    const job = restoreJob();

    await expect(
      deployment.restore(
        {
          archive: [Buffer.from("not the expected archive", "utf8")],
          expectedSha256: "0".repeat(64),
          job,
        },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject<Partial<RestoreDeploymentError>>({
      code: "archive-digest-mismatch",
    });

    expect(await readdir(root)).toEqual([]);
  });

  it("treats cleanup of an absent target as an idempotent success", async () => {
    const root = await mkdtemp(join(tmpdir(), "restore-deployment-"));
    roots.push(root);
    const deployment = new ProcessRestoreDeployment(
      restoreDeploymentConfiguration(root),
      new DatabaseRuntime(undefined),
      new RuntimeKernelDeploymentRegistry([]),
      new CapturingWorkerLogger(),
    );

    await expect(deployment.destroyTarget(restoreJob())).resolves.toBeUndefined();
    expect(await readdir(root)).toEqual([]);
  });
});
