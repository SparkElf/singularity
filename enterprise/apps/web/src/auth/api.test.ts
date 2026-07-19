import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { NetworkFailureError } from "@/api/http.ts";
import { getOrFetchCsrfToken } from "@/auth/api.ts";
import { useCsrfStore } from "@/auth/csrf-store.ts";

const FIRST_CSRF_TOKEN = "A".repeat(43);
const SECOND_CSRF_TOKEN = "B".repeat(43);

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

    await expect(first).rejects.toBeInstanceOf(NetworkFailureError);
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

    await expect(staleRequest).rejects.toBeInstanceOf(NetworkFailureError);
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
          const rejectAbort = () => reject(signal?.reason);
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

    await expect(abandoned).rejects.toBeInstanceOf(NetworkFailureError);
    await expect(replacement).resolves.toBe(SECOND_CSRF_TOKEN);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
