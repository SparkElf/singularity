import { describe, expect, test } from "vitest";

import { kernelErrorContext } from "../src/kernel/error-context.js";
import { CapturingLogger } from "./support/capturing-logger.js";

describe("Kernel error logging context", () => {
  test("preserves the original Error and its complete multi-frame stack", () => {
    const error = new Error("kernel-stack-sentinel");
    error.stack = [
      "Error: kernel-stack-sentinel",
      "    at firstKernelFrame (kernel-first.ts:10:20)",
      "    at secondKernelFrame (kernel-second.ts:30:40)",
    ].join("\n");
    const logger = new CapturingLogger();

    const context = kernelErrorContext(error, "Kernel callback failed");
    logger.error(context);

    expect(context.error).toBe(error);
    expect(context.errorStack).toBe(error.stack);
    expect(logger.output).toContain("firstKernelFrame (kernel-first.ts:10:20)");
    expect(logger.output).toContain("secondKernelFrame (kernel-second.ts:30:40)");
  });

  test("does not label a message fallback as a missing stack", () => {
    const error = new Error("stack-unavailable");
    delete error.stack;

    const context = kernelErrorContext(error, "Kernel callback failed");

    expect(context.error).toBe(error);
    expect(context).not.toHaveProperty("errorStack");
  });

  test("wraps a non-Error throw value once at the logging boundary", () => {
    const thrown = { reason: "non-error-sentinel" };

    const context = kernelErrorContext(thrown, "Kernel callback failed");

    expect(context.error).toBeInstanceOf(Error);
    expect(context.error.message).toBe("Kernel callback failed");
    expect(context.error.cause).toBe(thrown);
  });
});
