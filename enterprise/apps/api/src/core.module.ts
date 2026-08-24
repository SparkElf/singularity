import type { DynamicModule } from "@nestjs/common";
import { Module } from "@nestjs/common";
import { DiscoveryModule } from "@nestjs/core";
import {
  AuditWriter,
  DatabaseRuntime,
  type AuditConfiguration,
} from "@singularity/database";

import { AuditController } from "./audit/audit.controller.js";
import { ContentAuditIntentService } from "./audit/content-audit-intent.service.js";
import { AuditService } from "./audit/audit.service.js";
import { BackupController } from "./backups/backup.controller.js";
import { BackupService } from "./backups/backup.service.js";
import { DocumentAccessController } from "./document-access/document-access.controller.js";
import { DocumentAccessPolicyService } from "./document-access/document-access.service.js";
import { CommentController } from "./collaboration/comment.controller.js";
import { CommentService } from "./collaboration/comment.service.js";
import type { ApiConfiguration } from "./configuration.js";
import { GroupManagementService } from "./groups/group-management.service.js";
import { GroupsController } from "./groups/groups.controller.js";
import type { Clock } from "./identity/clock.js";
import { IdentityController } from "./identity/identity.controller.js";
import { IdentityProvisioningService } from "./identity/identity-provisioning.service.js";
import { HttpAccessGuard } from "./identity/http-access.js";
import { IdentityService } from "./identity/identity.service.js";
import { LoginRateLimiter } from "./identity/login-rate-limiter.js";
import { PasswordHasher } from "./identity/password-hasher.js";
import {
  SmtpPasswordResetMailer,
  type PasswordResetMailer,
} from "./identity/password-reset-mailer.js";
import { PasswordResetService } from "./identity/password-reset.service.js";
import { AccessChangedPublisher } from "./kernel/access-changed.js";
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
import { NotificationController } from "./notifications/notification.controller.js";
import { NotificationService } from "./notifications/notification.service.js";
import {
  API_CONFIGURATION,
  AUDIT_CONFIGURATION,
  CLOCK,
  PASSWORD_RESET_MAILER,
} from "./tokens.js";

export interface CoreModuleOptions {
  clock: Clock;
  configuration: ApiConfiguration;
  databaseUrl: string | undefined;
  auditConfiguration: AuditConfiguration;
  initializeDummyPasswordHash?: boolean;
  loginRateLimiter?: LoginRateLimiter;
  passwordResetMailer?: PasswordResetMailer;
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
        OrganizationsController,
        SpaceManagementController,
        SpacesController,
        AuditController,
        BackupController,
        SpaceObservabilityController,
        DocumentAccessController,
        CommentController,
        NotificationController,
      ],
      providers: [
        {
          provide: API_CONFIGURATION,
          useValue: options.configuration,
        },
        { provide: AUDIT_CONFIGURATION, useValue: options.auditConfiguration },
        AuditService,
        {
          provide: AuditWriter,
          inject: [AUDIT_CONFIGURATION],
          useFactory: (configuration: AuditConfiguration) =>
            new AuditWriter(configuration),
        },
        ContentAuditIntentService,
        BackupService,
        SpaceObservabilityService,
        DocumentAccessPolicyService,
        CommentService,
        NotificationService,
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
          useFactory: () => options.loginRateLimiter ?? new LoginRateLimiter(),
        },
        IdentityService,
        IdentityProvisioningService,
        PasswordResetService,
        {
          provide: PASSWORD_RESET_MAILER,
          inject: [API_CONFIGURATION],
          useFactory: (
            configuration: ApiConfiguration,
          ): PasswordResetMailer =>
            options.passwordResetMailer ??
            new SmtpPasswordResetMailer({
              from: configuration.passwordResetFrom,
              smtpUrl: configuration.passwordResetSmtpUrl,
            }),
        },
        SpaceAccessService,
        OrganizationManagementService,
        GroupManagementService,
        SpaceManagementService,
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
        OrganizationManagementService,
        PasswordHasher,
        PasswordResetService,
        SpaceAccessService,
        SpaceManagementService,
        AuditService,
        AuditWriter,
        ContentAuditIntentService,
        BackupService,
        SpaceObservabilityService,
        DocumentAccessPolicyService,
        CommentService,
        NotificationService,
      ],
    };
  }
}
