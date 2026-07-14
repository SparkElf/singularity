import type { DynamicModule } from "@nestjs/common";
import { Module } from "@nestjs/common";
import { DatabaseRuntime } from "@singularity/database";

import type { ApiConfiguration } from "./configuration.js";
import type { Clock } from "./identity/clock.js";
import { IdentityController } from "./identity/identity.controller.js";
import { IdentityService } from "./identity/identity.service.js";
import { LoginRateLimiter } from "./identity/login-rate-limiter.js";
import { PasswordHasher } from "./identity/password-hasher.js";
import { AccessOperationsService } from "./operations/access-operations.service.js";
import { SpacesController } from "./spaces/spaces.controller.js";
import { SpaceAccessService } from "./spaces/space-access.service.js";
import { API_CONFIGURATION, CLOCK } from "./tokens.js";

export interface CoreModuleOptions {
  clock: Clock;
  configuration: ApiConfiguration;
  databaseUrl: string | undefined;
  initializeDummyPasswordHash?: boolean;
}

@Module({})
export class CoreModule {
  static register(options: CoreModuleOptions): DynamicModule {
    return {
      module: CoreModule,
      controllers: [IdentityController, SpacesController],
      providers: [
        {
          provide: API_CONFIGURATION,
          useValue: options.configuration,
        },
        {
          provide: CLOCK,
          useValue: options.clock,
        },
        {
          provide: DatabaseRuntime,
          useFactory: () => new DatabaseRuntime(options.databaseUrl),
        },
        {
          provide: PasswordHasher,
          useFactory: async () => {
            const passwordHasher = new PasswordHasher();
            if (options.initializeDummyPasswordHash !== false) {
              await passwordHasher.initialize();
            }
            return passwordHasher;
          },
        },
        {
          provide: LoginRateLimiter,
          useFactory: () => new LoginRateLimiter(),
        },
        {
          provide: IdentityService,
          inject: [DatabaseRuntime, PasswordHasher, LoginRateLimiter, CLOCK],
          useFactory: (
            database: DatabaseRuntime,
            passwordHasher: PasswordHasher,
            loginRateLimiter: LoginRateLimiter,
            clock: Clock,
          ) =>
            new IdentityService(
              database,
              passwordHasher,
              loginRateLimiter,
              clock,
            ),
        },
        {
          provide: SpaceAccessService,
          inject: [DatabaseRuntime],
          useFactory: (database: DatabaseRuntime) =>
            new SpaceAccessService(database),
        },
        {
          provide: AccessOperationsService,
          inject: [DatabaseRuntime, IdentityService, SpaceAccessService, CLOCK],
          useFactory: (
            database: DatabaseRuntime,
            identity: IdentityService,
            spaces: SpaceAccessService,
            clock: Clock,
          ) => new AccessOperationsService(database, identity, spaces, clock),
        },
      ],
      exports: [
        AccessOperationsService,
        API_CONFIGURATION,
        CLOCK,
        DatabaseRuntime,
        IdentityService,
        SpaceAccessService,
      ],
    };
  }
}
