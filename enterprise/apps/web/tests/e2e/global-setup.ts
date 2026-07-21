import { spawn, type ChildProcess } from "node:child_process";
import { readFile, rm } from "node:fs/promises";
import { request as httpsRequest } from "node:https";
import { connect } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  parseP5E2EStackState,
  type P5E2EStackState,
} from "./support/stack-state.ts";

const waitTimeoutMilliseconds = 600_000;
const pollIntervalMilliseconds = 250;
const stackSupervisorStopTimeoutMilliseconds = 240_000;
const webSupervisorStopTimeoutMilliseconds = 45_000;
const supervisorOutputLimitCharacters = 64 * 1_024;
const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

interface Supervisor {
  readonly child: ChildProcess;
  readonly label: string;
  readonly stopTimeoutMilliseconds: number;
  startError?: Error;
  stderr: string;
  stdout: string;
}

function appendOutputTail(current: string, chunk: Buffer): string {
  const next = current + chunk.toString("utf8");
  return next.length <= supervisorOutputLimitCharacters
    ? next
    : next.slice(-supervisorOutputLimitCharacters);
}

function supervisorDiagnostic(supervisor: Supervisor): string {
  const stderr = supervisor.stderr.trim();
  const stdout = supervisor.stdout.trim();
  return [
    ...(stdout.length === 0
      ? []
      : [`[${supervisor.label} stdout tail]\n${stdout}`]),
    ...(stderr.length === 0
      ? []
      : [`[${supervisor.label} stderr tail]\n${stderr}`]),
  ].map((value) => `\n${value}`).join("");
}

function supervisorFailure(message: string, supervisor: Supervisor): Error {
  return new Error(`${message}${supervisorDiagnostic(supervisor)}`, {
    cause: supervisor.startError,
  });
}

function requiredPort(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? String(fallback));
  if (!Number.isSafeInteger(value) || value < 1 || value > 65_535) {
    throw new Error(`P5 E2E ${name} is invalid`);
  }
  return value;
}

function restorePorts(): readonly number[] {
  const first = requiredPort("SINGULARITY_E2E_RESTORE_PORT_FIRST", 6_810);
  const last = requiredPort("SINGULARITY_E2E_RESTORE_PORT_LAST", 6_819);
  if (first > last) {
    throw new Error("P5 E2E restore port range is invalid");
  }
  return Array.from({ length: last - first + 1 }, (_, index) => first + index);
}

function portIsListening(port: number): Promise<boolean> {
  return new Promise((resolveProbe, rejectProbe) => {
    const socket = connect({ host: "127.0.0.1", port });
    let settled = false;
    const finish = (result: boolean): void => {
      if (settled) {
        return;
      }
      settled = true;
      socket.destroy();
      resolveProbe(result);
    };
    // 空闲端口在 WSL 可能只留下 SYN-SENT，不会及时返回 ECONNREFUSED；超时视为未监听。
    socket.setTimeout(500, () => finish(false));
    socket.once("connect", () => finish(true));
    socket.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ECONNREFUSED") {
        finish(false);
        return;
      }
      if (!settled) {
        settled = true;
        socket.destroy();
        rejectProbe(error);
      }
    });
  });
}

async function assertPortsAvailable(ports: readonly number[]): Promise<void> {
  for (const port of ports) {
    if (await portIsListening(port)) {
      throw new Error(`P5 E2E port ${String(port)} is already in use`);
    }
  }
}

function statePath(): string {
  const value = process.env.SINGULARITY_E2E_STATE_FILE;
  if (value === undefined || value.length === 0) {
    throw new Error("SINGULARITY_E2E_STATE_FILE is not configured");
  }
  return value;
}

function expectedSchema(): string {
  const value = process.env.SINGULARITY_E2E_SCHEMA;
  if (value === undefined || !/^singularity_p5_e2e_[0-9]+$/.test(value)) {
    throw new Error("SINGULARITY_E2E_SCHEMA is not configured by the P5 runner");
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

async function waitForStackState(supervisor: Supervisor): Promise<P5E2EStackState> {
  const path = statePath();
  const deadline = Date.now() + waitTimeoutMilliseconds;
  while (Date.now() < deadline) {
    if (
      supervisor.child.exitCode !== null ||
      supervisor.child.signalCode !== null ||
      supervisor.startError !== undefined
    ) {
      throw supervisorFailure(
        "P5 E2E stack supervisor exited before publishing state",
        supervisor,
      );
    }
    const state = await readState(path);
    if (state !== null) {
      return state;
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMilliseconds));
  }
  throw supervisorFailure(
    "P5 E2E stack did not publish its state before timeout",
    supervisor,
  );
}

function startSupervisor(
  script: string,
  label: string,
  stopTimeoutMilliseconds: number,
  environment: NodeJS.ProcessEnv = process.env,
): Supervisor {
  const child = spawn(process.execPath, [script], {
    cwd: webRoot,
    detached: process.platform !== "win32",
    env: environment,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const supervisor: Supervisor = {
    child,
    label,
    stopTimeoutMilliseconds,
    stderr: "",
    stdout: "",
  };
  child.stdout?.on("data", (chunk: Buffer) => {
    process.stdout.write(chunk);
    supervisor.stdout = appendOutputTail(supervisor.stdout, chunk);
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    process.stderr.write(chunk);
    supervisor.stderr = appendOutputTail(supervisor.stderr, chunk);
  });
  child.once("error", (error) => {
    supervisor.startError = error;
  });
  return supervisor;
}

function requestWeb(origin: string): Promise<{ readonly error?: Error; readonly status?: number }> {
  return new Promise((resolveRequest) => {
    const request = httpsRequest(origin, {
      method: "GET",
      rejectUnauthorized: false,
      signal: AbortSignal.timeout(3_000),
    }, (response) => {
      response.resume();
      response.once("end", () => resolveRequest({ status: response.statusCode ?? 0 }));
    });
    request.once("error", (error) => resolveRequest({ error }));
    request.end();
  });
}

async function waitForWeb(origin: string, supervisor: Supervisor): Promise<void> {
  const deadline = Date.now() + waitTimeoutMilliseconds;
  let lastFailure: Error | undefined;
  while (Date.now() < deadline) {
    if (
      supervisor.child.exitCode !== null ||
      supervisor.child.signalCode !== null ||
      supervisor.startError !== undefined
    ) {
      throw new Error(
        `P5 E2E Web supervisor exited during startup${supervisorDiagnostic(supervisor)}`,
        { cause: supervisor.startError ?? lastFailure },
      );
    }
    const result = await requestWeb(origin);
    if (result.status === 200) {
      return;
    }
    lastFailure = result.error ??
      new Error(`P5 E2E Web readiness returned status ${String(result.status)}`);
    await new Promise((resolvePoll) => setTimeout(resolvePoll, pollIntervalMilliseconds));
  }
  throw new Error(
    `P5 E2E Web did not become ready before timeout${supervisorDiagnostic(supervisor)}`,
    {
      cause: lastFailure,
    },
  );
}

function signalSupervisor(
  child: ChildProcess,
  signal: NodeJS.Signals,
  processGroup: boolean,
): void {
  if (child.pid === undefined) {
    throw new Error("P5 E2E supervisor has no process identity");
  }
  try {
    if (process.platform === "win32" || !processGroup) {
      child.kill(signal);
      return;
    }
    process.kill(-child.pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") {
      return;
    }
    throw error;
  }
}

function waitForSupervisorClose(
  child: ChildProcess,
  timeoutMilliseconds: number,
): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve(true);
  }
  return new Promise((resolveWait) => {
    let settled = false;
    const finishWait = (closed: boolean): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      child.removeListener("close", handleClose);
      resolveWait(closed);
    };
    const handleClose = (): void => finishWait(true);
    const timer = setTimeout(() => finishWait(false), timeoutMilliseconds);
    child.once("close", handleClose);
  });
}

async function stopSupervisor(supervisor: Supervisor | undefined): Promise<void> {
  if (supervisor === undefined) {
    return;
  }
  const { child, label } = supervisor;
  if (child.exitCode === null && child.signalCode === null) {
    signalSupervisor(child, "SIGTERM", false);
    if (!(await waitForSupervisorClose(
      child,
      supervisor.stopTimeoutMilliseconds,
    ))) {
      signalSupervisor(child, "SIGKILL", true);
      await waitForSupervisorClose(child, 5_000);
    }
    if (child.exitCode === null && child.signalCode === null) {
      throw new Error(`${label} did not stop within its cleanup timeout`);
    }
  }
  if (child.exitCode !== 0) {
    throw supervisorFailure(
      child.signalCode === null
        ? `${label} exited with code ${String(child.exitCode)}`
        : `${label} exited after signal ${child.signalCode}`,
      supervisor,
    );
  }
}

async function cleanupSupervisors(
  webSupervisor: Supervisor | undefined,
  stackSupervisor: Supervisor | undefined,
  ports: readonly number[],
): Promise<void> {
  const failures: unknown[] = [];
  for (const supervisor of [webSupervisor, stackSupervisor]) {
    try {
      await stopSupervisor(supervisor);
    } catch (error) {
      failures.push(error);
    }
  }
  for (const port of ports) {
    try {
      if (await portIsListening(port)) {
        failures.push(new Error(`P5 E2E cleanup left port ${String(port)} in use`));
      }
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, "P5 E2E cleanup failed");
  }
}

export default async function globalSetup(): Promise<() => Promise<void>> {
  const apiPort = requiredPort("SINGULARITY_E2E_API_PORT", 3_012);
  const kernelPort = requiredPort("SINGULARITY_E2E_KERNEL_PORT", 6_807);
  const webPort = requiredPort("SINGULARITY_E2E_WEB_PORT", 4_174);
  const ports = [
    apiPort,
    kernelPort,
    ...restorePorts(),
    webPort,
  ];
  await assertPortsAvailable(ports);
  await rm(statePath(), { force: true });

  let stackSupervisor: Supervisor | undefined;
  let webSupervisor: Supervisor | undefined;
  try {
    stackSupervisor = startSupervisor(
      "tests/e2e/support/start-stack.mjs",
      "P5 E2E stack supervisor",
      stackSupervisorStopTimeoutMilliseconds,
    );
    const state = await waitForStackState(stackSupervisor);
    if (
      state.schema !== expectedSchema() ||
      state.apiOrigin !== `http://127.0.0.1:${String(apiPort)}` ||
      state.kernelPort !== kernelPort ||
      state.webOrigin !== `https://127.0.0.1:${String(webPort)}` ||
      state.webPort !== webPort
    ) {
      throw new Error("P5 E2E stack state does not match this runner");
    }
    webSupervisor = startSupervisor(
      "tests/e2e/support/start-web.mjs",
      "P5 E2E Web supervisor",
      webSupervisorStopTimeoutMilliseconds,
      {
        ...process.env,
        SINGULARITY_E2E_API_ORIGIN: state.apiOrigin,
        SINGULARITY_E2E_WEB_CERT_FILE: state.certificateFile,
        SINGULARITY_E2E_WEB_KEY_FILE: state.privateKeyFile,
        SINGULARITY_E2E_WEB_PORT: String(state.webPort),
      },
    );
    await waitForWeb(state.webOrigin, webSupervisor);
  } catch (error) {
    try {
      await cleanupSupervisors(webSupervisor, stackSupervisor, ports);
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "P5 E2E setup and cleanup failed",
        // 保留主启动错误作为聚合异常根因，清理错误仍在 errors 中保留。
        // eslint-disable-next-line preserve-caught-error
        { cause: error },
      );
    }
    throw error;
  }

  return async () =>
    cleanupSupervisors(webSupervisor, stackSupervisor, ports);
}
