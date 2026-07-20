import "reflect-metadata";

import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { OnModuleInit } from "@nestjs/common";
import { Injectable, Module } from "@nestjs/common";
import { DiscoveryModule, NestFactory } from "@nestjs/core";
import { kernelRoutePolicies } from "@singularity/authorization";
import {
  DatabaseRuntime,
  parseAuditConfiguration,
} from "@singularity/database";
import {
  KernelCredentialService,
  KernelRoutePolicyRegistry,
  RuntimeKernelDeploymentRegistry,
} from "@singularity/kernel-client";
import { describe, expect, it } from "vitest";

import { createWorkerApplication } from "../src/application.js";
import type { WorkerConfiguration } from "../src/configuration.js";
import { WorkerDeclarationDiscovery } from "../src/declaration-discovery.js";
import {
  HandlesWorkerJob,
  ProducesWorkerJob,
  scheduledWorkerJobKinds,
} from "../src/job-declarations.js";
import type { RestoreDeploymentPort } from "../src/l1-handlers.js";
import { RESTORE_DEPLOYMENT } from "../src/tokens.js";
import { workerJobKinds } from "../src/worker.js";

const DATABASE_URL =
  "postgresql://worker:worker@127.0.0.1:1/singularity_test?schema=worker_bootstrap_test";

const restoreDeployment: RestoreDeploymentPort = {
  async commitTarget(): Promise<void> {
    return;
  },
  async destroyTarget(): Promise<void> {
    return;
  },
  async restore() {
    throw new Error("Restore is not executed during bootstrap");
  },
};

function configuration(rootDirectory: string): WorkerConfiguration {
  const { privateKey } = generateKeyPairSync("ed25519");
  const credentials = new KernelCredentialService({
    keyId: "worker-test",
    privateKey,
  });
  return {
    archiveAuditIntervalMilliseconds: 300_000,
    audit: parseAuditConfiguration({
      SINGULARITY_AUDIT_HMAC_KEY: Buffer.alloc(32, 7).toString("base64url"),
      SINGULARITY_AUDIT_KEY_VERSION: "worker-test-v1",
    }),
    backupRequestTimeoutMilliseconds: 10_000,
    claimBatchSize: 4,
    contentAuditBatchSize: 100,
    contentAuditReconciliationIntervalMilliseconds: 5_000,
    credentials,
    deployments: new RuntimeKernelDeploymentRegistry([]),
    leaseDurationMilliseconds: 30_000,
    leaseRenewalMilliseconds: 10_000,
    maximumAuditArchiveBytes: 1_024 * 1_024,
    maximumAuditArchiveEvents: 100,
    maximumBackupBytes: 2 * 1_024 * 1_024,
    maximumConcurrentJobs: 2,
    maximumObjectBytes: 2 * 1_024 * 1_024,
    objectStoreRootDirectory: rootDirectory,
    policies: new KernelRoutePolicyRegistry(kernelRoutePolicies),
    pollIntervalMilliseconds: 1_000,
    restore: {
      archiveTimeoutMilliseconds: 10_000,
      archiveToolPath: rootDirectory,
      credentials,
      gatewayHostname: "127.0.0.1",
      handlePrefix: "restore-test",
      kernelBinaryPath: rootDirectory,
      kernelListenAddress: "127.0.0.1",
      kernelWorkingDirectory: rootDirectory,
      maximumArchiveBytes: 2 * 1_024 * 1_024,
      maximumEntryBytes: 2 * 1_024 * 1_024,
      maximumFiles: 100,
      maximumTotalBytes: 2 * 1_024 * 1_024,
      portRange: { first: 40_000, last: 40_010 },
      readinessPollMilliseconds: 100,
      runtimeRootDirectory: rootDirectory,
      runtimeOwner: "worker-test",
      startupTimeoutMilliseconds: 1_000,
      tls: {
        caCertificate: Buffer.from("test"),
        clientCertificate: Buffer.from("test"),
        clientPrivateKey: Buffer.from("test"),
        clientCaCertificateFile: rootDirectory,
        deploymentProfile: "restore-test",
        gatewayClientDnsName: "gateway.test",
        serverCertificateFile: rootDirectory,
        serverName: "kernel.test",
        serverPrivateKeyFile: rootDirectory,
        servicePublicKeysFile: rootDirectory,
      },
    },
    sampleKernelIntervalMilliseconds: 60_000,
    workerId: "worker-test",
  };
}

@Module({
  exports: [RESTORE_DEPLOYMENT],
  providers: [{ provide: RESTORE_DEPLOYMENT, useValue: restoreDeployment }],
})
class TestRestorePlatformModule {}

@Module({})
class MissingRestorePlatformModule {}

@Injectable()
@HandlesWorkerJob({ kind: "backup-space" })
class DuplicateBackupHandler {
  readonly kind = "backup-space" as const;

  decode(): never {
    throw new Error("Duplicate declaration is not executed");
  }

  async execute(): Promise<void> {
    return;
  }
}

@Module({
  exports: [RESTORE_DEPLOYMENT],
  providers: [
    DuplicateBackupHandler,
    { provide: RESTORE_DEPLOYMENT, useValue: restoreDeployment },
  ],
})
class DuplicateHandlerPlatformModule {}

@Injectable()
@ProducesWorkerJob({ kind: "sample-kernel" })
class OnlySampleKernelProducer {
  readonly intervalMilliseconds = 60_000;
  readonly kind = "sample-kernel" as const;

  async produce(): Promise<number> {
    return 0;
  }
}

@Injectable()
class ProducerDeclarationBootstrap implements OnModuleInit {
  constructor(private readonly declarations: WorkerDeclarationDiscovery) {}

  onModuleInit(): void {
    this.declarations.producers();
  }
}

@Module({
  imports: [DiscoveryModule],
  providers: [
    OnlySampleKernelProducer,
    ProducerDeclarationBootstrap,
    WorkerDeclarationDiscovery,
  ],
})
class IncompleteProducerModule {}

@Injectable()
@ProducesWorkerJob({ kind: "sample-kernel" })
class ConflictingSampleKernelProducer {
  readonly intervalMilliseconds = 60_000;
  readonly kind = "archive-audit" as const;

  async produce(): Promise<number> {
    return 0;
  }
}

@Module({
  imports: [DiscoveryModule],
  providers: [
    ConflictingSampleKernelProducer,
    ProducerDeclarationBootstrap,
    WorkerDeclarationDiscovery,
  ],
})
class ConflictingProducerModule {}

describe("Worker Nest composition", () => {
  it("discovers the production handlers and scheduled producers", async () => {
    const rootDirectory = await mkdtemp(join(tmpdir(), "worker-bootstrap-"));
    const context = await createWorkerApplication({
      configuration: configuration(rootDirectory),
      database: new DatabaseRuntime(DATABASE_URL),
      logger: false,
      restorePlatformModule: TestRestorePlatformModule,
    });
    try {
      const declarations = context.get(WorkerDeclarationDiscovery);
      expect(declarations.handlers().map((handler) => handler.kind)).toEqual(
        workerJobKinds,
      );
      expect(declarations.producers().map((producer) => producer.kind)).toEqual(
        scheduledWorkerJobKinds,
      );
    } finally {
      await context.close();
      await rm(rootDirectory, { force: true, recursive: true });
    }
  });

  it("rejects bootstrap when the declared restore platform omits its provider", async () => {
    const rootDirectory = await mkdtemp(join(tmpdir(), "worker-bootstrap-"));
    try {
      await expect(
        createWorkerApplication({
          configuration: configuration(rootDirectory),
          database: new DatabaseRuntime(DATABASE_URL),
          logger: false,
          restorePlatformModule: MissingRestorePlatformModule,
        }),
      ).rejects.toThrow(/RESTORE_DEPLOYMENT/);
    } finally {
      await rm(rootDirectory, { force: true, recursive: true });
    }
  });

  it("rejects duplicate handler metadata during Nest initialization", async () => {
    const rootDirectory = await mkdtemp(join(tmpdir(), "worker-bootstrap-"));
    try {
      await expect(
        createWorkerApplication({
          configuration: configuration(rootDirectory),
          database: new DatabaseRuntime(DATABASE_URL),
          logger: false,
          restorePlatformModule: DuplicateHandlerPlatformModule,
        }),
      ).rejects.toThrow("Worker handler declarations conflict");
    } finally {
      await rm(rootDirectory, { force: true, recursive: true });
    }
  });

  it("rejects a missing scheduled producer during Nest initialization", async () => {
    await expect(
      NestFactory.createApplicationContext(IncompleteProducerModule, {
        abortOnError: false,
        logger: false,
      }),
    ).rejects.toThrow("Worker producer declarations are incomplete");
  });

  it("rejects conflicting producer metadata during Nest initialization", async () => {
    await expect(
      NestFactory.createApplicationContext(ConflictingProducerModule, {
        abortOnError: false,
        logger: false,
      }),
    ).rejects.toThrow("Worker producer declarations conflict");
  });
});
