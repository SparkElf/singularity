import type { DynamicModule } from "@nestjs/common";
import { Module } from "@nestjs/common";
import { kernelRoutePolicies } from "@singularity/authorization";
import { KernelRoutePolicyRegistry } from "@singularity/kernel-client";

import type { ApiConfiguration } from "./configuration.js";
import type { AuditConfiguration } from "./audit/audit-writer.service.js";
import { CoreModule } from "./core.module.js";
import { DatabaseHealthController } from "./database-health.controller.js";
import type { Clock } from "./identity/clock.js";
import type { KernelGatewayRuntimeConfiguration } from "./kernel/configuration.js";
import { KernelGatewayAdmission } from "./kernel/kernel-gateway-admission.js";
import { KernelGatewayModule } from "./kernel/kernel.module.js";

export interface AppModuleOptions {
  clock: Clock;
  configuration: ApiConfiguration;
  databaseUrl: string | undefined;
  auditConfiguration: AuditConfiguration;
  kernelGateway: KernelGatewayRuntimeConfiguration;
}

@Module({})
export class AppModule {
  static register(options: AppModuleOptions): DynamicModule {
    const policies = new KernelRoutePolicyRegistry(kernelRoutePolicies);
    const core = CoreModule.register(options);
    return {
      module: AppModule,
      imports: [
        KernelGatewayModule.register(core, {
          ...options.kernelGateway,
          admission: new KernelGatewayAdmission(policies),
          policies,
        }),
      ],
      controllers: [DatabaseHealthController],
    };
  }
}
