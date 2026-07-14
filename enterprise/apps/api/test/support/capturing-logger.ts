import { inspect } from "node:util";

import type { LoggerService } from "@nestjs/common";

export class CapturingLogger implements LoggerService {
  readonly #entries: string[] = [];

  get output(): string {
    return this.#entries.join("\n");
  }

  clear(): void {
    this.#entries.length = 0;
  }

  log(message: unknown, ...optionalParams: unknown[]): void {
    this.#capture(message, optionalParams);
  }

  error(message: unknown, ...optionalParams: unknown[]): void {
    this.#capture(message, optionalParams);
  }

  warn(message: unknown, ...optionalParams: unknown[]): void {
    this.#capture(message, optionalParams);
  }

  debug(message: unknown, ...optionalParams: unknown[]): void {
    this.#capture(message, optionalParams);
  }

  verbose(message: unknown, ...optionalParams: unknown[]): void {
    this.#capture(message, optionalParams);
  }

  fatal(message: unknown, ...optionalParams: unknown[]): void {
    this.#capture(message, optionalParams);
  }

  #capture(message: unknown, optionalParams: unknown[]): void {
    this.#entries.push(inspect([message, ...optionalParams], { depth: null }));
  }
}
