import { generateKeyPairSync, randomUUID } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  KernelCredentialService,
  RuntimeKernelDeploymentRegistry,
} from "@singularity/kernel-client";
import { afterEach, describe, expect, it } from "vitest";

import type { RestoreDeploymentConfiguration } from "../src/configuration.js";
import {
  ProcessRestoreDeployment,
  RestoreDeploymentError,
} from "../src/restore-deployment.js";
import type { RestoreSpaceJob } from "../src/worker.js";

const roots: string[] = [];

function configuration(rootDirectory: string): RestoreDeploymentConfiguration {
  const { privateKey } = generateKeyPairSync("ed25519");
  return {
    archiveToolPath: process.execPath,
    credentials: new KernelCredentialService({
      keyId: "restore-test",
      privateKey,
    }),
    gatewayHostname: "127.0.0.1",
    handlePrefix: "restore-test",
    kernelBinaryPath: process.execPath,
    kernelWorkingDirectory: rootDirectory,
    maximumArchiveBytes: 1_024,
    maximumEntryBytes: 1_024,
    maximumFiles: 10,
    maximumTotalBytes: 1_024,
    portRange: { first: 49_152, last: 65_535 },
    readinessPollMilliseconds: 10,
    runtimeRootDirectory: rootDirectory,
    startupTimeoutMilliseconds: 100,
    tls: {
      caCertificate: Buffer.from("test"),
      clientCertificate: Buffer.from("test"),
      clientPrivateKey: Buffer.from("test"),
      clientCaCertificateFile: process.execPath,
      deploymentProfile: "restore-test",
      gatewayClientDnsName: "gateway.test",
      serverCertificateFile: process.execPath,
      serverName: "kernel.test",
      serverPrivateKeyFile: process.execPath,
      servicePublicKeysFile: process.execPath,
    },
  };
}

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
      configuration(root),
      new RuntimeKernelDeploymentRegistry([]),
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
      configuration(root),
      new RuntimeKernelDeploymentRegistry([]),
    );

    await expect(deployment.destroyTarget(restoreJob())).resolves.toBeUndefined();
    expect(await readdir(root)).toEqual([]);
  });
});
