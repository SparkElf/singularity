import { describe, expect, test, vi } from "vitest";

import { SpaceConnectionRegistry } from "../src/kernel/space-connection.registry.js";

const SPACE_ID = "22222222-2222-4222-8222-222222222222";
const OTHER_SPACE_ID = "33333333-3333-4333-8333-333333333333";
const KERNEL_INSTANCE_ID = "11111111-1111-4111-8111-111111111111";

function markRegistryReady(registry: SpaceConnectionRegistry): void {
  expect(registry.markNotificationListenerReady("access")).toBe(true);
  expect(registry.available).toBe(false);
  expect(registry.markNotificationListenerReady("deployment")).toBe(true);
  expect(registry.available).toBe(true);
}

describe("Kernel connection lifecycle", () => {
  test("fences pending and active connections until the latest deployment generation resolves", () => {
    const registry = new SpaceConnectionRegistry({
      now: () => new Date("2026-07-19T10:00:00.000Z"),
    });
    markRegistryReady(registry);

    const activeEvents: string[] = [];
    const active = registry.registerPending({
      authSessionId: "44444444-4444-4444-8444-444444444444",
      closeBrowser: (code, reason) =>
        activeEvents.push(`browser:${String(code)}:${reason}`),
      connectionId: "55555555-5555-4555-8555-555555555555",
      organizationId: "11111111-1111-4111-8111-111111111111",
      requestId: "66666666-6666-4666-8666-666666666666",
      sendBrowser: () => activeEvents.push("push"),
      spaceId: SPACE_ID,
      userId: "77777777-7777-4777-8777-777777777777",
    });
    expect(
      active.activate(
        new Date("2026-07-19T11:00:00.000Z"),
        KERNEL_INSTANCE_ID,
      ),
    ).toBe(true);
    expect(active.bindUpstream(() => activeEvents.push("upstream"))).toBe(true);

    const pendingEvents: string[] = [];
    const pending = registry.registerPending({
      authSessionId: "88888888-8888-4888-8888-888888888888",
      closeBrowser: (code, reason) =>
        pendingEvents.push(`browser:${String(code)}:${reason}`),
      connectionId: "99999999-9999-4999-8999-999999999999",
      organizationId: "11111111-1111-4111-8111-111111111111",
      requestId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      sendBrowser: () => pendingEvents.push("push"),
      spaceId: SPACE_ID,
      userId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    });

    const connectingEvents: string[] = [];
    const connecting = registry.registerPending({
      authSessionId: "12121212-1212-4121-8121-121212121212",
      closeBrowser: (code, reason) =>
        connectingEvents.push(`browser:${String(code)}:${reason}`),
      connectionId: "13131313-1313-4131-8131-131313131313",
      organizationId: "11111111-1111-4111-8111-111111111111",
      requestId: "14141414-1414-4141-8141-141414141414",
      sendBrowser: () => connectingEvents.push("push"),
      spaceId: SPACE_ID,
      userId: "15151515-1515-4151-8151-151515151515",
    });
    expect(
      connecting.activate(
        new Date("2026-07-19T11:00:00.000Z"),
        KERNEL_INSTANCE_ID,
      ),
    ).toBe(true);

    const otherEvents: string[] = [];
    const other = registry.registerPending({
      authSessionId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      closeBrowser: (code, reason) =>
        otherEvents.push(`browser:${String(code)}:${reason}`),
      connectionId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      organizationId: "11111111-1111-4111-8111-111111111111",
      requestId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
      sendBrowser: () => otherEvents.push("push"),
      spaceId: OTHER_SPACE_ID,
      userId: "ffffffff-ffff-4fff-8fff-ffffffffffff",
    });
    expect(
      other.activate(
        new Date("2026-07-19T11:00:00.000Z"),
        KERNEL_INSTANCE_ID,
      ),
    ).toBe(true);

    registry.fenceKernelLifecycle(SPACE_ID, 2);
    active.upstreamMessage(Buffer.from("late"), false);
    other.upstreamMessage(Buffer.from("current"), false);

    expect(activeEvents).toEqual([
      "upstream",
      "browser:1011:kernel-unavailable",
    ]);
    expect(pendingEvents).toEqual(["browser:1011:kernel-unavailable"]);
    expect(connectingEvents).toEqual(["browser:1011:kernel-unavailable"]);
    expect(
      pending.activate(
        new Date("2026-07-19T11:00:00.000Z"),
        KERNEL_INSTANCE_ID,
      ),
    ).toBe(false);
    const lateUpstreamClose = vi.fn();
    expect(connecting.bindUpstream(lateUpstreamClose)).toBe(false);
    expect(lateUpstreamClose).toHaveBeenCalledOnce();
    expect(otherEvents).toEqual(["push"]);

    const registerDuringFence = (): void => {
      registry.registerPending({
        authSessionId: "16161616-1616-4161-8161-161616161616",
        closeBrowser: () => undefined,
        connectionId: "17171717-1717-4171-8171-171717171717",
        organizationId: "11111111-1111-4111-8111-111111111111",
        requestId: "18181818-1818-4181-8181-181818181818",
        sendBrowser: () => undefined,
        spaceId: SPACE_ID,
        userId: "19191919-1919-4191-8191-191919191919",
      });
    };
    expect(registerDuringFence).toThrow(
      "Kernel deployment lifecycle is changing",
    );
    expect(registry.resolveKernelLifecycleFence(SPACE_ID, 1)).toBe(false);
    expect(registerDuringFence).toThrow(
      "Kernel deployment lifecycle is changing",
    );
    expect(registry.resolveKernelLifecycleFence(SPACE_ID, 2)).toBe(true);
    expect(registerDuringFence).not.toThrow();

    registry.closeAllByKernelLifecycle();
  });

  test("refreshes only the matching active session and replaces its expiry timer", () => {
    vi.useFakeTimers();
    try {
      let now = new Date("2026-07-19T10:00:00.000Z");
      const registry = new SpaceConnectionRegistry({ now: () => now });
      markRegistryReady(registry);
      const events: string[] = [];
      const handle = registry.registerPending({
        authSessionId: "44444444-4444-4444-8444-444444444444",
        closeBrowser: (code, reason) =>
          events.push(`browser:${String(code)}:${reason}`),
        connectionId: "55555555-5555-4555-8555-555555555555",
        organizationId: "11111111-1111-4111-8111-111111111111",
        requestId: "66666666-6666-4666-8666-666666666666",
        sendBrowser: () => events.push("push"),
        spaceId: SPACE_ID,
        userId: "77777777-7777-4777-8777-777777777777",
      });
      expect(
        handle.activate(
          new Date(now.getTime() + 1_000),
          KERNEL_INSTANCE_ID,
        ),
      ).toBe(true);
      expect(handle.bindUpstream(() => events.push("upstream"))).toBe(true);

      registry.refreshSessionExpiry(
        "88888888-8888-4888-8888-888888888888",
        new Date(now.getTime() + 10_000),
      );
      registry.refreshSessionExpiry(
        "44444444-4444-4444-8444-444444444444",
        new Date(now.getTime() + 2_000),
      );
      now = new Date(now.getTime() + 1_000);
      vi.advanceTimersByTime(1_000);
      expect(events).toEqual([]);

      now = new Date(now.getTime() + 1_000);
      vi.advanceTimersByTime(1_000);
      handle.upstreamMessage(Buffer.from("late"), false);
      expect(events).toEqual([
        "upstream",
        "browser:4401:unauthenticated",
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  test("uses a later expiry received while pending instead of stale revalidation data", () => {
    vi.useFakeTimers();
    try {
      let now = new Date("2026-07-19T10:00:00.000Z");
      const startedAt = now.getTime();
      const registry = new SpaceConnectionRegistry({ now: () => now });
      markRegistryReady(registry);
      const events: string[] = [];
      const handle = registry.registerPending({
        authSessionId: "44444444-4444-4444-8444-444444444444",
        closeBrowser: (code, reason) =>
          events.push(`browser:${String(code)}:${reason}`),
        connectionId: "55555555-5555-4555-8555-555555555555",
        organizationId: "11111111-1111-4111-8111-111111111111",
        requestId: "66666666-6666-4666-8666-666666666666",
        sendBrowser: () => events.push("push"),
        spaceId: SPACE_ID,
        userId: "77777777-7777-4777-8777-777777777777",
      });

      registry.refreshSessionExpiry(
        "44444444-4444-4444-8444-444444444444",
        new Date(startedAt + 10_000),
      );
      now = new Date(startedAt + 1_000);
      vi.advanceTimersByTime(1_000);
      expect(events).toEqual([]);
      expect(
        handle.activate(new Date(startedAt + 1_000), KERNEL_INSTANCE_ID),
      ).toBe(true);

      now = new Date(startedAt + 9_999);
      vi.advanceTimersByTime(8_999);
      expect(events).toEqual([]);
      now = new Date(startedAt + 10_000);
      vi.advanceTimersByTime(1);
      expect(events).toEqual(["browser:4401:unauthenticated"]);
    } finally {
      vi.useRealTimers();
    }
  });

  test("applies combined access selectors as an intersection", () => {
    const registry = new SpaceConnectionRegistry({
      now: () => new Date("2026-07-19T10:00:00.000Z"),
    });
    markRegistryReady(registry);
    const matchedEvents: string[] = [];
    const sameUserEvents: string[] = [];
    const sameOrganizationEvents: string[] = [];
    const userId = "44444444-4444-4444-8444-444444444444";
    const organizationId = "55555555-5555-4555-8555-555555555555";
    const register = (input: {
      connectionId: string;
      events: string[];
      organizationId: string;
      userId: string;
    }) =>
      registry.registerPending({
        authSessionId: input.connectionId,
        closeBrowser: (code, reason) =>
          input.events.push(`browser:${String(code)}:${reason}`),
        connectionId: input.connectionId,
        organizationId: input.organizationId,
        requestId: input.connectionId,
        sendBrowser: () => input.events.push("push"),
        spaceId: SPACE_ID,
        userId: input.userId,
      });
    const matched = register({
      connectionId: "66666666-6666-4666-8666-666666666666",
      events: matchedEvents,
      organizationId,
      userId,
    });
    const sameUser = register({
      connectionId: "77777777-7777-4777-8777-777777777777",
      events: sameUserEvents,
      organizationId: "88888888-8888-4888-8888-888888888888",
      userId,
    });
    const sameOrganization = register({
      connectionId: "99999999-9999-4999-8999-999999999999",
      events: sameOrganizationEvents,
      organizationId,
      userId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    });
    for (const handle of [matched, sameUser, sameOrganization]) {
      expect(
        handle.activate(
          new Date("2026-07-19T11:00:00.000Z"),
          KERNEL_INSTANCE_ID,
        ),
      ).toBe(true);
    }

    registry.closeByAccessChange({
      kind: "close",
      reason: "forbidden",
      requestId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      selectors: [
        { kind: "user", value: userId },
        { kind: "organization", value: organizationId },
      ],
    });
    matched.upstreamMessage(Buffer.from("late"), false);
    sameUser.upstreamMessage(Buffer.from("current"), false);
    sameOrganization.upstreamMessage(Buffer.from("current"), false);

    expect(matchedEvents).toEqual(["browser:4403:forbidden"]);
    expect(sameUserEvents).toEqual(["push"]);
    expect(sameOrganizationEvents).toEqual(["push"]);
    registry.closeAllByKernelLifecycle();
  });
});
