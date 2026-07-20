import { Logger } from "@nestjs/common";
import { RateLimiterMemory, type RateLimiterRes } from "rate-limiter-flexible";

import { LoginRateLimitError } from "./login-rate-limiter.js";

const OIDC_START_LIMIT_DURATION_SECONDS = 15 * 60;
const DEFAULT_GLOBAL_CONCURRENCY = 16;
const DEFAULT_PROVIDER_CONCURRENCY = 4;

export interface OidcStartAdmissionOptions {
  readonly globalConcurrency?: number;
  readonly providerConcurrency?: number;
  readonly providerLimiter?: RateLimiterMemory;
  readonly sourceLimiter?: RateLimiterMemory;
}

function retryAfterFromReason(reason: unknown): number | undefined {
  if (
    typeof reason !== "object" ||
    reason === null ||
    !("msBeforeNext" in reason) ||
    typeof (reason as RateLimiterRes).msBeforeNext !== "number"
  ) {
    return undefined;
  }
  return Math.max(1, Math.ceil((reason as RateLimiterRes).msBeforeNext / 1_000));
}

export class OidcStartAdmission {
  readonly #logger = new Logger("OidcStartAdmission");
  readonly #globalConcurrency: number;
  readonly #providerConcurrency: number;
  readonly #providerLimiter: RateLimiterMemory;
  readonly #sourceLimiter: RateLimiterMemory;
  readonly #activeByProvider = new Map<string, number>();
  #active = 0;

  constructor(options: OidcStartAdmissionOptions = {}) {
    this.#globalConcurrency =
      options.globalConcurrency ?? DEFAULT_GLOBAL_CONCURRENCY;
    this.#providerConcurrency =
      options.providerConcurrency ?? DEFAULT_PROVIDER_CONCURRENCY;
    if (
      !Number.isSafeInteger(this.#globalConcurrency) ||
      this.#globalConcurrency <= 0 ||
      !Number.isSafeInteger(this.#providerConcurrency) ||
      this.#providerConcurrency <= 0
    ) {
      throw new Error("OIDC start concurrency limits are invalid");
    }
    this.#providerLimiter =
      options.providerLimiter ??
      new RateLimiterMemory({
        duration: OIDC_START_LIMIT_DURATION_SECONDS,
        keyPrefix: "oidc-start-provider",
        points: 300,
      });
    this.#sourceLimiter =
      options.sourceLimiter ??
      new RateLimiterMemory({
        duration: OIDC_START_LIMIT_DURATION_SECONDS,
        keyPrefix: "oidc-start-source",
        points: 30,
      });
  }

  async run<T>(
    input: {
      readonly providerId: string;
      readonly requestId: string;
      readonly sourceAddress: string;
    },
    operation: () => Promise<T>,
  ): Promise<T> {
    await this.#consumeRateLimits(input);
    const providerActive = this.#activeByProvider.get(input.providerId) ?? 0;
    if (
      this.#active >= this.#globalConcurrency ||
      providerActive >= this.#providerConcurrency
    ) {
      this.#logger.warn({
        event: "auth.oidc-start",
        keyTypes: ["concurrency"],
        outcome: "rejected",
        requestId: input.requestId,
        retryAfter: 1,
      });
      throw new LoginRateLimitError(1);
    }

    this.#active += 1;
    this.#activeByProvider.set(input.providerId, providerActive + 1);
    try {
      return await operation();
    } finally {
      this.#active -= 1;
      const remaining = (this.#activeByProvider.get(input.providerId) ?? 1) - 1;
      if (remaining === 0) {
        this.#activeByProvider.delete(input.providerId);
      } else {
        this.#activeByProvider.set(input.providerId, remaining);
      }
    }
  }

  async #consumeRateLimits(input: {
    readonly providerId: string;
    readonly requestId: string;
    readonly sourceAddress: string;
  }): Promise<void> {
    await this.#consumeRateLimit(
      this.#sourceLimiter,
      input.sourceAddress,
      "source",
      input.requestId,
    );
    await this.#consumeRateLimit(
      this.#providerLimiter,
      input.providerId,
      "provider",
      input.requestId,
    );
  }

  async #consumeRateLimit(
    limiter: RateLimiterMemory,
    key: string,
    keyType: "provider" | "source",
    requestId: string,
  ): Promise<void> {
    try {
      await limiter.consume(key);
    } catch (reason) {
      const retryAfter = retryAfterFromReason(reason);
      if (retryAfter === undefined) {
        throw reason;
      }
      this.#logger.warn({
        event: "auth.oidc-start",
        keyTypes: [keyType],
        outcome: "rejected",
        requestId,
        retryAfter,
      });
      throw new LoginRateLimitError(retryAfter);
    }
  }
}
