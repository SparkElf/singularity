import "reflect-metadata";

import type {
  DatabaseNotificationSubscription,
  DatabaseRuntime,
} from "@singularity/database";
import {
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
    const connections = new SpaceConnectionRegistry({
      now: () => new Date("2026-07-19T10:00:00.000Z"),
    });
    expect(connections.markNotificationListenerReady()).toBe(true);
    const connectionEvents: string[] = [];
    const connection = connections.registerPending({
      authSessionId: "33333333-3333-4333-8333-333333333333",
      closeBrowser: (code, reason) =>
        connectionEvents.push(`browser:${code}:${reason}`),
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
      throw new Error("synchronizer listener failure callback was not installed");
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
    expect(() =>
      deployments.resolve({
        handle: ENDPOINT.deploymentHandle,
        kernelInstanceId: ENDPOINT.kernelInstanceId,
        spaceId: ENDPOINT.spaceId,
      }),
    ).toThrow("Kernel deployment is unavailable");
  });

  test("hydrates a persisted ready endpoint into the shared deployment registry", async () => {
    const closeSubscription = vi.fn(() => Promise.resolve());
    const database = {
      client: { $queryRaw: vi.fn(() => Promise.resolve([ENDPOINT])) },
      listen: vi.fn(() =>
        Promise.resolve({ close: closeSubscription } satisfies DatabaseNotificationSubscription),
      ),
    } as unknown as DatabaseRuntime;
    const deployments = new RuntimeKernelDeploymentRegistry([]);
    const synchronizer = new KernelRuntimeDeploymentSynchronizer(
      database,
      deployments,
      runtimeConfiguration(),
      new SpaceConnectionRegistry({
        now: () => new Date("2026-07-19T10:00:00.000Z"),
      }),
    );

    await synchronizer.onApplicationBootstrap();

    expect(
      deployments.resolve({
        handle: ENDPOINT.deploymentHandle,
        kernelInstanceId: ENDPOINT.kernelInstanceId,
        spaceId: ENDPOINT.spaceId,
      }),
    ).toMatchObject({
      hostname: ENDPOINT.hostname,
      port: ENDPOINT.port,
      serverName: ENDPOINT.serverName,
    });
    await synchronizer.onApplicationShutdown();
    expect(closeSubscription).toHaveBeenCalledOnce();
  });

  test("invalidates the affected space before a deployment fact read can finish", async () => {
    const endpointRead = deferred<readonly []>();
    const endpointReadStarted = deferred<void>();
    let notification: ((payload: string) => void) | undefined;
    let queryCount = 0;
    const database = {
      client: {
        $queryRaw: vi.fn(() => {
          queryCount += 1;
          if (queryCount === 1) {
            return Promise.resolve([]);
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
    const connections = new SpaceConnectionRegistry({
      now: () => new Date("2026-07-19T10:00:00.000Z"),
    });
    expect(connections.markNotificationListenerReady()).toBe(true);
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
    const synchronizer = new KernelRuntimeDeploymentSynchronizer(
      database,
      new RuntimeKernelDeploymentRegistry([]),
      runtimeConfiguration(),
      connections,
    );
    await synchronizer.onApplicationBootstrap();
    if (notification === undefined) {
      throw new Error("synchronizer notification callback was not installed");
    }

    notification(
      JSON.stringify(
        {
          kernelInstanceId: ENDPOINT.kernelInstanceId,
          kind: "upsert",
          requestId: "88888888-8888-4888-8888-888888888888",
          spaceId: ENDPOINT.spaceId,
        } satisfies KernelDeploymentChangedEvent,
      ),
    );
    await endpointReadStarted.promise;
    connection.upstreamMessage(Buffer.from("late"), false);

    expect(events).toEqual([
      "upstream",
      "browser:1011:kernel-unavailable",
    ]);
    endpointRead.resolve([]);
    await synchronizer.onApplicationShutdown();
  });
});
