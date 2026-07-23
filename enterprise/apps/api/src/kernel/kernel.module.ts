import type { DynamicModule, Provider } from "@nestjs/common";
import { Module } from "@nestjs/common";
import { DiscoveryModule } from "@nestjs/core";
import {
  KernelPrivateClient,
  KernelPrivateWebSocketClient,
  KernelRoutePolicyRegistry,
  RuntimeKernelDeploymentRegistry,
  type KernelDeploymentRegistry,
} from "@singularity/kernel-client";

import { CoreModule } from "../core.module.js";
import {
  AccessChangedListener,
  ACCESS_CHANGED_COLLABORATION,
} from "./access-changed.js";
import type { KernelGatewayRuntimeConfiguration } from "./configuration.js";
import { ContentDirectoryController } from "./content-directory.controller.js";
import { ContentDirectoryService } from "./content-directory.service.js";
import { KernelAccessService } from "./kernel-access.service.js";
import { KernelGatewayAdmission } from "./kernel-gateway-admission.js";
import { KernelGatewayController } from "./kernel-gateway.controller.js";
import { KernelGatewayService } from "./kernel-gateway.service.js";
import { HistoryController } from "./history.controller.js";
import { HistoryService } from "./history.service.js";
import { KernelRuntimeDeploymentSynchronizer } from "./kernel-runtime-deployment-synchronizer.js";
import { KernelWebSocketGateway } from "./kernel-websocket.gateway.js";
import { SpaceConnectionRegistry } from "./space-connection.registry.js";
import { SpaceDiscoveryController } from "./space-discovery.controller.js";
import { SpaceDiscoveryService } from "./space-discovery.service.js";
import {
  PublicShareController,
  ShareManagementController,
} from "../shares/share.controller.js";
import { ShareKernelClient } from "../shares/share-kernel.client.js";
import { SharePasswordRateLimiter } from "../shares/share-password-rate-limiter.js";
import { ShareService } from "../shares/share.service.js";
import { SHARE_KERNEL } from "../shares/share.types.js";
import { KERNEL_RUNTIME_DEPLOYMENT_CONFIGURATION } from "../tokens.js";
import { CollaborationCoordinator, COLLABORATION_FEATURE_GATE, KERNEL_COLLABORATION_PORT } from "../collaboration/realtime-coordinator.js";
import { RealtimeCollaborationWebSocketGateway } from "../collaboration/realtime-websocket.gateway.js";
import { CollaborationOperationDiscovery } from "../collaboration/realtime-handler-discovery.js";
import { RealtimeOperationHandlers } from "../collaboration/realtime-operation-handlers.js";
import { KernelProductionCollaborationPort } from "../collaboration/kernel-production-collaboration.port.js";
import { CollaborationControlService } from "../collaboration/collaboration-control.service.js";
import { RealtimeFeatureController } from "../collaboration/realtime-feature.controller.js";
import { GovernanceController } from "../governance/governance.controller.js";
import { EnterpriseGovernanceService } from "../governance/governance.service.js";
import { ScimTokenGuard } from "../governance/scim-token.guard.js";

export interface KernelGatewayModuleOptions
  extends KernelGatewayRuntimeConfiguration {
  readonly admission: KernelGatewayAdmission;
  readonly policies: KernelRoutePolicyRegistry;
}

const KERNEL_DEPLOYMENTS = Symbol("KERNEL_DEPLOYMENTS");
const KERNEL_CREDENTIALS = Symbol("KERNEL_CREDENTIALS");

function kernelProviders(options: KernelGatewayModuleOptions): Provider[] {
  return [
    { provide: KernelGatewayAdmission, useValue: options.admission },
    { provide: KernelRoutePolicyRegistry, useValue: options.policies },
    {
      provide: RuntimeKernelDeploymentRegistry,
      useValue: options.deployments,
    },
    { provide: KERNEL_DEPLOYMENTS, useValue: options.deployments },
    { provide: KERNEL_CREDENTIALS, useValue: options.credentials },
    {
      provide: KERNEL_RUNTIME_DEPLOYMENT_CONFIGURATION,
      useValue: options.runtimeDeployment,
    },
    {
      provide: KernelPrivateClient,
      inject: [KERNEL_CREDENTIALS, KERNEL_DEPLOYMENTS, KernelRoutePolicyRegistry],
      useFactory: (
        credentials: KernelGatewayRuntimeConfiguration["credentials"],
        deployments: KernelDeploymentRegistry,
        policies: KernelRoutePolicyRegistry,
      ) => new KernelPrivateClient({ credentials, deployments, policies }),
    },
    {
      provide: KernelPrivateWebSocketClient,
      inject: [KERNEL_CREDENTIALS, KERNEL_DEPLOYMENTS, KernelRoutePolicyRegistry],
      useFactory: (
        credentials: KernelGatewayRuntimeConfiguration["credentials"],
        deployments: KernelDeploymentRegistry,
        policies: KernelRoutePolicyRegistry,
      ) =>
        new KernelPrivateWebSocketClient({ credentials, deployments, policies }),
    },
    AccessChangedListener,
    SpaceDiscoveryService,
    ContentDirectoryService,
    EnterpriseGovernanceService,
    ScimTokenGuard,
    KernelAccessService,
    KernelGatewayService,
    HistoryService,
    KernelRuntimeDeploymentSynchronizer,
    KernelWebSocketGateway,
    ShareKernelClient,
    { provide: SHARE_KERNEL, useExisting: ShareKernelClient },
    SharePasswordRateLimiter,
    ShareService,
    SpaceConnectionRegistry,
    KernelProductionCollaborationPort,
    CollaborationControlService,
    CollaborationCoordinator,
    CollaborationOperationDiscovery,
    RealtimeOperationHandlers,
    RealtimeCollaborationWebSocketGateway,
    {
      provide: ACCESS_CHANGED_COLLABORATION,
      useExisting: RealtimeCollaborationWebSocketGateway,
    },
    { provide: COLLABORATION_FEATURE_GATE, useExisting: CollaborationControlService },
    { provide: KERNEL_COLLABORATION_PORT, useExisting: KernelProductionCollaborationPort },
  ];
}

@Module({})
export class KernelGatewayModule {
  static register(
    core: DynamicModule,
    options: KernelGatewayModuleOptions,
  ): DynamicModule {
    return {
      module: KernelGatewayModule,
      imports: [core, DiscoveryModule],
      controllers: [
        ContentDirectoryController,
        SpaceDiscoveryController,
        KernelGatewayController,
        HistoryController,
        PublicShareController,
        ShareManagementController,
        RealtimeFeatureController,
        GovernanceController,
      ],
      providers: kernelProviders(options),
      exports: [
        CoreModule,
        KernelGatewayAdmission,
        KernelWebSocketGateway,
        SpaceConnectionRegistry,
        CollaborationCoordinator,
        CollaborationOperationDiscovery,
        RealtimeCollaborationWebSocketGateway,
      ],
    };
  }
}
