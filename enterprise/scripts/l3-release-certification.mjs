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
    const targetReport = JSON.parse(await readFile(targetSupervisorReportPath, "utf8"));
    if (targetReport.status === "passed" && targetReport.evidence?.resourceCleanup === "passed") {
      targetSupervisorCertification = "passed";
    } else {
      throw new Error("目标 supervisor 证据报告未达到 passed/resourceCleanup=passed");
    }
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

await main();
