import { beforeEach, describe, expect, test, vi } from "vitest";

const pgClientBoundary = vi.hoisted(() => ({
  clients: [] as Array<{
    endCalls: number;
    emitEnd(): void;
    emitError(error: Error): void;
    emitNotification(channel: string, payload: string): void;
  }>,
}));

vi.mock("pg", async (importOriginal) => {
  const actual = await importOriginal<typeof import("pg")>();

  class NotificationClient {
    readonly #control: (typeof pgClientBoundary.clients)[number];
    readonly #listeners = new Map<
      string,
      Set<(...arguments_: unknown[]) => void>
    >();

    constructor() {
      this.#control = {
        endCalls: 0,
        emitEnd: () => this.#emit("end"),
        emitError: (error) => this.#emit("error", error),
        emitNotification: (channel, payload) =>
          this.#emit("notification", { channel, payload }),
      };
      pgClientBoundary.clients.push(this.#control);
    }

    connect(): Promise<void> {
      return Promise.resolve();
    }

    end(): Promise<void> {
      this.#control.endCalls += 1;
      this.#emit("end");
      return Promise.resolve();
    }

    on(
      event: string,
      listener: (...arguments_: unknown[]) => void,
    ): this {
      const listeners = this.#listeners.get(event) ?? new Set();
      listeners.add(listener);
      this.#listeners.set(event, listeners);
      return this;
    }

    query(): Promise<{ rows: never[] }> {
      return Promise.resolve({ rows: [] });
    }

    removeAllListeners(): this {
      this.#listeners.clear();
      return this;
    }

    #emit(event: string, ...arguments_: unknown[]): void {
      for (const listener of this.#listeners.get(event) ?? []) {
        listener(...arguments_);
      }
    }
  }

  return { ...actual, Client: NotificationClient };
});

import { DatabaseRuntime } from "../src/index.js";

const databaseUrl =
  "postgresql://singularity_test:singularity_test@127.0.0.1:55432/singularity_test";
const channel = "singularity_test_notification";

function latestClient(): (typeof pgClientBoundary.clients)[number] {
  const client = pgClientBoundary.clients.at(-1);
  if (client === undefined) {
    throw new Error("The notification client was not created");
  }
  return client;
}

describe("database notification subscription lifecycle", () => {
  beforeEach(() => {
    pgClientBoundary.clients.length = 0;
  });

  test("treats an unexpected clean end as one terminal failure", async () => {
    const runtime = new DatabaseRuntime(databaseUrl);
    const onNotification = vi.fn();
    const onFailure = vi.fn();
    const subscription = await runtime.listen(
      channel,
      onNotification,
      onFailure,
    );
    const client = latestClient();

    try {
      client.emitEnd();
      client.emitNotification(channel, "late-notification");
      client.emitEnd();

      expect(onFailure).toHaveBeenCalledOnce();
      expect(onFailure).toHaveBeenCalledWith(
        expect.objectContaining({
          message: "PostgreSQL notification connection ended unexpectedly",
        }),
      );
      expect(onNotification).not.toHaveBeenCalled();
      expect(pgClientBoundary.clients).toHaveLength(1);
    } finally {
      await subscription.close();
      await runtime.onApplicationShutdown();
    }
  });

  test("reports an error followed by end only once", async () => {
    const runtime = new DatabaseRuntime(databaseUrl);
    const onFailure = vi.fn();
    const subscription = await runtime.listen(channel, vi.fn(), onFailure);
    const client = latestClient();
    const connectionError = new Error("notification transport failed");

    try {
      client.emitError(connectionError);
      client.emitEnd();

      expect(onFailure).toHaveBeenCalledOnce();
      expect(onFailure).toHaveBeenCalledWith(connectionError);
      expect(pgClientBoundary.clients).toHaveLength(1);
    } finally {
      await subscription.close();
      await runtime.onApplicationShutdown();
    }
  });

  test("does not report an explicit idempotent close as failure", async () => {
    const runtime = new DatabaseRuntime(databaseUrl);
    const onFailure = vi.fn();
    const subscription = await runtime.listen(channel, vi.fn(), onFailure);
    const client = latestClient();

    await Promise.all([subscription.close(), subscription.close()]);
    client.emitEnd();
    await runtime.onApplicationShutdown();

    expect(onFailure).not.toHaveBeenCalled();
    expect(client.endCalls).toBe(1);
  });
});
