import { afterEach, describe, expect, it, vi } from "vitest";

import type { WorkerJobProducer } from "../src/job-declarations.js";
import { WorkerJobScheduler } from "../src/scheduler.js";
import type {
  ArchiveAuditJob,
  SampleKernelJob,
  WorkerJobLogger,
} from "../src/worker.js";

function logger(entries: Readonly<Record<string, unknown>>[]): WorkerJobLogger {
  return {
    debug(context) {
      entries.push(context);
    },
    error(context) {
      entries.push(context);
    },
    info(context) {
      entries.push(context);
    },
    warn(context) {
      entries.push(context);
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("WorkerJobScheduler declared producer cadence", () => {
  it("runs producers immediately on independent intervals and stops on cancellation", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-19T10:00:00.000Z"));
    const sampleProduce = vi.fn(async () => 1);
    const archiveProduce = vi.fn(async () => 1);
    const sampleProducer: WorkerJobProducer<SampleKernelJob> = {
      intervalMilliseconds: 1_000,
      kind: "sample-kernel",
      produce: sampleProduce,
    };
    const archiveProducer: WorkerJobProducer<ArchiveAuditJob> = {
      intervalMilliseconds: 2_000,
      kind: "archive-audit",
      produce: archiveProduce,
    };
    const entries: Readonly<Record<string, unknown>>[] = [];
    const abort = new AbortController();
    const run = new WorkerJobScheduler({
      logger: logger(entries),
      now: () => new Date(Date.now()),
      producers: [sampleProducer, archiveProducer],
    }).run(abort.signal);

    await vi.advanceTimersByTimeAsync(0);
    expect(sampleProduce).toHaveBeenCalledTimes(1);
    expect(archiveProduce).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(sampleProduce).toHaveBeenCalledTimes(2);
    expect(archiveProduce).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(sampleProduce).toHaveBeenCalledTimes(3);
    expect(archiveProduce).toHaveBeenCalledTimes(2);

    abort.abort();
    await run;
    expect(entries).toContainEqual({
      event: "worker.scheduler",
      outcome: "stopped",
    });
  });

  it("fails closed when a declared producer cannot persist its jobs", async () => {
    const persistenceFailure = new Error("producer persistence unavailable");
    const producer: WorkerJobProducer<SampleKernelJob> = {
      intervalMilliseconds: 1_000,
      kind: "sample-kernel",
      async produce() {
        throw persistenceFailure;
      },
    };
    const entries: Readonly<Record<string, unknown>>[] = [];

    await expect(
      new WorkerJobScheduler({
        logger: logger(entries),
        producers: [producer],
      }).run(new AbortController().signal),
    ).rejects.toBe(persistenceFailure);
    expect(entries).toContainEqual({
      error: persistenceFailure,
      event: "worker.producer",
      kind: "sample-kernel",
      outcome: "failed",
    });
    const failureLog = entries.find(
      (entry) =>
        entry.event === "worker.producer" && entry.outcome === "failed",
    );
    expect(failureLog?.error).toBe(persistenceFailure);
    expect((failureLog?.error as Error).stack).toContain(
      "producer persistence unavailable",
    );
    expect(entries).toContainEqual({
      event: "worker.scheduler",
      outcome: "stopped",
    });
  });
});
