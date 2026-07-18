import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from "@nestjs/common";
import {
  DatabaseRuntime,
  Prisma,
  type DatabaseNotificationSubscription,
} from "@singularity/database";
import {
  createKernelDeployment,
  KERNEL_DEPLOYMENT_CHANGED_CHANNEL,
  kernelRuntimeEndpointSchema,
  parseKernelDeploymentChangedEvent,
  RuntimeKernelDeploymentRegistry,
  type KernelDeploymentChangedEvent,
  type KernelRuntimeEndpoint,
} from "@singularity/kernel-client";

import {
  KERNEL_RUNTIME_DEPLOYMENT_CONFIGURATION,
} from "../tokens.js";
import type { KernelGatewayRuntimeConfiguration } from "./configuration.js";

interface RuntimeEndpointRow {
  deploymentHandle: string;
  hostname: string;
  kernelInstanceId: string;
  port: number;
  serverName: string;
  spaceId: string;
  tlsProfile: string;
}

@Injectable()
export class KernelRuntimeDeploymentSynchronizer
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  readonly #logger = new Logger("KernelRuntimeDeploymentSynchronizer");
  readonly #database: DatabaseRuntime;
  readonly #deployments: RuntimeKernelDeploymentRegistry;
  readonly #configuration: KernelGatewayRuntimeConfiguration["runtimeDeployment"];
  readonly #dynamic = new Map<
    string,
    { handle: string; kernelInstanceId: string; spaceId: string }
  >();
  #hydrated = false;
  #failed = false;
  #pending: string[] = [];
  #subscription: DatabaseNotificationSubscription | undefined;
  #tail: Promise<void> = Promise.resolve();

  constructor(
    database: DatabaseRuntime,
    @Inject(RuntimeKernelDeploymentRegistry)
    deployments: RuntimeKernelDeploymentRegistry,
    @Inject(KERNEL_RUNTIME_DEPLOYMENT_CONFIGURATION)
    configuration: KernelGatewayRuntimeConfiguration["runtimeDeployment"],
  ) {
    this.#database = database;
    this.#deployments = deployments;
    this.#configuration = configuration;
  }

  async onApplicationBootstrap(): Promise<void> {
    try {
      this.#subscription = await this.#database.listen(
        KERNEL_DEPLOYMENT_CHANGED_CHANNEL,
        (payload) => this.#receive(payload),
        (error) => this.#listenerFailed(error),
      );
    } catch (error) {
      this.#logger.warn({
        event: "kernel.deployment.listener",
        outcome: "unavailable",
        reason: this.#diagnostic(error),
      });
      throw error;
    }

    try {
      const rows = await this.#readReadyEndpoints();
      for (const row of rows) {
        this.#install(row);
      }
      // Drain while still holding the pre-hydration gate. JavaScript cannot
      // interleave a notification between the final empty check and opening
      // the gate, so every event is applied in one ordered chain.
      while (this.#pending.length > 0) {
        const payload = this.#pending.shift();
        if (payload === undefined) {
          continue;
        }
        await this.#apply(payload);
      }
      this.#hydrated = true;
    } catch (error) {
      this.#failed = true;
      this.#hydrated = false;
      this.#pending = [];
      this.#clearDynamic();
      await this.#subscription?.close();
      this.#subscription = undefined;
      this.#logger.error({
        event: "kernel.deployment.hydrate",
        outcome: "failed",
        reason: this.#diagnostic(error),
      });
      throw error;
    }
  }

  async onApplicationShutdown(): Promise<void> {
    this.#failed = true;
    this.#hydrated = false;
    this.#pending = [];
    this.#clearDynamic();
    await this.#subscription?.close();
    this.#subscription = undefined;
  }

  #receive(payload: string): void {
    if (this.#failed) {
      return;
    }
    if (!this.#hydrated) {
      this.#pending.push(payload);
      return;
    }
    this.#tail = this.#tail
      .then(() => this.#apply(payload))
      .catch((error: unknown) => {
        this.#failed = true;
        this.#hydrated = false;
        this.#clearDynamic();
        this.#logger.error({
          event: "kernel.deployment.event",
          outcome: "failed",
          reason: this.#diagnostic(error),
        });
      });
  }

  #listenerFailed(error: Error): void {
    this.#failed = true;
    this.#hydrated = false;
    this.#pending = [];
    this.#clearDynamic();
    this.#logger.error({
      event: "kernel.deployment.listener",
      outcome: "failed",
      reason: this.#diagnostic(error),
    });
  }

  async #apply(payload: string): Promise<void> {
    if (this.#failed) {
      return;
    }
    let decoded: unknown;
    try {
      decoded = JSON.parse(payload) as unknown;
    } catch {
      throw new Error("Kernel deployment event is invalid");
    }
    let event: KernelDeploymentChangedEvent;
    try {
      event = parseKernelDeploymentChangedEvent(decoded);
    } catch {
      throw new Error("Kernel deployment event is invalid");
    }
    const row = await this.#readEndpoint(event);
    if (this.#failed) {
      return;
    }
    if (row === null) {
      this.#removeDynamic(event);
      return;
    }
    this.#install(row);
  }

  async #readReadyEndpoints(): Promise<RuntimeEndpointRow[]> {
    return this.#database.client.$queryRaw<RuntimeEndpointRow[]>(
      Prisma.sql`
        SELECT
          kernel."deployment_handle" AS "deploymentHandle",
          endpoint."hostname",
          endpoint."kernel_instance_id" AS "kernelInstanceId",
          endpoint."port",
          endpoint."server_name" AS "serverName",
          endpoint."space_id" AS "spaceId",
          endpoint."tls_profile" AS "tlsProfile"
        FROM "kernel_runtime_endpoints" AS endpoint
        INNER JOIN "kernel_instances" AS kernel
          ON kernel."id" = endpoint."kernel_instance_id"
          AND kernel."space_id" = endpoint."space_id"
        WHERE kernel."status" = 'ready'::"kernel_instance_status"
          AND kernel."deployment_handle" IS NOT NULL
      `,
    );
  }

  async #readEndpoint(
    event: KernelDeploymentChangedEvent,
  ): Promise<RuntimeEndpointRow | null> {
    const rows = await this.#database.client.$queryRaw<RuntimeEndpointRow[]>(
      Prisma.sql`
        SELECT
          kernel."deployment_handle" AS "deploymentHandle",
          endpoint."hostname",
          endpoint."kernel_instance_id" AS "kernelInstanceId",
          endpoint."port",
          endpoint."server_name" AS "serverName",
          endpoint."space_id" AS "spaceId",
          endpoint."tls_profile" AS "tlsProfile"
        FROM "kernel_runtime_endpoints" AS endpoint
        INNER JOIN "kernel_instances" AS kernel
          ON kernel."id" = endpoint."kernel_instance_id"
          AND kernel."space_id" = endpoint."space_id"
        WHERE endpoint."kernel_instance_id" = ${event.kernelInstanceId}::uuid
          AND endpoint."space_id" = ${event.spaceId}::uuid
          AND kernel."status" = 'ready'::"kernel_instance_status"
          AND kernel."deployment_handle" IS NOT NULL
        LIMIT 1
      `,
    );
    return rows[0] ?? null;
  }

  #install(row: RuntimeEndpointRow): void {
    const endpoint = kernelRuntimeEndpointSchema.parse({
      handle: row.deploymentHandle,
      hostname: row.hostname,
      kernelInstanceId: row.kernelInstanceId,
      port: row.port,
      serverName: row.serverName,
      spaceId: row.spaceId,
      tlsProfile: row.tlsProfile,
    }) satisfies KernelRuntimeEndpoint;
    if (endpoint.tlsProfile !== this.#configuration.tlsProfile) {
      throw new Error("Kernel deployment TLS profile is unavailable");
    }
    const key = this.#dynamicKey(endpoint);
    const previous = this.#dynamic.get(key);
    if (previous !== undefined && previous.handle !== endpoint.handle) {
      this.#deployments.unregister(previous);
    }
    this.#deployments.replace(
      createKernelDeployment(endpoint, this.#configuration.tls),
    );
    this.#dynamic.set(key, {
      handle: endpoint.handle,
      kernelInstanceId: endpoint.kernelInstanceId,
      spaceId: endpoint.spaceId,
    });
    this.#logger.debug({
      event: "kernel.deployment",
      outcome: "registered",
      kernelInstanceId: endpoint.kernelInstanceId,
      spaceId: endpoint.spaceId,
    });
  }

  #removeDynamic(identity: KernelDeploymentChangedEvent): void {
    const key = this.#dynamicKey(identity);
    const previous = this.#dynamic.get(key);
    if (previous !== undefined) {
      this.#deployments.unregister(previous);
      this.#dynamic.delete(key);
    }
  }

  #clearDynamic(): void {
    for (const identity of this.#dynamic.values()) {
      this.#deployments.unregister(identity);
    }
    this.#dynamic.clear();
  }

  #dynamicKey(identity: { kernelInstanceId: string; spaceId: string }): string {
    return `${identity.spaceId}:${identity.kernelInstanceId}`;
  }

  #diagnostic(error: unknown): string | undefined {
    return error instanceof Error && error.message.length > 0
      ? error.message.slice(0, 160)
      : undefined;
  }
}
