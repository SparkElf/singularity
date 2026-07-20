import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const stopTimeoutMilliseconds = 30_000;

function requiredEnvironment(name) {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`P5 E2E ${name} is not configured`);
  }
  return value;
}

function requiredPort(name) {
  const value = Number(requiredEnvironment(name));
  if (!Number.isSafeInteger(value) || value < 1 || value > 65_535) {
    throw new Error(`P5 E2E ${name} is invalid`);
  }
  return value;
}

function signalProcessGroup(child, signal) {
  if (child.pid === undefined) {
    throw new Error("P5 E2E Vite preview has no process identity");
  }
  try {
    if (process.platform === "win32") {
      child.kill(signal);
      return;
    }
    process.kill(-child.pid, signal);
  } catch (error) {
    if (error !== null && typeof error === "object" && error.code === "ESRCH") {
      return;
    }
    throw error;
  }
}

function waitForProcessClose(child, timeoutMilliseconds) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve(true);
  }
  return new Promise((resolveWait) => {
    let settled = false;
    const finishWait = (closed) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      child.removeListener("close", handleClose);
      resolveWait(closed);
    };
    const handleClose = () => finishWait(true);
    const timer = setTimeout(() => finishWait(false), timeoutMilliseconds);
    child.once("close", handleClose);
  });
}

async function stopProcess(child) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  signalProcessGroup(child, "SIGTERM");
  if (!(await waitForProcessClose(child, stopTimeoutMilliseconds))) {
    signalProcessGroup(child, "SIGKILL");
    await waitForProcessClose(child, 5_000);
  }
  if (child.exitCode === null && child.signalCode === null) {
    throw new Error("P5 E2E Vite preview did not stop");
  }
}

const apiOrigin = requiredEnvironment("SINGULARITY_E2E_API_ORIGIN");
const certificateFile = requiredEnvironment("SINGULARITY_E2E_WEB_CERT_FILE");
const privateKeyFile = requiredEnvironment("SINGULARITY_E2E_WEB_KEY_FILE");
const webPort = requiredPort("SINGULARITY_E2E_WEB_PORT");
const child = spawn(
  "pnpm",
  ["preview", "--host", "127.0.0.1", "--port", String(webPort)],
  {
    cwd: webRoot,
    detached: process.platform !== "win32",
    env: {
      ...process.env,
      SINGULARITY_E2E_API_ORIGIN: apiOrigin,
      SINGULARITY_E2E_WEB_CERT_FILE: certificateFile,
      SINGULARITY_E2E_WEB_KEY_FILE: privateKeyFile,
    },
    stdio: "inherit",
  },
);

const childExit = new Promise((resolveExit, rejectExit) => {
  child.once("error", (error) => {
    rejectExit(new Error("P5 E2E Vite preview failed to start", { cause: error }));
  });
  child.once("close", (code, signal) => resolveExit({ code, signal }));
});
let requestStop;
const stopRequested = new Promise((resolveStop) => {
  requestStop = resolveStop;
});
process.once("SIGINT", () => requestStop("SIGINT"));
process.once("SIGTERM", () => requestStop("SIGTERM"));

const outcome = await Promise.race([
  childExit.then((result) => ({ kind: "exit", result })),
  stopRequested.then((signal) => ({ kind: "stop", signal })),
]);
if (outcome.kind === "stop") {
  await stopProcess(child);
  await childExit;
} else {
  const { code, signal } = outcome.result;
  throw new Error(
    signal === null
      ? `P5 E2E Vite preview exited unexpectedly with code ${String(code)}`
      : `P5 E2E Vite preview exited unexpectedly after signal ${signal}`,
  );
}
