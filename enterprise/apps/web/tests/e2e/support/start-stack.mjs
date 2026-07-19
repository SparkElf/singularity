import { spawn } from "node:child_process";
import {
  randomBytes,
  randomUUID,
  sign,
} from "node:crypto";
import { once } from "node:events";
import {
  copyFile,
  chmod,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { request as httpsRequest } from "node:https";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const enterpriseRoot = resolve(webRoot, "../..");
const repositoryRoot = resolve(enterpriseRoot, "..");
const apiRoot = join(enterpriseRoot, "apps/api");
const appRoot = join(repositoryRoot, "app");
const databaseRoot = join(enterpriseRoot, "packages/database");
const kernelRoot = join(repositoryRoot, "kernel");
const workerRoot = join(enterpriseRoot, "apps/worker");
const runtimeRoot = resolve(tmpdir(), `singularity-p5-e2e-runtime-${String(process.pid)}`);
const kernelBinaryRoot = join(appRoot, `.singularity-p5-e2e-kernel-${String(process.pid)}`);
const objectStoreRoot = join(runtimeRoot, "object-store");
const restoreRuntimeRoot = join(runtimeRoot, "restore-runtime");
const workspaceRoot = join(runtimeRoot, "workspace");
const schema = "singularity_p5_e2e";
const stateFile = process.env.SINGULARITY_E2E_STATE_FILE;
const apiPort = Number(process.env.SINGULARITY_E2E_API_PORT ?? "3012");
const kernelPort = Number(process.env.SINGULARITY_E2E_KERNEL_PORT ?? "6807");
const restorePortFirst = Number(
  process.env.SINGULARITY_E2E_RESTORE_PORT_FIRST ?? "6810",
);
const restorePortLast = Number(
  process.env.SINGULARITY_E2E_RESTORE_PORT_LAST ?? "6819",
);
const webPort = Number(process.env.SINGULARITY_E2E_WEB_PORT ?? "4174");
const apiOrigin = `http://127.0.0.1:${apiPort}`;
const webOrigin = `https://127.0.0.1:${webPort}`;
const deploymentHandle = "p5-e2e-kernel";
const serviceKeyId = "p5-e2e";
const editorCredentials = {
  loginIdentifier: "p5-editor",
  password: "P5-editor-password-2026",
};
const viewerCredentials = {
  loginIdentifier: "p5-viewer",
  password: "P5-viewer-password-2026",
};
const organizationName = "奇点 P5 企业";
const spaceName = "P5 真实链路空间";
const notebookName = "P5 真实链路笔记本";
const documentTitle = "P5 真实链路文档";
const documentInitialText = "P5 初始内容由真实 Go Kernel 提供";
const commandOutputLimitBytes = 2 * 1_024 * 1_024;
let stack;
let stopping = false;
const activeCommands = new Set();

if (process.versions.node.split(".")[0] !== "24") {
  throw new Error("P5 E2E requires Node.js 24");
}
if (stateFile === undefined || stateFile.length === 0) {
  throw new Error("SINGULARITY_E2E_STATE_FILE is not configured");
}
for (const [name, value] of Object.entries({
  apiPort,
  kernelPort,
  restorePortFirst,
  restorePortLast,
  webPort,
})) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 65_535) {
    throw new Error(`P5 E2E ${name} is invalid`);
  }
}
if (restorePortFirst > restorePortLast) {
  throw new Error("P5 E2E restore port range is invalid");
}

function appendBounded(current, chunk) {
  const next = current + chunk.toString("utf8");
  if (Buffer.byteLength(next, "utf8") > commandOutputLimitBytes) {
    throw new Error("P5 E2E setup command output exceeded its limit");
  }
  return next;
}

async function runCommand(command, args, options = {}) {
  if (stopping && options.allowDuringShutdown !== true) {
    throw new Error("P5 E2E stack shutdown was requested");
  }
  return new Promise((resolveCommand, rejectCommand) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    activeCommands.add(child);
    let stdout = "";
    let stderr = "";
    let startError;
    child.stdout.on("data", (chunk) => {
      try {
        stdout = appendBounded(stdout, chunk);
      } catch (error) {
        child.kill("SIGKILL");
        startError = error;
      }
    });
    child.stderr.on("data", (chunk) => {
      try {
        stderr = appendBounded(stderr, chunk);
      } catch (error) {
        child.kill("SIGKILL");
        startError = error;
      }
    });
    child.once("error", (error) => {
      startError = error;
    });
    if (options.input === undefined) {
      child.stdin.end();
    } else {
      child.stdin.end(options.input, "utf8");
    }
    child.once("close", (code, signal) => {
      activeCommands.delete(child);
      if (startError !== undefined) {
        rejectCommand(startError);
        return;
      }
      if (code === 0) {
        resolveCommand({ stderr, stdout });
        return;
      }
      rejectCommand(new Error(
        signal === null
          ? `P5 E2E setup command ${command} exited with code ${String(code)}`
          : `P5 E2E setup command ${command} exited after signal ${signal}`,
      ));
    });
  });
}

function lastOutputLine(output) {
  const lines = output.trim().split(/\r?\n/).filter((line) => line.length > 0);
  const line = lines.at(-1);
  if (line === undefined) {
    throw new Error("P5 E2E setup command returned no result");
  }
  return line;
}

function databaseUrls() {
  const configured = process.env.SINGULARITY_TEST_DATABASE_URL ??
    "postgresql://singularity_test:singularity_test@127.0.0.1:55432/singularity_test";
  const baseUrl = new URL(configured);
  const databaseName = decodeURIComponent(baseUrl.pathname.slice(1));
  if (
    (baseUrl.protocol !== "postgres:" && baseUrl.protocol !== "postgresql:") ||
    !databaseName.endsWith("_test")
  ) {
    throw new Error("P5 E2E requires a PostgreSQL test database");
  }
  baseUrl.searchParams.delete("schema");
  const isolatedUrl = new URL(baseUrl);
  isolatedUrl.searchParams.set("schema", schema);
  return {
    base: baseUrl.toString(),
    isolated: isolatedUrl.toString(),
  };
}

function psqlConnection(databaseUrl) {
  const url = new URL(databaseUrl);
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

async function resetAndMigrateDatabase(baseDatabaseUrl, databaseUrl) {
  const connection = psqlConnection(baseDatabaseUrl);
  await runCommand(
    "psql",
    [
      "--no-psqlrc",
      "--set=ON_ERROR_STOP=1",
      connection.url,
      "--command",
      `DROP SCHEMA IF EXISTS "${schema}" CASCADE; CREATE SCHEMA "${schema}";`,
    ],
    { env: connection.environment },
  );
  await runCommand(
    "pnpm",
    ["exec", "prisma", "migrate", "deploy", "--config", "prisma.config.ts"],
    {
      cwd: databaseRoot,
      env: { ...process.env, DATABASE_URL: databaseUrl },
    },
  );
}

async function readKernelInstanceId(baseDatabaseUrl, spaceId) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(spaceId)) {
    throw new Error("P5 E2E space identity is invalid");
  }
  const connection = psqlConnection(baseDatabaseUrl);
  const { stdout } = await runCommand(
    "psql",
    [
      "--no-psqlrc",
      "--set=ON_ERROR_STOP=1",
      "--tuples-only",
      "--no-align",
      connection.url,
      "--command",
      `SELECT "id" FROM "${schema}"."kernel_instances" WHERE "space_id" = '${spaceId}'::uuid;`,
    ],
    { env: connection.environment },
  );
  const rows = stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const kernelInstanceId = rows[0];
  if (
    rows.length !== 1 ||
    kernelInstanceId === undefined ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(kernelInstanceId)
  ) {
    throw new Error("P5 E2E Kernel instance identity is unavailable");
  }
  return kernelInstanceId;
}

async function buildRuntimeArtifacts() {
  const kernelBinary = join(kernelBinaryRoot, "singularity-kernel");
  await rm(kernelBinaryRoot, { force: true, recursive: true });
  await mkdir(kernelBinaryRoot, { recursive: true });
  await runCommand(
    "pnpm",
    ["--filter", "@singularity/api...", "build"],
    { cwd: enterpriseRoot },
  );
  await runCommand(
    "pnpm",
    ["--filter", "@singularity/worker...", "build"],
    { cwd: enterpriseRoot },
  );
  await runCommand(
    "pnpm",
    ["--filter", "@singularity/web", "build"],
    { cwd: enterpriseRoot },
  );
  await runCommand("go", ["build", "-o", kernelBinary, "."], {
    cwd: kernelRoot,
  });
  return kernelBinary;
}

async function runAccessOperation(databaseUrl, auditKey, command) {
  const entry = join(apiRoot, "dist/operations/main.js");
  const { stdout } = await runCommand("node", [entry], {
    cwd: apiRoot,
    env: {
      ...process.env,
      DATABASE_URL: databaseUrl,
      SINGULARITY_AUDIT_HMAC_KEY: auditKey,
      SINGULARITY_AUDIT_KEY_VERSION: "p5-e2e-v1",
    },
    input: JSON.stringify(command),
  });
  const result = JSON.parse(lastOutputLine(stdout));
  if (
    result === null ||
    typeof result !== "object" ||
    !["created", "updated", "revoked"].includes(result.outcome)
  ) {
    throw new Error(`P5 E2E access operation ${command.operation} was rejected`);
  }
  return result;
}

async function createKernelContent(kernelBinary) {
  await mkdir(join(workspaceRoot, "conf"), { recursive: true });
  await writeFile(
    join(workspaceRoot, "conf/conf.json"),
    JSON.stringify({ kernelVersion: "3.7.2" }),
    "utf8",
  );
  const cliEnvironment = {
    ...process.env,
    SIYUAN_WORKSPACE_PATH: workspaceRoot,
  };
  const notebook = await runCommand(
    kernelBinary,
    ["--workspace", workspaceRoot, "notebook", "create", "--name", notebookName],
    { cwd: appRoot, env: cliEnvironment },
  );
  const notebookId = lastOutputLine(notebook.stdout);
  const document = await runCommand(
    kernelBinary,
    [
      "--workspace",
      workspaceRoot,
      "document",
      "create",
      "--notebook",
      notebookId,
      "--title",
      documentTitle,
      "--markdown",
      `# ${documentTitle}\n\n${documentInitialText}`,
    ],
    { cwd: appRoot, env: cliEnvironment },
  );
  return {
    documentId: lastOutputLine(document.stdout),
    notebookId,
  };
}

async function createServiceIdentity() {
  const certificateFile = join(runtimeRoot, "kernel.crt");
  const privateKeyFile = join(runtimeRoot, "kernel.key");
  const servicePrivateKeyFile = join(runtimeRoot, "service.key");
  const servicePublicKeyFile = join(runtimeRoot, "service.pub");
  const keyRingFile = join(runtimeRoot, "service-keys.json");
  await copyFile(join(apiRoot, "test/fixtures/kernel-gateway.crt"), certificateFile);
  await copyFile(join(apiRoot, "test/fixtures/kernel-gateway.key"), privateKeyFile);
  await chmod(certificateFile, 0o600);
  await chmod(privateKeyFile, 0o600);
  await runCommand(
    "openssl",
    ["genpkey", "-algorithm", "ED25519", "-out", servicePrivateKeyFile],
  );
  await runCommand(
    "openssl",
    ["pkey", "-in", servicePrivateKeyFile, "-pubout", "-out", servicePublicKeyFile],
  );
  const publicKeyPem = await readFile(servicePublicKeyFile, "utf8");
  await writeFile(
    keyRingFile,
    JSON.stringify({ keys: [{ kid: serviceKeyId, publicKeyPem }] }),
    "utf8",
  );
  await chmod(servicePrivateKeyFile, 0o600);
  await chmod(servicePublicKeyFile, 0o600);
  await chmod(keyRingFile, 0o600);
  return {
    certificateFile,
    keyRingFile,
    privateKeyFile,
    servicePrivateKeyFile,
  };
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
  const signature = sign(null, Buffer.from(input, "ascii"), privateKey)
    .toString("base64url");
  return `${input}.${signature}`;
}

async function requestKernelReady(input) {
  const requestId = randomUUID();
  const privateKey = await readFile(input.servicePrivateKeyFile);
  const certificate = await readFile(input.certificateFile);
  const clientKey = await readFile(input.privateKeyFile);
  const token = serviceToken(
    privateKey,
    input.kernelInstanceId,
    input.spaceId,
    requestId,
  );
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
      port: kernelPort,
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

async function waitForKernelReady(input, kernelProcess) {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (kernelProcess.exitCode !== null || kernelProcess.signalCode !== null) {
      throw new Error("P5 E2E Go Kernel exited during startup");
    }
    try {
      if (await requestKernelReady(input) === 200) {
        return;
      }
    } catch {
      // 进程尚未完成 TLS 与 readiness 启动。
    }
    await new Promise((resolvePoll) => setTimeout(resolvePoll, 250));
  }
  throw new Error("P5 E2E Go Kernel did not become ready before timeout");
}

async function waitForApiReady(apiProcess) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (apiProcess.exitCode !== null || apiProcess.signalCode !== null) {
      throw new Error("P5 E2E Nest API exited during startup");
    }
    try {
      const response = await fetch(`${apiOrigin}/api/v1/health/database`, {
        signal: AbortSignal.timeout(2_000),
      });
      if (response.ok) {
        return;
      }
    } catch {
      // HTTP listener 尚未就绪。
    }
    await new Promise((resolvePoll) => setTimeout(resolvePoll, 250));
  }
  throw new Error("P5 E2E Nest API did not become ready before timeout");
}

async function waitForWorkerStartup(workerProcess) {
  await new Promise((resolvePoll) => setTimeout(resolvePoll, 250));
  if (workerProcess.exitCode !== null || workerProcess.signalCode !== null) {
    throw new Error("P5 E2E Nest Worker exited during startup");
  }
}

function startProcess(command, args, options) {
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env,
    stdio: ["ignore", "inherit", "inherit"],
  });
  child.once("error", (error) => {
    console.error(`[p5.e2e] ${options.label} failed to start`, error.name);
  });
  return child;
}

async function stopProcess(child) {
  if (child === undefined) {
    return;
  }
  const closed = once(child, "close");
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  child.kill("SIGTERM");
  await Promise.race([
    closed,
    new Promise((resolveWait) => setTimeout(resolveWait, 5_000)),
  ]);
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
    await Promise.race([
      closed,
      new Promise((resolveWait) => setTimeout(resolveWait, 5_000)),
    ]);
  }
  if (child.exitCode === null && child.signalCode === null) {
    throw new Error("P5 E2E child process did not stop");
  }
}

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error !== null && typeof error === "object" && error.code === "ESRCH") {
      return false;
    }
    throw error;
  }
}

async function stopPersistedProcess(pid) {
  if (!processExists(pid)) {
    return;
  }
  process.kill(pid, "SIGTERM");
  let deadline = Date.now() + 5_000;
  while (processExists(pid) && Date.now() < deadline) {
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  if (!processExists(pid)) {
    return;
  }
  process.kill(pid, "SIGKILL");
  deadline = Date.now() + 5_000;
  while (processExists(pid) && Date.now() < deadline) {
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  if (processExists(pid)) {
    throw new Error("P5 E2E restored Kernel process did not stop");
  }
}

async function stopRestoredKernelProcesses() {
  let entries;
  try {
    entries = await readdir(restoreRuntimeRoot, { withFileTypes: true });
  } catch (error) {
    if (error !== null && typeof error === "object" && error.code === "ENOENT") {
      return;
    }
    throw error;
  }
  const processIds = [];
  for (const entry of entries) {
    if (
      !entry.isFile() ||
      !entry.name.startsWith(".p5-e2e-restore-") ||
      !entry.name.endsWith(".json")
    ) {
      continue;
    }
    const metadata = JSON.parse(
      await readFile(join(restoreRuntimeRoot, entry.name), "utf8"),
    );
    const pid = metadata?.pid;
    if (pid === null) {
      continue;
    }
    if (!Number.isSafeInteger(pid) || pid < 1) {
      throw new Error("P5 E2E restored Kernel process identity is invalid");
    }
    processIds.push(pid);
  }
  await Promise.all(processIds.map((pid) => stopPersistedProcess(pid)));
}

async function writeStackState(state) {
  const temporaryStateFile = `${stateFile}.${String(process.pid)}.tmp`;
  await mkdir(dirname(stateFile), { recursive: true });
  try {
    await writeFile(temporaryStateFile, JSON.stringify(state), "utf8");
    await chmod(temporaryStateFile, 0o600);
    await rename(temporaryStateFile, stateFile);
  } catch (error) {
    await rm(temporaryStateFile, { force: true });
    throw error;
  }
}

async function startStack() {
  const { base: baseDatabaseUrl, isolated: databaseUrl } = databaseUrls();
  stack = {
    apiProcess: undefined,
    baseDatabaseUrl,
    kernelProcess: undefined,
    workerProcess: undefined,
  };
  await rm(runtimeRoot, { force: true, recursive: true });
  await rm(stateFile, { force: true });
  await mkdir(runtimeRoot, { mode: 0o700, recursive: true });
  await mkdir(objectStoreRoot, { mode: 0o700, recursive: true });
  await mkdir(restoreRuntimeRoot, { mode: 0o700, recursive: true });
  await resetAndMigrateDatabase(baseDatabaseUrl, databaseUrl);
  const kernelBinary = await buildRuntimeArtifacts();
  const auditKey = randomBytes(32).toString("base64url");
  const installation = await runAccessOperation(databaseUrl, auditKey, {
    loginIdentifier: editorCredentials.loginIdentifier,
    operation: "initialize",
    organizationName,
    password: editorCredentials.password,
    spaceName,
  });
  const kernelInstanceId = await readKernelInstanceId(
    baseDatabaseUrl,
    installation.spaceId,
  );
  const viewer = await runAccessOperation(databaseUrl, auditKey, {
    loginIdentifier: viewerCredentials.loginIdentifier,
    operation: "create-user",
    organizationId: installation.organizationId,
    password: viewerCredentials.password,
  });
  await runAccessOperation(databaseUrl, auditKey, {
    operation: "set-space-member",
    role: "viewer",
    spaceId: installation.spaceId,
    userId: viewer.userId,
  });
  const content = await createKernelContent(kernelBinary);
  const serviceIdentity = await createServiceIdentity();
  const kernelProcess = startProcess(
    kernelBinary,
    [
      "serve",
      "--workspace",
      workspaceRoot,
      "--wd",
      appRoot,
      "--port",
      String(kernelPort),
      "--mode",
      "prod",
    ],
    {
      cwd: repositoryRoot,
      env: {
        ...process.env,
        SINGULARITY_KERNEL_CLIENT_CA_FILE: serviceIdentity.certificateFile,
        SINGULARITY_KERNEL_ENTERPRISE: "1",
        SINGULARITY_KERNEL_GATEWAY_CLIENT_DNS_NAME: "kernel.test",
        SINGULARITY_KERNEL_INSTANCE_ID: kernelInstanceId,
        SINGULARITY_KERNEL_LISTEN_ADDRESS: "127.0.0.1",
        SINGULARITY_KERNEL_SERVICE_KEYS_FILE: serviceIdentity.keyRingFile,
        SINGULARITY_KERNEL_SPACE_ID: installation.spaceId,
        SINGULARITY_KERNEL_TLS_CERT_FILE: serviceIdentity.certificateFile,
        SINGULARITY_KERNEL_TLS_KEY_FILE: serviceIdentity.privateKeyFile,
      },
      label: "Go Kernel",
    },
  );
  stack.kernelProcess = kernelProcess;
  await waitForKernelReady({
    ...serviceIdentity,
    kernelInstanceId,
    spaceId: installation.spaceId,
  }, kernelProcess);

  await runAccessOperation(databaseUrl, auditKey, {
    deploymentHandle,
    kernelState: "ready",
    operation: "set-kernel-state",
    spaceId: installation.spaceId,
    version: "3.7.2",
  });
  const deploymentsFile = join(runtimeRoot, "deployments.json");
  await writeFile(deploymentsFile, JSON.stringify({
    deployments: [{
      caCertificateFile: serviceIdentity.certificateFile,
      clientCertificateFile: serviceIdentity.certificateFile,
      clientPrivateKeyFile: serviceIdentity.privateKeyFile,
      handle: deploymentHandle,
      hostname: "127.0.0.1",
      kernelInstanceId,
      port: kernelPort,
      serverName: "kernel.test",
      spaceId: installation.spaceId,
    }],
  }), "utf8");
  await chmod(deploymentsFile, 0o600);
  const apiProcess = startProcess("node", [join(apiRoot, "dist/main.js")], {
    cwd: apiRoot,
    env: {
      ...process.env,
      DATABASE_URL: databaseUrl,
      PORT: String(apiPort),
      SINGULARITY_AUDIT_HMAC_KEY: auditKey,
      SINGULARITY_AUDIT_KEY_VERSION: "p5-e2e-v1",
      SINGULARITY_KERNEL_DEPLOYMENTS_FILE: deploymentsFile,
      SINGULARITY_KERNEL_RUNTIME_CA_FILE: serviceIdentity.certificateFile,
      SINGULARITY_KERNEL_RUNTIME_CLIENT_CERTIFICATE_FILE: serviceIdentity.certificateFile,
      SINGULARITY_KERNEL_RUNTIME_CLIENT_PRIVATE_KEY_FILE: serviceIdentity.privateKeyFile,
      SINGULARITY_KERNEL_RUNTIME_TLS_PROFILE: "p5-e2e",
      SINGULARITY_KERNEL_SERVICE_KEY_ID: serviceKeyId,
      SINGULARITY_KERNEL_SERVICE_PRIVATE_KEY_FILE: serviceIdentity.servicePrivateKeyFile,
      SINGULARITY_PUBLIC_ORIGIN: webOrigin,
    },
    label: "Nest API",
  });
  stack.apiProcess = apiProcess;
  await waitForApiReady(apiProcess);
  const workerProcess = startProcess("node", [join(workerRoot, "dist/main.js")], {
    cwd: workerRoot,
    env: {
      ...process.env,
      DATABASE_URL: databaseUrl,
      SINGULARITY_AUDIT_HMAC_KEY: auditKey,
      SINGULARITY_AUDIT_KEY_VERSION: "p5-e2e-v1",
      SINGULARITY_KERNEL_DEPLOYMENTS_FILE: deploymentsFile,
      SINGULARITY_KERNEL_SERVICE_KEY_ID: serviceKeyId,
      SINGULARITY_KERNEL_SERVICE_PRIVATE_KEY_FILE:
        serviceIdentity.servicePrivateKeyFile,
      SINGULARITY_WORKER_ID: `p5-e2e-${String(process.pid)}`,
      SINGULARITY_WORKER_CONTENT_AUDIT_RECONCILIATION_INTERVAL_MS: "1000",
      SINGULARITY_WORKER_MAXIMUM_CONCURRENT_JOBS: "4",
      SINGULARITY_WORKER_OBJECT_STORE_ROOT: objectStoreRoot,
      SINGULARITY_WORKER_POLL_INTERVAL_MS: "100",
      SINGULARITY_WORKER_RESTORE_ARCHIVE_TOOL: kernelBinary,
      SINGULARITY_WORKER_RESTORE_CLIENT_CA_FILE:
        serviceIdentity.certificateFile,
      SINGULARITY_WORKER_RESTORE_CLIENT_CERT_FILE:
        serviceIdentity.certificateFile,
      SINGULARITY_WORKER_RESTORE_CLIENT_KEY_FILE:
        serviceIdentity.privateKeyFile,
      SINGULARITY_WORKER_RESTORE_GATEWAY_CLIENT_DNS_NAME: "kernel.test",
      SINGULARITY_WORKER_RESTORE_GATEWAY_HOSTNAME: "127.0.0.1",
      SINGULARITY_WORKER_RESTORE_HANDLE_PREFIX: "p5-e2e-restore",
      SINGULARITY_WORKER_RESTORE_KERNEL_BINARY: kernelBinary,
      SINGULARITY_WORKER_RESTORE_KERNEL_WORKING_DIRECTORY: appRoot,
      SINGULARITY_WORKER_RESTORE_PORT_FIRST: String(restorePortFirst),
      SINGULARITY_WORKER_RESTORE_PORT_LAST: String(restorePortLast),
      SINGULARITY_WORKER_RESTORE_RUNTIME_ROOT: restoreRuntimeRoot,
      SINGULARITY_WORKER_RESTORE_SERVER_CERT_FILE:
        serviceIdentity.certificateFile,
      SINGULARITY_WORKER_RESTORE_SERVER_KEY_FILE:
        serviceIdentity.privateKeyFile,
      SINGULARITY_WORKER_RESTORE_SERVER_NAME: "kernel.test",
      SINGULARITY_WORKER_RESTORE_SERVICE_KEYS_FILE:
        serviceIdentity.keyRingFile,
      SINGULARITY_WORKER_RESTORE_TLS_PROFILE: "p5-e2e",
    },
    label: "Nest Worker",
  });
  stack.workerProcess = workerProcess;
  await waitForWorkerStartup(workerProcess);
  await writeStackState({
    apiOrigin,
    certificateFile: serviceIdentity.certificateFile,
    documentId: content.documentId,
    documentInitialText,
    documentTitle,
    editor: { ...editorCredentials, userId: installation.userId },
    kernelInstanceId,
    kernelPort,
    notebookId: content.notebookId,
    notebookName,
    organizationId: installation.organizationId,
    organizationName,
    privateKeyFile: serviceIdentity.privateKeyFile,
    schema,
    spaceId: installation.spaceId,
    spaceName,
    stateVersion: 1,
    viewer: { ...viewerCredentials, userId: viewer.userId },
    webOrigin,
    webPort,
  });

  return stack;
}

let finish;
const finished = new Promise((resolveFinished) => {
  finish = resolveFinished;
});

async function shutdown(exitCode) {
  if (stopping) {
    return;
  }
  stopping = true;
  await rm(stateFile, { force: true });
  const workerStopResults = await Promise.allSettled([
    ...[...activeCommands].map((child) => stopProcess(child)),
    stopProcess(stack?.workerProcess),
  ]);
  const stopResults = await Promise.allSettled([
    stopRestoredKernelProcesses(),
    stopProcess(stack?.apiProcess),
    stopProcess(stack?.kernelProcess),
  ]);
  if (
    workerStopResults.some((result) => result.status === "rejected") ||
    stopResults.some((result) => result.status === "rejected")
  ) {
    exitCode = 1;
  }
  if (stack?.baseDatabaseUrl !== undefined) {
    try {
      const connection = psqlConnection(stack.baseDatabaseUrl);
      await runCommand(
        "psql",
        [
          "--no-psqlrc",
          "--set=ON_ERROR_STOP=1",
          connection.url,
          "--command",
          `DROP SCHEMA IF EXISTS "${schema}" CASCADE;`,
        ],
        { allowDuringShutdown: true, env: connection.environment },
      );
    } catch {
      exitCode = 1;
    }
  }
  await rm(runtimeRoot, { force: true, recursive: true });
  await rm(kernelBinaryRoot, { force: true, recursive: true });
  process.exitCode = exitCode;
  finish();
}

process.once("SIGINT", () => void shutdown(0));
process.once("SIGTERM", () => void shutdown(0));

try {
  stack = await startStack();
  stack.apiProcess.once("exit", () => {
    if (!stopping) {
      void shutdown(1);
    }
  });
  stack.kernelProcess.once("exit", () => {
    if (!stopping) {
      void shutdown(1);
    }
  });
  stack.workerProcess.once("exit", () => {
    if (!stopping) {
      void shutdown(1);
    }
  });
  await finished;
} catch (error) {
  console.error("[p5.e2e] stack setup failed", error instanceof Error ? error.name : "unknown");
  await shutdown(1);
}
