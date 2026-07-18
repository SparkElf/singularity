import { PassThrough, Readable } from "node:stream";

import { Module } from "@nestjs/common";
import { accessOperationResultSchemaByOperation } from "@singularity/contracts";
import { afterEach, expect, test, vi } from "vitest";

import { CoreModule } from "../src/core.module.js";
import { runAccessOperationsApplication } from "../src/operations/application.js";
import { testAuditConfiguration } from "./support/audit-configuration.js";

@Module({})
class FailingOperationsModule {}

function streamText(stream: PassThrough): string {
  const chunk: unknown = stream.read();
  if (Buffer.isBuffer(chunk)) {
    return chunk.toString("utf8");
  }
  return typeof chunk === "string" ? chunk : "";
}

afterEach(() => {
  vi.restoreAllMocks();
});

test("bootstrap failures return one sanitized operation result without aborting", async () => {
  const bootstrapSentinel = "bootstrap-secret-sentinel";
  vi.spyOn(CoreModule, "register").mockReturnValue({
    module: FailingOperationsModule,
    providers: [
      {
        provide: "BOOTSTRAP_FAILURE",
        useFactory: () => {
          throw new Error(bootstrapSentinel);
        },
      },
    ],
  });
  const abort = vi.spyOn(process, "abort").mockImplementation(() => {
    throw new Error("process.abort must not be called");
  });
  const stdout = new PassThrough();
  const stderr = new PassThrough();

  const exitCode = await runAccessOperationsApplication({
    auditConfiguration: testAuditConfiguration(),
    databaseUrl: "postgresql://unused.invalid/singularity",
    stderr,
    stdin: Readable.from(["{}"]),
    stdout,
  });
  const stdoutText = streamText(stdout);
  const stderrText = streamText(stderr);
  const result = accessOperationResultSchemaByOperation["disable-space"].parse(
    JSON.parse(stdoutText),
  );

  expect(abort).not.toHaveBeenCalled();
  expect(exitCode).toBe(1);
  expect(result.outcome).toBe("failed");
  expect(Object.keys(result).sort()).toEqual(["operationId", "outcome"]);
  expect(stdoutText.endsWith("\n")).toBe(true);
  expect(stdoutText.trimEnd()).not.toContain("\n");
  expect(stderrText).toBe("access-operation failed\n");
  expect(`${stdoutText}${stderrText}`).not.toContain(bootstrapSentinel);
});
