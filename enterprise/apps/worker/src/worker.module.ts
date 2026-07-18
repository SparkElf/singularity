import type { DynamicModule, Type } from "@nestjs/common";
import { Module } from "@nestjs/common";
import { DiscoveryModule } from "@nestjs/core";
import { DatabaseRuntime } from "@singularity/database";
import { KernelPrivateClient } from "@singularity/kernel-client";
import { FileObjectStore } from "@singularity/object-store";

import type { WorkerConfiguration } from "./configuration.js";
import { WorkerDeclarationDiscovery } from "./declaration-discovery.js";
import { KernelWorkerClient } from "./kernel-worker-client.js";
import {
  ArchiveAuditHandler,
  BackupSpaceHandler,
  RestoreSpaceHandler,
  SampleKernelHandler,
} from "./l1-handlers.js";
import { NestWorkerJobLogger } from "./logger.js";
import { PostgresWorkerJobRepository } from "./postgres-job-repository.js";
import {
  ArchiveAuditJobProducer,
  SampleKernelJobProducer,
} from "./scheduled-producers.js";
import {
  KERNEL_WORKER,
  MAXIMUM_AUDIT_ARCHIVE_BYTES,
  MAXIMUM_AUDIT_ARCHIVE_EVENT_COUNT,
  MAXIMUM_BACKUP_BYTES,
  WORKER_CONFIGURATION,
} from "./tokens.js";
import { WorkerApplication } from "./worker-application.js";

export interface WorkerModuleOptions {
  readonly configuration: WorkerConfiguration;
  readonly database: DatabaseRuntime;
  readonly restorePlatformModule: DynamicModule | Type<unknown>;
}

@Module({})
export class WorkerModule {
  static register(options: WorkerModuleOptions): DynamicModule {
    const restorePlatformModule = options.restorePlatformModule;
    return {
      module: WorkerModule,
      imports: [DiscoveryModule, restorePlatformModule],
      providers: [
        {
          provide: WORKER_CONFIGURATION,
          useValue: options.configuration,
        },
        { provide: DatabaseRuntime, useValue: options.database },
        {
          provide: FileObjectStore,
          inject: [WORKER_CONFIGURATION],
          useFactory: (configuration: WorkerConfiguration) =>
            FileObjectStore.open({
              maximumObjectBytes: configuration.maximumObjectBytes,
              rootDirectory: configuration.objectStoreRootDirectory,
            }),
        },
        {
          provide: KernelPrivateClient,
          inject: [WORKER_CONFIGURATION],
          useFactory: (configuration: WorkerConfiguration) =>
            new KernelPrivateClient({
              credentials: configuration.credentials,
              deployments: configuration.deployments,
              policies: configuration.policies,
            }),
        },
        {
          provide: KERNEL_WORKER,
          useExisting: KernelWorkerClient,
        },
        {
          provide: MAXIMUM_AUDIT_ARCHIVE_BYTES,
          inject: [WORKER_CONFIGURATION],
          useFactory: (configuration: WorkerConfiguration) =>
            configuration.maximumAuditArchiveBytes,
        },
        {
          provide: MAXIMUM_AUDIT_ARCHIVE_EVENT_COUNT,
          inject: [WORKER_CONFIGURATION],
          useFactory: (configuration: WorkerConfiguration) =>
            configuration.maximumAuditArchiveEvents,
        },
        {
          provide: MAXIMUM_BACKUP_BYTES,
          inject: [WORKER_CONFIGURATION],
          useFactory: (configuration: WorkerConfiguration) =>
            configuration.maximumBackupBytes,
        },
        ArchiveAuditHandler,
        ArchiveAuditJobProducer,
        BackupSpaceHandler,
        KernelWorkerClient,
        NestWorkerJobLogger,
        PostgresWorkerJobRepository,
        RestoreSpaceHandler,
        SampleKernelHandler,
        SampleKernelJobProducer,
        WorkerApplication,
        WorkerDeclarationDiscovery,
      ],
      exports: [WorkerApplication, WorkerDeclarationDiscovery],
    };
  }
}
