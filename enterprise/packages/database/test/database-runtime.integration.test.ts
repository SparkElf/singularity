import { inspect } from "node:util";

import { isolatedDatabaseUrl } from "@singularity/database/testing/postgres";
import { describe, expect, test } from "vitest";

import { DatabaseClient } from "../src/index.js";

interface Signal {
  promise: Promise<void>;
  resolve(): void;
}

function createSignal(): Signal {
  let resolveSignal!: () => void;
  const promise = new Promise<void>((resolve) => {
    resolveSignal = resolve;
  });

  return {
    promise,
    resolve(): void {
      resolveSignal();
    },
  };
}

describe("database runtime limits", () => {
  test("rejects pool checkout after the fixed three-second wait", async () => {
    const databaseUrl = new URL(isolatedDatabaseUrl());
    databaseUrl.searchParams.set("connect_timeout", "1");
    const database = new DatabaseClient(databaseUrl.toString());
    const connections = Array.from({ length: 5 }, () => ({
      release: createSignal(),
      started: createSignal(),
    }));

    await database.$connect();
    const holders = connections.map(({ release, started }) =>
      database.$transaction(
        async (transaction) => {
          await transaction.$queryRaw`SELECT 1`;
          started.resolve();
          await release.promise;
        },
        { maxWait: 5_000, timeout: 10_000 },
      ),
    );

    try {
      const earlyHolderCompletion = Promise.race(holders).then(
        () => {
          throw new Error("A pool holder completed before release");
        },
        (error: unknown) => {
          throw error;
        },
      );
      await Promise.race([
        Promise.all(connections.map(({ started }) => started.promise)),
        earlyHolderCompletion,
      ]);

      let failure: unknown;
      const startedAt = performance.now();
      try {
        await database.$queryRaw`SELECT 1`;
      } catch (error) {
        failure = error;
      }
      const elapsedMilliseconds = performance.now() - startedAt;

      expect(failure).toBeInstanceOf(Error);
      expect(elapsedMilliseconds).toBeGreaterThanOrEqual(2_500);
      expect(elapsedMilliseconds).toBeLessThan(4_500);
    } finally {
      for (const { release } of connections) {
        release.resolve();
      }
      await Promise.allSettled(holders);
      await database.$disconnect();
    }
  });

  test("rejects a query at the fixed five-second client timeout", async () => {
    const databaseUrl = new URL(isolatedDatabaseUrl());
    databaseUrl.searchParams.set("query_timeout", "250");
    databaseUrl.searchParams.set("statement_timeout", "250");
    const database = new DatabaseClient(databaseUrl.toString());

    await database.$connect();
    try {
      let failure: unknown;
      try {
        await database.$transaction(
          async (transaction) => {
            await transaction.$executeRawUnsafe(
              "SET LOCAL statement_timeout = 0",
            );
            const startedAt = performance.now();
            try {
              await transaction.$queryRaw`SELECT pg_sleep(6)`;
            } catch (error) {
              const elapsedMilliseconds = performance.now() - startedAt;
              expect(elapsedMilliseconds).toBeGreaterThanOrEqual(4_500);
              expect(elapsedMilliseconds).toBeLessThan(5_800);
              throw error;
            }
          },
          { maxWait: 5_000, timeout: 10_000 },
        );
      } catch (error) {
        failure = error;
      }

      expect(inspect(failure, { depth: null })).toContain("Query read timeout");
    } finally {
      await database.$disconnect();
    }
  });

  test("cancels a query at the fixed four-second server statement timeout", async () => {
    const databaseUrl = new URL(isolatedDatabaseUrl());
    databaseUrl.searchParams.set("query_timeout", "10000");
    databaseUrl.searchParams.set("statement_timeout", "250");
    const database = new DatabaseClient(databaseUrl.toString());

    await database.$connect();
    try {
      let failure: unknown;
      const startedAt = performance.now();
      try {
        await database.$queryRaw`SELECT pg_sleep(6)`;
      } catch (error) {
        failure = error;
      }
      const elapsedMilliseconds = performance.now() - startedAt;
      const failureDetails = inspect(failure, { depth: null });

      expect(failureDetails).toContain("57014");
      expect(failureDetails).toContain("statement timeout");
      expect(elapsedMilliseconds).toBeGreaterThanOrEqual(3_500);
      expect(elapsedMilliseconds).toBeLessThan(4_900);
    } finally {
      await database.$disconnect();
    }
  });
});
