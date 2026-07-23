import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const enterpriseRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const inputPath = resolve(enterpriseRoot, process.env.SINGULARITY_L3_TARGET_SUPERVISOR_EVIDENCE ?? "test-results/l3-release-certification/target-supervisor-evidence.json");
const reportPath = resolve(enterpriseRoot, process.env.SINGULARITY_L3_TARGET_SUPERVISOR_REPORT ?? "test-results/l3-release-certification/target-supervisor.json");
const requiredRoles = ["kernel", "api", "worker"];

// 统一生成证据合同错误，调用方据此让目标部署认证失败而不是降级为 pending。
function fail(message) {
  throw new Error(`L3 target supervisor evidence is invalid: ${message}`);
}

// 校验运维记录中的必填文本字段，避免空字符串伪造部署观察结果。
function stringField(value, name) {
  if (typeof value !== "string" || value.trim().length === 0) {
    fail(`${name} must be a non-empty string`);
  }
  return value;
}

// 校验每个 readiness/归属/清理断言都明确达到 passed。
function passed(value, name) {
  if (value !== "passed") {
    fail(`${name} must be passed`);
  }
  return value;
}

// 校验 supervisor 管理的单个进程记录，确保角色、PID/PPID 和命令都可审计。
function processRecord(value, stageName) {
  if (value === null || typeof value !== "object") {
    fail(`${stageName} process record must be an object`);
  }
  const record = value;
  if (!requiredRoles.includes(record.role)) {
    fail(`${stageName} process role is not one of kernel/api/worker`);
  }
  for (const field of ["pid", "ppid"]) {
    if (!Number.isSafeInteger(record[field]) || record[field] <= 0) {
      fail(`${stageName} ${record.role} ${field} must be a positive integer`);
    }
  }
  stringField(record.command, `${stageName} ${record.role} command`);
  return { command: record.command, pid: record.pid, ppid: record.ppid, role: record.role };
}

// 校验候选或批准版本的三进程阶段证据，并收敛为报告使用的最小字段。
function stageRecord(value, name) {
  if (value === null || typeof value !== "object") {
    fail(`${name} stage must be an object`);
  }
  const stage = value;
  stringField(stage.revision, `${name} revision`);
  stringField(stage.supervisorId, `${name} supervisorId`);
  if (!Array.isArray(stage.processes) || stage.processes.length !== requiredRoles.length) {
    fail(`${name} must record exactly three managed processes`);
  }
  const processes = stage.processes.map((process) => processRecord(process, name));
  if (new Set(processes.map((process) => process.role)).size !== requiredRoles.length) {
    fail(`${name} process roles must be unique`);
  }
  const health = stage.health;
  if (health === null || typeof health !== "object") {
    fail(`${name} health must be an object`);
  }
  passed(health.kernel, `${name} kernel readiness`);
  passed(health.api, `${name} api readiness`);
  passed(health.worker, `${name} worker readiness`);
  passed(stage.processOwnership, `${name} processOwnership`);
  passed(stage.resourceCleanup, `${name} resourceCleanup`);
  return { health: { api: health.api, kernel: health.kernel, worker: health.worker }, processOwnership: stage.processOwnership, processes, resourceCleanup: stage.resourceCleanup, revision: stage.revision, supervisorId: stage.supervisorId };
}

// 校验真实部署运维记录的最小可审计事实；不接受日志片段或命令退出码替代运行时观察结果。
function validateEvidence(value) {
  if (value === null || typeof value !== "object") {
    fail("document must be an object");
  }
  const evidence = value;
  if (evidence.schemaVersion !== 1) {
    fail("schemaVersion must be 1");
  }
  stringField(evidence.deploymentId, "deploymentId");
  stringField(evidence.operator, "operator");
  stringField(evidence.startedAt, "startedAt");
  stringField(evidence.completedAt, "completedAt");
  if (evidence.status !== "passed") {
    fail("status must be passed");
  }
  const candidate = stageRecord(evidence.candidate, "candidate");
  const approved = stageRecord(evidence.approved, "approved");
  if (candidate.revision === approved.revision) {
    fail("candidate and approved revisions must differ");
  }
  const switchRecord = evidence.switch;
  if (switchRecord === null || typeof switchRecord !== "object") {
    fail("switch must be an object");
  }
  passed(switchRecord.candidateStopped, "switch candidateStopped");
  passed(switchRecord.sharedPortsReused, "switch sharedPortsReused");
  passed(switchRecord.oldProcessesGone, "switch oldProcessesGone");
  passed(evidence.resourceCleanup, "resourceCleanup");
  return { approved, candidate, completedAt: evidence.completedAt, deploymentId: evidence.deploymentId, operator: evidence.operator, resourceCleanup: evidence.resourceCleanup, schemaVersion: evidence.schemaVersion, startedAt: evidence.startedAt, status: evidence.status, switch: { candidateStopped: switchRecord.candidateStopped, oldProcessesGone: switchRecord.oldProcessesGone, sharedPortsReused: switchRecord.sharedPortsReused } };
}

export async function main() {
  if (process.versions.node.split(".")[0] !== "24") {
    throw new Error("L3 target supervisor evidence requires Node.js 24");
  }
  const evidence = validateEvidence(JSON.parse(await readFile(inputPath, "utf8")));
  await writeFile(reportPath, `${JSON.stringify({ generatedAt: new Date().toISOString(), evidence, status: "passed" }, null, 2)}\n`, "utf8");
  process.stdout.write(`validated target supervisor evidence: ${reportPath}\n`);
}

const isDirectExecution = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectExecution) {
  await main();
}

export { validateEvidence };
