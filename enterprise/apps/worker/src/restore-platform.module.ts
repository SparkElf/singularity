import type { DynamicModule } from "@nestjs/common";
import { Module } from "@nestjs/common";
import { DatabaseRuntime } from "@singularity/database";
import { RuntimeKernelDeploymentRegistry } from "@singularity/kernel-client";

import type { RestoreDeploymentConfiguration } from "./configuration.js";
import {
  ProcessRestoreDeployment,
  RESTORE_PLATFORM_CONFIGURATION,
} from "./restore-deployment.js";
import { RESTORE_DEPLOYMENT } from "./tokens.js";

@Module({})
export class RestorePlatformModule {
  static register(
    configuration: RestoreDeploymentConfiguration,
    deployments: RuntimeKernelDeploymentRegistry,
    database: DatabaseRuntime,
  ): DynamicModule {
    return {
      module: RestorePlatformModule,
      providers: [
        { provide: DatabaseRuntime, useValue: database },
        {
          provide: RESTORE_PLATFORM_CONFIGURATION,
          useValue: configuration,
        },
        {
          provide: RuntimeKernelDeploymentRegistry,
          useValue: deployments,
        },
        ProcessRestoreDeployment,
        {
          provide: RESTORE_DEPLOYMENT,
          useExisting: ProcessRestoreDeployment,
        },
      ],
      exports: [RESTORE_DEPLOYMENT],
    };
  }
}
