import { randomUUID } from "node:crypto";
import { once } from "node:events";
import type { Readable, Writable } from "node:stream";

import {
  ACCESS_OPERATION_INPUT_MAX_BYTES,
  type AccessOperation,
  accessOperationExitCodeByOutcome,
  accessOperationResultSchemaByOperation,
  accessOperationSchema,
} from "@singularity/contracts";

export class AccessOperationInputError extends Error {
  constructor() {
    super("Access operation input is invalid");
    this.name = "AccessOperationInputError";
  }
}

export interface AccessOperationInput extends Readable {
  isTTY?: boolean;
}

export interface AccessOperationExecutor {
  execute(command: AccessOperation): Promise<unknown>;
}

function chunkBytes(chunk: unknown): Buffer {
  if (Buffer.isBuffer(chunk)) {
    return chunk;
  }
  if (chunk instanceof Uint8Array) {
    return Buffer.from(chunk);
  }
  if (typeof chunk === "string") {
    return Buffer.from(chunk, "utf8");
  }
  throw new AccessOperationInputError();
}

export async function parseAccessOperationInput(
  input: AccessOperationInput,
): Promise<AccessOperation> {
  if (input.isTTY === true) {
    throw new AccessOperationInputError();
  }

  const chunks: Buffer[] = [];
  let byteLength = 0;
  for await (const chunk of input) {
    const bytes = chunkBytes(chunk);
    byteLength += bytes.length;
    if (byteLength > ACCESS_OPERATION_INPUT_MAX_BYTES) {
      throw new AccessOperationInputError();
    }
    chunks.push(bytes);
  }
  if (byteLength === 0) {
    throw new AccessOperationInputError();
  }

  const payload = Buffer.concat(chunks, byteLength);
  chunks.length = 0;
  let value: unknown;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(payload);
    value = JSON.parse(text) as unknown;
  } catch {
    throw new AccessOperationInputError();
  } finally {
    payload.fill(0);
  }
  const parsed = accessOperationSchema.safeParse(value);
  if (!parsed.success) {
    throw new AccessOperationInputError();
  }
  return parsed.data;
}

async function writeLine(output: Writable, value: string): Promise<void> {
  if (!output.write(`${value}\n`, "utf8")) {
    await once(output, "drain");
  }
}

export async function writeFailedAccessOperation(
  stdout: Writable,
  stderr: Writable,
): Promise<1> {
  const result = {
    operationId: randomUUID(),
    outcome: "failed",
  } as const;
  await writeLine(stdout, JSON.stringify(result));
  await writeLine(stderr, "access-operation failed");
  return accessOperationExitCodeByOutcome.failed;
}

export async function runAccessOperation(input: {
  service: AccessOperationExecutor;
  stderr: Writable;
  stdin: AccessOperationInput;
  stdout: Writable;
}): Promise<0 | 1 | 2> {
  try {
    const command = await parseAccessOperationInput(input.stdin);
    const rawResult = await input.service.execute(command);
    const result = accessOperationResultSchemaByOperation[
      command.operation
    ].safeParse(rawResult);
    if (!result.success) {
      throw new Error("Invalid access operation service result");
    }
    await writeLine(input.stdout, JSON.stringify(result.data));
    return accessOperationExitCodeByOutcome[result.data.outcome];
  } catch {
    return writeFailedAccessOperation(input.stdout, input.stderr);
  }
}
