import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import {
  link,
  mkdir,
  mkdtemp,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  RuntimeKernelDeploymentRegistry,
} from "@singularity/kernel-client";
import { DatabaseRuntime } from "@singularity/database";
import { afterEach, describe, expect, it, vi } from "vitest";

const processInspection = vi.hoisted(() => ({
  commandLine: undefined as string | undefined,
  environment: undefined as string | undefined,
  overridePid: undefined as number | undefined,
  rootUnavailable: false,
  unreadablePid: undefined as number | undefined,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...original,
    opendir: async (...arguments_: Parameters<typeof original.opendir>) => {
      if (processInspection.rootUnavailable && arguments_[0] === "/proc") {
        throw Object.assign(new Error("process inspection unavailable"), {
          code: "ENOENT",
        });
      }
      return original.opendir(...arguments_);
    },
    readFile: async (...arguments_: Parameters<typeof original.readFile>) => {
      if (
        processInspection.overridePid !== undefined &&
        String(arguments_[0]).startsWith(
          `/proc/${processInspection.overridePid}/`,
        )
      ) {
        if (
          String(arguments_[0]).endsWith("/cmdline") &&
          processInspection.commandLine !== undefined
        ) {
          return processInspection.commandLine as never;
        }
        if (
          String(arguments_[0]).endsWith("/environ") &&
          processInspection.environment !== undefined
        ) {
          return processInspection.environment as never;
        }
      }
      if (
        processInspection.unreadablePid !== undefined &&
        String(arguments_[0]).startsWith(
          `/proc/${processInspection.unreadablePid}/`,
        )
      ) {
        throw Object.assign(new Error("process identity unavailable"), {
          code: "ENOENT",
        });
      }
      return original.readFile(...arguments_);
    },
  };
});

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

function targetPaths(root: string, job: RestoreSpaceJob) {
  const workspaceDirectoryName = `restore-test-${job.targetKernelInstanceId}`;
  return {
    metadataPath: join(root, `.${workspaceDirectoryName}.json`),
    workspaceDirectory: join(root, workspaceDirectoryName),
    workspaceDirectoryName,
  };
}

function runtimeMetadata(job: RestoreSpaceJob) {
  const workspaceDirectoryName = `restore-test-${job.targetKernelInstanceId}`;
  return {
    handle: workspaceDirectoryName,
    hostname: "127.0.0.1",
    kernelInstanceId: job.targetKernelInstanceId,
    pid: null,
    port: 49_152,
    serverName: "kernel.test",
    spaceId: job.targetSpaceId,
    state: "starting",
    tlsProfile: "restore-test",
    workspaceDirectoryName,
  } as const;
}

afterEach(async () => {
  processInspection.commandLine = undefined;
  processInspection.environment = undefined;
  processInspection.overridePid = undefined;
  processInspection.rootUnavailable = false;
  processInspection.unreadablePid = undefined;
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

  it("removes the deterministic workspace when runtime metadata is missing", async () => {
    const root = await mkdtemp(join(tmpdir(), "restore-deployment-"));
    roots.push(root);
    const deployment = new ProcessRestoreDeployment(
      restoreDeploymentConfiguration(root),
      new DatabaseRuntime(undefined),
      new RuntimeKernelDeploymentRegistry([]),
      new CapturingWorkerLogger(),
    );
    const job = restoreJob();
    const { workspaceDirectory } = targetPaths(root, job);
    await mkdir(workspaceDirectory, { mode: 0o700 });

    await expect(deployment.destroyTarget(job)).resolves.toBeUndefined();
    expect(await readdir(root)).toEqual([]);
  });

  it("preserves the workspace when the Linux process table cannot be opened", async () => {
    const root = await mkdtemp(join(tmpdir(), "restore-deployment-"));
    roots.push(root);
    const deployment = new ProcessRestoreDeployment(
      restoreDeploymentConfiguration(root),
      new DatabaseRuntime(undefined),
      new RuntimeKernelDeploymentRegistry([]),
      new CapturingWorkerLogger(),
    );
    const job = restoreJob();
    const { metadataPath, workspaceDirectory, workspaceDirectoryName } =
      targetPaths(root, job);
    await mkdir(workspaceDirectory, { mode: 0o700 });
    await writeFile(metadataPath, JSON.stringify(runtimeMetadata(job)), {
      mode: 0o600,
    });
    processInspection.rootUnavailable = true;

    await expect(deployment.destroyTarget(job)).rejects.toMatchObject<
      Partial<RestoreDeploymentError>
    >({ code: "target-cleanup-failed" });
    expect((await readdir(root)).sort()).toEqual(
      [`.${workspaceDirectoryName}.json`, workspaceDirectoryName].sort(),
    );
  });

  it("terminates a matching process when the persisted PID is still null", async () => {
    const root = await mkdtemp(join(tmpdir(), "restore-deployment-"));
    roots.push(root);
    const configuration = restoreDeploymentConfiguration(root);
    const deployment = new ProcessRestoreDeployment(
      configuration,
      new DatabaseRuntime(undefined),
      new RuntimeKernelDeploymentRegistry([]),
      new CapturingWorkerLogger(),
    );
    const job = restoreJob();
    const { metadataPath, workspaceDirectory } = targetPaths(root, job);
    await mkdir(workspaceDirectory, { mode: 0o700 });
    await writeFile(metadataPath, JSON.stringify(runtimeMetadata(job)), {
      mode: 0o600,
    });
    const child = spawn(
      process.execPath,
      [
        "-e",
        "setInterval(() => {}, 1000);",
        "--workspace",
        workspaceDirectory,
        "--port",
        "49152",
      ],
      {
        env: {
          ...process.env,
          SINGULARITY_KERNEL_INSTANCE_ID: job.targetKernelInstanceId,
          SINGULARITY_KERNEL_LISTEN_ADDRESS: "127.0.0.1",
          SINGULARITY_KERNEL_SPACE_ID: job.targetSpaceId,
        },
        stdio: "ignore",
      },
    );
    const childClosed = new Promise<void>((resolve, reject) => {
      child.once("close", () => resolve());
      child.once("error", reject);
    });
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", () => resolve());
      child.once("error", reject);
    });
    try {
      await expect(deployment.destroyTarget(job)).resolves.toBeUndefined();
      await childClosed;
      expect(await readdir(root)).toEqual([]);
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
      await childClosed.catch(() => undefined);
    }
  });

  it("rejects duplicate process identity arguments and environment keys", async () => {
    const root = await mkdtemp(join(tmpdir(), "restore-deployment-"));
    roots.push(root);
    const configuration = restoreDeploymentConfiguration(root);
    const deployment = new ProcessRestoreDeployment(
      configuration,
      new DatabaseRuntime(undefined),
      new RuntimeKernelDeploymentRegistry([]),
      new CapturingWorkerLogger(),
    );
    const job = restoreJob();
    const { metadataPath, workspaceDirectory, workspaceDirectoryName } =
      targetPaths(root, job);
    await mkdir(workspaceDirectory, { mode: 0o700 });
    await writeFile(
      metadataPath,
      JSON.stringify({ ...runtimeMetadata(job), pid: process.pid }),
      { mode: 0o600 },
    );
    processInspection.overridePid = process.pid;
    processInspection.commandLine = [
      configuration.kernelBinaryPath,
      "serve",
      "--workspace",
      workspaceDirectory,
      "--workspace",
      workspaceDirectory,
      "--port",
      "49152",
    ].join("\u0000");
    processInspection.environment = [
      `SINGULARITY_KERNEL_INSTANCE_ID=${job.targetKernelInstanceId}`,
      "SINGULARITY_KERNEL_LISTEN_ADDRESS=127.0.0.1",
      `SINGULARITY_KERNEL_SPACE_ID=${job.targetSpaceId}`,
    ].join("\u0000");
    await expect(deployment.destroyTarget(job)).rejects.toMatchObject<
      Partial<RestoreDeploymentError>
    >({ code: "target-runtime-invalid" });

    processInspection.commandLine = [
      configuration.kernelBinaryPath,
      "serve",
      "--workspace",
      workspaceDirectory,
      "--port",
      "49152",
    ].join("\u0000");
    processInspection.environment = [
      `SINGULARITY_KERNEL_INSTANCE_ID=${job.targetKernelInstanceId}`,
      `SINGULARITY_KERNEL_INSTANCE_ID=${job.targetKernelInstanceId}`,
      "SINGULARITY_KERNEL_LISTEN_ADDRESS=127.0.0.1",
      `SINGULARITY_KERNEL_SPACE_ID=${job.targetSpaceId}`,
    ].join("\u0000");
    await expect(deployment.destroyTarget(job)).rejects.toMatchObject<
      Partial<RestoreDeploymentError>
    >({ code: "target-runtime-invalid" });
    expect((await readdir(root)).sort()).toEqual(
      [`.${workspaceDirectoryName}.json`, workspaceDirectoryName].sort(),
    );
  });

  it("preserves a known target when its persisted process identity cannot be read", async () => {
    const root = await mkdtemp(join(tmpdir(), "restore-deployment-"));
    roots.push(root);
    const deployment = new ProcessRestoreDeployment(
      restoreDeploymentConfiguration(root),
      new DatabaseRuntime(undefined),
      new RuntimeKernelDeploymentRegistry([]),
      new CapturingWorkerLogger(),
    );
    const job = restoreJob();
    const { metadataPath, workspaceDirectory, workspaceDirectoryName } =
      targetPaths(root, job);
    await mkdir(workspaceDirectory, { mode: 0o700 });
    await writeFile(
      metadataPath,
      JSON.stringify({ ...runtimeMetadata(job), pid: process.pid }),
      { mode: 0o600 },
    );
    processInspection.unreadablePid = process.pid;

    await expect(deployment.destroyTarget(job)).rejects.toMatchObject<
      Partial<RestoreDeploymentError>
    >({ code: "target-cleanup-failed" });
    expect((await readdir(root)).sort()).toEqual(
      [`.${workspaceDirectoryName}.json`, workspaceDirectoryName].sort(),
    );
  });

  it("rejects hard-linked runtime metadata", async () => {
    const root = await mkdtemp(join(tmpdir(), "restore-deployment-"));
    roots.push(root);
    const deployment = new ProcessRestoreDeployment(
      restoreDeploymentConfiguration(root),
      new DatabaseRuntime(undefined),
      new RuntimeKernelDeploymentRegistry([]),
      new CapturingWorkerLogger(),
    );
    const job = restoreJob();
    const { metadataPath } = targetPaths(root, job);
    await writeFile(metadataPath, JSON.stringify(runtimeMetadata(job)), {
      mode: 0o600,
    });
    await link(metadataPath, join(root, "metadata-hardlink.json"));

    await expect(deployment.destroyTarget(job)).rejects.toMatchObject<
      Partial<RestoreDeploymentError>
    >({ code: "target-runtime-invalid" });
  });

  it("rejects a prefixed runtime artifact that is not a directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "restore-deployment-"));
    roots.push(root);
    const deployment = new ProcessRestoreDeployment(
      restoreDeploymentConfiguration(root),
      new DatabaseRuntime(undefined),
      new RuntimeKernelDeploymentRegistry([]),
      new CapturingWorkerLogger(),
    );
    const job = restoreJob();
    const { workspaceDirectory } = targetPaths(root, job);
    await writeFile(workspaceDirectory, "not a workspace", { mode: 0o600 });

    await expect(deployment.onModuleInit()).rejects.toMatchObject<
      Partial<RestoreDeploymentError>
    >({ code: "target-runtime-invalid" });
  });
});
