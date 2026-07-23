import { spawn } from "node:child_process";
import {
  randomBytes,
  randomUUID,
  sign,
} from "node:crypto";
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
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const defaultWebRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const defaultEnterpriseRoot = resolve(defaultWebRoot, "../..");
const defaultRepositoryRoot = resolve(defaultEnterpriseRoot, "..");
const artifactRoot = resolve(
  process.env.SINGULARITY_E2E_ARTIFACT_ROOT ?? defaultRepositoryRoot,
);
const webRoot = join(artifactRoot, "enterprise/apps/web");
const enterpriseRoot = join(artifactRoot, "enterprise");
const repositoryRoot = artifactRoot;
const apiRoot = join(enterpriseRoot, "apps/api");
const appRoot = join(repositoryRoot, "app");
const databaseRoot = join(enterpriseRoot, "packages/database");
const kernelRoot = join(repositoryRoot, "kernel");
const workerRoot = join(enterpriseRoot, "apps/worker");
const runtimeRoot = process.env.SINGULARITY_E2E_RUNTIME_ROOT ?? "";
const objectStoreRoot = join(runtimeRoot, "object-store");
const restoreRuntimeRoot = join(runtimeRoot, "restore-runtime");
const workspaceRoot = join(runtimeRoot, "workspace");
const kernelBinary = join(runtimeRoot, "singularity-kernel");
const schema = process.env.SINGULARITY_E2E_SCHEMA ?? "";
const stateFile = process.env.SINGULARITY_E2E_STATE_FILE;
const reuseSchema = process.env.SINGULARITY_E2E_REUSE_SCHEMA === "1";
const preserveSchema = process.env.SINGULARITY_E2E_PRESERVE_SCHEMA === "1";
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
const identitySuffix = process.env.SINGULARITY_E2E_IDENTITY_SUFFIX ?? "p5";
const editorCredentials = {
  loginIdentifier: `${identitySuffix}-editor`,
  password: "P5-editor-password-2026",
};
const viewerCredentials = {
  loginIdentifier: `${identitySuffix}-viewer`,
  password: "P5-viewer-password-2026",
};
const organizationName = "奇点 P5 企业";
const spaceName = "P5 真实链路空间";
const notebookName = "P5 真实链路笔记本";
const documentTitle = "P5 真实链路文档";
const documentInitialText = "P5 初始内容由真实 Go Kernel 提供";
const referenceDocumentTitle = "P5 真实引用文档";
const searchMarker = `P5 唯一搜索标记 ${String(process.pid)}`;
const workerId = `p5-e2e-${String(process.pid)}`;
const commandOutputLimitCharacters = 64 * 1_024;
const commandTimeoutMilliseconds = 300_000;
const processStopTimeoutMilliseconds = 30_000;
let stack;
let stopping = false;
let requestedExitCode = 0;
let shutdownPromise;
const activeCommands = new Set();

if (process.versions.node.split(".")[0] !== "24") {
  throw new Error("P5 E2E requires Node.js 24");
}
if (stateFile === undefined || stateFile.length === 0) {
  throw new Error("SINGULARITY_E2E_STATE_FILE is not configured");
}
if (!/^singularity_p5_e2e_[0-9]+$/.test(schema)) {
  throw new Error("SINGULARITY_E2E_SCHEMA is not owned by the P5 runner");
}
if (!isAbsolute(runtimeRoot)) {
  throw new Error("SINGULARITY_E2E_RUNTIME_ROOT must be absolute");
}
if (
  dirname(runtimeRoot) !== resolve(tmpdir()) ||
  !/^singularity-p5-e2e-runtime-[0-9]+$/.test(basename(runtimeRoot))
) {
  throw new Error("SINGULARITY_E2E_RUNTIME_ROOT is not owned by the P5 runner");
}
if (stateFile !== join(runtimeRoot, "stack-state.json")) {
  throw new Error("SINGULARITY_E2E_STATE_FILE is outside the P5 runtime directory");
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
  if (next.length <= commandOutputLimitCharacters) {
    return next;
  }
  return next.slice(-commandOutputLimitCharacters);
}

function commandDiagnostic(stderr, stdout) {
  const stderrValue = stderr.trim();
  const stdoutValue = stdout.trim();
  return [
    ...(stdoutValue.length === 0 ? [] : [`[stdout tail]\n${stdoutValue}`]),
    ...(stderrValue.length === 0 ? [] : [`[stderr tail]\n${stderrValue}`]),
  ].map((value) => `\n${value}`).join("");
}

// 递归展开关闭阶段的 AggregateError，保留每个进程清理失败的完整堆栈。
function shutdownDiagnostic(error) {
  if (error instanceof AggregateError) {
    return {
      errors: error.errors.map((nested) => shutdownDiagnostic(nested)),
      message: error.message,
      name: error.name,
      stack: error.stack,
    };
  }
  if (error instanceof Error) {
    return {
      cause: error.cause === undefined ? undefined : shutdownDiagnostic(error.cause),
      message: error.message,
      name: error.name,
      stack: error.stack,
    };
  }
  return { value: String(error) };
}

function signalProcess(child, signal, processGroup) {
  if (child.pid === undefined) {
    throw new Error("P5 E2E child process has no process identity");
  }
  try {
    if (process.platform === "win32" || !processGroup) {
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

async function runCommand(command, args, options = {}) {
  if (stopping && options.allowDuringShutdown !== true) {
    throw new Error("P5 E2E stack shutdown was requested");
  }
  return new Promise((resolveCommand, rejectCommand) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      detached: process.platform !== "win32",
      env: options.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    activeCommands.add(child);
    let stdout = "";
    let stderr = "";
    let startError;
    const timeout = setTimeout(() => {
      startError = new Error(
        `P5 E2E setup command ${command} exceeded its timeout`,
      );
      try {
        signalProcess(child, "SIGKILL", true);
      } catch (error) {
        startError = new AggregateError(
          [startError, error],
          `P5 E2E setup command ${command} timed out and could not be stopped`,
        );
      }
    }, options.timeoutMilliseconds ?? commandTimeoutMilliseconds);
    timeout.unref();
    child.stdout.on("data", (chunk) => {
      stdout = appendBounded(stdout, chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr = appendBounded(stderr, chunk);
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
      clearTimeout(timeout);
      activeCommands.delete(child);
      if (startError !== undefined) {
        rejectCommand(new Error(
          `P5 E2E setup command ${command} failed` +
            commandDiagnostic(stderr, stdout),
          { cause: startError },
        ));
        return;
      }
      if (
        code === 0 ||
        (options.acceptedExitCodes ?? []).includes(code)
      ) {
        resolveCommand({ stderr, stdout });
        return;
      }
      rejectCommand(new Error(
        (signal === null
          ? `P5 E2E setup command ${command} exited with code ${String(code)}`
          : `P5 E2E setup command ${command} exited after signal ${signal}`) +
          commandDiagnostic(stderr, stdout),
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
  // Prisma 用 query 参数选择 schema，libpq 不识别该参数；SQL 查询会显式限定受控 schema。
  url.searchParams.delete("schema");
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

// 将夹具身份约束转为 SQL 字符串字面量；只做单引号转义，不改变查询语义。
function sqlStringLiteral(value) {
  if (typeof value !== "string") {
    throw new Error("P5 E2E SQL identity value must be text");
  }
  return `'${value.replaceAll("'", "''")}'`;
}

// 读取回滚复用 schema 中的既有身份；查询条件必须来自本阶段显式命令，不从响应顺序推断空间归属。
async function readPsqlRows(databaseUrl, query) {
  const connection = psqlConnection(databaseUrl);
  const arguments_ = [
    "--no-psqlrc",
    "--set=ON_ERROR_STOP=1",
    "--tuples-only",
    "--no-align",
  ];
  arguments_.push(connection.url, "--command", query);
  const { stdout } = await runCommand("psql", arguments_, {
    env: connection.environment,
  });
  return stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

// 按稳定的组织名、空间名和 owner 关系恢复三段控制面 UUID，拒绝多行或缺失结果。
async function readExistingInstallation(databaseUrl) {
  const rows = await readPsqlRows(
    databaseUrl,
    `SELECT users."id" || '|' || organizations."id" || '|' || spaces."id"
       FROM "${schema}"."users" AS users
       INNER JOIN "${schema}"."organization_memberships" AS organization_memberships
         ON organization_memberships."user_id" = users."id"
       INNER JOIN "${schema}"."organizations" AS organizations
         ON organizations."id" = organization_memberships."organization_id"
       INNER JOIN "${schema}"."spaces" AS spaces
         ON spaces."organization_id" = organizations."id"
       INNER JOIN "${schema}"."space_memberships" AS space_memberships
         ON space_memberships."space_id" = spaces."id"
        AND space_memberships."user_id" = users."id"
      WHERE organizations."name" = ${sqlStringLiteral(organizationName)}
        AND spaces."name" = ${sqlStringLiteral(spaceName)}
        AND users."status" = 'active'
        AND organizations."status" = 'active'
        AND spaces."status" = 'active'
        AND organization_memberships."status" = 'active'
        AND organization_memberships."role" = 'owner'
        AND space_memberships."status" = 'active';`,
  );
  const identity = rows[0]?.split("|");
  if (
    rows.length !== 1 ||
    identity?.length !== 3 ||
    identity.some((value) => value.length === 0)
  ) {
    throw new Error("P5 E2E reused installation identity is unavailable");
  }
  return {
    organizationId: identity[1],
    spaceId: identity[2],
    userId: identity[0],
  };
}

// 按组织边界恢复复用阶段的 viewer UUID，避免把其他组织的同名身份带入切换。
async function readExistingUserId(databaseUrl, organizationId, loginIdentifier) {
  const rows = await readPsqlRows(
    databaseUrl,
    `SELECT users."id"
       FROM "${schema}"."users" AS users
       INNER JOIN "${schema}"."organization_memberships" AS memberships
         ON memberships."user_id" = users."id"
      WHERE users."login_identifier" = ${sqlStringLiteral(loginIdentifier)}
        AND memberships."organization_id" = ${sqlStringLiteral(organizationId)}::uuid
        AND users."status" = 'active'
        AND memberships."status" = 'active';`,
  );
  if (rows.length !== 1 || rows[0].length === 0) {
    throw new Error("P5 E2E reused viewer identity is unavailable");
  }
  return rows[0];
}

async function resetAndMigrateDatabase(baseDatabaseUrl, databaseUrl) {
  const connection = psqlConnection(baseDatabaseUrl);
  if (reuseSchema) {
    // 回滚切换保留同一控制面 schema；候选 supervisor 已完成清理，批准版本只需继续迁移。
    await runCommand(
      "psql",
      [
        "--no-psqlrc",
        "--set=ON_ERROR_STOP=1",
        connection.url,
        "--command",
        `CREATE SCHEMA IF NOT EXISTS "${schema}";`,
      ],
      { env: connection.environment },
    );
  } else {
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
  }
  if (!reuseSchema) {
    await runCommand(
      "pnpm",
      ["exec", "prisma", "migrate", "deploy", "--config", "prisma.config.ts"],
      {
        cwd: databaseRoot,
        env: { ...process.env, DATABASE_URL: databaseUrl },
      },
    );
  }
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
  await runCommand(
    "go",
    ["build", "-tags", "fts5 sqlcipher", "-o", kernelBinary, "."],
    { cwd: kernelRoot },
  );
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
    acceptedExitCodes: reuseSchema &&
      ["initialize", "create-user"].includes(command.operation)
      ? [2]
      : undefined,
  });
  const result = JSON.parse(lastOutputLine(stdout));
  const reusedInitialization = reuseSchema &&
    command.operation === "initialize" &&
    result?.outcome === "already-initialized";
  const reusedUser = reuseSchema &&
    command.operation === "create-user" &&
    result?.outcome === "conflict";
  if (
    result === null ||
    typeof result !== "object" ||
    (!["created", "updated", "revoked"].includes(result.outcome) &&
      !reusedInitialization &&
      !reusedUser)
  ) {
    throw new Error(`P5 E2E access operation ${command.operation} was rejected`);
  }
  if (reusedInitialization) {
    return { ...result, ...await readExistingInstallation(databaseUrl) };
  }
  if (reusedUser) {
    return {
      ...result,
      userId: await readExistingUserId(
        databaseUrl,
        command.organizationId,
        command.loginIdentifier,
      ),
    };
  }
  return result;
}

async function createKernelContent(kernelBinary) {
  await mkdir(join(workspaceRoot, "conf"), { recursive: true });
  await writeFile(
    join(workspaceRoot, "conf/conf.json"),
    JSON.stringify({ fileTree: {}, kernelVersion: "3.7.2" }),
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
  await runCommand(
    kernelBinary,
    ["--workspace", workspaceRoot, "notebook", "open", "--id", notebookId],
    { cwd: appRoot, env: cliEnvironment },
  );
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
      [
        `# ${documentTitle}`,
        "",
        `${documentInitialText} ${searchMarker}`,
        "",
        "```plantuml",
        "@startuml",
        "Alice -> Bob: P5 active content fence",
        "@enduml",
        "```",
        "",
        '<div><script>window.__p5ActiveContentExecuted = true</script><img src="https://p5-active-content.invalid/pixel.png"></div>',
      ].join("\n"),
    ],
    { cwd: appRoot, env: cliEnvironment },
  );
  const documentId = lastOutputLine(document.stdout);
  const referenceDocument = await runCommand(
    kernelBinary,
    [
      "--workspace",
      workspaceRoot,
      "document",
      "create",
      "--notebook",
      notebookId,
      "--title",
      referenceDocumentTitle,
      "--markdown",
      `# ${referenceDocumentTitle}\n\n((${documentId} 'P5 引用'))`,
    ],
    { cwd: appRoot, env: cliEnvironment },
  );
  return {
    documentId,
    notebookId,
    referenceDocumentId: lastOutputLine(referenceDocument.stdout),
    referenceDocumentTitle,
    searchMarker,
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
  let lastFailure;
  while (Date.now() < deadline) {
    if (stopping) {
      throw new Error("P5 E2E stack shutdown interrupted Kernel readiness");
    }
    if (kernelProcess.exitCode !== null || kernelProcess.signalCode !== null) {
      throw new Error("P5 E2E Go Kernel exited during startup");
    }
    try {
      const status = await requestKernelReady(input);
      if (status === 200) {
        return;
      }
      lastFailure = new Error(`P5 E2E Go Kernel readiness returned status ${String(status)}`);
    } catch (error) {
      lastFailure = error;
    }
    await new Promise((resolvePoll) => setTimeout(resolvePoll, 250));
  }
  throw new Error("P5 E2E Go Kernel did not become ready before timeout", {
    cause: lastFailure,
  });
}

async function waitForApiReady(apiProcess) {
  const deadline = Date.now() + 60_000;
  let lastFailure;
  while (Date.now() < deadline) {
    if (stopping) {
      throw new Error("P5 E2E stack shutdown interrupted API readiness");
    }
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
      lastFailure = new Error(`P5 E2E Nest API readiness returned status ${String(response.status)}`);
    } catch (error) {
      lastFailure = error;
    }
    await new Promise((resolvePoll) => setTimeout(resolvePoll, 250));
  }
  throw new Error("P5 E2E Nest API did not become ready before timeout", {
    cause: lastFailure,
  });
}

async function waitForWorkerReady(baseDatabaseUrl, kernelInstanceId, workerProcess) {
  const connection = psqlConnection(baseDatabaseUrl);
  const deadline = Date.now() + 60_000;
  let lastStatus = "unobserved";
  while (Date.now() < deadline) {
    if (stopping) {
      throw new Error("P5 E2E stack shutdown interrupted Worker readiness");
    }
    if (workerProcess.exitCode !== null || workerProcess.signalCode !== null) {
      throw new Error("P5 E2E Nest Worker exited during startup");
    }
    const { stdout } = await runCommand(
      "psql",
      [
        "--no-psqlrc",
        "--set=ON_ERROR_STOP=1",
        "--tuples-only",
        "--no-align",
        connection.url,
        "--command",
        `SELECT COALESCE((
          SELECT "status"::text || ':' || COALESCE("error_code", '') || ':' || "attempt"::text
          FROM "${schema}"."worker_jobs"
          WHERE "kind" = 'sample-kernel'
            AND "payload" ->> 'kernelInstanceId' = '${kernelInstanceId}'
          ORDER BY "created_at" DESC
          LIMIT 1
        ), 'pending');`,
      ],
      { env: connection.environment },
    );
    lastStatus = lastOutputLine(stdout);
    if (lastStatus.startsWith("succeeded:")) {
      return;
    }
    if (lastStatus.startsWith("failed:")) {
      throw new Error(
        `P5 E2E Nest Worker readiness job failed; status=${lastStatus}`,
      );
    }
    await new Promise((resolvePoll) => setTimeout(resolvePoll, 500));
  }
  throw new Error(`P5 E2E Nest Worker did not become ready before timeout; last job status=${lastStatus}`);
}

function startProcess(command, args, options) {
  if (stopping) {
    throw new Error(`P5 E2E cannot start ${options.label} during shutdown`);
  }
  const child = spawn(command, args, {
    cwd: options.cwd,
    detached: false,
    env: options.env,
    stdio: ["ignore", "inherit", "inherit"],
  });
  let startFailure;
  child.once("error", (error) => {
    startFailure = error;
    console.error(`[p5.e2e] ${options.label} failed to start`, error);
    void shutdown(1, error);
  });
  child.once("close", (code, signal) => {
    if (!stopping && startFailure === undefined) {
      const error = new Error(
        signal === null
          ? `${options.label} exited with code ${String(code)}`
          : `${options.label} exited after signal ${signal}`,
      );
      console.error(
        `[p5.e2e] ${options.label} exited unexpectedly`,
        error,
      );
      void shutdown(1, error);
    }
  });
  return child;
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

async function stopProcess(child, processGroup = false) {
  if (child === undefined) {
    return;
  }
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  signalProcess(child, "SIGTERM", processGroup);
  if (!(await waitForProcessClose(child, processStopTimeoutMilliseconds))) {
    signalProcess(child, "SIGKILL", processGroup);
    await waitForProcessClose(child, 5_000);
  }
  if (child.exitCode === null && child.signalCode === null) {
    throw new Error("P5 E2E child process did not stop");
  }
}

function processInspectionUnavailable(error) {
  return error !== null &&
    typeof error === "object" &&
    (error.code === "ENOENT" || error.code === "ESRCH");
}

function processArgument(arguments_, name) {
  const index = arguments_.indexOf(name);
  return index === -1 ? undefined : arguments_[index + 1];
}

function processEnvironmentValue(entries, name) {
  const prefix = `${name}=`;
  return entries.find((entry) => entry.startsWith(prefix))?.slice(prefix.length);
}

function restoredProcessMetadata(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("P5 E2E restored Kernel metadata is invalid");
  }
  const metadata = value;
  if (metadata.pid === null) {
    return null;
  }
  if (
    !Number.isSafeInteger(metadata.pid) ||
    metadata.pid < 1 ||
    !Number.isSafeInteger(metadata.port) ||
    metadata.port < restorePortFirst ||
    metadata.port > restorePortLast ||
    typeof metadata.kernelInstanceId !== "string" ||
    typeof metadata.spaceId !== "string" ||
    metadata.kernelListenAddress !== "127.0.0.1" ||
    metadata.runtimeOwner !== workerId ||
    typeof metadata.workspaceDirectoryName !== "string" ||
    !/^p5-e2e-restore-[0-9a-f-]+$/.test(metadata.workspaceDirectoryName)
  ) {
    throw new Error("P5 E2E restored Kernel process identity is invalid");
  }
  return metadata;
}

// 严格校验待终止进程身份；终止后的等待阶段允许 PID 复用，但绝不向复用 PID 发信号。
async function persistedProcessMatchesIdentity(metadata, options = {}) {
  let commandLine;
  let environment;
  try {
    [commandLine, environment] = await Promise.all([
      readFile(`/proc/${String(metadata.pid)}/cmdline`, "utf8"),
      readFile(`/proc/${String(metadata.pid)}/environ`, "utf8"),
    ]);
  } catch (error) {
    if (processInspectionUnavailable(error)) {
      return false;
    }
    throw error;
  }
  const arguments_ = commandLine.split("\u0000").filter(Boolean);
  const environmentEntries = environment.split("\u0000").filter(Boolean);
  const workspaceDirectory = join(
    restoreRuntimeRoot,
    metadata.workspaceDirectoryName,
  );
  const matches = !(
    arguments_[0] !== kernelBinary ||
    processArgument(arguments_, "--workspace") !== workspaceDirectory ||
    processArgument(arguments_, "--port") !== String(metadata.port) ||
    processEnvironmentValue(
      environmentEntries,
      "SINGULARITY_KERNEL_INSTANCE_ID",
    ) !== metadata.kernelInstanceId ||
    processEnvironmentValue(
      environmentEntries,
      "SINGULARITY_KERNEL_SPACE_ID",
    ) !== metadata.spaceId ||
    processEnvironmentValue(
      environmentEntries,
      "SINGULARITY_KERNEL_LISTEN_ADDRESS",
    ) !== "127.0.0.1" ||
    processEnvironmentValue(
      environmentEntries,
      "SINGULARITY_KERNEL_RUNTIME_OWNER",
    ) !== workerId
  );
  if (!matches && options.failOnMismatch !== false) {
    throw new Error("P5 E2E restored Kernel PID belongs to another process");
  }
  return matches;
}

async function signalPersistedProcess(metadata, signal) {
  if (!(await persistedProcessMatchesIdentity(metadata))) {
    return false;
  }
  try {
    process.kill(metadata.pid, signal);
    return true;
  } catch (error) {
    if (processInspectionUnavailable(error)) {
      return false;
    }
    throw error;
  }
}

async function waitForPersistedProcessExit(metadata, timeoutMilliseconds) {
  const deadline = Date.now() + timeoutMilliseconds;
  while (Date.now() < deadline) {
    // 终止后 PID 可能立即被系统复用；身份不再匹配即表示原目标已经退出，不能继续向新进程发信号。
    if (
      !(await persistedProcessMatchesIdentity(metadata, { failOnMismatch: false }))
    ) {
      return true;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  return !(await persistedProcessMatchesIdentity(metadata, { failOnMismatch: false }));
}

async function stopPersistedProcess(metadata) {
  if (!(await signalPersistedProcess(metadata, "SIGTERM"))) {
    return;
  }
  if (await waitForPersistedProcessExit(metadata, 5_000)) {
    return;
  }
  if (!(await signalPersistedProcess(metadata, "SIGKILL"))) {
    return;
  }
  if (!(await waitForPersistedProcessExit(metadata, 5_000))) {
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
  const processes = [];
  for (const entry of entries) {
    if (
      !entry.isFile() ||
      !entry.name.startsWith(".p5-e2e-restore-") ||
      !entry.name.endsWith(".json")
    ) {
      continue;
    }
    const metadata = restoredProcessMetadata(JSON.parse(
      await readFile(join(restoreRuntimeRoot, entry.name), "utf8"),
    ));
    if (metadata !== null) {
      processes.push(metadata);
    }
  }
  const results = await Promise.allSettled(
    processes.map((metadata) => stopPersistedProcess(metadata)),
  );
  const failures = results
    .filter((result) => result.status === "rejected")
    .map((result) => result.reason);
  if (failures.length > 0) {
    throw new AggregateError(
      failures,
      "P5 E2E restored Kernel cleanup failed",
    );
  }
}

async function writeStackState(state) {
  const temporaryStateFile = `${stateFile}.${String(process.pid)}.tmp`;
  if (stopping) {
    throw new Error("P5 E2E cannot publish stack state during shutdown");
  }
  await mkdir(dirname(stateFile), { recursive: true });
  try {
    await writeFile(temporaryStateFile, JSON.stringify(state), {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    if (stopping) {
      throw new Error("P5 E2E stack shutdown interrupted state publication");
    }
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
      SINGULARITY_WORKER_BACKUP_REQUEST_TIMEOUT_MS: "300000",
      SINGULARITY_WORKER_CONTENT_AUDIT_RECONCILIATION_INTERVAL_MS: "1000",
      SINGULARITY_WORKER_ID: workerId,
      SINGULARITY_WORKER_MAXIMUM_CONCURRENT_JOBS: "4",
      SINGULARITY_WORKER_OBJECT_STORE_ROOT: objectStoreRoot,
      SINGULARITY_WORKER_POLL_INTERVAL_MS: "100",
      SINGULARITY_WORKER_RESTORE_ARCHIVE_TOOL: kernelBinary,
      SINGULARITY_WORKER_RESTORE_ARCHIVE_TIMEOUT_MS: "300000",
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
      SINGULARITY_WORKER_RESTORE_KERNEL_LISTEN_ADDRESS: "127.0.0.1",
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
  await waitForWorkerReady(baseDatabaseUrl, kernelInstanceId, workerProcess);
  for (const [label, child] of [
    ["Go Kernel", kernelProcess],
    ["Nest API", apiProcess],
    ["Nest Worker", workerProcess],
  ]) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`P5 E2E ${label} exited before state publication`);
    }
  }
  await writeStackState({
    apiOrigin,
    certificateFile: serviceIdentity.certificateFile,
    documentId: content.documentId,
    documentTitle,
    editor: { ...editorCredentials, userId: installation.userId },
    kernelInstanceId,
    kernelPort,
    notebookId: content.notebookId,
    notebookName,
    organizationId: installation.organizationId,
    organizationName,
    privateKeyFile: serviceIdentity.privateKeyFile,
    referenceDocumentId: content.referenceDocumentId,
    referenceDocumentTitle: content.referenceDocumentTitle,
    schema,
    searchMarker: content.searchMarker,
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

async function performShutdown(trigger) {
  const failures = [];
  if (trigger !== undefined) {
    failures.push(trigger);
  }
  const cleanup = async (label, operation) => {
    try {
      await operation();
    } catch (error) {
      failures.push(new Error(label, { cause: error }));
    }
  };

  await cleanup("P5 E2E state cleanup failed", () =>
    rm(stateFile, { force: true }));
  await cleanup("P5 E2E setup command cleanup failed", async () => {
    const results = await Promise.allSettled(
      [...activeCommands].map((child) => stopProcess(child, true)),
    );
    const errors = results
      .filter((result) => result.status === "rejected")
      .map((result) => result.reason);
    if (errors.length > 0) {
      throw new AggregateError(errors, "P5 E2E setup commands did not stop");
    }
  });
  await cleanup("P5 E2E Worker cleanup failed", () =>
    stopProcess(stack?.workerProcess));
  await cleanup("P5 E2E restored Kernel cleanup failed", () =>
    stopRestoredKernelProcesses());
  await cleanup("P5 E2E API cleanup failed", () => stopProcess(stack?.apiProcess));
  await cleanup("P5 E2E source Kernel cleanup failed", () =>
    stopProcess(stack?.kernelProcess));

  if (stack?.baseDatabaseUrl !== undefined && !preserveSchema) {
    await cleanup("P5 E2E schema cleanup failed", async () => {
      const connection = psqlConnection(stack.baseDatabaseUrl);
      await runCommand(
        "psql",
        [
          "--no-psqlrc",
          "--set=ON_ERROR_STOP=1",
          connection.url,
          "--command",
          `SET lock_timeout = '5s'; SET statement_timeout = '30s'; DROP SCHEMA IF EXISTS "${schema}" CASCADE;`,
        ],
        {
          allowDuringShutdown: true,
          env: connection.environment,
          timeoutMilliseconds: 45_000,
        },
      );
    });
  }
  await cleanup("P5 E2E runtime directory cleanup failed", () =>
    rm(runtimeRoot, { force: true, recursive: true }));

  if (failures.length > 0) {
    requestedExitCode = 1;
    console.error(
      "[p5.e2e] stack shutdown failed",
      JSON.stringify(
        failures.map((failure) => shutdownDiagnostic(failure)),
        null,
        2,
      ),
    );
  }
  process.exitCode = requestedExitCode;
}

function shutdown(exitCode, trigger) {
  requestedExitCode = Math.max(requestedExitCode, exitCode);
  if (shutdownPromise !== undefined) {
    return shutdownPromise;
  }
  stopping = true;
  shutdownPromise = performShutdown(trigger).finally(() => finish());
  return shutdownPromise;
}

process.once("SIGINT", () => void shutdown(0));
process.once("SIGTERM", () => void shutdown(0));

try {
  stack = await startStack();
  await finished;
} catch (error) {
  console.error("[p5.e2e] stack setup failed", error);
  await shutdown(1, error);
}
