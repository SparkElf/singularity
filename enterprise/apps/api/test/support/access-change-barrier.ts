import { randomUUID } from "node:crypto";

import { DatabaseRuntime, Prisma } from "@singularity/database";

import { ACCESS_CHANGE_CHANNEL } from "../../src/kernel/access-changed.js";

const NOTIFICATION_TIMEOUT_MS = 5_000;

export async function captureAccessChanges<T>(
  database: DatabaseRuntime,
  action: () => Promise<T>,
): Promise<{ events: unknown[]; result: T }> {
  const barrierRequestId = randomUUID();
  const events: unknown[] = [];
  let resolveBarrier!: () => void;
  let rejectBarrier!: (error: unknown) => void;
  const barrier = new Promise<void>((resolve, reject) => {
    resolveBarrier = resolve;
    rejectBarrier = reject;
  });
  const subscription = await database.listen(
    ACCESS_CHANGE_CHANNEL,
    (payload) => {
      try {
        const event = JSON.parse(payload) as unknown;
        if (
          typeof event === "object" &&
          event !== null &&
          "requestId" in event &&
          event.requestId === barrierRequestId
        ) {
          resolveBarrier();
          return;
        }
        if (
          typeof event === "object" &&
          event !== null &&
          "kind" in event &&
          event.kind === "close"
        ) {
          events.push(event);
        }
      } catch (error) {
        rejectBarrier(error);
      }
    },
    rejectBarrier,
  );
  let timeout: ReturnType<typeof setTimeout> | undefined;

  try {
    const result = await action();
    const barrierEvent = JSON.stringify({
      kind: "close",
      reason: "forbidden",
      requestId: barrierRequestId,
      selectors: [{ kind: "user", value: randomUUID() }],
    });
    await database.client.$queryRaw(
      Prisma.sql`SELECT pg_notify(${ACCESS_CHANGE_CHANNEL}, ${barrierEvent})`,
    );
    await Promise.race([
      barrier,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error("The access-change barrier was not delivered")),
          NOTIFICATION_TIMEOUT_MS,
        );
      }),
    ]);
    return { events, result };
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
    await subscription.close();
  }
}
