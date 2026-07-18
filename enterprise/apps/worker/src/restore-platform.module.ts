import type { DynamicModule, Type } from "@nestjs/common";
import { Module } from "@nestjs/common";

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
    platformModule: DynamicModule | Type<unknown>,
  ): DynamicModule {
    return {
      module: RestorePlatformModule,
      imports: [platformModule],
      providers: [
        {
          provide: RESTORE_PLATFORM_CONFIGURATION,
          useValue: configuration,
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
