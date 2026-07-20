import { Inject, Injectable, Logger } from "@nestjs/common";

import type { Clock } from "../identity/clock.js";
import { CLOCK } from "../tokens.js";
import type { AccessChanged, AccessSelector } from "./access-changed.js";
import { kernelErrorContext } from "./error-context.js";

export type SpaceConnectionState = "pending" | "active" | "closed";

export interface PendingSpaceConnection {
  readonly authSessionId: string;
  readonly closeBrowser: (code: number, reason: string) => void;
  readonly connectionId: string;
  readonly organizationId: string;
  readonly requestId: string;
  readonly sendBrowser: (data: Buffer, binary: boolean) => void;
  readonly spaceId: string;
  readonly userId: string;
}

export interface SpaceConnectionHandle {
  readonly connectionId: string;
  readonly signal: AbortSignal;
  activate(expiresAt: Date, kernelInstanceId: string): boolean;
  bindUpstream(close: () => void): boolean;
  browserClosed(): void;
  clientMessageReceived(): void;
  reject(reason: "unauthenticated" | "forbidden" | "kernel-unavailable"): void;
  upstreamClosed(): void;
  upstreamMessage(data: Buffer, binary: boolean): void;
}

interface ConnectionRecord extends PendingSpaceConnection {
  readonly abortController: AbortController;
  closeUpstream?: () => void;
  expiresAt?: Date;
  expiryTimer?: ReturnType<typeof setTimeout>;
  kernelInstanceId?: string;
  state: SpaceConnectionState;
}

export type KernelNotificationListener = "access" | "deployment";
type KernelNotificationListenerState = "starting" | "ready" | "failed";

const CLOSE = {
  forbidden: { code: 4403, reason: "forbidden" },
  "kernel-unavailable": { code: 1011, reason: "kernel-unavailable" },
  "protocol-violation": { code: 4408, reason: "client-messages-forbidden" },
  "service-unavailable": { code: 1011, reason: "service-unavailable" },
  unauthenticated: { code: 4401, reason: "unauthenticated" },
} as const;

@Injectable()
export class SpaceConnectionRegistry {
  readonly #byAuthSession = new Map<string, Set<string>>();
  readonly #byOrganization = new Map<string, Set<string>>();
  readonly #bySpace = new Map<string, Set<string>>();
  readonly #byUser = new Map<string, Set<string>>();
  readonly #connections = new Map<string, ConnectionRecord>();
  readonly #kernelLifecycleGenerationBySpace = new Map<string, number>();
  readonly #logger = new Logger("SpaceConnectionRegistry");
  readonly #notificationListenerState: Record<
    KernelNotificationListener,
    KernelNotificationListenerState
  > = {
    access: "starting",
    deployment: "starting",
  };

  constructor(@Inject(CLOCK) private readonly clock: Clock) {}

  /** 只有 AccessChanged 与 deployment 两条通知链均健康时才允许建立新连接。 */
  get available(): boolean {
    return Object.values(this.#notificationListenerState).every(
      (state) => state === "ready",
    );
  }

  markNotificationListenerReady(listener: KernelNotificationListener): boolean {
    if (
      Object.values(this.#notificationListenerState).some(
        (state) => state === "failed",
      )
    ) {
      return false;
    }
    this.#notificationListenerState[listener] = "ready";
    return true;
  }

  failNotificationListener(listener: KernelNotificationListener): void {
    if (this.#notificationListenerState[listener] === "failed") {
      return;
    }
    this.#notificationListenerState[listener] = "failed";
    this.#kernelLifecycleGenerationBySpace.clear();
    for (const record of [...this.#connections.values()]) {
      this.#close(record, "service-unavailable", true);
    }
  }

  /** 登记待复验连接并建立唯一索引；空间生命周期失效期间直接拒绝新连接。 */
  registerPending(input: PendingSpaceConnection): SpaceConnectionHandle {
    if (!this.available) {
      throw new Error("Access notification listener is unavailable");
    }
    if (this.#kernelLifecycleGenerationBySpace.has(input.spaceId)) {
      throw new Error("Kernel deployment lifecycle is changing");
    }
    if (this.#connections.has(input.connectionId)) {
      throw new Error("Space connection identity is unavailable");
    }
    const record: ConnectionRecord = {
      ...input,
      abortController: new AbortController(),
      state: "pending",
    };
    this.#connections.set(record.connectionId, record);
    this.#index(this.#byAuthSession, record.authSessionId, record.connectionId);
    this.#index(this.#byUser, record.userId, record.connectionId);
    this.#index(this.#byOrganization, record.organizationId, record.connectionId);
    this.#index(this.#bySpace, record.spaceId, record.connectionId);

    return {
      connectionId: record.connectionId,
      signal: record.abortController.signal,
      activate: (expiresAt, kernelInstanceId) =>
        this.#activate(record, expiresAt, kernelInstanceId),
      bindUpstream: (close) => this.#bindUpstream(record, close),
      browserClosed: () => this.#close(record, "kernel-unavailable", false),
      clientMessageReceived: () =>
        this.#close(record, "protocol-violation", true),
      reject: (reason) => this.#close(record, reason, true),
      upstreamClosed: () =>
        this.#close(record, "kernel-unavailable", true, false),
      upstreamMessage: (data, binary) => this.#send(record, data, binary),
    };
  }

  closeByAccessChange(change: AccessChanged): void {
    const connectionIds = this.#matchingConnectionIds(change.selectors);
    for (const connectionId of connectionIds) {
      const record = this.#connections.get(connectionId);
      if (record !== undefined) {
        this.#close(record, change.reason, true);
      }
    }
  }

  /** 以空间代次封锁 pending/active 连接，先中止上游再通知浏览器。 */
  fenceKernelLifecycle(spaceId: string, generation: number): void {
    const currentGeneration =
      this.#kernelLifecycleGenerationBySpace.get(spaceId);
    if (
      currentGeneration !== undefined &&
      currentGeneration >= generation
    ) {
      return;
    }
    this.#kernelLifecycleGenerationBySpace.set(spaceId, generation);
    const connectionIds = [...(this.#bySpace.get(spaceId) ?? [])];
    for (const connectionId of connectionIds) {
      const record = this.#connections.get(connectionId);
      if (record !== undefined) {
        this.#close(record, "kernel-unavailable", true);
      }
    }
  }

  /** 仅最新代次完成数据库事实应用后解除空间封锁，迟到代次不得重新放行。 */
  resolveKernelLifecycleFence(spaceId: string, generation: number): boolean {
    if (this.#kernelLifecycleGenerationBySpace.get(spaceId) !== generation) {
      return false;
    }
    this.#kernelLifecycleGenerationBySpace.delete(spaceId);
    return true;
  }

  closeAllByKernelLifecycle(): void {
    for (const record of [...this.#connections.values()]) {
      this.#close(record, "kernel-unavailable", true);
    }
  }

  /** 单调延长同一认证会话的连接期限，并让 pending 连接在激活时使用最新期限。 */
  refreshSessionExpiry(authSessionId: string, expiresAt: Date): void {
    for (const connectionId of this.#byAuthSession.get(authSessionId) ?? []) {
      const record = this.#connections.get(connectionId);
      if (
        record === undefined ||
        record.state === "closed" ||
        (record.expiresAt !== undefined &&
          record.expiresAt.getTime() >= expiresAt.getTime())
      ) {
        continue;
      }
      record.expiresAt = expiresAt;
      if (record.state === "active") {
        this.#scheduleExpiry(record, expiresAt);
      }
    }
  }

  /** 在生命周期封锁、授权期限和连接状态均有效时把 pending 提升为 active。 */
  #activate(
    record: ConnectionRecord,
    expiresAt: Date,
    kernelInstanceId: string,
  ): boolean {
    if (record.state !== "pending") {
      return false;
    }
    if (this.#kernelLifecycleGenerationBySpace.has(record.spaceId)) {
      this.#close(record, "kernel-unavailable", true);
      return false;
    }
    const effectiveExpiresAt =
      record.expiresAt !== undefined &&
      record.expiresAt.getTime() > expiresAt.getTime()
        ? record.expiresAt
        : expiresAt;
    if (effectiveExpiresAt.getTime() <= this.clock.now().getTime()) {
      this.#close(record, "unauthenticated", true);
      return false;
    }
    record.kernelInstanceId = kernelInstanceId;
    record.state = "active";
    this.#scheduleExpiry(record, effectiveExpiresAt);
    return true;
  }

  #bindUpstream(record: ConnectionRecord, close: () => void): boolean {
    if (record.state !== "active") {
      close();
      return false;
    }
    record.closeUpstream = close;
    return true;
  }

  #send(record: ConnectionRecord, data: Buffer, binary: boolean): void {
    if (record.state !== "active") {
      return;
    }
    try {
      record.sendBrowser(data, binary);
    } catch (error) {
      this.#logger.warn({
        ...kernelErrorContext(error, "Browser WebSocket send failed"),
        connectionId: record.connectionId,
        event: "kernel.route",
        outcome: "browser-send-failed",
        requestId: record.requestId,
        spaceId: record.spaceId,
        ...(record.kernelInstanceId === undefined
          ? {}
          : { kernelInstanceId: record.kernelInstanceId }),
      });
      this.#close(record, "kernel-unavailable", true);
    }
  }

  #scheduleExpiry(record: ConnectionRecord, expiresAt: Date): void {
    if (record.expiryTimer !== undefined) {
      clearTimeout(record.expiryTimer);
    }
    record.expiresAt = expiresAt;
    const delay = Math.max(0, expiresAt.getTime() - this.clock.now().getTime());
    record.expiryTimer = setTimeout(() => {
      if (
        record.state !== "closed" &&
        record.expiresAt?.getTime() === expiresAt.getTime()
      ) {
        this.#close(record, "unauthenticated", true);
      }
    }, delay);
  }

  /** 统一连接终止顺序：冻结状态、取消上游、通知浏览器、移除全部索引。 */
  #close(
    record: ConnectionRecord,
    reason: keyof typeof CLOSE,
    notifyBrowser: boolean,
    closeUpstream = true,
  ): void {
    if (record.state === "closed") {
      return;
    }
    record.state = "closed";
    record.abortController.abort(new Error(CLOSE[reason].reason));
    if (record.expiryTimer !== undefined) {
      clearTimeout(record.expiryTimer);
    }
    if (closeUpstream) {
      try {
        record.closeUpstream?.();
      } catch (error) {
        this.#logger.warn({
          ...kernelErrorContext(error, "Kernel upstream close callback failed"),
          connectionId: record.connectionId,
          event: "kernel.route",
          outcome: "upstream-close-failed",
          requestId: record.requestId,
          spaceId: record.spaceId,
          ...(record.kernelInstanceId !== undefined
            ? { kernelInstanceId: record.kernelInstanceId }
            : {}),
        });
      }
    }
    if (notifyBrowser) {
      try {
        record.closeBrowser(CLOSE[reason].code, CLOSE[reason].reason);
      } catch (error) {
        this.#logger.warn({
          ...kernelErrorContext(error, "Browser WebSocket close callback failed"),
          connectionId: record.connectionId,
          event: "kernel.route",
          outcome: "browser-close-failed",
          requestId: record.requestId,
          spaceId: record.spaceId,
          ...(record.kernelInstanceId !== undefined
            ? { kernelInstanceId: record.kernelInstanceId }
            : {}),
        });
      }
    }
    this.#connections.delete(record.connectionId);
    this.#unindex(this.#byAuthSession, record.authSessionId, record.connectionId);
    this.#unindex(this.#byUser, record.userId, record.connectionId);
    this.#unindex(
      this.#byOrganization,
      record.organizationId,
      record.connectionId,
    );
    this.#unindex(this.#bySpace, record.spaceId, record.connectionId);
  }

  #matchingConnectionIds(
    selectors: readonly [AccessSelector, ...AccessSelector[]],
  ): readonly string[] {
    const sets = selectors.map((selector) => this.#setForSelector(selector));
    sets.sort((left, right) => left.size - right.size);
    const smallest = sets[0];
    if (smallest === undefined) {
      return [];
    }
    return [...smallest].filter((connectionId) =>
      sets.every((set) => set.has(connectionId)),
    );
  }

  #setForSelector(selector: AccessSelector): ReadonlySet<string> {
    if (selector.kind === "auth-session") {
      return this.#byAuthSession.get(selector.value) ?? new Set();
    }
    if (selector.kind === "user") {
      return this.#byUser.get(selector.value) ?? new Set();
    }
    if (selector.kind === "organization") {
      return this.#byOrganization.get(selector.value) ?? new Set();
    }
    return this.#bySpace.get(selector.value) ?? new Set();
  }

  #index(index: Map<string, Set<string>>, key: string, connectionId: string): void {
    const connections = index.get(key);
    if (connections === undefined) {
      index.set(key, new Set([connectionId]));
    } else {
      connections.add(connectionId);
    }
  }

  #unindex(
    index: Map<string, Set<string>>,
    key: string,
    connectionId: string,
  ): void {
    const connections = index.get(key);
    connections?.delete(connectionId);
    if (connections?.size === 0) {
      index.delete(key);
    }
  }
}
