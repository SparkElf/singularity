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
import { kernelErrorContext } from "./error-context.js";
import { SpaceConnectionRegistry } from "./space-connection.registry.js";

interface RuntimeEndpointRow {
  deploymentHandle: string;
  hostname: string;
  kernelInstanceId: string;
  port: number;
  serverName: string;
  spaceId: string;
  tlsProfile: string;
}

interface QueuedDeploymentChange {
  readonly event: KernelDeploymentChangedEvent;
  readonly generation: number;
}

@Injectable()
export class KernelRuntimeDeploymentSynchronizer
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  readonly #logger = new Logger("KernelRuntimeDeploymentSynchronizer");
  readonly #database: DatabaseRuntime;
  readonly #deployments: RuntimeKernelDeploymentRegistry;
  readonly #configuration: KernelGatewayRuntimeConfiguration["runtimeDeployment"];
  readonly #dynamic = new Map<string, KernelRuntimeEndpoint>();
  readonly #generationBySpace = new Map<string, number>();
  #hydrated = false;
  #failed = false;
  #pending: QueuedDeploymentChange[] = [];
  #subscription: DatabaseNotificationSubscription | undefined;
  #subscriptionClose: Promise<void> = Promise.resolve();
  #tail: Promise<void> = Promise.resolve();

  constructor(
    database: DatabaseRuntime,
    @Inject(RuntimeKernelDeploymentRegistry)
    deployments: RuntimeKernelDeploymentRegistry,
    @Inject(KERNEL_RUNTIME_DEPLOYMENT_CONFIGURATION)
    configuration: KernelGatewayRuntimeConfiguration["runtimeDeployment"],
    private readonly connections: SpaceConnectionRegistry,
  ) {
    this.#database = database;
    this.#deployments = deployments;
    this.#configuration = configuration;
  }

  /** 先建立 PostgreSQL 通知订阅，再 hydrate ready 端点；未完成前不开放 Gateway。 */
  async onApplicationBootstrap(): Promise<void> {
    try {
      this.#subscription = await this.#database.listen(
        KERNEL_DEPLOYMENT_CHANGED_CHANNEL,
        (payload) => this.#receive(payload),
        (error) => this.#listenerFailed(error),
      );
    } catch (error) {
      this.#failed = true;
      this.#hydrated = false;
      this.#pending = [];
      this.connections.failNotificationListener("deployment");
      this.#clearDynamic();
      this.#logger.warn({
        ...kernelErrorContext(error, "Kernel deployment listener failed"),
        event: "kernel.deployment.listener",
        outcome: "unavailable",
      });
      return;
    }

    try {
      this.#assertListenerAvailable();
      const rows = await this.#readReadyEndpoints();
      this.#assertListenerAvailable();
      for (const row of rows) {
        if (!this.#generationBySpace.has(row.spaceId)) {
          this.#install(row);
        }
      }
      // 在 hydration 门禁仍关闭时排空通知；JavaScript 不会在最终空检查和开闸之间插入通知，
      // 因此所有事件都能在同一条有序链中应用。
      while (this.#pending.length > 0) {
        const change = this.#pending.shift();
        if (change === undefined) {
          continue;
        }
        await this.#apply(change);
      }
      this.#assertListenerAvailable();
      if (!this.connections.markNotificationListenerReady("deployment")) {
        this.#failed = true;
        this.#clearDynamic();
        await this.#closeSubscription();
        return;
      }
      this.#hydrated = true;
    } catch (error) {
      this.#failed = true;
      this.#hydrated = false;
      this.#pending = [];
      this.connections.failNotificationListener("deployment");
      this.#clearDynamic();
      await this.#closeSubscription();
      this.#logger.error({
        ...kernelErrorContext(error, "Kernel deployment hydration failed"),
        event: "kernel.deployment.hydrate",
        outcome: "failed",
      });
      throw error;
    }
  }

  /** 关闭事件订阅、动态部署和全部关联连接，保证进程退出前不再消费迟到通知。 */
  async onApplicationShutdown(): Promise<void> {
    this.#failed = true;
    this.#hydrated = false;
    this.#pending = [];
    this.connections.failNotificationListener("deployment");
    this.#clearDynamic();
    await this.#closeSubscription();
    await this.#tail;
  }

  /** 将通知转换为当前空间的失效代次，先封锁新连接，再串行回读数据库事实。 */
  #receive(payload: string): void {
    if (this.#failed) {
      return;
    }
    let event: KernelDeploymentChangedEvent;
    try {
      event = this.#parseEvent(payload);
    } catch (error) {
      this.#eventFailed(error);
      return;
    }
    const generation = (this.#generationBySpace.get(event.spaceId) ?? 0) + 1;
    this.#generationBySpace.set(event.spaceId, generation);
    // 通知只负责低延迟失效。数据库回读仍决定端点事实；在最新事实收敛前，
    // 同一身份的新请求也不能继续解析到旧网络坐标。
    this.connections.fenceKernelLifecycle(event.spaceId, generation);
    this.#fenceDynamicSpace(event.spaceId);
    const change = { event, generation } satisfies QueuedDeploymentChange;
    if (!this.#hydrated) {
      this.#pending.push(change);
      return;
    }
    this.#tail = this.#tail
      .then(() => this.#apply(change))
      .catch((error: unknown) => this.#eventFailed(error));
  }

  #listenerFailed(error: Error): void {
    if (this.#failed) {
      return;
    }
    this.#failed = true;
    this.#hydrated = false;
    this.#pending = [];
    this.connections.failNotificationListener("deployment");
    this.#clearDynamic();
    this.#logger.error({
      ...kernelErrorContext(error, "Kernel deployment listener failed"),
      event: "kernel.deployment.listener",
      outcome: "failed",
    });
    void this.#closeSubscription();
  }

  /** 只允许最新代次应用数据库端点；读回失败或过期时保持该空间 fail-closed。 */
  async #apply(change: QueuedDeploymentChange): Promise<void> {
    if (
      this.#failed ||
      this.#generationBySpace.get(change.event.spaceId) !== change.generation
    ) {
      return;
    }
    const row = await this.#readEndpoint(change.event);
    if (
      this.#failed ||
      this.#generationBySpace.get(change.event.spaceId) !== change.generation
    ) {
      return;
    }
    // 首次通知可能在hydrate投影端点前撤销了空registry，应用数据库事实前须再次同步撤销。
    this.#fenceDynamicSpace(change.event.spaceId);
    if (row !== null) {
      this.#install(row, change.event.requestId);
    }
    if (
      this.connections.resolveKernelLifecycleFence(
        change.event.spaceId,
        change.generation,
      )
    ) {
      this.#generationBySpace.delete(change.event.spaceId);
    }
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

  /** 将数据库端点投影为进程内唯一部署句柄，并原子替换同空间旧端点。 */
  #install(row: RuntimeEndpointRow, requestId?: string): void {
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
    const key = endpoint.spaceId;
    const previous = this.#dynamic.get(key);
    if (previous !== undefined) {
      this.#deployments.unregister({
        handle: previous.handle,
        kernelInstanceId: previous.kernelInstanceId,
        spaceId: previous.spaceId,
      });
    }
    this.#deployments.register(
      createKernelDeployment(endpoint, this.#configuration.tls),
    );
    this.#dynamic.set(key, endpoint);
    this.#logger.debug({
      event: "kernel.deployment",
      outcome: "registered",
      kernelInstanceId: endpoint.kernelInstanceId,
      ...(requestId === undefined ? {} : { requestId }),
      spaceId: endpoint.spaceId,
    });
  }

  /** 删除同空间旧句柄，使数据库事实重新收敛前任何新请求都无法解析旧坐标。 */
  #fenceDynamicSpace(spaceId: string): void {
    const previous = this.#dynamic.get(spaceId);
    if (previous === undefined) {
      return;
    }
    this.#deployments.unregister({
      handle: previous.handle,
      kernelInstanceId: previous.kernelInstanceId,
      spaceId: previous.spaceId,
    });
    this.#dynamic.delete(spaceId);
  }

  #clearDynamic(): void {
    for (const identity of this.#dynamic.values()) {
      this.#deployments.unregister({
        handle: identity.handle,
        kernelInstanceId: identity.kernelInstanceId,
        spaceId: identity.spaceId,
      });
    }
    this.#dynamic.clear();
    this.#generationBySpace.clear();
  }

  #assertListenerAvailable(): void {
    if (this.#failed) {
      throw new Error("Kernel deployment listener is unavailable");
    }
  }

  #parseEvent(payload: string): KernelDeploymentChangedEvent {
    let decoded: unknown;
    try {
      decoded = JSON.parse(payload) as unknown;
    } catch (error) {
      throw new Error("Kernel deployment event is invalid", { cause: error });
    }
    try {
      return parseKernelDeploymentChangedEvent(decoded);
    } catch (error) {
      throw new Error("Kernel deployment event is invalid", { cause: error });
    }
  }

  /** 事件解析或应用失败时清空动态路由并永久拒绝新连接，避免继续使用过期端点。 */
  #eventFailed(error: unknown): void {
    if (this.#failed) {
      return;
    }
    this.#failed = true;
    this.#hydrated = false;
    this.#pending = [];
    this.connections.failNotificationListener("deployment");
    this.#clearDynamic();
    this.#logger.error({
      ...kernelErrorContext(error, "Kernel deployment event failed"),
      event: "kernel.deployment.event",
      outcome: "failed",
    });
    void this.#closeSubscription();
  }

  #closeSubscription(): Promise<void> {
    const subscription = this.#subscription;
    this.#subscription = undefined;
    if (subscription === undefined) {
      return this.#subscriptionClose;
    }
    this.#subscriptionClose = subscription.close().catch((error: unknown) => {
      this.#logger.error({
        ...kernelErrorContext(error, "Kernel deployment listener close failed"),
        event: "kernel.deployment.listener",
        outcome: "close-failed",
      });
    });
    return this.#subscriptionClose;
  }
}
