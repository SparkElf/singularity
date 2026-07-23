import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const enterpriseRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const reportPath = resolve(enterpriseRoot, "test-results/l4-governance/report.json");
const commands = [
  { command: "pnpm", args: ["test:architecture"], label: "Architecture and contract boundary" },
  { command: "pnpm", args: ["--filter", "@singularity/contracts", "test"], label: "Contracts contract runner" },
  { command: "pnpm", args: ["--filter", "@singularity/database", "typecheck"], label: "Prisma schema and database typecheck" },
  { command: "pnpm", args: ["--filter", "@singularity/api", "typecheck"], label: "Nest API typecheck" },
  { command: "pnpm", args: ["--filter", "@singularity/worker", "typecheck"], label: "Worker typecheck" },
  { command: "pnpm", args: ["--filter", "@singularity/web", "typecheck"], label: "React web typecheck" },
  { command: "pnpm", args: ["--filter", "@singularity/database", "test:integration"], label: "Prisma governance integration" },
  { command: "pnpm", args: ["--filter", "@singularity/api", "test"], label: "Nest governance HTTP and unit" },
  { command: "pnpm", args: ["--filter", "@singularity/worker", "test"], label: "Governance worker task integration" },
  { command: "pnpm", args: ["--filter", "@singularity/web", "test"], label: "React governance components" },
  { command: "pnpm", args: ["--filter", "@singularity/web", "test:browser-integration"], label: "Browser governance paths" },
  { command: "pnpm", args: ["verify:l3-production"], label: "L3 production regression aggregate" },
];

function runCommand(spec) {
  return new Promise((resolveCommand, rejectCommand) => {
    const startedAt = Date.now();
    const child = spawn(spec.command, spec.args, { cwd: enterpriseRoot, env: process.env, stdio: "inherit" });
    child.once("error", rejectCommand);
    child.once("close", (code, signal) => resolveCommand({ code, durationMilliseconds: Date.now() - startedAt, label: spec.label, signal }));
  });
}

async function main() {
  if (process.versions.node.split(".")[0] !== "24") {
    throw new Error("L4 governance verification requires Node.js 24");
  }
  const results = [];
  let failed = false;
  for (const command of commands) {
    let result;
    try {
      result = await runCommand(command);
    } catch (error) {
      result = { label: command.label, status: "spawn-failed", error: error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : { name: "UnknownError", message: String(error) } };
    }
    results.push(result);
    if (result.status === "spawn-failed" || result.code !== 0 || result.signal !== null) {
      failed = true;
      break;
    }
  }
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify({ generatedAt: new Date().toISOString(), results, status: failed ? "failed" : "automated-passed" }, null, 2)}\n`, "utf8");
  if (failed) process.exitCode = 1;
}

await main();
