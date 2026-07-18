import type { DynamicModule } from "@nestjs/common";
import { Module } from "@nestjs/common";
import { DatabaseRuntime } from "@singularity/database";
import { RuntimeKernelDeploymentRegistry } from "@singularity/kernel-client";

import { NestWorkerJobLogger } from "./logger.js";
import { WORKER_JOB_LOGGER } from "./tokens.js";

@Module({})
export class WorkerPlatformModule {
  static register(
    database: DatabaseRuntime,
    deployments: RuntimeKernelDeploymentRegistry,
  ): DynamicModule {
    return {
      module: WorkerPlatformModule,
      providers: [
        { provide: DatabaseRuntime, useValue: database },
        {
          provide: RuntimeKernelDeploymentRegistry,
          useValue: deployments,
        },
        NestWorkerJobLogger,
        {
          provide: WORKER_JOB_LOGGER,
          useExisting: NestWorkerJobLogger,
        },
      ],
      exports: [
        DatabaseRuntime,
        RuntimeKernelDeploymentRegistry,
        NestWorkerJobLogger,
        WORKER_JOB_LOGGER,
      ],
    };
  }
}
