import { waitForDelay } from "./wait.js";

export const MAXIMUM_AUDIT_ARCHIVE_EVENTS = 10_000;

export interface WorkerJobBase {
  attempt: number;
  id: string;
  leaseExpiresAt: Date;
  organizationId: string;
  requestId: string;
}

export interface ArchiveAuditJob extends WorkerJobBase {
  fromSequence: string;
  kind: "archive-audit";
  throughSequence: string;
}

export interface BackupSpaceJob extends WorkerJobBase {
  backupId: string;
  kind: "backup-space";
  spaceId: string;
}

export interface RestoreSpaceJob extends WorkerJobBase {
  backupId: string;
  kind: "restore-space";
  restoreId: string;
  sourceSpaceId: string;
  targetKernelInstanceId: string;
  targetSpaceId: string;
}

export interface ReconcileContentAuditJob extends WorkerJobBase {
  kind: "reconcile-content-audit";
}

export interface SampleKernelJob extends WorkerJobBase {
  kernelInstanceId: string;
  kind: "sample-kernel";
  spaceId: string;
}

export interface GovernanceTaskJob extends WorkerJobBase {
  documentId: string;
  kind: "governance-task";
  notebookId: string;
  spaceId: string;
  taskId: string;
  taskKind: "verify" | "archive" | "retain" | "export_watermark";
}

export type ClaimedWorkerJob =
  | ArchiveAuditJob
  | BackupSpaceJob
  | ReconcileContentAuditJob
  | RestoreSpaceJob
  | SampleKernelJob
  | GovernanceTaskJob;

export const workerJobKinds = [
  "archive-audit",
  "backup-space",
  "reconcile-content-audit",
  "restore-space",
  "sample-kernel",
  "governance-task",
] as const satisfies readonly ClaimedWorkerJob["kind"][];

export type WorkerJobKind = (typeof workerJobKinds)[number];

export interface WorkerJobRecord extends WorkerJobBase {
  kind: WorkerJobKind;
  payload: Readonly<Record<string, unknown>>;
}

export interface WorkerJobRepository {
  claimBatch(input: {
    kinds: readonly WorkerJobKind[];
    leaseExpiresAt: Date;
    limit: number;
    now: Date;
    workerId: string;
  }): Promise<readonly WorkerJobRecord[]>;
  complete(input: {
    completedAt: Date;
    jobId: string;
    workerId: string;
  }): Promise<boolean>;
  fail(input: {
    errorCode: string;
    failedAt: Date;
    jobId: string;
    retryAt: Date | null;
    workerId: string;
  }): Promise<boolean>;
  renewLease(input: {
    jobId: string;
    leaseExpiresAt: Date;
    workerId: string;
  }): Promise<boolean>;
}

export interface WorkerJobHandler<Job extends ClaimedWorkerJob> {
  readonly kind: Job["kind"];
  decode(record: WorkerJobRecord): Job;
  execute(job: Job, signal: AbortSignal): Promise<void>;
}

export type DeclaredWorkerJobHandler = {
  [Kind in WorkerJobKind]: WorkerJobHandler<
    Extract<ClaimedWorkerJob, { kind: Kind }>
  >;
}[WorkerJobKind];

export interface WorkerJobLogger {
  debug(context: Readonly<Record<string, unknown>>): void;
  error(context: Readonly<Record<string, unknown>>): void;
  info(context: Readonly<Record<string, unknown>>): void;
  warn(context: Readonly<Record<string, unknown>>): void;
}

export interface WorkerOptions {
  claimBatchSize: number;
  handlers: Iterable<DeclaredWorkerJobHandler>;
  leaseDurationMilliseconds: number;
  leaseRenewalMilliseconds: number;
  logger: WorkerJobLogger;
  maximumConcurrentJobs: number;
  now?: () => Date;
  pollIntervalMilliseconds: number;
  repository: WorkerJobRepository;
  workerId: string;
}

export class WorkerJobError extends Error {
  constructor(
    readonly code: string,
    readonly retryAt: Date | null,
    options?: ErrorOptions,
  ) {
    super(code, options);
    this.name = "WorkerJobError";
  }
}

function requireIntegerInRange(
  value: number,
  minimum: number,
  maximum: number,
): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new TypeError("Worker configuration is unavailable");
  }
  return value;
}

export class BoundedJobWorker {
  readonly #claimBatchSize: number;
  readonly #handlers: ReadonlyMap<WorkerJobKind, DeclaredWorkerJobHandler>;
  readonly #jobKinds: readonly WorkerJobKind[];
  readonly #leaseDurationMilliseconds: number;
  readonly #leaseRenewalMilliseconds: number;
  readonly #logger: WorkerJobLogger;
  readonly #maximumConcurrentJobs: number;
  readonly #now: () => Date;
  readonly #pollIntervalMilliseconds: number;
  readonly #repository: WorkerJobRepository;
  readonly #workerId: string;
  #running = false;

  constructor(options: WorkerOptions) {
    const claimBatchSize = requireIntegerInRange(
      options.claimBatchSize,
      1,
      32,
    );
    this.#maximumConcurrentJobs = requireIntegerInRange(
      options.maximumConcurrentJobs,
      1,
      32,
    );
    this.#claimBatchSize = Math.min(
      claimBatchSize,
      this.#maximumConcurrentJobs,
    );
    this.#pollIntervalMilliseconds = requireIntegerInRange(
      options.pollIntervalMilliseconds,
      100,
      60_000,
    );
    this.#leaseDurationMilliseconds = requireIntegerInRange(
      options.leaseDurationMilliseconds,
      5_000,
      30 * 60_000,
    );
    this.#leaseRenewalMilliseconds = requireIntegerInRange(
      options.leaseRenewalMilliseconds,
      1_000,
      Math.floor(this.#leaseDurationMilliseconds / 2),
    );
    if (options.workerId.trim().length === 0) {
      throw new TypeError("Worker configuration is unavailable");
    }
    const handlers = new Map<WorkerJobKind, DeclaredWorkerJobHandler>();
    for (const handler of options.handlers) {
      if (handlers.has(handler.kind)) {
        throw new TypeError("Worker handler declaration is duplicated");
      }
      handlers.set(handler.kind, handler);
    }
    if (handlers.size === 0) {
      throw new TypeError("Worker handler declaration is unavailable");
    }
    this.#handlers = handlers;
    this.#jobKinds = Object.freeze([...handlers.keys()]);
    this.#logger = options.logger;
    this.#now = options.now ?? (() => new Date());
    this.#repository = options.repository;
    this.#workerId = options.workerId;
  }

  async run(signal: AbortSignal): Promise<void> {
    if (this.#running) {
      throw new Error("Worker is already running");
    }
    this.#running = true;
    this.#logger.info({
      event: "worker.lifecycle",
      outcome: "started",
      workerId: this.#workerId,
    });
    try {
      while (!signal.aborted) {
        const now = this.#now();
        const jobs = await this.#repository.claimBatch({
          kinds: this.#jobKinds,
          leaseExpiresAt: new Date(
            now.getTime() + this.#leaseDurationMilliseconds,
          ),
          limit: this.#claimBatchSize,
          now,
          workerId: this.#workerId,
        });
        if (jobs.length === 0) {
          await this.#waitForNextPoll(signal);
          continue;
        }
        await this.#processBatch(jobs, signal);
      }
    } finally {
      this.#running = false;
      this.#logger.info({
        event: "worker.lifecycle",
        outcome: "stopped",
        workerId: this.#workerId,
      });
    }
  }

  async #processBatch(
    jobs: readonly WorkerJobRecord[],
    signal: AbortSignal,
  ): Promise<void> {
    for (
      let offset = 0;
      offset < jobs.length;
      offset += this.#maximumConcurrentJobs
    ) {
      await Promise.all(
        jobs
          .slice(offset, offset + this.#maximumConcurrentJobs)
          .map((job) => this.#processJob(job, signal)),
      );
    }
  }

  async #processJob(
    record: WorkerJobRecord,
    runSignal: AbortSignal,
  ): Promise<void> {
    const handlerAbort = new AbortController();
    const renewalAbort = new AbortController();
    const forwardRunAbort = (): void => {
      handlerAbort.abort(runSignal.reason);
    };
    if (runSignal.aborted) {
      forwardRunAbort();
    } else {
      runSignal.addEventListener("abort", forwardRunAbort, { once: true });
    }
    const leaseOutcome = this.#maintainLease(
      record,
      handlerAbort,
      renewalAbort.signal,
    ).then(
      (held) => ({ held } as const),
      (error: unknown) => ({ error, renewalFailed: true } as const),
    );
    this.#logger.info({
      attempt: record.attempt,
      event: "worker.job",
      jobId: record.id,
      kind: record.kind,
      organizationId: record.organizationId,
      outcome: "started",
      requestId: record.requestId,
      workerId: this.#workerId,
    });

    let failure: unknown;
    let job: ClaimedWorkerJob | undefined;
    try {
      handlerAbort.signal.throwIfAborted();
      const handler = this.#handlers.get(record.kind)!;
      job = handler.decode(record);
      await this.#execute(handler, job, handlerAbort.signal);
    } catch (error) {
      failure = error;
    } finally {
      renewalAbort.abort();
      runSignal.removeEventListener("abort", forwardRunAbort);
    }

    const lease = await leaseOutcome;
    if ("renewalFailed" in lease) {
      this.#logger.error({
        error: lease.error,
        event: "worker.lease",
        jobId: record.id,
        kind: record.kind,
        outcome: "renewal-failed",
        workerId: this.#workerId,
      });
      return;
    }
    if (!lease.held) {
      this.#logger.warn({
        event: "worker.lease",
        jobId: record.id,
        kind: record.kind,
        outcome: "lost",
        workerId: this.#workerId,
      });
      return;
    }

    if (runSignal.aborted) {
      this.#logger.warn({
        event: "worker.job",
        jobId: record.id,
        kind: record.kind,
        outcome: "interrupted",
        workerId: this.#workerId,
      });
      return;
    }

    if (failure === undefined && job !== undefined) {
      const completed = await this.#repository.complete({
        completedAt: this.#now(),
        jobId: record.id,
        workerId: this.#workerId,
      });
      this.#logger.info({
        event: "worker.job",
        jobId: record.id,
        kind: record.kind,
        outcome: completed ? "completed" : "completion-lease-lost",
        workerId: this.#workerId,
      });
      return;
    }

    const errorCode =
      failure instanceof WorkerJobError
        ? failure.code
        : "unhandled-worker-error";
    const retryAt =
      failure instanceof WorkerJobError ? failure.retryAt : null;
    const failed = await this.#repository.fail({
      errorCode,
      failedAt: this.#now(),
      jobId: record.id,
      retryAt,
      workerId: this.#workerId,
    });
    this.#logger.warn({
      error: failure,
      errorCode,
      event: "worker.job",
      jobId: record.id,
      kind: record.kind,
      outcome: failed ? "failed" : "failure-lease-lost",
      retryAt: retryAt?.toISOString() ?? null,
      workerId: this.#workerId,
    });
  }

  async #execute(
    handler: DeclaredWorkerJobHandler,
    job: ClaimedWorkerJob,
    signal: AbortSignal,
  ): Promise<void> {
    const execute = handler.execute.bind(handler) as (
      job: ClaimedWorkerJob,
      signal: AbortSignal,
    ) => Promise<void>;
    await execute(job, signal);
  }

  async #maintainLease(
    job: WorkerJobRecord,
    handlerAbort: AbortController,
    signal: AbortSignal,
  ): Promise<boolean> {
    while (!signal.aborted) {
      try {
        await waitForDelay(this.#leaseRenewalMilliseconds, signal);
      } catch (error) {
        if (signal.aborted) {
          return true;
        }
        handlerAbort.abort(error);
        throw error;
      }
      if (signal.aborted) {
        return true;
      }
      const now = this.#now();
      let renewed: boolean;
      try {
        renewed = await this.#repository.renewLease({
          jobId: job.id,
          leaseExpiresAt: new Date(
            now.getTime() + this.#leaseDurationMilliseconds,
          ),
          workerId: this.#workerId,
        });
      } catch (error) {
        handlerAbort.abort(error);
        throw error;
      }
      if (!renewed) {
        handlerAbort.abort(new WorkerJobError("lease-lost", null));
        return false;
      }
      this.#logger.debug({
        event: "worker.lease",
        jobId: job.id,
        kind: job.kind,
        outcome: "renewed",
        workerId: this.#workerId,
      });
    }
    return true;
  }

  async #waitForNextPoll(signal: AbortSignal): Promise<void> {
    try {
      await waitForDelay(this.#pollIntervalMilliseconds, signal);
    } catch (error) {
      if (!signal.aborted) {
        throw error;
      }
    }
  }
}
