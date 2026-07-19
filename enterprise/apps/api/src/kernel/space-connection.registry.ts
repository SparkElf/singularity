import { Inject, Injectable, Logger } from "@nestjs/common";

import type { Clock } from "../identity/clock.js";
import { CLOCK } from "../tokens.js";
import type { AccessChanged, AccessSelector } from "./access-changed.js";

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
  activate(expiresAt: Date): boolean;
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
  state: SpaceConnectionState;
}

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
  readonly #logger = new Logger("SpaceConnectionRegistry");
  #notificationListenerState: "starting" | "ready" | "failed" = "starting";

  constructor(@Inject(CLOCK) private readonly clock: Clock) {}

  get available(): boolean {
    return this.#notificationListenerState === "ready";
  }

  markNotificationListenerReady(): boolean {
    if (this.#notificationListenerState === "failed") {
      return false;
    }
    this.#notificationListenerState = "ready";
    return true;
  }

  failNotificationListener(): void {
    if (this.#notificationListenerState === "failed") {
      return;
    }
    this.#notificationListenerState = "failed";
    for (const record of [...this.#connections.values()]) {
      this.#close(record, "service-unavailable", true);
    }
  }

  registerPending(input: PendingSpaceConnection): SpaceConnectionHandle {
    if (this.#notificationListenerState !== "ready") {
      throw new Error("Access notification listener is unavailable");
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
      activate: (expiresAt) => this.#activate(record, expiresAt),
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

  /**
   * 端点离开 ready 或被替换时，先终止该空间的上游订阅，再通知浏览器显式重试。
   * 该路径不改变用户授权状态，因而使用 kernel-unavailable 而不是 forbidden。
   */
  closeByKernelLifecycle(spaceId: string): void {
    const connectionIds = [...(this.#bySpace.get(spaceId) ?? [])];
    for (const connectionId of connectionIds) {
      const record = this.#connections.get(connectionId);
      if (record !== undefined) {
        this.#close(record, "kernel-unavailable", true);
      }
    }
  }

  closeAllByKernelLifecycle(): void {
    for (const record of [...this.#connections.values()]) {
      this.#close(record, "kernel-unavailable", true);
    }
  }

  refreshSessionExpiry(authSessionId: string, expiresAt: Date): void {
    for (const connectionId of this.#byAuthSession.get(authSessionId) ?? []) {
      const record = this.#connections.get(connectionId);
      if (record !== undefined && record.state === "active") {
        this.#scheduleExpiry(record, expiresAt);
      }
    }
  }

  #activate(record: ConnectionRecord, expiresAt: Date): boolean {
    if (record.state !== "pending") {
      return false;
    }
    if (expiresAt.getTime() <= this.clock.now().getTime()) {
      this.#close(record, "unauthenticated", true);
      return false;
    }
    record.state = "active";
    this.#scheduleExpiry(record, expiresAt);
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
    } catch {
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
      } catch {
        this.#logger.warn({
          connectionId: record.connectionId,
          event: "kernel.route",
          outcome: "upstream-close-failed",
          requestId: record.requestId,
          spaceId: record.spaceId,
        });
      }
    }
    if (notifyBrowser) {
      try {
        record.closeBrowser(CLOSE[reason].code, CLOSE[reason].reason);
      } catch {
        this.#logger.warn({
          connectionId: record.connectionId,
          event: "kernel.route",
          outcome: "browser-close-failed",
          requestId: record.requestId,
          spaceId: record.spaceId,
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
