import type { DeclaredWorkerJobProducer } from "./job-declarations.js";
import { waitForDelay } from "./wait.js";
import type { WorkerJobLogger } from "./worker.js";

export interface WorkerJobSchedulerOptions {
  readonly logger: WorkerJobLogger;
  readonly now?: () => Date;
  readonly producers: readonly DeclaredWorkerJobProducer[];
}

export class WorkerJobScheduler {
  readonly #logger: WorkerJobLogger;
  readonly #now: () => Date;
  readonly #producers: readonly DeclaredWorkerJobProducer[];
  #running = false;

  constructor(options: WorkerJobSchedulerOptions) {
    if (options.producers.length === 0) {
      throw new TypeError("Worker producer declaration is unavailable");
    }
    for (const producer of options.producers) {
      if (
        !Number.isSafeInteger(producer.intervalMilliseconds) ||
        producer.intervalMilliseconds < 1_000 ||
        producer.intervalMilliseconds > 24 * 60 * 60_000
      ) {
        throw new TypeError("Worker producer schedule is unavailable");
      }
    }
    this.#logger = options.logger;
    this.#now = options.now ?? (() => new Date());
    this.#producers = options.producers;
  }

  async run(signal: AbortSignal): Promise<void> {
    if (this.#running) {
      throw new Error("Worker scheduler is already running");
    }
    this.#running = true;
    const nextRuns = new Map<DeclaredWorkerJobProducer, number>(
      this.#producers.map((producer) => [producer, 0]),
    );
    this.#logger.info({
      event: "worker.scheduler",
      outcome: "started",
    });
    try {
      while (!signal.aborted) {
        const now = this.#now();
        const due = this.#producers.filter(
          (producer) => (nextRuns.get(producer) ?? 0) <= now.getTime(),
        );
        if (due.length === 0) {
          const nextRun = Math.min(...nextRuns.values());
          await this.#wait(Math.max(1, nextRun - now.getTime()), signal);
          continue;
        }
        await Promise.all(
          due.map(async (producer) => {
            await this.#produce(producer, now);
            nextRuns.set(
              producer,
              this.#now().getTime() + producer.intervalMilliseconds,
            );
          }),
        );
      }
    } finally {
      this.#running = false;
      this.#logger.info({
        event: "worker.scheduler",
        outcome: "stopped",
      });
    }
  }

  async #produce(
    producer: DeclaredWorkerJobProducer,
    now: Date,
  ): Promise<void> {
    this.#logger.info({
      event: "worker.producer",
      kind: producer.kind,
      outcome: "started",
    });
    try {
      const producedJobs = await producer.produce(now);
      this.#logger.info({
        event: "worker.producer",
        kind: producer.kind,
        outcome: "completed",
        producedJobs,
      });
    } catch (error) {
      this.#logger.error({
        error,
        event: "worker.producer",
        kind: producer.kind,
        outcome: "failed",
      });
      throw error;
    }
  }

  async #wait(milliseconds: number, signal: AbortSignal): Promise<void> {
    try {
      await waitForDelay(milliseconds, signal);
    } catch (error) {
      if (!signal.aborted) {
        throw error;
      }
    }
  }
}
