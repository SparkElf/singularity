import type { DynamicModule } from "@nestjs/common";
import { Module } from "@nestjs/common";

import type { ApiConfiguration } from "./configuration.js";
import { CoreModule } from "./core.module.js";
import { DatabaseHealthController } from "./database-health.controller.js";
import type { Clock } from "./identity/clock.js";

export interface AppModuleOptions {
  clock: Clock;
  configuration: ApiConfiguration;
  databaseUrl: string | undefined;
}

@Module({})
export class AppModule {
  static register(options: AppModuleOptions): DynamicModule {
    return {
      module: AppModule,
      imports: [CoreModule.register(options)],
      controllers: [DatabaseHealthController],
    };
  }
}
