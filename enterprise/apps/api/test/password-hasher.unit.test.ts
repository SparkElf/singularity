import { describe, expect, test, vi } from "vitest";

import {
  KdfAdmissionError,
  PasswordHasher,
  type ArgonDriver,
} from "../src/identity/password-hasher.js";

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe("password KDF admission", () => {
  test("runs at most two operations and rejects beyond eight queued items", async () => {
    const calls: Deferred<string>[] = [];
    const driver: ArgonDriver = {
      hash: vi.fn(() => {
        const call = deferred<string>();
        calls.push(call);
        return call.promise;
      }),
      verify: vi.fn(() => Promise.resolve(true)),
    };
    const hasher = new PasswordHasher(driver, {
      maximumActive: 2,
      maximumQueued: 8,
      waitTimeoutMilliseconds: 5_000,
    });
    const accepted = Array.from({ length: 10 }, (_, index) =>
      hasher.hashPassword(`password-${index}`),
    );
    const rejected = hasher.hashPassword("password-over-capacity");

    expect(hasher.activeCount).toBe(2);
    expect(hasher.queuedCount).toBe(8);
    expect(calls).toHaveLength(2);
    await expect(rejected).rejects.toBeInstanceOf(KdfAdmissionError);

    calls[0]?.resolve("digest-0");
    await accepted[0];
    expect(hasher.activeCount).toBe(2);
    expect(hasher.queuedCount).toBe(7);
    expect(calls).toHaveLength(3);

    for (let index = 1; index < accepted.length; index += 1) {
      calls[index]?.resolve(`digest-${index}`);
      await accepted[index];
    }
    expect(hasher.activeCount).toBe(0);
    expect(hasher.queuedCount).toBe(0);
  });

  test("removes a request that exceeds its queue wait", async () => {
    vi.useFakeTimers();
    try {
      const active = deferred<string>();
      const driver: ArgonDriver = {
        hash: vi.fn(() => active.promise),
        verify: vi.fn(() => Promise.resolve(true)),
      };
      const hasher = new PasswordHasher(driver, {
        maximumActive: 1,
        maximumQueued: 1,
        waitTimeoutMilliseconds: 5_000,
      });
      const first = hasher.hashPassword("first-password");
      const timedOut = hasher.hashPassword("queued-password");
      const timeoutExpectation = expect(timedOut).rejects.toBeInstanceOf(
        KdfAdmissionError,
      );

      await vi.advanceTimersByTimeAsync(5_000);
      await timeoutExpectation;
      expect(hasher.queuedCount).toBe(0);

      active.resolve("digest");
      await expect(first).resolves.toBe("digest");
    } finally {
      vi.useRealTimers();
    }
  });

  test("reuses one dummy digest while admitting every verification", async () => {
    const hashMock = vi.fn(() => Promise.resolve("dummy-phc"));
    const verifyMock = vi.fn(() => Promise.resolve(false));
    const driver: ArgonDriver = {
      hash: hashMock,
      verify: verifyMock,
    };
    const hasher = new PasswordHasher(driver);

    await hasher.verifyDummy("unknown-one");
    await hasher.verifyDummy("unknown-two");

    expect(hashMock).toHaveBeenCalledOnce();
    expect(verifyMock).toHaveBeenNthCalledWith(
      1,
      "dummy-phc",
      "unknown-one",
    );
    expect(verifyMock).toHaveBeenNthCalledWith(
      2,
      "dummy-phc",
      "unknown-two",
    );
  });
});
