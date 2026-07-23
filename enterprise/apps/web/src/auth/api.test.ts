import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ApiProblemError } from "@/api/http.ts";
import { getOrFetchCsrfToken, login, verifyMfaChallenge } from "@/auth/api.ts";
import { useCsrfStore } from "@/auth/csrf-store.ts";

const FIRST_CSRF_TOKEN = "A".repeat(42) + "E";
const SECOND_CSRF_TOKEN = "B".repeat(42) + "I";

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: Deferred<T>["resolve"];
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}

function csrfResponse(csrfToken: string): Response {
  return new Response(JSON.stringify({ csrfToken }), {
    headers: { "Content-Type": "application/json" },
    status: 200,
  });
}

function unauthenticatedResponse(): Response {
  return new Response(
    JSON.stringify({
      code: "unauthenticated",
      requestId: "99999999-9999-4999-8999-999999999999",
      status: 401,
    }),
    {
      headers: { "Content-Type": "application/json" },
      status: 401,
    },
  );
}

beforeEach(() => {
  useCsrfStore.getState().clearCsrfToken();
});

afterEach(() => {
  useCsrfStore.getState().clearCsrfToken();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("getOrFetchCsrfToken", () => {
  it("shares the first request without coupling caller cancellation", async () => {
    const response = deferred<Response>();
    const fetchMock = vi.fn<typeof fetch>(() => response.promise);
    vi.stubGlobal("fetch", fetchMock);
    const firstController = new AbortController();
    const secondController = new AbortController();

    const first = getOrFetchCsrfToken(firstController.signal);
    const second = getOrFetchCsrfToken(secondController.signal);
    firstController.abort();

    await expect(first).rejects.toMatchObject({ name: "AbortError" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[1]?.signal?.aborted).toBe(false);

    response.resolve(csrfResponse(FIRST_CSRF_TOKEN));

    await expect(second).resolves.toBe(FIRST_CSRF_TOKEN);
    expect(useCsrfStore.getState().csrfToken).toBe(FIRST_CSRF_TOKEN);
  });

  it("returns the cached token without issuing a request", async () => {
    useCsrfStore.getState().setCsrfToken(FIRST_CSRF_TOKEN);
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);

    await expect(getOrFetchCsrfToken()).resolves.toBe(FIRST_CSRF_TOKEN);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a response from the cleared session and fetches the new token", async () => {
    const staleResponse = deferred<Response>();
    const fetchMock = vi.fn<typeof fetch>()
      .mockImplementationOnce(() => staleResponse.promise)
      .mockResolvedValueOnce(csrfResponse(SECOND_CSRF_TOKEN));
    vi.stubGlobal("fetch", fetchMock);

    const staleRequest = getOrFetchCsrfToken();
    useCsrfStore.getState().clearCsrfToken();
    staleResponse.resolve(csrfResponse(FIRST_CSRF_TOKEN));

    await expect(staleRequest).rejects.toMatchObject({ name: "AbortError" });
    expect(useCsrfStore.getState().csrfToken).toBeNull();
    await expect(getOrFetchCsrfToken()).resolves.toBe(SECOND_CSRF_TOKEN);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(useCsrfStore.getState().csrfToken).toBe(SECOND_CSRF_TOKEN);
  });

  it("does not reuse a shared request after its last caller cancels", async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockImplementationOnce((_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          const rejectAbort = () => {
            const reason: unknown = signal?.reason;
            reject(
              reason instanceof Error
                ? reason
                : new Error(String(reason), { cause: reason }),
            );
          };
          signal?.addEventListener("abort", rejectAbort, { once: true });
          if (signal?.aborted) {
            rejectAbort();
          }
        }))
      .mockResolvedValueOnce(csrfResponse(SECOND_CSRF_TOKEN));
    vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController();

    const abandoned = getOrFetchCsrfToken(controller.signal);
    controller.abort();
    const replacement = getOrFetchCsrfToken();

    await expect(abandoned).rejects.toMatchObject({ name: "AbortError" });
    await expect(replacement).resolves.toBe(SECOND_CSRF_TOKEN);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("rejects an old session 401 without clearing the newly authenticated token", async () => {
    const staleResponse = deferred<Response>();
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(() => staleResponse.promise));

    const staleRequest = getOrFetchCsrfToken();
    useCsrfStore.getState().setCsrfToken(SECOND_CSRF_TOKEN);
    staleResponse.resolve(unauthenticatedResponse());

    await expect(staleRequest).rejects.toMatchObject({
      cause: expect.any(ApiProblemError) as unknown,
      name: "AbortError",
    });
    expect(useCsrfStore.getState().csrfToken).toBe(SECOND_CSRF_TOKEN);
  });

  it("honors an already aborted caller when the token is cached", async () => {
    useCsrfStore.getState().setCsrfToken(FIRST_CSRF_TOKEN);
    const controller = new AbortController();
    controller.abort();

    await expect(getOrFetchCsrfToken(controller.signal)).rejects.toMatchObject({
      name: "AbortError",
    });
  });
});

describe("MFA login contract", () => {
  it("keeps a password login challenge distinct from an authenticated CSRF response", async () => {
    const challengeToken = "challenge_" + "A".repeat(32);
    const csrfToken = "C".repeat(42) + "M";
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ challengeToken, expiresAt: "2026-07-23T10:00:00.000Z" }), { status: 202, headers: { "Content-Type": "application/json" } }))
      .mockResolvedValueOnce(csrfResponse(csrfToken));
    vi.stubGlobal("fetch", fetchMock);

    await expect(login({ loginIdentifier: "user@example.com", password: "a".repeat(12) })).resolves.toMatchObject({ challengeToken });
    await expect(verifyMfaChallenge({ challengeToken, code: "123456" })).resolves.toEqual({ csrfToken });
    expect(new URL(String(fetchMock.mock.calls[1]?.[0]), window.location.origin).pathname).toBe("/api/v1/auth/mfa/challenge/verify");
  });
});
