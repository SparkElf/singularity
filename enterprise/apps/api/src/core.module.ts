import type { DynamicModule } from "@nestjs/common";
import { Module } from "@nestjs/common";
import { DiscoveryModule } from "@nestjs/core";
import { DatabaseRuntime } from "@singularity/database";

import { AuditController } from "./audit/audit.controller.js";
import { AuditService } from "./audit/audit.service.js";
import {
  AuditWriter,
  AUDIT_CONFIGURATION,
  type AuditConfiguration,
} from "./audit/audit-writer.service.js";
import { BackupController } from "./backups/backup.controller.js";
import { BackupService } from "./backups/backup.service.js";
import type { ApiConfiguration } from "./configuration.js";
import { GroupManagementService } from "./groups/group-management.service.js";
import { GroupsController } from "./groups/groups.controller.js";
import type { Clock } from "./identity/clock.js";
import { IdentityController } from "./identity/identity.controller.js";
import { HttpAccessGuard } from "./identity/http-access.js";
import { IdentityService } from "./identity/identity.service.js";
import { LoginRateLimiter } from "./identity/login-rate-limiter.js";
import { PasswordHasher } from "./identity/password-hasher.js";
import { AccessChangedPublisher } from "./kernel/access-changed.js";
import {
  FetchOidcProviderClient,
  FileOidcClientSecretResolver,
  type OidcClientSecretResolver,
  OidcService,
} from "./identity/oidc.service.js";
import { OidcController } from "./identity/oidc.controller.js";
import { AccessOperationDiscovery } from "./operations/access-operation-discovery.js";
import { AccessOperationsService } from "./operations/access-operations.service.js";
import { OrganizationManagementService } from "./organizations/organization-management.service.js";
import { OrganizationsController } from "./organizations/organizations.controller.js";
import { SpacesController } from "./spaces/spaces.controller.js";
import { SpaceAccessService } from "./spaces/space-access.service.js";
import { SpaceManagementController } from "./spaces/space-management.controller.js";
import { SpaceManagementService } from "./spaces/space-management.service.js";
import { SpaceObservabilityController } from "./spaces/space-observability.controller.js";
import { SpaceObservabilityService } from "./spaces/space-observability.service.js";
import {
  API_CONFIGURATION,
  CLOCK,
  OIDC_CLIENT_SECRET_RESOLVER,
  OIDC_PROVIDER_CLIENT,
} from "./tokens.js";

export interface CoreModuleOptions {
  clock: Clock;
  configuration: ApiConfiguration;
  databaseUrl: string | undefined;
  auditConfiguration: AuditConfiguration;
  initializeDummyPasswordHash?: boolean;
}

@Module({})
export class CoreModule {
  static register(options: CoreModuleOptions): DynamicModule {
    return {
      module: CoreModule,
      imports: [DiscoveryModule],
      controllers: [
        GroupsController,
        IdentityController,
        OidcController,
        OrganizationsController,
        SpaceManagementController,
        SpacesController,
        AuditController,
        BackupController,
        SpaceObservabilityController,
      ],
      providers: [
        {
          provide: API_CONFIGURATION,
          useValue: options.configuration,
        },
        { provide: AUDIT_CONFIGURATION, useValue: options.auditConfiguration },
        AuditService,
        AuditWriter,
        BackupService,
        SpaceObservabilityService,
        {
          provide: CLOCK,
          useValue: options.clock,
        },
        {
          provide: DatabaseRuntime,
          useFactory: () => new DatabaseRuntime(options.databaseUrl),
        },
        AccessChangedPublisher,
        HttpAccessGuard,
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
        IdentityService,
        SpaceAccessService,
        OrganizationManagementService,
        GroupManagementService,
        SpaceManagementService,
        {
          provide: OIDC_CLIENT_SECRET_RESOLVER,
          useFactory: () =>
            new FileOidcClientSecretResolver(
              options.configuration.oidcClientSecretFiles,
            ),
        },
        {
          provide: OIDC_PROVIDER_CLIENT,
          inject: [OIDC_CLIENT_SECRET_RESOLVER],
          useFactory: (secretResolver: OidcClientSecretResolver) =>
            new FetchOidcProviderClient(secretResolver),
        },
        OidcService,
        AccessOperationDiscovery,
        AccessOperationsService,
      ],
      exports: [
        AccessChangedPublisher,
        AccessOperationsService,
        API_CONFIGURATION,
        CLOCK,
        DatabaseRuntime,
        GroupManagementService,
        HttpAccessGuard,
        IdentityService,
        OidcService,
        OrganizationManagementService,
        SpaceAccessService,
        SpaceManagementService,
        AuditService,
        AuditWriter,
        BackupService,
        SpaceObservabilityService,
      ],
    };
  }
}
