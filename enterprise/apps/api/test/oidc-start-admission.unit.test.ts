import { randomUUID } from "node:crypto";

import { RateLimiterMemory } from "rate-limiter-flexible";
import { describe, expect, test } from "vitest";

import { LoginRateLimitError } from "../src/identity/login-rate-limiter.js";
import { OidcStartAdmission } from "../src/identity/oidc-start-admission.js";

function limiter(points: number): RateLimiterMemory {
  return new RateLimiterMemory({ duration: 60, points });
}

describe("OIDC start admission", () => {
  test("rejects a second concurrent discovery for the same provider", async () => {
    const admission = new OidcStartAdmission({
      globalConcurrency: 2,
      providerConcurrency: 1,
      providerLimiter: limiter(10),
      sourceLimiter: limiter(10),
    });
    const providerId = randomUUID();
    let release!: () => void;
    let markEntered!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const entered = new Promise<void>((resolve) => {
      markEntered = resolve;
    });
    const first = admission.run(
      {
        providerId,
        requestId: randomUUID(),
        sourceAddress: "203.0.113.10",
      },
      async () => {
        markEntered();
        await blocked;
        return "first";
      },
    );
    await entered;

    await expect(
      admission.run(
        {
          providerId,
          requestId: randomUUID(),
          sourceAddress: "203.0.113.11",
        },
        async () => "second",
      ),
    ).rejects.toBeInstanceOf(LoginRateLimitError);

    release();
    await expect(first).resolves.toBe("first");
    await expect(
      admission.run(
        {
          providerId,
          requestId: randomUUID(),
          sourceAddress: "203.0.113.12",
        },
        async () => "after-release",
      ),
    ).resolves.toBe("after-release");
  });

  test("rate-limits one source across providers", async () => {
    const admission = new OidcStartAdmission({
      providerLimiter: limiter(10),
      sourceLimiter: limiter(1),
    });
    const sourceAddress = "203.0.113.20";
    await expect(
      admission.run(
        {
          providerId: randomUUID(),
          requestId: randomUUID(),
          sourceAddress,
        },
        async () => "accepted",
      ),
    ).resolves.toBe("accepted");

    await expect(
      admission.run(
        {
          providerId: randomUUID(),
          requestId: randomUUID(),
          sourceAddress,
        },
        async () => "rejected",
      ),
    ).rejects.toMatchObject({ retryAfter: expect.any(Number) });
  });

  test("does not spend provider capacity after a source is already limited", async () => {
    const admission = new OidcStartAdmission({
      providerLimiter: limiter(2),
      sourceLimiter: limiter(1),
    });
    const providerId = randomUUID();
    const request = (sourceAddress: string) => ({
      providerId,
      requestId: randomUUID(),
      sourceAddress,
    });

    await expect(
      admission.run(request("203.0.113.30"), async () => "first"),
    ).resolves.toBe("first");
    await expect(
      admission.run(request("203.0.113.30"), async () => "limited"),
    ).rejects.toBeInstanceOf(LoginRateLimitError);
    await expect(
      admission.run(request("203.0.113.31"), async () => "second-source"),
    ).resolves.toBe("second-source");
  });
});
