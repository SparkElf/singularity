import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, "../..");

const readJson = (path) => JSON.parse(readFileSync(resolve(repositoryRoot, path), "utf8"));
const runGit = (...args) => execFileSync("git", args, {
  cwd: repositoryRoot,
  encoding: "utf8",
}).trim();
const gitSucceeds = (...args) => spawnSync("git", args, {
  cwd: repositoryRoot,
  encoding: "utf8",
}).status === 0;

const baseline = readJson("config/upstream-baseline.json");
const appPackage = readJson("app/package.json");
const goModule = readFileSync(resolve(repositoryRoot, "kernel/go.mod"), "utf8");
const goVersion = goModule.match(/^go\s+(\S+)$/m)?.[1];
const upstreamUrl = runGit("remote", "get-url", "upstream");

const checks = [
  ["upstream remote", upstreamUrl === baseline.upstreamRepository, upstreamUrl],
  ["upstream commit", gitSucceeds("merge-base", "--is-ancestor", baseline.upstreamCommit, "HEAD"), runGit("rev-parse", "HEAD")],
  ["upstream version", appPackage.version === baseline.upstreamVersion, appPackage.version],
  ["Go version", goVersion === baseline.goVersion, goVersion],
  ["package manager", appPackage.packageManager === baseline.packageManager, appPackage.packageManager],
  ["architecture document", existsSync(resolve(repositoryRoot, baseline.architectureDocument)), baseline.architectureDocument],
];

const failures = checks.filter(([, passed]) => !passed);
for (const [name, passed, actual] of checks) {
  process.stdout.write(`${passed ? "PASS" : "FAIL"} ${name}: ${actual}\n`);
}

if (failures.length > 0) {
  process.exitCode = 1;
}
