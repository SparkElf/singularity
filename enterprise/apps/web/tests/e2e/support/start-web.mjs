import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const stateFile = process.env.SINGULARITY_E2E_STATE_FILE;
const waitTimeoutMilliseconds = 300_000;

if (stateFile === undefined || stateFile.length === 0) {
  throw new Error("SINGULARITY_E2E_STATE_FILE is not configured");
}

async function readState() {
  try {
    return JSON.parse(await readFile(stateFile, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function waitForState() {
  const deadline = Date.now() + waitTimeoutMilliseconds;
  while (Date.now() < deadline) {
    const state = await readState();
    if (
      state !== null &&
      state.stateVersion === 1 &&
      typeof state.apiOrigin === "string" &&
      typeof state.certificateFile === "string" &&
      typeof state.privateKeyFile === "string" &&
      typeof state.webPort === "number"
    ) {
      return state;
    }
    await new Promise((resolvePoll) => setTimeout(resolvePoll, 250));
  }
  throw new Error("P5 E2E stack state was not published before timeout");
}

const state = await waitForState();
const child = spawn(
  "pnpm",
  ["preview", "--host", "127.0.0.1", "--port", String(state.webPort)],
  {
    cwd: webRoot,
    env: {
      ...process.env,
      SINGULARITY_E2E_API_ORIGIN: state.apiOrigin,
      SINGULARITY_E2E_WEB_CERT_FILE: state.certificateFile,
      SINGULARITY_E2E_WEB_KEY_FILE: state.privateKeyFile,
    },
    stdio: "inherit",
  },
);

let stopping = false;
const stop = (signal) => {
  if (stopping) {
    return;
  }
  stopping = true;
  child.kill(signal);
};
process.once("SIGINT", () => stop("SIGINT"));
process.once("SIGTERM", () => stop("SIGTERM"));

const [code, signal] = await once(child, "exit");
if (!stopping && code !== 0) {
  throw new Error(
    signal === null
      ? `P5 E2E Vite preview exited with code ${String(code)}`
      : `P5 E2E Vite preview exited after signal ${signal}`,
  );
}
