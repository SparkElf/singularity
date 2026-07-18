import { Injectable, Logger } from "@nestjs/common";

import type { WorkerJobLogger } from "./worker.js";

@Injectable()
export class NestWorkerJobLogger implements WorkerJobLogger {
  readonly #logger = new Logger("EnterpriseWorker");

  debug(context: Readonly<Record<string, unknown>>): void {
    this.#logger.debug(context);
  }

  error(context: Readonly<Record<string, unknown>>): void {
    this.#logger.error(context);
  }

  info(context: Readonly<Record<string, unknown>>): void {
    this.#logger.log(context);
  }

  warn(context: Readonly<Record<string, unknown>>): void {
    this.#logger.warn(context);
  }
}
