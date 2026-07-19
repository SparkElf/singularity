import { createHash } from "node:crypto";

import { Injectable, Logger } from "@nestjs/common";
import { RateLimiterMemory, type RateLimiterRes } from "rate-limiter-flexible";

import { ApiProblemError } from "../problem.js";

const LIMIT_DURATION_SECONDS = 15 * 60;

export function shareSourceDigest(sourceAddress: string): string {
  return createHash("sha256")
    .update("singularity.share-source.v1", "utf8")
    .update(Buffer.from([0]))
    .update(sourceAddress, "utf8")
    .digest("hex");
}

function retryAfter(reason: unknown): number | null {
  if (
    typeof reason !== "object" ||
    reason === null ||
    !("msBeforeNext" in reason) ||
    typeof (reason as RateLimiterRes).msBeforeNext !== "number"
  ) {
    return null;
  }
  return Math.max(1, Math.ceil((reason as RateLimiterRes).msBeforeNext / 1_000));
}

@Injectable()
export class SharePasswordRateLimiter {
  readonly #logger = new Logger("SharePasswordRateLimiter");
  readonly #share = new RateLimiterMemory({
    duration: LIMIT_DURATION_SECONDS,
    keyPrefix: "share-password-share",
    points: 8,
  });
  readonly #source = new RateLimiterMemory({
    duration: LIMIT_DURATION_SECONDS,
    keyPrefix: "share-password-source",
    points: 30,
  });

  async consume(
    sourceAddress: string,
    shareId: string,
    requestId: string,
  ): Promise<void> {
    const sourceDigest = shareSourceDigest(sourceAddress);
    const shareKey = createHash("sha256")
      .update("singularity.share-rate-limit.v1", "utf8")
      .update(Buffer.from([0]))
      .update(shareId, "utf8")
      .digest("hex");
    const results = await Promise.allSettled([
      this.#source.consume(sourceDigest),
      this.#share.consume(shareKey),
    ]);
    let maximumRetryAfter = 0;
    for (const result of results) {
      if (result.status === "fulfilled") {
        continue;
      }
      const limitedFor = retryAfter(result.reason);
      if (limitedFor === null) {
        throw result.reason;
      }
      maximumRetryAfter = Math.max(maximumRetryAfter, limitedFor);
    }
    if (maximumRetryAfter > 0) {
      this.#logger.warn({
        event: "share.access",
        outcome: "password-rate-limited",
        requestId,
        shareId,
        sourceDigest,
      });
      throw new ApiProblemError("rate-limited", 429, maximumRetryAfter);
    }
  }
}
