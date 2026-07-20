import "reflect-metadata";

import type {
  DatabaseNotificationSubscription,
  DatabaseRuntime,
} from "@singularity/database";
import {
  createKernelDeployment,
  RuntimeKernelDeploymentRegistry,
  type KernelDeploymentChangedEvent,
} from "@singularity/kernel-client";
import { describe, expect, test, vi } from "vitest";

import { KernelRuntimeDeploymentSynchronizer } from "../src/kernel/kernel-runtime-deployment-synchronizer.js";
import { SpaceConnectionRegistry } from "../src/kernel/space-connection.registry.js";
import {
  TEST_TLS_CERTIFICATE,
  TEST_TLS_PRIVATE_KEY,
} from "./support/kernel-gateway.js";

const ENDPOINT = {
  deploymentHandle: "runtime-kernel",
  hostname: "127.0.0.1",
  kernelInstanceId: "11111111-1111-4111-8111-111111111111",
  port: 9443,
  serverName: "kernel.test",
  spaceId: "22222222-2222-4222-8222-222222222222",
  tlsProfile: "test-runtime",
} as const;

const ENDPOINT_IDENTITY = {
  handle: ENDPOINT.deploymentHandle,
  kernelInstanceId: ENDPOINT.kernelInstanceId,
  spaceId: ENDPOINT.spaceId,
} as const;

const UPDATED_ENDPOINT = {
  ...ENDPOINT,
  hostname: "runtime-kernel.internal",
  port: 9555,
} as const;

function deferred<T>(): {
  readonly promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolvePromise!: (value: T) => void;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
}

function runtimeConfiguration() {
  return {
    tls: {
      caCertificate: TEST_TLS_CERTIFICATE,
      clientCertificate: TEST_TLS_CERTIFICATE,
      clientPrivateKey: TEST_TLS_PRIVATE_KEY,
    },
    tlsProfile: ENDPOINT.tlsProfile,
  };
}

function createConnections(): SpaceConnectionRegistry {
  const connections = new SpaceConnectionRegistry({
    now: () => new Date("2026-07-19T10:00:00.000Z"),
  });
  expect(connections.markNotificationListenerReady("access")).toBe(true);
  return connections;
}

function deploymentEvent(
  requestId = "88888888-8888-4888-8888-888888888888",
): KernelDeploymentChangedEvent {
  return {
    kernelInstanceId: ENDPOINT.kernelInstanceId,
    kind: "upsert",
    requestId,
    spaceId: ENDPOINT.spaceId,
  };
}

describe("Kernel runtime deployment synchronization", () => {
  test("fails hydration without publishing an endpoint when LISTEN is lost during the initial query", async () => {
    const hydration = deferred<readonly [typeof ENDPOINT]>();
    const queryStarted = deferred<void>();
    let listenerFailure: ((error: Error) => void) | undefined;
    const closeSubscription = vi.fn(() => Promise.resolve());
    const subscription: DatabaseNotificationSubscription = {
      close: closeSubscription,
    };
    const database = {
      client: {
        $queryRaw: vi.fn(() => {
          queryStarted.resolve();
          return hydration.promise;
        }),
      },
      listen: vi.fn(
        async (
          _channel: string,
          _onNotification: (payload: string) => void,
          onFailure: (error: Error) => void,
        ) => {
          listenerFailure = onFailure;
          return subscription;
        },
      ),
    } as unknown as DatabaseRuntime;
    const deployments = new RuntimeKernelDeploymentRegistry([]);
    const connections = createConnections();
    expect(connections.markNotificationListenerReady("deployment")).toBe(true);
    const connectionEvents: string[] = [];
    const connection = connections.registerPending({
      authSessionId: "33333333-3333-4333-8333-333333333333",
      closeBrowser: (code, reason) =>
        connectionEvents.push(`browser:${String(code)}:${reason}`),
      connectionId: "44444444-4444-4444-8444-444444444444",
      organizationId: "55555555-5555-4555-8555-555555555555",
      requestId: "66666666-6666-4666-8666-666666666666",
      sendBrowser: () => connectionEvents.push("push"),
      spaceId: ENDPOINT.spaceId,
      userId: "77777777-7777-4777-8777-777777777777",
    });
    expect(
      connection.activate(
        new Date("2026-07-19T11:00:00.000Z"),
        ENDPOINT.kernelInstanceId,
      ),
    ).toBe(true);
    expect(
      connection.bindUpstream(() => connectionEvents.push("upstream")),
    ).toBe(true);
    const synchronizer = new KernelRuntimeDeploymentSynchronizer(
      database,
      deployments,
      runtimeConfiguration(),
      connections,
    );

    const bootstrap = synchronizer.onApplicationBootstrap();
    const rejection = expect(bootstrap).rejects.toThrow(
      "Kernel deployment listener is unavailable",
    );
    await queryStarted.promise;
    if (listenerFailure === undefined) {
      throw new Error("Synchronizer listener failure callback was not installed");
    }
    listenerFailure(new Error("LISTEN connection ended"));
    hydration.resolve([ENDPOINT]);

    await rejection;
    expect(connectionEvents).toEqual([
      "upstream",
      "browser:1011:service-unavailable",
    ]);
    expect(closeSubscription).toHaveBeenCalledOnce();
    expect(() =>
      connections.registerPending({
        authSessionId: "88888888-8888-4888-8888-888888888888",
        closeBrowser: () => undefined,
        connectionId: "99999999-9999-4999-8999-999999999999",
        organizationId: "55555555-5555-4555-8555-555555555555",
        requestId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        sendBrowser: () => undefined,
        spaceId: ENDPOINT.spaceId,
        userId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      }),
    ).toThrow("Access notification listener is unavailable");
    expect(() => deployments.resolve(ENDPOINT_IDENTITY)).toThrow(
      "Kernel deployment is unavailable",
    );
  });

  test("hydrates a persisted ready endpoint and waits for subscription close", async () => {
    const subscriptionClosed = deferred<void>();
    const closeSubscription = vi.fn(() => subscriptionClosed.promise);
    const database = {
      client: { $queryRaw: vi.fn(() => Promise.resolve([ENDPOINT])) },
      listen: vi.fn(() =>
        Promise.resolve({
          close: closeSubscription,
        } satisfies DatabaseNotificationSubscription),
      ),
    } as unknown as DatabaseRuntime;
    const deployments = new RuntimeKernelDeploymentRegistry([]);
    const synchronizer = new KernelRuntimeDeploymentSynchronizer(
      database,
      deployments,
      runtimeConfiguration(),
      createConnections(),
    );

    await synchronizer.onApplicationBootstrap();
    expect(deployments.resolve(ENDPOINT_IDENTITY)).toMatchObject({
      hostname: ENDPOINT.hostname,
      port: ENDPOINT.port,
      serverName: ENDPOINT.serverName,
    });

    let shutdownCompleted = false;
    const shutdown = synchronizer.onApplicationShutdown().then(() => {
      shutdownCompleted = true;
    });
    await Promise.resolve();
    expect(shutdownCompleted).toBe(false);
    subscriptionClosed.resolve();
    await shutdown;
    expect(closeSubscription).toHaveBeenCalledOnce();
  });

  test("fences a hydrated endpoint and new connections before fact readback finishes", async () => {
    const endpointRead = deferred<readonly []>();
    const endpointReadStarted = deferred<void>();
    let notification: ((payload: string) => void) | undefined;
    let queryCount = 0;
    const database = {
      client: {
        $queryRaw: vi.fn(() => {
          queryCount += 1;
          if (queryCount === 1) {
            return Promise.resolve([ENDPOINT]);
          }
          endpointReadStarted.resolve();
          return endpointRead.promise;
        }),
      },
      listen: vi.fn(
        async (
          _channel: string,
          onNotification: (payload: string) => void,
        ) => {
          notification = onNotification;
          return { close: () => Promise.resolve() };
        },
      ),
    } as unknown as DatabaseRuntime;
    const connections = createConnections();
    expect(connections.markNotificationListenerReady("deployment")).toBe(true);
    const events: string[] = [];
    const connection = connections.registerPending({
      authSessionId: "33333333-3333-4333-8333-333333333333",
      closeBrowser: (code, reason) =>
        events.push(`browser:${String(code)}:${reason}`),
      connectionId: "44444444-4444-4444-8444-444444444444",
      organizationId: "55555555-5555-4555-8555-555555555555",
      requestId: "66666666-6666-4666-8666-666666666666",
      sendBrowser: () => events.push("push"),
      spaceId: ENDPOINT.spaceId,
      userId: "77777777-7777-4777-8777-777777777777",
    });
    expect(
      connection.activate(
        new Date("2026-07-19T11:00:00.000Z"),
        ENDPOINT.kernelInstanceId,
      ),
    ).toBe(true);
    expect(connection.bindUpstream(() => events.push("upstream"))).toBe(true);
    const deployments = new RuntimeKernelDeploymentRegistry([]);
    const synchronizer = new KernelRuntimeDeploymentSynchronizer(
      database,
      deployments,
      runtimeConfiguration(),
      connections,
    );
    await synchronizer.onApplicationBootstrap();
    expect(deployments.resolve(ENDPOINT_IDENTITY)).toBeDefined();
    if (notification === undefined) {
      throw new Error("Synchronizer notification callback was not installed");
    }

    notification(JSON.stringify(deploymentEvent()));
    await endpointReadStarted.promise;
    connection.upstreamMessage(Buffer.from("late"), false);

    expect(events).toEqual([
      "upstream",
      "browser:1011:kernel-unavailable",
    ]);
    expect(() => deployments.resolve(ENDPOINT_IDENTITY)).toThrow(
      "Kernel deployment is unavailable",
    );
    expect(() =>
      connections.registerPending({
        authSessionId: "88888888-8888-4888-8888-888888888888",
        closeBrowser: () => undefined,
        connectionId: "99999999-9999-4999-8999-999999999999",
        organizationId: "55555555-5555-4555-8555-555555555555",
        requestId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        sendBrowser: () => undefined,
        spaceId: ENDPOINT.spaceId,
        userId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      }),
    ).toThrow("Kernel deployment lifecycle is changing");

    endpointRead.resolve([]);
    await vi.waitFor(() => {
      expect(() =>
        connections.registerPending({
          authSessionId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
          closeBrowser: () => undefined,
          connectionId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
          organizationId: "55555555-5555-4555-8555-555555555555",
          requestId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
          sendBrowser: () => undefined,
          spaceId: ENDPOINT.spaceId,
          userId: "ffffffff-ffff-4fff-8fff-ffffffffffff",
        }),
      ).not.toThrow();
    });
    await synchronizer.onApplicationShutdown();
  });

  test("installs only the latest fact when same-space notifications overlap", async () => {
    const firstRead = deferred<readonly [typeof ENDPOINT]>();
    const firstReadStarted = deferred<void>();
    const secondRead = deferred<readonly [typeof UPDATED_ENDPOINT]>();
    const secondReadStarted = deferred<void>();
    let notification: ((payload: string) => void) | undefined;
    let queryCount = 0;
    const database = {
      client: {
        $queryRaw: vi.fn(() => {
          queryCount += 1;
          if (queryCount === 1) {
            return Promise.resolve([]);
          }
          if (queryCount === 2) {
            firstReadStarted.resolve();
            return firstRead.promise;
          }
          secondReadStarted.resolve();
          return secondRead.promise;
        }),
      },
      listen: vi.fn(
        async (
          _channel: string,
          onNotification: (payload: string) => void,
        ) => {
          notification = onNotification;
          return { close: () => Promise.resolve() };
        },
      ),
    } as unknown as DatabaseRuntime;
    const deployments = new RuntimeKernelDeploymentRegistry([]);
    const synchronizer = new KernelRuntimeDeploymentSynchronizer(
      database,
      deployments,
      runtimeConfiguration(),
      createConnections(),
    );
    await synchronizer.onApplicationBootstrap();
    if (notification === undefined) {
      throw new Error("Synchronizer notification callback was not installed");
    }

    notification(JSON.stringify(deploymentEvent()));
    await firstReadStarted.promise;
    notification(
      JSON.stringify(
        deploymentEvent("99999999-9999-4999-8999-999999999999"),
      ),
    );
    firstRead.resolve([ENDPOINT]);
    await secondReadStarted.promise;
    expect(() => deployments.resolve(ENDPOINT_IDENTITY)).toThrow(
      "Kernel deployment is unavailable",
    );
    secondRead.resolve([UPDATED_ENDPOINT]);

    await vi.waitFor(() => {
      expect(deployments.resolve(ENDPOINT_IDENTITY)).toMatchObject({
        hostname: UPDATED_ENDPOINT.hostname,
        port: UPDATED_ENDPOINT.port,
      });
    });
    await synchronizer.onApplicationShutdown();
  });

  test("does not reinstall an initial snapshot for a space notified during hydration", async () => {
    const hydration = deferred<readonly [typeof ENDPOINT]>();
    const hydrationStarted = deferred<void>();
    const eventRead = deferred<readonly [typeof UPDATED_ENDPOINT]>();
    const eventReadStarted = deferred<void>();
    let notification: ((payload: string) => void) | undefined;
    let queryCount = 0;
    const database = {
      client: {
        $queryRaw: vi.fn(() => {
          queryCount += 1;
          if (queryCount === 1) {
            hydrationStarted.resolve();
            return hydration.promise;
          }
          eventReadStarted.resolve();
          return eventRead.promise;
        }),
      },
      listen: vi.fn(
        async (
          _channel: string,
          onNotification: (payload: string) => void,
        ) => {
          notification = onNotification;
          return { close: () => Promise.resolve() };
        },
      ),
    } as unknown as DatabaseRuntime;
    const deployments = new RuntimeKernelDeploymentRegistry([]);
    const synchronizer = new KernelRuntimeDeploymentSynchronizer(
      database,
      deployments,
      runtimeConfiguration(),
      createConnections(),
    );

    const bootstrap = synchronizer.onApplicationBootstrap();
    await hydrationStarted.promise;
    if (notification === undefined) {
      throw new Error("Synchronizer notification callback was not installed");
    }
    notification(JSON.stringify(deploymentEvent()));
    hydration.resolve([ENDPOINT]);
    await eventReadStarted.promise;
    expect(() => deployments.resolve(ENDPOINT_IDENTITY)).toThrow(
      "Kernel deployment is unavailable",
    );
    eventRead.resolve([UPDATED_ENDPOINT]);
    await bootstrap;

    expect(deployments.resolve(ENDPOINT_IDENTITY)).toMatchObject({
      hostname: UPDATED_ENDPOINT.hostname,
      port: UPDATED_ENDPOINT.port,
    });
    await synchronizer.onApplicationShutdown();
  });

  test("fails bootstrap on a static handle conflict without removing the static deployment", async () => {
    const staticDeployment = createKernelDeployment(
      {
        handle: ENDPOINT.deploymentHandle,
        hostname: "static-kernel.internal",
        kernelInstanceId: ENDPOINT.kernelInstanceId,
        port: 8443,
        serverName: ENDPOINT.serverName,
        spaceId: ENDPOINT.spaceId,
      },
      runtimeConfiguration().tls,
    );
    const deployments = new RuntimeKernelDeploymentRegistry([staticDeployment]);
    const closeSubscription = vi.fn(() => Promise.resolve());
    const database = {
      client: { $queryRaw: vi.fn(() => Promise.resolve([ENDPOINT])) },
      listen: vi.fn(() =>
        Promise.resolve({ close: closeSubscription }),
      ),
    } as unknown as DatabaseRuntime;
    const synchronizer = new KernelRuntimeDeploymentSynchronizer(
      database,
      deployments,
      runtimeConfiguration(),
      createConnections(),
    );

    await expect(synchronizer.onApplicationBootstrap()).rejects.toThrow(
      "Kernel deployment registration conflicts",
    );
    expect(deployments.resolve(ENDPOINT_IDENTITY)).toBe(staticDeployment);
    expect(closeSubscription).toHaveBeenCalledOnce();
  });

  test("closes a terminal invalid-event subscription exactly once", async () => {
    let notification: ((payload: string) => void) | undefined;
    const closeSubscription = vi.fn(() => Promise.resolve());
    const database = {
      client: { $queryRaw: vi.fn(() => Promise.resolve([])) },
      listen: vi.fn(
        async (
          _channel: string,
          onNotification: (payload: string) => void,
        ) => {
          notification = onNotification;
          return { close: closeSubscription };
        },
      ),
    } as unknown as DatabaseRuntime;
    const connections = createConnections();
    const synchronizer = new KernelRuntimeDeploymentSynchronizer(
      database,
      new RuntimeKernelDeploymentRegistry([]),
      runtimeConfiguration(),
      connections,
    );
    await synchronizer.onApplicationBootstrap();
    if (notification === undefined) {
      throw new Error("Synchronizer notification callback was not installed");
    }

    notification('{"kind":');
    expect(closeSubscription).toHaveBeenCalledOnce();
    expect(connections.available).toBe(false);
    await synchronizer.onApplicationShutdown();
    expect(closeSubscription).toHaveBeenCalledOnce();
  });

  test("keeps startup available for readiness while marking a missing listener unhealthy", async () => {
    const connections = createConnections();
    const database = {
      client: { $queryRaw: vi.fn() },
      listen: vi.fn(() => Promise.reject(new Error("LISTEN unavailable"))),
    } as unknown as DatabaseRuntime;
    const synchronizer = new KernelRuntimeDeploymentSynchronizer(
      database,
      new RuntimeKernelDeploymentRegistry([]),
      runtimeConfiguration(),
      connections,
    );

    await expect(synchronizer.onApplicationBootstrap()).resolves.toBeUndefined();
    expect(connections.available).toBe(false);
  });
});
