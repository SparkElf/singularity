import { randomUUID, sign } from "node:crypto";
import { spawn } from "node:child_process";
import { request as httpsRequest } from "node:https";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import {
  mkdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const enterpriseRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(enterpriseRoot, "..");
const reportPath = resolve(
  enterpriseRoot,
  process.env.SINGULARITY_L3_ROLLBACK_REPORT ??
    "test-results/l3-release-certification/rollback.json",
);
const baseDatabaseUrl = process.env.SINGULARITY_TEST_DATABASE_URL ??
  "postgresql://singularity_test:singularity_test@127.0.0.1:55432/singularity_test";
const runtimeRoot = join(tmpdir(), `singularity-p5-e2e-runtime-${process.pid}`);
const schema = `singularity_p5_e2e_${process.pid}`;
const stateFile = join(runtimeRoot, "stack-state.json");
const apiPort = Number(process.env.SINGULARITY_E2E_API_PORT ?? "39112");
const kernelPort = Number(process.env.SINGULARITY_E2E_KERNEL_PORT ?? "36807");
const restorePortFirst = Number(
  process.env.SINGULARITY_E2E_RESTORE_PORT_FIRST ?? "36810",
);
const restorePortLast = Number(
  process.env.SINGULARITY_E2E_RESTORE_PORT_LAST ?? "36819",
);
const webPort = Number(process.env.SINGULARITY_E2E_WEB_PORT ?? "44174");
const supervisorStopTimeoutMilliseconds = 240_000;
const commandTimeoutMilliseconds = 300_000;
const outputLimitCharacters = 16 * 1_024;
const serviceKeyId = "p5-e2e";
const stackScriptRelativePath = "apps/web/tests/e2e/support/start-stack.mjs";

function boundedOutput(current, chunk) {
  const next = current + chunk.toString("utf8");
  return next.length <= outputLimitCharacters
    ? next
    : next.slice(-outputLimitCharacters);
}

// 运行受控命令并只保留有限尾部输出；输出不进入发布报告，避免把凭据带入证据产物。
function runCommand(command, args, options = {}) {
  return new Promise((resolveCommand, rejectCommand) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, options.timeoutMilliseconds ?? commandTimeoutMilliseconds);
    child.stdout.on("data", (chunk) => {
      stdout = boundedOutput(stdout, chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr = boundedOutput(stderr, chunk);
    });
    child.once("error", rejectCommand);
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      if (code === 0 && !timedOut) {
        resolveCommand({ code, signal, stderr, stdout });
        return;
      }
      const output = `${stdout.trim()}\n${stderr.trim()}`.trim().slice(-4_000);
      rejectCommand(new Error(
        `${command} failed with ${signal ?? `exit ${String(code)}`}` +
          (output.length === 0 ? "" : `: ${output}`),
      ));
    });
  });
}

function databaseConnection(urlValue) {
  const url = new URL(urlValue);
  const password = decodeURIComponent(url.password);
  url.password = "";
  const environment = { ...process.env };
  delete environment.DATABASE_URL;
  delete environment.SINGULARITY_TEST_DATABASE_URL;
  return {
    environment: {
      ...environment,
      ...(password.length === 0 ? {} : { PGPASSWORD: password }),
    },
    url: url.toString(),
  };
}

async function currentRevisions() {
  const candidate = await runCommand("git", ["rev-parse", "HEAD"], {
    cwd: repositoryRoot,
  });
  const approved = await runCommand("git", ["rev-parse", "HEAD^"], {
    cwd: repositoryRoot,
  });
  const status = await runCommand("git", ["status", "--porcelain"], {
    cwd: repositoryRoot,
  });
  return {
    approved: approved.stdout.trim(),
    candidate: `${candidate.stdout.trim()}${status.stdout.trim().length === 0 ? "" : "+dirty"}`,
  };
}

// 构造隔离的批准制品根，并在其内部安装 workspace 链接，保证版本切换不消费候选源码。
async function prepareApprovedWorktree(revision) {
  const worktreeRoot = join(tmpdir(), `singularity-l3-approved-${process.pid}`);
  await rm(worktreeRoot, { force: true, recursive: true });
  try {
    await runCommand("git", ["worktree", "add", "--detach", worktreeRoot, revision], {
      cwd: repositoryRoot,
    });
    const approvedEnterpriseRoot = join(worktreeRoot, "enterprise");
    // 两棵锁文件分别覆盖企业服务与上游 Protyle 资源；都在批准 worktree 内安装，避免构建时回读候选根的依赖。
    await runCommand("pnpm", ["install", "--offline", "--frozen-lockfile"], {
      cwd: approvedEnterpriseRoot,
      env: { ...process.env, CI: "1" },
      timeoutMilliseconds: commandTimeoutMilliseconds,
    });
    await runCommand("pnpm", ["install", "--offline", "--frozen-lockfile"], {
      cwd: join(worktreeRoot, "app"),
      env: { ...process.env, CI: "1" },
      timeoutMilliseconds: commandTimeoutMilliseconds,
    });
    return worktreeRoot;
  } catch (error) {
    await runCommand("git", ["worktree", "remove", "--force", worktreeRoot], {
      cwd: repositoryRoot,
    }).catch(() => undefined);
    throw error;
  }
}

function portIsListening(port) {
  return new Promise((resolvePort, rejectPort) => {
    const socket = connect({ host: "127.0.0.1", port });
    let settled = false;
    const finish = (result) => {
      if (settled) {
        return;
      }
      settled = true;
      socket.destroy();
      resolvePort(result);
    };
    socket.setTimeout(500, () => finish(false));
    socket.once("connect", () => finish(true));
    socket.once("error", (error) => {
      if (error.code === "ECONNREFUSED") {
        finish(false);
        return;
      }
      if (!settled) {
        settled = true;
        socket.destroy();
        rejectPort(error);
      }
    });
  });
}

async function assertPortsAvailable() {
  const ports = [apiPort, kernelPort, restorePortFirst, restorePortLast, webPort];
  for (const port of ports) {
    if (await portIsListening(port)) {
      throw new Error(`L3 supervisor rollback port ${String(port)} is already in use`);
    }
  }
}

async function waitForPortsFree() {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const ports = [apiPort, kernelPort];
    const listening = await Promise.all(ports.map((port) => portIsListening(port)));
    if (listening.every((value) => !value)) {
      return;
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
  }
  throw new Error("L3 supervisor rollback left a service port listening");
}

function startSupervisor(artifactRoot, environment, label) {
  const child = spawn(
    process.execPath,
    [join(enterpriseRoot, stackScriptRelativePath)],
    {
      cwd: enterpriseRoot,
      env: {
        ...process.env,
        ...environment,
        SINGULARITY_E2E_ARTIFACT_ROOT: artifactRoot,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout = boundedOutput(stdout, chunk);
  });
  child.stderr.on("data", (chunk) => {
    stderr = boundedOutput(stderr, chunk);
  });
  child.once("error", (error) => {
    child.startError = error;
  });
  child.outputTail = () => `${stdout.trim()}\n${stderr.trim()}`.trim().slice(-4_000);
  child.label = label;
  child.artifactRoot = artifactRoot;
  return child;
}

async function readStackState() {
  try {
    const parsed = JSON.parse(await readFile(stateFile, "utf8"));
    if (
      parsed === null ||
      typeof parsed !== "object" ||
      parsed.stateVersion !== 1 ||
      parsed.schema !== schema ||
      parsed.kernelPort !== kernelPort ||
      parsed.apiOrigin !== `http://127.0.0.1:${String(apiPort)}`
    ) {
      throw new Error("L3 supervisor stack state does not match the drill");
    }
    return parsed;
  } catch (error) {
    if (error?.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

async function waitForStackState(supervisor) {
  const deadline = Date.now() + 600_000;
  while (Date.now() < deadline) {
    if (supervisor.exitCode !== null || supervisor.signalCode !== null) {
      throw new Error(
        `${supervisor.label} exited before publishing state: ${supervisor.outputTail()}`,
      );
    }
    const state = await readStackState();
    if (state !== undefined) {
      return state;
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
  }
  throw new Error(`${supervisor.label} did not publish stack state before timeout`);
}

function serviceToken(privateKey, instanceId, spaceId, requestId) {
  const issuedAt = Math.floor(Date.now() / 1_000);
  const header = Buffer.from(JSON.stringify({ alg: "EdDSA", kid: serviceKeyId }))
    .toString("base64url");
  const payload = Buffer.from(JSON.stringify({
    aud: instanceId,
    exp: issuedAt + 20,
    iat: issuedAt,
    iss: "singularity-api",
    jti: requestId,
    spaceId,
  })).toString("base64url");
  const input = `${header}.${payload}`;
  return `${input}.${sign(null, Buffer.from(input, "ascii"), privateKey).toString("base64url")}`;
}

// 通过 Kernel 真实 mTLS/service token readiness 端点确认当前空间制品已经可用。
async function checkKernelReady(state) {
  const requestId = randomUUID();
  const [privateKey, certificate, clientKey] = await Promise.all([
    readFile(join(runtimeRoot, "service.key")),
    readFile(state.certificateFile),
    readFile(state.privateKeyFile),
  ]);
  const token = serviceToken(privateKey, state.kernelInstanceId, state.spaceId, requestId);
  return new Promise((resolveRequest, rejectRequest) => {
    const request = httpsRequest({
      ca: certificate,
      cert: certificate,
      headers: {
        Accept: "application/json",
        "X-Singularity-Request-Id": requestId,
        "X-Singularity-Service-Token": token,
      },
      hostname: "127.0.0.1",
      key: clientKey,
      method: "GET",
      path: "/internal/readyz",
      port: state.kernelPort,
      rejectUnauthorized: true,
      servername: "kernel.test",
      signal: AbortSignal.timeout(3_000),
    }, (response) => {
      response.resume();
      response.once("end", () => resolveRequest(response.statusCode ?? 0));
    });
    request.once("error", rejectRequest);
    request.end();
  });
}

async function checkApi(state) {
  const readiness = await fetch(`${state.apiOrigin}/api/v1/health/database`, {
    signal: AbortSignal.timeout(3_000),
  });
  const openApi = await fetch(`${state.apiOrigin}/api/openapi.json`, {
    signal: AbortSignal.timeout(3_000),
  });
  return {
    openApiStatus: openApi.status,
    readinessStatus: readiness.status,
  };
}

// 读取固定 schema 中该空间的 sample-kernel 任务，证明 Worker 已完成真实观测链路。
async function checkWorker(state) {
  const connection = databaseConnection(baseDatabaseUrl);
  const { stdout } = await runCommand("psql", [
    "--no-psqlrc",
    "--set=ON_ERROR_STOP=1",
    "--tuples-only",
    "--no-align",
    connection.url,
    "--command",
    `SELECT COALESCE((SELECT "status"::text || ':' || COALESCE("error_code", '') || ':' || "attempt"::text FROM "${schema}"."worker_jobs" WHERE "kind" = 'sample-kernel' AND "payload" ->> 'kernelInstanceId' = '${state.kernelInstanceId}' ORDER BY "created_at" DESC LIMIT 1), 'pending');`,
  ], { env: connection.environment });
  const status = stdout.trim().split(/\r?\n/).map((line) => line.trim()).filter(Boolean).at(-1) ?? "pending";
  if (!status.startsWith("succeeded:")) {
    throw new Error(`Worker sample-kernel is not ready: ${status}`);
  }
  return { status };
}

async function processTable() {
  const { stdout } = await runCommand("ps", ["-eo", "pid=,ppid=,args="]);
  const processes = new Map();
  for (const line of stdout.split(/\r?\n/)) {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);
    if (match !== null) {
      processes.set(Number(match[1]), {
        command: match[3],
        pid: Number(match[1]),
        ppid: Number(match[2]),
      });
    }
  }
  return processes;
}

function descendants(processes, rootPid) {
  const children = new Map();
  for (const process of processes.values()) {
    const values = children.get(process.ppid) ?? [];
    values.push(process);
    children.set(process.ppid, values);
  }
  const found = [];
  const queue = [...(children.get(rootPid) ?? [])];
  while (queue.length > 0) {
    const process = queue.shift();
    found.push(process);
    queue.push(...(children.get(process.pid) ?? []));
  }
  return found;
}

// 只接受当前 supervisor 后代中的三类目标命令，记录 PID/PPID 供切换后核对退出。
function processOwnership(processes, supervisor, state) {
  const owned = descendants(processes, supervisor.pid);
  const kernel = owned.find((process) =>
    process.command.includes(`${runtimeRoot}/singularity-kernel`) && process.command.includes(" serve "));
  const api = owned.find((process) => process.command.includes("apps/api/dist/main.js"));
  const worker = owned.find((process) => process.command.includes("apps/worker/dist/main.js"));
  if (kernel === undefined || api === undefined || worker === undefined) {
    throw new Error(`三进程 supervisor 归属不完整: ${JSON.stringify({
      kernelInstanceId: state.kernelInstanceId,
      processes: owned,
      spaceId: state.spaceId,
    })}`);
  }
  return {
    api,
    kernel,
    supervisorPid: supervisor.pid,
    worker,
  };
}

async function inspectOwnership(supervisor, state) {
  return processOwnership(await processTable(), supervisor, state);
}

async function waitForOwnedProcessesGone(processes) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const current = await processTable();
    const alive = processes.filter((expected) => {
      const actual = current.get(expected.pid);
      return actual !== undefined && actual.command === expected.command;
    });
    if (alive.length === 0) {
      return;
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
  }
  throw new Error("supervisor owned process did not exit after stop");
}

// supervisor 超时才按已核对的运行时路径收敛子进程，避免用进程组信号误触用户服务。
async function terminateOwnedDescendants(supervisor) {
  const processes = descendants(await processTable(), supervisor.pid);
  const owned = processes.filter((process) =>
    process.command.includes(`${runtimeRoot}/singularity-kernel`) ||
    process.command.includes(`${supervisor.artifactRoot}/enterprise/apps/api/dist/main.js`) ||
    process.command.includes(`${supervisor.artifactRoot}/enterprise/apps/worker/dist/main.js`),
  );
  for (const process of owned.reverse()) {
    try {
      globalThis.process.kill(process.pid, "SIGTERM");
    } catch (error) {
      if (error?.code !== "ESRCH") {
        throw error;
      }
    }
  }
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 5_000));
  const remaining = (await processTable()).values();
  for (const process of remaining) {
    if (!owned.some((expected) => expected.pid === process.pid && expected.command === process.command)) {
      continue;
    }
    try {
      globalThis.process.kill(process.pid, "SIGKILL");
    } catch (error) {
      if (error?.code !== "ESRCH") {
        throw error;
      }
    }
  }
}

function waitForClose(child, timeoutMilliseconds) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve(true);
  }
  return new Promise((resolveClose) => {
    let settled = false;
    const finish = (closed) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      child.removeListener("close", onClose);
      resolveClose(closed);
    };
    const onClose = () => finish(true);
    const timer = setTimeout(() => finish(false), timeoutMilliseconds);
    child.once("close", onClose);
  });
}

async function stopSupervisor(supervisor) {
  if (supervisor === undefined || supervisor.exitCode !== null || supervisor.signalCode !== null) {
    return;
  }
  supervisor.kill("SIGTERM");
  if (!(await waitForClose(supervisor, supervisorStopTimeoutMilliseconds))) {
    await terminateOwnedDescendants(supervisor);
    supervisor.kill("SIGKILL");
    await waitForClose(supervisor, 10_000);
  }
  if (supervisor.exitCode === null && supervisor.signalCode === null) {
    throw new Error(`${supervisor.label} did not stop: ${supervisor.outputTail()}`);
  }
  if (supervisor.exitCode !== 0 && supervisor.signalCode !== "SIGTERM") {
    throw new Error(`${supervisor.label} exited unexpectedly: ${supervisor.outputTail()}`);
  }
}

// 启动一个候选/批准阶段并集中收集健康、Worker、版本和进程归属证据。
async function runStage(worktreeRoot, revisions, revision, label, reuseSchema, preserveSchema) {
  await rm(stateFile, { force: true });
  const supervisor = startSupervisor(worktreeRoot, {
    SINGULARITY_E2E_API_PORT: String(apiPort),
    SINGULARITY_E2E_IDENTITY_SUFFIX: label,
    SINGULARITY_E2E_KERNEL_PORT: String(kernelPort),
    SINGULARITY_E2E_PRESERVE_SCHEMA: preserveSchema ? "1" : "0",
    SINGULARITY_E2E_RESTORE_PORT_FIRST: String(restorePortFirst),
    SINGULARITY_E2E_RESTORE_PORT_LAST: String(restorePortLast),
    SINGULARITY_E2E_RUNTIME_ROOT: runtimeRoot,
    SINGULARITY_E2E_SCHEMA: schema,
    SINGULARITY_E2E_STATE_FILE: stateFile,
    SINGULARITY_E2E_WEB_PORT: String(webPort),
    SINGULARITY_E2E_REUSE_SCHEMA: reuseSchema ? "1" : "0",
  }, label);
  const startedAt = Date.now();
  try {
    const state = await waitForStackState(supervisor);
    const kernelStatus = await checkKernelReady(state);
    const apiStatus = await checkApi(state);
    const workerStatus = await checkWorker(state);
    const ownership = await inspectOwnership(supervisor, state);
    supervisor.ownedProcesses = [ownership.api, ownership.kernel, ownership.worker];
    if (kernelStatus !== 200 || apiStatus.readinessStatus !== 200 || apiStatus.openApiStatus !== 200) {
      throw new Error(`三进程健康检查失败: ${JSON.stringify({ apiStatus, kernelStatus, workerStatus })}`);
    }
    const record = {
      approvedRevision: revisions.approved,
      candidateRevision: revisions.candidate,
      health: { api: apiStatus, kernelStatus, worker: workerStatus },
      label,
      ownership,
      revision,
      startedAt: new Date(startedAt).toISOString(),
      startupDurationMilliseconds: Date.now() - startedAt,
      state: {
        apiOrigin: state.apiOrigin,
        kernelInstanceId: state.kernelInstanceId,
        kernelPort: state.kernelPort,
        schema: state.schema,
        spaceId: state.spaceId,
      },
    };
    return { record, supervisor };
  } catch (error) {
    await stopSupervisor(supervisor).catch(() => undefined);
    if (supervisor.ownedProcesses !== undefined) {
      await waitForOwnedProcessesGone(supervisor.ownedProcesses).catch(() => undefined);
    }
    throw error;
  }
}

async function dropSchema() {
  const connection = databaseConnection(baseDatabaseUrl);
  await runCommand("psql", [
    "--no-psqlrc",
    "--set=ON_ERROR_STOP=1",
    connection.url,
    "--command",
    `DROP SCHEMA IF EXISTS "${schema}" CASCADE;`,
  ], { env: connection.environment });
}

// 统一停止本轮 supervisor、核对端口、删除 schema/runtime/worktree；用户固定数据库不受影响。
async function cleanup(worktreeRoot, supervisors) {
  const failures = [];
  for (const supervisor of supervisors.reverse()) {
    try {
      await stopSupervisor(supervisor);
      if (supervisor.ownedProcesses !== undefined) {
        await waitForOwnedProcessesGone(supervisor.ownedProcesses);
      }
    } catch (error) {
      failures.push(error);
    }
  }
  try {
    await dropSchema();
  } catch (error) {
    failures.push(error);
  }
  try {
    await waitForPortsFree();
  } catch (error) {
    failures.push(error);
  }
  try {
    await rm(runtimeRoot, { force: true, recursive: true });
  } catch (error) {
    failures.push(error);
  }
  if (worktreeRoot !== undefined) {
    try {
      await runCommand("git", ["worktree", "remove", "--force", worktreeRoot], {
        cwd: repositoryRoot,
      });
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, "L3 supervisor rollback cleanup failed");
  }
}

async function main() {
  if (process.versions.node.split(".")[0] !== "24") {
    throw new Error("L3 supervisor rollback drill requires Node.js 24");
  }
  for (const [name, value] of Object.entries({ apiPort, kernelPort, restorePortFirst, restorePortLast, webPort })) {
    if (!Number.isSafeInteger(value) || value < 1 || value > 65_535) {
      throw new Error(`L3 supervisor rollback ${name} is invalid`);
    }
  }
  if (restorePortFirst > restorePortLast) {
    throw new Error("L3 supervisor rollback restore port range is invalid");
  }
  await assertPortsAvailable();
  const revisions = await currentRevisions();
  let approvedWorktree;
  const supervisors = [];
  const startedAt = Date.now();
  try {
    approvedWorktree = await prepareApprovedWorktree(revisions.approved);
    const candidateStage = await runStage(repositoryRoot, revisions, revisions.candidate, "l3-candidate", false, true);
    const candidateSupervisor = candidateStage.supervisor;
    supervisors.push(candidateSupervisor);
    await stopSupervisor(candidateSupervisor);
    await waitForOwnedProcessesGone(candidateSupervisor.ownedProcesses);
    await waitForPortsFree();
    const approvedStage = await runStage(approvedWorktree, revisions, revisions.approved, "l3-approved", true, false);
    const approvedSupervisor = approvedStage.supervisor;
    supervisors.push(approvedSupervisor);
    await writeFile(reportPath, `${JSON.stringify({
      caseId: "L3-REL-10",
      candidateRevision: revisions.candidate,
      approvedRevision: revisions.approved,
      mode: "local-supervisor-rehearsal",
      stages: [candidateStage.record, approvedStage.record],
      switch: { candidateProcessesStopped: true, candidateStopped: true, sharedPortsReused: true },
      durationMilliseconds: Date.now() - startedAt,
      targetDeploymentSupervisorCertification: "pending",
      resourceCleanup: "pending",
      status: "passed",
    }, null, 2)}\n`, "utf8");
    await cleanup(approvedWorktree, supervisors);
    approvedWorktree = undefined;
    const report = JSON.parse(await readFile(reportPath, "utf8"));
    report.resourceCleanup = "passed";
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  } catch (error) {
    try {
      await cleanup(approvedWorktree, supervisors);
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "L3 supervisor rollback failed and cleanup failed", { cause: error });
    }
    throw error;
  }
}

await mkdir(dirname(reportPath), { recursive: true });
await main();
