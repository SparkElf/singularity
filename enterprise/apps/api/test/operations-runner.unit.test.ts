import { PassThrough, Readable } from "node:stream";

import {
  type AccessOperation,
  type AccessOperationName,
  accessOperationResultSchemaByOperation,
} from "@singularity/contracts";
import { describe, expect, test, vi } from "vitest";

import {
  type AccessOperationExecutor,
  AccessOperationInputError,
  parseAccessOperationInput,
  runAccessOperation,
} from "../src/operations/runner.js";

function input(value: Buffer | string): Readable {
  return Readable.from([value]);
}

function outputText(stream: PassThrough): string {
  const chunk: unknown = stream.read();
  if (Buffer.isBuffer(chunk)) {
    return chunk.toString("utf8");
  }
  return typeof chunk === "string" ? chunk : "";
}

function serviceReturning(result: unknown): AccessOperationExecutor {
  return {
    execute: vi.fn(() => Promise.resolve(result)),
  };
}

async function runServiceResult(
  command: AccessOperation,
  result: unknown,
): Promise<{ exitCode: 0 | 1 | 2; stderr: string; stdout: string }> {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const exitCode = await runAccessOperation({
    service: serviceReturning(result),
    stderr,
    stdin: input(JSON.stringify(command)),
    stdout,
  });
  return {
    exitCode,
    stderr: outputText(stderr),
    stdout: outputText(stdout),
  };
}

function expectSanitizedFailure(
  run: Awaited<ReturnType<typeof runServiceResult>>,
  operation: AccessOperationName,
  leakedValues: readonly string[],
): void {
  const result =
    accessOperationResultSchemaByOperation[operation].parse(
      JSON.parse(run.stdout),
    );

  expect(run.exitCode).toBe(1);
  expect(result.outcome).toBe("failed");
  expect(Object.keys(result).sort()).toEqual(["operationId", "outcome"]);
  expect(run.stderr).toBe("access-operation failed\n");
  for (const leakedValue of leakedValues) {
    expect(`${run.stdout}${run.stderr}`).not.toContain(leakedValue);
  }
}

describe("controlled access operation runner", () => {
  test("parses one strict JSON command and normalizes its identifier", async () => {
    await expect(
      parseAccessOperationInput(
        input(
          JSON.stringify({
            operation: "initialize",
            loginIdentifier: "  ADMIN@Example.COM  ",
            password: "correct horse battery staple",
            organizationName: "Singularity",
            spaceName: "Research",
          }),
        ),
      ),
    ).resolves.toMatchObject({
      loginIdentifier: "admin@example.com",
      operation: "initialize",
    });
  });

  test.each([
    {
      name: "TTY input",
      stream: () => Object.assign(input("{}"), { isTTY: true }),
    },
    {
      name: "empty input",
      stream: () => input(""),
    },
    {
      name: "invalid UTF-8",
      stream: () => input(Buffer.from([0xc3, 0x28])),
    },
    {
      name: "more than one JSON value",
      stream: () => input("{} {}"),
    },
    {
      name: "unknown field",
      stream: () =>
        input(
          JSON.stringify({
            operation: "disable-user",
            userId: "ba577e2f-8821-47a2-a93a-4e87660f7b96",
            password: "secret-sentinel",
          }),
        ),
    },
    {
      name: "payload beyond 16 KiB",
      stream: () => input("x".repeat(16 * 1_024 + 1)),
    },
  ])("rejects $name", async ({ stream }) => {
    await expect(parseAccessOperationInput(stream())).rejects.toBeInstanceOf(
      AccessOperationInputError,
    );
  });

  test("writes exactly one success JSON line and no diagnostics", async () => {
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const operationId = "6621073e-688c-49c4-ac06-1a509a9a0327";
    const exitCode = await runAccessOperation({
      service: serviceReturning({ operationId, outcome: "updated" }),
      stderr,
      stdin: input(
        JSON.stringify({
          operation: "disable-space",
          spaceId: "d879b45a-2f94-4e32-8b55-cbb10aa2e902",
        }),
      ),
      stdout,
    });

    expect(exitCode).toBe(0);
    expect(outputText(stdout)).toBe(
      `${JSON.stringify({ operationId, outcome: "updated" })}\n`,
    );
    expect(outputText(stderr)).toBe("");
  });

  test("uses exit code two for a stable business rejection", async () => {
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const exitCode = await runAccessOperation({
      service: serviceReturning({
        operationId: "ac619d35-fd6c-43d2-915d-b2318da6e860",
        outcome: "not-found",
      }),
      stderr,
      stdin: input(
        JSON.stringify({
          operation: "disable-user",
          userId: "c9962884-8ead-4225-881c-0fd4f3e4485f",
        }),
      ),
      stdout,
    });

    expect(exitCode).toBe(2);
    expect(JSON.parse(outputText(stdout))).toMatchObject({ outcome: "not-found" });
    expect(outputText(stderr)).toBe("");
  });

  test("rejects an initialize success missing a required generated ID", async () => {
    const rawOperationId = "89d4e78c-ff2c-4b39-9767-b89cb03a13ac";
    const rawUserId = "b52e46aa-30d7-4f14-80f8-cb9213b1281e";
    const rawOrganizationId = "a1526336-6490-4afb-b698-539a138ce7c1";
    const passwordSentinel = "password-result-contract-sentinel";
    const run = await runServiceResult(
      {
        operation: "initialize",
        loginIdentifier: "owner@example.test",
        password: passwordSentinel,
        organizationName: "Singularity",
        spaceName: "Research",
      },
      {
        operationId: rawOperationId,
        outcome: "created",
        organizationId: rawOrganizationId,
        userId: rawUserId,
      },
    );

    expectSanitizedFailure(run, "initialize", [
      rawOperationId,
      rawUserId,
      rawOrganizationId,
      passwordSentinel,
    ]);
  });

  test("rejects a success outcome belonging to another operation", async () => {
    const rawOperationId = "a681e3ab-6f77-4ef8-9fb6-b834e77a3e0e";
    const run = await runServiceResult(
      {
        operation: "disable-space",
        spaceId: "12fc6f03-264a-43da-9dab-8e1dfa516c49",
      },
      { operationId: rawOperationId, outcome: "revoked" },
    );

    expectSanitizedFailure(run, "disable-space", [rawOperationId]);
  });

  test("rejects a business rejection not defined for the operation", async () => {
    const rawOperationId = "f7bfe989-cf0c-46fe-a0bf-26321a501478";
    const run = await runServiceResult(
      {
        operation: "disable-space",
        spaceId: "36b9160f-0fd9-4a1c-a60d-c2ec5b81ce8e",
      },
      { operationId: rawOperationId, outcome: "conflict" },
    );

    expectSanitizedFailure(run, "disable-space", [rawOperationId]);
  });

  test("sanitizes invalid input failures", async () => {
    const sentinel = "raw-password-and-database-sentinel";
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const execute = vi.fn(() => Promise.resolve({ outcome: "must-not-run" }));
    const service = { execute } satisfies AccessOperationExecutor;
    const exitCode = await runAccessOperation({
      service,
      stderr,
      stdin: input(sentinel),
      stdout,
    });
    const stdoutText = outputText(stdout);
    const stderrText = outputText(stderr);

    expect(exitCode).toBe(1);
    expect(JSON.parse(stdoutText)).toMatchObject({ outcome: "failed" });
    expect(stderrText).toBe("access-operation failed\n");
    expect(`${stdoutText}${stderrText}`).not.toContain(sentinel);
    expect(execute).not.toHaveBeenCalled();
  });

  test("sanitizes unexpected service exceptions", async () => {
    const sentinel = "raw-password-and-database-sentinel";
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const service = {
      execute: vi.fn(() => Promise.reject(new Error(sentinel))),
    } satisfies AccessOperationExecutor;
    const exitCode = await runAccessOperation({
      service,
      stderr,
      stdin: input(
        JSON.stringify({
          operation: "disable-user",
          userId: "29e0b920-5cf0-497c-a9b8-f26cc9c3414a",
        }),
      ),
      stdout,
    });
    const stdoutText = outputText(stdout);
    const stderrText = outputText(stderr);

    expect(exitCode).toBe(1);
    expect(JSON.parse(stdoutText)).toMatchObject({ outcome: "failed" });
    expect(stderrText).toBe("access-operation failed\n");
    expect(`${stdoutText}${stderrText}`).not.toContain(sentinel);
  });
});
