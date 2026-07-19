import { readFile } from "node:fs/promises";

import {
  parseP5E2EStackState,
  type P5E2EStackState,
} from "./support/stack-state.ts";

const waitTimeoutMilliseconds = 180_000;
const pollIntervalMilliseconds = 250;

function statePath(): string {
  const value = process.env.SINGULARITY_E2E_STATE_FILE;
  if (value === undefined || value.length === 0) {
    throw new Error("SINGULARITY_E2E_STATE_FILE is not configured");
  }
  return value;
}

async function readState(path: string): Promise<P5E2EStackState | null> {
  try {
    return parseP5E2EStackState(JSON.parse(await readFile(path, "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function waitForStackState(): Promise<P5E2EStackState> {
  const path = statePath();
  const deadline = Date.now() + waitTimeoutMilliseconds;
  while (Date.now() < deadline) {
    const state = await readState(path);
    if (state !== null) {
      return state;
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMilliseconds));
  }
  throw new Error("P5 E2E stack did not publish its state before timeout");
}

export default async function globalSetup(): Promise<void> {
  const state = await waitForStackState();
  if (state.schema !== "singularity_p5_e2e") {
    throw new Error("P5 E2E stack did not use the dedicated PostgreSQL schema");
  }
}
