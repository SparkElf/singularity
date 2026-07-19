import { describe, expect, test, vi } from "vitest";

import { SpaceConnectionRegistry } from "../src/kernel/space-connection.registry.js";

const SPACE_ID = "22222222-2222-4222-8222-222222222222";
const OTHER_SPACE_ID = "33333333-3333-4333-8333-333333333333";
const KERNEL_INSTANCE_ID = "11111111-1111-4111-8111-111111111111";

describe("Kernel connection lifecycle", () => {
  test("closes pending and active connections before an endpoint is replaced", () => {
    const registry = new SpaceConnectionRegistry({
      now: () => new Date("2026-07-19T10:00:00.000Z"),
    });
    expect(registry.markNotificationListenerReady()).toBe(true);

    const activeEvents: string[] = [];
    const active = registry.registerPending({
      authSessionId: "44444444-4444-4444-8444-444444444444",
      closeBrowser: (code, reason) => activeEvents.push(`browser:${code}:${reason}`),
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
    registry.registerPending({
      authSessionId: "88888888-8888-4888-8888-888888888888",
      closeBrowser: (code, reason) => pendingEvents.push(`browser:${code}:${reason}`),
      connectionId: "99999999-9999-4999-8999-999999999999",
      organizationId: "11111111-1111-4111-8111-111111111111",
      requestId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      sendBrowser: () => pendingEvents.push("push"),
      spaceId: SPACE_ID,
      userId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    });

    const otherEvents: string[] = [];
    const other = registry.registerPending({
      authSessionId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      closeBrowser: (code, reason) => otherEvents.push(`browser:${code}:${reason}`),
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

    registry.closeByKernelLifecycle(SPACE_ID);
    active.upstreamMessage(Buffer.from("late"), false);
    other.upstreamMessage(Buffer.from("current"), false);

    expect(activeEvents).toEqual([
      "upstream",
      "browser:1011:kernel-unavailable",
    ]);
    expect(pendingEvents).toEqual(["browser:1011:kernel-unavailable"]);
    expect(otherEvents).toEqual(["push"]);
    other.browserClosed();
  });

  test("expires active connections by closing upstream before notifying the browser", () => {
    vi.useFakeTimers();
    try {
      let now = new Date("2026-07-19T10:00:00.000Z");
      const registry = new SpaceConnectionRegistry({ now: () => now });
      expect(registry.markNotificationListenerReady()).toBe(true);
      const events: string[] = [];
      const handle = registry.registerPending({
        authSessionId: "44444444-4444-4444-8444-444444444444",
        closeBrowser: (code, reason) => events.push(`browser:${code}:${reason}`),
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

  test("does not schedule session expiry for a pending connection", () => {
    vi.useFakeTimers();
    try {
      let now = new Date("2026-07-19T10:00:00.000Z");
      const registry = new SpaceConnectionRegistry({ now: () => now });
      expect(registry.markNotificationListenerReady()).toBe(true);
      const events: string[] = [];
      const handle = registry.registerPending({
        authSessionId: "44444444-4444-4444-8444-444444444444",
        closeBrowser: (code, reason) => events.push(`browser:${code}:${reason}`),
        connectionId: "55555555-5555-4555-8555-555555555555",
        organizationId: "11111111-1111-4111-8111-111111111111",
        requestId: "66666666-6666-4666-8666-666666666666",
        sendBrowser: () => events.push("push"),
        spaceId: SPACE_ID,
        userId: "77777777-7777-4777-8777-777777777777",
      });

      registry.refreshSessionExpiry(
        "44444444-4444-4444-8444-444444444444",
        new Date(now.getTime() + 1_000),
      );
      vi.advanceTimersByTime(1_000);
      expect(events).toEqual([]);

      now = new Date(now.getTime() + 1_000);
      expect(
        handle.activate(
          new Date(now.getTime() + 1_000),
          KERNEL_INSTANCE_ID,
        ),
      ).toBe(true);
      now = new Date(now.getTime() + 1_000);
      vi.advanceTimersByTime(1_000);
      expect(events).toEqual(["browser:4401:unauthenticated"]);
    } finally {
      vi.useRealTimers();
    }
  });
});
