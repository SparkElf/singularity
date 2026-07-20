import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  NetworkFailureError,
  ResponseContractError,
  requestJson,
} from "@/api/http.ts";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("HTTP client failure observability", () => {
  it("retries one transient browser network change", async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), {
        headers: { "Content-Type": "application/json" },
        status: 200,
      }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(requestJson(z.object({ ok: z.literal(true) }), "/health"))
      .resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("records the original network error with its complete stack", async () => {
    const failure = new Error("network-stack-sentinel");
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async () => {
      throw failure;
    }));

    await expect(requestJson(z.object({ ok: z.literal(true) }), "/health"))
      .rejects.toEqual(expect.objectContaining({
        cause: failure,
        name: "NetworkFailureError",
      } satisfies Partial<NetworkFailureError>));
    expect(failure.stack).toContain("network-stack-sentinel");
    expect(consoleError).toHaveBeenCalledWith(
      "[http.client]",
      { phase: "network" },
      failure,
    );
  });

  it("records the parser error when a successful response violates its schema", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async () =>
        new Response(JSON.stringify({ ok: false }), {
          headers: { "Content-Type": "application/json" },
          status: 200,
        }),
      ),
    );

    await expect(requestJson(z.object({ ok: z.literal(true) }), "/health"))
      .rejects.toBeInstanceOf(ResponseContractError);
    const recorded: unknown = consoleError.mock.calls[0]?.[2] as unknown;
    expect(recorded).toBeInstanceOf(Error);
    if (!(recorded instanceof Error)) {
      throw new Error("The response contract error was not recorded");
    }
    expect(recorded.stack).toContain("ZodError");
  });
});
