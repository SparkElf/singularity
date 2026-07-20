import { afterEach, describe, expect, it, vi } from "vitest";

import {
  BoundedJobWorker,
  WorkerJobError,
  type SampleKernelJob,
  type WorkerJobHandler,
  type WorkerJobLogger,
  type WorkerJobRecord,
  type WorkerJobRepository,
} from "../src/worker.js";

const record: WorkerJobRecord = {
  attempt: 1,
  id: "10000000-0000-4000-8000-000000000001",
  kind: "sample-kernel",
  leaseExpiresAt: new Date("2020-01-01T00:00:00.000Z"),
  organizationId: "10000000-0000-4000-8000-000000000002",
  payload: {
    kernelInstanceId: "10000000-0000-4000-8000-000000000003",
    spaceId: "10000000-0000-4000-8000-000000000004",
  },
  requestId: "10000000-0000-4000-8000-000000000005",
};

const decodedJob: SampleKernelJob = {
  attempt: record.attempt,
  id: record.id,
  kernelInstanceId: "10000000-0000-4000-8000-000000000003",
  kind: "sample-kernel",
  leaseExpiresAt: record.leaseExpiresAt,
  organizationId: record.organizationId,
  requestId: record.requestId,
  spaceId: "10000000-0000-4000-8000-000000000004",
};

function repository(
  overrides: Partial<WorkerJobRepository>,
): WorkerJobRepository {
  return {
    async claimBatch() {
      return [];
    },
    async complete() {
      return true;
    },
    async fail() {
      return true;
    },
    async renewLease() {
      return true;
    },
    ...overrides,
  };
}

function handler(
  execute: WorkerJobHandler<SampleKernelJob>["execute"],
): WorkerJobHandler<SampleKernelJob> {
  return {
    decode() {
      return decodedJob;
    },
    execute,
    kind: "sample-kernel",
  };
}

function logger(): WorkerJobLogger {
  return {
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  };
}

function worker(
  jobRepository: WorkerJobRepository,
  jobHandler: WorkerJobHandler<SampleKernelJob>,
  overrides: Partial<{
    claimBatchSize: number;
    jobLogger: WorkerJobLogger;
    maximumConcurrentJobs: number;
  }> = {},
): BoundedJobWorker {
  return new BoundedJobWorker({
    claimBatchSize: overrides.claimBatchSize ?? 1,
    handlers: [jobHandler],
    leaseDurationMilliseconds: 5_000,
    leaseRenewalMilliseconds: 1_000,
    logger: overrides.jobLogger ?? logger(),
    maximumConcurrentJobs: overrides.maximumConcurrentJobs ?? 1,
    pollIntervalMilliseconds: 100,
    repository: jobRepository,
    workerId: "worker-test",
  });
}

afterEach(() => {
  vi.useRealTimers();
});

describe("BoundedJobWorker lease contract", () => {
  it("renews a held lease before completing a recovered record", async () => {
    vi.useFakeTimers();
    const abort = new AbortController();
    let claimed = false;
    let releaseExecution = (): void => {
      throw new Error("Execution resolver is unavailable");
    };
    const execution = new Promise<void>((resolve) => {
      releaseExecution = () => resolve();
    });
    const renewLease = vi.fn(async () => true);
    const complete = vi.fn(async () => {
      abort.abort();
      return true;
    });
    const fail = vi.fn(async () => true);
    const run = worker(
      repository({
        async claimBatch() {
          if (claimed) {
            return [];
          }
          claimed = true;
          return [record];
        },
        complete,
        fail,
        renewLease,
      }),
      handler(async () => execution),
    ).run(abort.signal);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(renewLease).toHaveBeenCalledOnce();
    releaseExecution();
    await run;

    expect(complete).toHaveBeenCalledOnce();
    expect(fail).not.toHaveBeenCalled();
  });

  it("does not complete or fail after renewal reports a lost lease", async () => {
    vi.useFakeTimers();
    const abort = new AbortController();
    let claimed = false;
    const complete = vi.fn(async () => true);
    const fail = vi.fn(async () => true);
    const renewLease = vi.fn(async () => {
      abort.abort();
      return false;
    });
    const run = worker(
      repository({
        async claimBatch() {
          if (claimed) {
            return [];
          }
          claimed = true;
          return [record];
        },
        complete,
        fail,
        renewLease,
      }),
      handler(
        async (_job, signal) =>
          new Promise<void>((resolve) => {
            if (signal.aborted) {
              resolve();
              return;
            }
            signal.addEventListener("abort", () => resolve(), { once: true });
          }),
      ),
    ).run(abort.signal);

    await vi.advanceTimersByTimeAsync(1_000);
    await run;

    expect(renewLease).toHaveBeenCalledOnce();
    expect(complete).not.toHaveBeenCalled();
    expect(fail).not.toHaveBeenCalled();
  });

  it("passes shutdown cancellation to a running handler and leaves its lease recoverable", async () => {
    const abort = new AbortController();
    let claimed = false;
    let started = (): void => {
      throw new Error("Handler start resolver is unavailable");
    };
    const handlerStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const complete = vi.fn(async () => true);
    const fail = vi.fn(async () => true);
    const run = worker(
      repository({
        async claimBatch() {
          if (claimed) {
            return [];
          }
          claimed = true;
          return [record];
        },
        complete,
        fail,
      }),
      handler(async (_job, signal) => {
        started();
        return new Promise<void>((resolve, reject) => {
          if (signal.aborted) {
            reject(signal.reason);
            return;
          }
          signal.addEventListener(
            "abort",
            () => reject(signal.reason),
            { once: true },
          );
        });
      }),
    ).run(abort.signal);

    await handlerStarted;
    abort.abort(new Error("worker shutdown"));
    await run;

    expect(complete).not.toHaveBeenCalled();
    expect(fail).not.toHaveBeenCalled();
  });

  it("does not settle a lease when a handler ignores shutdown cancellation", async () => {
    const abort = new AbortController();
    let claimed = false;
    let started = (): void => {
      throw new Error("Handler start resolver is unavailable");
    };
    const handlerStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    let releaseExecution = (): void => {
      throw new Error("Execution resolver is unavailable");
    };
    const execution = new Promise<void>((resolve) => {
      releaseExecution = resolve;
    });
    const complete = vi.fn(async () => true);
    const fail = vi.fn(async () => true);
    const run = worker(
      repository({
        async claimBatch() {
          if (claimed) {
            return [];
          }
          claimed = true;
          return [record];
        },
        complete,
        fail,
      }),
      handler(async () => {
        started();
        await execution;
      }),
    ).run(abort.signal);

    await handlerStarted;
    abort.abort(new Error("worker shutdown"));
    releaseExecution();
    await run;

    expect(complete).not.toHaveBeenCalled();
    expect(fail).not.toHaveBeenCalled();
  });

  it("persists the declared retry time for a handler failure", async () => {
    const abort = new AbortController();
    const retryAt = new Date("2026-07-18T00:01:00.000Z");
    const failure = new WorkerJobError("sample-failed", retryAt);
    const jobLogger = logger();
    let claimed = false;
    const fail = vi.fn(async () => {
      abort.abort();
      return true;
    });
    await worker(
      repository({
        async claimBatch() {
          if (claimed) {
            return [];
          }
          claimed = true;
          return [record];
        },
        fail,
      }),
      handler(async () => {
        throw failure;
      }),
      { jobLogger },
    ).run(abort.signal);

    expect(fail).toHaveBeenCalledWith(
      expect.objectContaining({
        errorCode: "sample-failed",
        retryAt,
      }),
    );
    const failureLog = vi.mocked(jobLogger.warn).mock.calls.at(-1)?.[0];
    expect(failureLog?.error).toBe(failure);
    expect((failureLog?.error as Error).stack).toContain("sample-failed");
  });

  it("never claims more leases than it can begin concurrently", async () => {
    const abort = new AbortController();
    const claimBatch = vi.fn(async () => {
      abort.abort();
      return [];
    });
    await worker(
      repository({ claimBatch }),
      handler(async () => undefined),
      { claimBatchSize: 16, maximumConcurrentJobs: 4 },
    ).run(abort.signal);

    expect(claimBatch).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 4 }),
    );
  });
});
