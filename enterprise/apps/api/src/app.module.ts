import type { DynamicModule } from "@nestjs/common";
import { Module } from "@nestjs/common";
import { DatabaseRuntime } from "@singularity/database";

import { DatabaseHealthController } from "./database-health.controller.js";

export interface AppModuleOptions {
  databaseUrl: string | undefined;
}

@Module({})
export class AppModule {
  static register(options: AppModuleOptions): DynamicModule {
    return {
      module: AppModule,
      controllers: [DatabaseHealthController],
      providers: [
        {
          provide: DatabaseRuntime,
          useFactory: () => new DatabaseRuntime(options.databaseUrl),
        },
      ],
    };
  }
}
