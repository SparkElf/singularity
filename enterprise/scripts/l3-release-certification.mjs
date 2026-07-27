import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const enterpriseRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const reportPath = resolve(
  enterpriseRoot,
  process.env.SINGULARITY_L3_RELEASE_REPORT ??
    "test-results/l3-release-certification/report.json",
);
const targetSupervisorReportPath = resolve(
  enterpriseRoot,
  process.env.SINGULARITY_L3_TARGET_SUPERVISOR_REPORT ??
    "test-results/l3-release-certification/target-supervisor.json",
);

const commands = [
  {
    args: ["verify:l3-production"],
    caseIds: ["L3-REL-01"],
    command: "pnpm",
    label: "L3 technical verification",
  },
  {
    args: ["-C", "../kernel", "test", "-vet=off", "-tags", "fts5 sqlcipher releasecert", "./collab/..."],
    caseIds: ["L3-REL-06", "L3-REL-08"],
    command: "go",
    environment: { CGO_ENABLED: "1" },
    label: "Kernel release certification",
  },
  {
    args: ["--filter", "@singularity/api", "test:release-certification"],
    caseIds: ["L3-REL-02", "L3-REL-03", "L3-REL-04", "L3-REL-05", "L3-REL-07", "L3-REL-08", "L3-REL-09", "L3-REL-11", "L3-REL-12"],
    command: "pnpm",
    environment: { SINGULARITY_COLLABORATION_ENABLED: "1" },
    label: "API and WSS release certification",
  },
  {
    args: ["scripts/l3-supervisor-rollback-drill.mjs"],
    caseIds: ["L3-REL-10"],
    command: "node",
    environment: { SINGULARITY_COLLABORATION_ENABLED: "0" },
    label: "Controlled release rollback drill",
  },
  {
    // 直接调用 Playwright CLI，确保过滤器不会被 pnpm 的脚本转发层吞掉。
    args: [
      "--filter",
      "@singularity/web",
      "exec",
      "playwright",
      "test",
      "--config",
      "playwright.e2e.config.ts",
      "--grep",
      "@l3-release",
    ],
    caseIds: ["L3-REL-02", "L3-REL-07", "L3-REL-09", "L3-REL-11", "L3-REL-12"],
    command: "pnpm",
    environment: { CGO_ENABLED: "1", SINGULARITY_COLLABORATION_ENABLED: "1" },
    label: "Browser release certification",
  },
];

// 校验目标部署 supervisor 报告的三态合同：合法 pending 不替代真实认证，完整 passed 才能放行手工门禁。
function validateTargetSupervisorReport(report) {
  if (report === null || typeof report !== "object" || Array.isArray(report)) {
    throw new Error("目标 supervisor 证据报告必须是对象");
  }
  if (report.status === "passed") {
    if (
      report.evidence === null ||
      typeof report.evidence !== "object" ||
      Array.isArray(report.evidence) ||
      report.evidence.resourceCleanup !== "passed"
    ) {
      throw new Error("目标 supervisor 证据报告未达到 passed/resourceCleanup=passed");
    }
    return "passed";
  }
  if (report.status === "pending") {
    const requiredFields = {
      releaseDecision: "blocked-until-target-supervisor-evidence",
      scope: "target-deployment-supervisor",
    };
    for (const [field, expected] of Object.entries(requiredFields)) {
      if (report[field] !== expected) {
        throw new Error(`目标 supervisor pending 报告的 ${field} 不符合合同`);
      }
    }
    for (const field of ["reason", "requiredCommand", "requiredInput"]) {
      if (typeof report[field] !== "string" || report[field].trim().length === 0) {
        throw new Error(`目标 supervisor pending 报告缺少 ${field}`);
      }
    }
    return "pending";
  }
  throw new Error("目标 supervisor 证据报告 status 必须是 passed 或合法 pending");
}

// 运行已注册的标准 runner；本函数只负责生命周期和退出码，不读取或解释业务结果。
function runCommand(spec) {
  return new Promise((resolveCommand, rejectCommand) => {
    const startedAt = Date.now();
    const child = spawn(spec.command, spec.args, {
      cwd: enterpriseRoot,
      env: { ...process.env, ...spec.environment },
      stdio: "inherit",
    });
    child.once("error", (error) => {
      rejectCommand(error);
    });
    child.once("close", (code, signal) => {
      resolveCommand({
        caseIds: spec.caseIds,
        code,
        durationMilliseconds: Date.now() - startedAt,
        label: spec.label,
        signal,
      });
    });
  });
}

// 编排 L3 标准 runner 并汇总目标部署手工证据；自动化通过不替代真实 supervisor 观察结果。
async function main() {
  if (process.versions.node.split(".")[0] !== "24") {
    throw new Error("L3 release certification requires Node.js 24");
  }
  const results = [];
  let failed = false;
  for (const command of commands) {
    let result;
    try {
      result = await runCommand(command);
    } catch (error) {
      result = {
        error: error instanceof Error
          ? { name: error.name, message: error.message, stack: error.stack }
          : { name: "UnknownError", message: String(error), stack: undefined },
        label: command.label,
        caseIds: command.caseIds,
        status: "spawn-failed",
      };
    }
    results.push(result);
    if (result.status === "spawn-failed" || result.code !== 0 || result.signal !== null) {
      failed = true;
      break;
    }
  }
  let targetSupervisorCertification = "pending";
  try {
    targetSupervisorCertification = validateTargetSupervisorReport(
      JSON.parse(await readFile(targetSupervisorReportPath, "utf8")),
    );
  } catch (error) {
    const failure = error instanceof Error ? error : new Error("读取目标 supervisor 证据失败", { cause: error });
    if (error?.code !== "ENOENT") {
      throw failure;
    }
    process.stderr.write(`[l3-target-supervisor-pending] ${failure.stack ?? failure.message}\n`);
    // 目标部署未提供附件时保持 pending；本地 aggregate 不替代真实部署观察。
  }
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(
    reportPath,
    `${JSON.stringify({
      generatedAt: new Date().toISOString(),
      results,
      manualEvidence: {
        rollback: targetSupervisorCertification === "passed"
          ? "target-supervisor-passed"
          : results.some((result) =>
            result.label === "Controlled release rollback drill" &&
            result.code === 0 &&
            result.signal === null
          ) ? "local-supervisor-rehearsal;target-supervisor-manual-pending" : "pending-runbook-drill",
        rollbackReport: "test-results/l3-release-certification/rollback.json",
        targetSupervisorReport: "test-results/l3-release-certification/target-supervisor.json",
        targetDeploymentSupervisorCertification: targetSupervisorCertification,
        teardown: "automated-runner",
      },
      status: failed ? "failed" : "automated-passed",
    }, null, 2)}\n`,
    "utf8",
  );
  if (failed) {
    process.exitCode = 1;
  }
}

const isDirectExecution = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectExecution) {
  await main();
}

export { validateTargetSupervisorReport };
