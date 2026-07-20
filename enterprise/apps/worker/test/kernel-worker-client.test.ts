import { describe, expect, test } from "vitest";

import { parseKernelObservationResponse } from "../src/kernel-worker-client.js";

const SAMPLED_AT = "2026-07-19T10:00:00.000Z";

function observation(input: {
  capacityErrorCode?: string;
  healthErrorCode?: string;
}) {
  return {
    capacity: {
      assetBytes: "256",
      dataBytes: "1024",
      ...(input.capacityErrorCode === undefined
        ? {}
        : { errorCode: input.capacityErrorCode }),
      fileCount: "8",
      sampleDurationMilliseconds: 14,
      sampledAt: SAMPLED_AT,
    },
    health: {
      ...(input.healthErrorCode === undefined
        ? {}
        : { errorCode: input.healthErrorCode }),
      kernelVersion: "3.7.2",
      sampledAt: SAMPLED_AT,
      status: "ready",
    },
  };
}

describe("Kernel observation response parser", () => {
  test("accepts stable machine error codes at the authenticated process boundary", () => {
    expect(
      parseKernelObservationResponse(
        observation({
          capacityErrorCode: "capacity-scan-failed",
          healthErrorCode: "kernel-not-booted",
        }),
      ),
    ).toEqual(
      observation({
        capacityErrorCode: "capacity-scan-failed",
        healthErrorCode: "kernel-not-booted",
      }),
    );
  });

  test("rejects capacity and health values from different snapshots", () => {
    const mismatched = observation({});
    mismatched.health.sampledAt = "2026-07-19T10:00:01.000Z";

    expect(() => parseKernelObservationResponse(mismatched)).toThrowError(
      expect.objectContaining({ code: "kernel-response-invalid" }),
    );
  });

  test("rejects a future snapshot that could hide later observations", () => {
    const future = observation({});
    future.capacity.sampledAt = "2099-07-19T10:00:00.000Z";
    future.health.sampledAt = future.capacity.sampledAt;

    expect(() => parseKernelObservationResponse(future)).toThrowError(
      expect.objectContaining({ code: "kernel-response-invalid" }),
    );
  });

  test.each([
    {
      errorCode: "/srv/singularity/workspaces/private/data",
      label: "absolute path",
    },
    {
      errorCode: "capacity scan failed\n/private/path",
      label: "multiline detail",
    },
    { errorCode: "CAPACITY_SCAN_FAILED", label: "uppercase text" },
    { errorCode: "capacity_scan_failed", label: "underscored text" },
    { errorCode: `x${"a".repeat(64)}`, label: "oversized text" },
  ])("rejects $label without exposing it", ({ errorCode }) => {
    let thrown: unknown;
    try {
      parseKernelObservationResponse(
        observation({ capacityErrorCode: errorCode }),
      );
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({
      code: "kernel-response-invalid",
      message: "kernel-response-invalid",
      retryAt: null,
    });
    expect(String(thrown)).not.toContain(errorCode);
  });
});
