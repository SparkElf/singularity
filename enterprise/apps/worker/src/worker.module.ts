import type { DynamicModule, Type } from "@nestjs/common";
import { Module } from "@nestjs/common";
import { DiscoveryModule } from "@nestjs/core";
import {
  AuditWriter,
  type DatabaseRuntime,
} from "@singularity/database";
import { KernelPrivateClient } from "@singularity/kernel-client";
import { FileObjectStore } from "@singularity/object-store";

import type { WorkerConfiguration } from "./configuration.js";
import { WorkerDeclarationDiscovery } from "./declaration-discovery.js";
import { ContentAuditHandler } from "./content-audit-reconciliation.js";
import { KernelWorkerClient } from "./kernel-worker-client.js";
import {
  ArchiveAuditHandler,
  BackupSpaceHandler,
  RestoreSpaceHandler,
  SampleKernelHandler,
} from "./l1-handlers.js";
import { PostgresWorkerJobRepository } from "./postgres-job-repository.js";
import { RestorePlatformModule } from "./restore-platform.module.js";
import {
  ArchiveAuditJobProducer,
  ContentAuditJobProducer,
  SampleKernelJobProducer,
} from "./scheduled-producers.js";
import {
  BACKUP_REQUEST_TIMEOUT_MILLISECONDS,
  KERNEL_WORKER,
  MAXIMUM_AUDIT_ARCHIVE_BYTES,
  MAXIMUM_AUDIT_ARCHIVE_EVENT_COUNT,
  MAXIMUM_BACKUP_BYTES,
  MAXIMUM_BACKUP_FILES,
  WORKER_CONFIGURATION,
} from "./tokens.js";
import { WorkerApplication } from "./worker-application.js";
import { WorkerPlatformModule } from "./worker-platform.module.js";

export interface WorkerModuleOptions {
  readonly configuration: WorkerConfiguration;
  readonly database: DatabaseRuntime;
  readonly restorePlatformModule?: DynamicModule | Type<unknown>;
}

@Module({})
export class WorkerModule {
  static register(options: WorkerModuleOptions): DynamicModule {
    const platformModule = WorkerPlatformModule.register(
      options.database,
      options.configuration.deployments,
    );
    const restorePlatformModule = options.restorePlatformModule ??
      RestorePlatformModule.register(options.configuration.restore, platformModule);
    return {
      module: WorkerModule,
      imports: [DiscoveryModule, platformModule, restorePlatformModule],
      providers: [
        {
          provide: WORKER_CONFIGURATION,
          useValue: options.configuration,
        },
        {
          provide: AuditWriter,
          inject: [WORKER_CONFIGURATION],
          useFactory: (configuration: WorkerConfiguration) =>
            new AuditWriter(configuration.audit),
        },
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
          provide: BACKUP_REQUEST_TIMEOUT_MILLISECONDS,
          inject: [WORKER_CONFIGURATION],
          useFactory: (configuration: WorkerConfiguration) =>
            configuration.backupRequestTimeoutMilliseconds,
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
        {
          provide: MAXIMUM_BACKUP_FILES,
          inject: [WORKER_CONFIGURATION],
          useFactory: (configuration: WorkerConfiguration) =>
            configuration.restore.maximumFiles,
        },
        ArchiveAuditHandler,
        ArchiveAuditJobProducer,
        BackupSpaceHandler,
        ContentAuditHandler,
        ContentAuditJobProducer,
        KernelWorkerClient,
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
