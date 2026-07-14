import { createHash } from "node:crypto";

import { Logger } from "@nestjs/common";
import { RateLimiterMemory, type RateLimiterRes } from "rate-limiter-flexible";

const LIMIT_DURATION_SECONDS = 15 * 60;
const ACCOUNT_KEY_DOMAIN = "singularity.login-identifier.v1";

export class LoginRateLimitError extends Error {
  constructor(readonly retryAfter: number) {
    super("Login rate limit exceeded");
    this.name = "LoginRateLimitError";
  }
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

export class LoginRateLimiter {
  readonly #logger = new Logger("LoginRateLimiter");
  readonly #source: RateLimiterMemory;
  readonly #account: RateLimiterMemory;

  constructor(
    source = new RateLimiterMemory({
      duration: LIMIT_DURATION_SECONDS,
      keyPrefix: "login-source",
      points: 30,
    }),
    account = new RateLimiterMemory({
      duration: LIMIT_DURATION_SECONDS,
      keyPrefix: "login-account",
      points: 10,
    }),
  ) {
    this.#source = source;
    this.#account = account;
  }

  async consume(
    sourceAddress: string,
    normalizedLoginIdentifier: string,
    requestId: string,
  ): Promise<void> {
    const accountKey = createHash("sha256")
      .update(ACCOUNT_KEY_DOMAIN, "utf8")
      .update(Buffer.from([0]))
      .update(normalizedLoginIdentifier, "utf8")
      .digest("hex");
    const results = await Promise.allSettled([
      this.#source.consume(sourceAddress),
      this.#account.consume(accountKey),
    ]);
    let retryAfter = 0;
    for (const result of results) {
      if (result.status === "fulfilled") {
        continue;
      }
      const rejectedForLimit = retryAfterFromReason(result.reason);
      if (rejectedForLimit === undefined) {
        throw result.reason;
      }
      retryAfter = Math.max(retryAfter, rejectedForLimit);
    }

    if (retryAfter > 0) {
      const limitedKeys = results.flatMap((result, index) =>
        result.status === "rejected"
          ? [index === 0 ? "source" : "account"]
          : [],
      );
      this.#logger.warn({
        event: "auth.rate-limit",
        keyTypes: limitedKeys,
        outcome: "rejected",
        requestId,
        retryAfter,
      });
      throw new LoginRateLimitError(retryAfter);
    }
  }
}
