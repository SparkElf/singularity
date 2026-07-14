import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, "../..");
const enterpriseRequire = createRequire(resolve(repositoryRoot, "enterprise/package.json"));
const { parseDocument } = enterpriseRequire("yaml");

const readJson = (path) => JSON.parse(readFileSync(resolve(repositoryRoot, path), "utf8"));
const readText = (path) => readFileSync(resolve(repositoryRoot, path), "utf8");
const runGit = (...args) => execFileSync("git", args, {
  cwd: repositoryRoot,
  encoding: "utf8",
}).trim();
const gitSucceeds = (...args) => spawnSync("git", args, {
  cwd: repositoryRoot,
  encoding: "utf8",
}).status === 0;

function canonicalGitUrl(value) {
  return value.trim().replace(/\/+$/, "").replace(/\.git$/, "");
}

function githubRepositoryFromRemote(value) {
  const sshMatch = value.match(/^git@github\.com:([^/]+\/[^/]+?)(?:\.git)?$/);
  if (sshMatch !== null) {
    return sshMatch[1];
  }

  try {
    const url = new URL(value);
    if (url.hostname !== "github.com") {
      return null;
    }
    return url.pathname.replace(/^\//, "").replace(/\/+$/, "").replace(/\.git$/, "");
  } catch {
    return null;
  }
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(resolve(repositoryRoot, path))).digest("hex");
}

function validateWorkflow(path, expectedRepositoryGuard) {
  const document = parseDocument(readText(`.github/workflows/${path}`), {
    prettyErrors: true,
    uniqueKeys: true,
  });
  if (document.errors.length > 0) {
    return document.errors.map((error) => error.message);
  }

  const workflow = document.toJS();
  const failures = [];
  const permissions = workflow?.permissions;
  if (
    permissions === null ||
    typeof permissions !== "object" ||
    Array.isArray(permissions) ||
    Object.keys(permissions).length !== 1 ||
    permissions.contents !== "read"
  ) {
    failures.push("workflow permissions must be exactly contents: read");
  }

  const jobs = workflow?.jobs;
  if (jobs === null || typeof jobs !== "object" || Array.isArray(jobs) || Object.keys(jobs).length === 0) {
    failures.push("workflow must define at least one job");
    return failures;
  }

  for (const [jobName, job] of Object.entries(jobs)) {
    if (job === null || typeof job !== "object" || Array.isArray(job)) {
      failures.push(`job ${jobName} must be a mapping`);
      continue;
    }
    if (job.if !== expectedRepositoryGuard) {
      failures.push(`job ${jobName} must use the exact fork repository guard`);
    }
    if (job.permissions !== undefined) {
      failures.push(`job ${jobName} must not widen workflow permissions`);
    }

    const steps = Array.isArray(job.steps) ? job.steps : [];
    for (const [index, step] of steps.entries()) {
      if (step === null || typeof step !== "object" || typeof step.uses !== "string") {
        continue;
      }
      if (!/^[^@\s]+@[0-9a-f]{40}$/.test(step.uses)) {
        failures.push(`job ${jobName} step ${String(index + 1)} must pin uses to a full commit SHA`);
      }
    }
  }

  return failures;
}

const baseline = readJson("config/upstream-baseline.json");
const appPackage = readJson("app/package.json");
const goModule = readText("kernel/go.mod");
const goVersion = goModule.match(/^go\s+(\S+)$/m)?.[1];
const originUrl = runGit("remote", "get-url", "origin");
const upstreamUrl = runGit("remote", "get-url", "upstream");
const upstreamPushUrl = runGit("remote", "get-url", "--push", "upstream");
const headCommit = runGit("rev-parse", "HEAD");
const notice = existsSync(resolve(repositoryRoot, baseline.noticeFile)) ? readText(baseline.noticeFile) : "";
const workflowDirectory = resolve(repositoryRoot, ".github/workflows");
const actualWorkflows = readdirSync(workflowDirectory)
  .filter((path) => /\.ya?ml$/.test(path))
  .sort();
const allowedWorkflows = [...baseline.allowedWorkflows].sort();
const expectedRepositoryGuard = "${{ github.repository == '" + baseline.forkRepository + "' }}";
const workflowFailures = actualWorkflows.flatMap((path) =>
  validateWorkflow(path, expectedRepositoryGuard).map((failure) => `${path}: ${failure}`),
);

const checks = [
  ["origin repository", githubRepositoryFromRemote(originUrl) === baseline.forkRepository, originUrl],
  [
    "upstream remote",
    canonicalGitUrl(upstreamUrl) === canonicalGitUrl(baseline.upstreamRepository),
    upstreamUrl,
  ],
  ["upstream push disabled", upstreamPushUrl === baseline.upstreamPushUrl, upstreamPushUrl],
  ["upstream branch", gitSucceeds("check-ref-format", "--branch", baseline.upstreamBranch), baseline.upstreamBranch],
  [
    "upstream commit",
    gitSucceeds("merge-base", "--is-ancestor", baseline.upstreamCommit, "HEAD"),
    headCommit,
  ],
  [
    "upstream candidate",
    gitSucceeds("cat-file", "-e", `${baseline.upstreamCandidateCommit}^{commit}`),
    baseline.upstreamCandidateCommit,
  ],
  ["upstream version", appPackage.version === baseline.upstreamVersion, appPackage.version],
  ["Go version", goVersion === baseline.goVersion, goVersion],
  ["package manager", appPackage.packageManager === baseline.packageManager, appPackage.packageManager],
  ["license identifier", baseline.license === "AGPL-3.0-or-later", baseline.license],
  ["license file", existsSync(resolve(repositoryRoot, baseline.licenseFile)), baseline.licenseFile],
  [
    "license hash",
    existsSync(resolve(repositoryRoot, baseline.licenseFile)) && sha256(baseline.licenseFile) === baseline.licenseSha256,
    existsSync(resolve(repositoryRoot, baseline.licenseFile)) ? sha256(baseline.licenseFile) : "missing",
  ],
  ["notice file", notice.length > 0, baseline.noticeFile],
  [
    "notice attribution",
    notice.includes(baseline.upstreamRepository) &&
      notice.includes(baseline.upstreamCommit) &&
      notice.includes(baseline.upstreamVersion) &&
      notice.includes("AGPL-3.0"),
    baseline.noticeFile,
  ],
  [
    "workflow allowlist",
    JSON.stringify(actualWorkflows) === JSON.stringify(allowedWorkflows),
    actualWorkflows.join(", "),
  ],
  [
    "workflow structure",
    workflowFailures.length === 0,
    workflowFailures.length === 0 ? "all jobs guarded and actions pinned" : workflowFailures.join("; "),
  ],
  [
    "architecture document",
    existsSync(resolve(repositoryRoot, baseline.architectureDocument)),
    baseline.architectureDocument,
  ],
];

const failures = checks.filter(([, passed]) => !passed);
for (const [name, passed, actual] of checks) {
  process.stdout.write(`${passed ? "PASS" : "FAIL"} ${name}: ${String(actual)}\n`);
}

if (failures.length > 0) {
  process.exitCode = 1;
}
