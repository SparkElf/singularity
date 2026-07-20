import type { OnApplicationShutdown, OnModuleInit } from "@nestjs/common";
import { Inject, Injectable } from "@nestjs/common";
import { DatabaseRuntime } from "@singularity/database";

import type { WorkerConfiguration } from "./configuration.js";
import { WorkerDeclarationDiscovery } from "./declaration-discovery.js";
import { NestWorkerJobLogger } from "./logger.js";
import { PostgresWorkerJobRepository } from "./postgres-job-repository.js";
import { WorkerJobScheduler } from "./scheduler.js";
import { WORKER_CONFIGURATION } from "./tokens.js";
import { BoundedJobWorker } from "./worker.js";

@Injectable()
export class WorkerApplication
  implements OnApplicationShutdown, OnModuleInit
{
  #activeAbort: AbortController | undefined;
  #scheduler: WorkerJobScheduler | undefined;
  #worker: BoundedJobWorker | undefined;

  constructor(
    @Inject(WORKER_CONFIGURATION)
    private readonly configuration: WorkerConfiguration,
    private readonly database: DatabaseRuntime,
    private readonly declarations: WorkerDeclarationDiscovery,
    private readonly logger: NestWorkerJobLogger,
    private readonly repository: PostgresWorkerJobRepository,
  ) {}

  onModuleInit(): void {
    void this.database.client;
    const handlers = this.declarations.handlers();
    const producers = this.declarations.producers();
    this.#worker = new BoundedJobWorker({
      claimBatchSize: this.configuration.claimBatchSize,
      handlers,
      leaseDurationMilliseconds: this.configuration.leaseDurationMilliseconds,
      leaseRenewalMilliseconds:
        this.configuration.leaseRenewalMilliseconds,
      logger: this.logger,
      maximumConcurrentJobs: this.configuration.maximumConcurrentJobs,
      pollIntervalMilliseconds: this.configuration.pollIntervalMilliseconds,
      repository: this.repository,
      workerId: this.configuration.workerId,
    });
    this.#scheduler = new WorkerJobScheduler({
      logger: this.logger,
      producers,
    });
  }

  onApplicationShutdown(): void {
    this.#activeAbort?.abort();
  }

  async run(signal: AbortSignal): Promise<void> {
    if (this.#worker === undefined || this.#scheduler === undefined) {
      throw new Error("Worker application is not initialized");
    }
    if (this.#activeAbort !== undefined) {
      throw new Error("Worker application is already running");
    }
    const abort = new AbortController();
    this.#activeAbort = abort;
    const forwardAbort = (): void => abort.abort(signal.reason);
    if (signal.aborted) {
      forwardAbort();
    } else {
      signal.addEventListener("abort", forwardAbort, { once: true });
    }
    const executions = [
      this.#worker.run(abort.signal),
      this.#scheduler.run(abort.signal),
    ];
    try {
      await Promise.all(executions);
    } catch (error) {
      this.logger.error({
        error,
        event: "worker.lifecycle",
        outcome: "failed",
        workerId: this.configuration.workerId,
      });
      abort.abort(error);
      await Promise.allSettled(executions);
      throw error;
    } finally {
      signal.removeEventListener("abort", forwardAbort);
      this.#activeAbort = undefined;
    }
  }

}
