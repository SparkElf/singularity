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

export const REQUIRED_L0_TRIGGER_PATHS = [
  ".dockerignore",
  ".github/**",
  "README*.md",
  "LICENSE",
  "NOTICE",
  "Dockerfile*",
  "app/**",
  "config/**",
  "docs/**",
  "enterprise/**",
  "kernel/**",
  "output/md/**",
  "plans/**",
  "scripts/singularity/**",
];

const readJson = (root, path) => JSON.parse(readFileSync(resolve(root, path), "utf8"));
const readText = (root, path) => readFileSync(resolve(root, path), "utf8");
const runGit = (root, ...args) => execFileSync("git", args, {
  cwd: root,
  encoding: "utf8",
}).trim();
const gitSucceeds = (root, ...args) => spawnSync("git", args, {
  cwd: root,
  encoding: "utf8",
}).status === 0;

function canonicalGitUrl(value) {
  const trimmed = value.trim();
  const sshMatch = trimmed.match(/^git@github\.com:([^/]+\/[^/]+?)(?:\.git)?$/);
  if (sshMatch !== null) {
    return `github.com/${sshMatch[1]}`;
  }

  try {
    const url = new URL(trimmed);
    const path = url.pathname.replace(/^\//, "").replace(/\/+$/, "").replace(/\.git$/, "");
    return url.hostname === "github.com"
      ? `github.com/${path}`
      : `${url.protocol}//${url.host}/${path}`;
  } catch {
    return trimmed.replace(/\/+$/, "").replace(/\.git$/, "");
  }
}

function hasEmbeddedCredentials(value) {
  try {
    const url = new URL(value);
    return url.username.length > 0 || url.password.length > 0;
  } catch {
    return false;
  }
}

function safeRemoteDisplay(value) {
  const trimmed = value.trim();
  if (/^git@github\.com:[^/]+\/[^/]+(?:\.git)?$/.test(trimmed) || trimmed === "DISABLED") {
    return trimmed;
  }
  try {
    const url = new URL(trimmed);
    return `${url.protocol}//${url.host}${url.pathname}`;
  } catch {
    return "<invalid remote URL>";
  }
}

function githubRepositoryFromRemote(value) {
  const sshMatch = value.match(/^git@github\.com:([^/]+\/[^/]+?)(?:\.git)?$/);
  if (sshMatch !== null) {
    return sshMatch[1];
  }

  try {
    const url = new URL(value);
    if (url.hostname !== "github.com" || hasEmbeddedCredentials(value)) {
      return null;
    }
    return url.pathname.replace(/^\//, "").replace(/\/+$/, "").replace(/\.git$/, "");
  } catch {
    return null;
  }
}

function sha256(root, path) {
  return createHash("sha256").update(readFileSync(resolve(root, path))).digest("hex");
}

export function validateWorkflowDocument(workflow, path, expectedRepositoryGuard) {
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

  if (path === "singularity-l0.yml") {
    for (const eventName of ["pull_request", "push"]) {
      const triggerPaths = workflow?.on?.[eventName]?.paths;
      if (!Array.isArray(triggerPaths)) {
        failures.push(`${eventName} must define paths`);
        continue;
      }
      for (const requiredPath of REQUIRED_L0_TRIGGER_PATHS) {
        if (!triggerPaths.includes(requiredPath)) {
          failures.push(`${eventName} paths must include ${requiredPath}`);
        }
      }
    }
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
    if (job.uses !== undefined) {
      failures.push(`job ${jobName} must not call a reusable workflow`);
    }

    const steps = Array.isArray(job.steps) ? job.steps : [];
    if (steps.length === 0) {
      failures.push(`job ${jobName} must define steps`);
    }
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

function validateWorkflow(root, path, expectedRepositoryGuard) {
  const document = parseDocument(readText(root, `.github/workflows/${path}`), {
    prettyErrors: true,
    uniqueKeys: true,
  });
  if (document.errors.length > 0) {
    return document.errors.map((error) => error.message);
  }

  return validateWorkflowDocument(document.toJS(), path, expectedRepositoryGuard);
}

export function verifyUpstreamBaseline(root = repositoryRoot, configuredBaseline) {
  const baseline = configuredBaseline ?? readJson(root, "config/upstream-baseline.json");
  const upstreamRef = `refs/remotes/upstream/${baseline.upstreamBranch}`;
  const baselineAppPackage = JSON.parse(runGit(root, "show", `${baseline.upstreamCommit}:app/package.json`));
  const baselineGoModule = runGit(root, "show", `${baseline.upstreamCommit}:kernel/go.mod`);
  const goVersion = baselineGoModule.match(/^go\s+(\S+)$/m)?.[1];
  const originUrl = runGit(root, "remote", "get-url", "origin");
  const upstreamUrl = runGit(root, "remote", "get-url", "upstream");
  const upstreamPushUrls = runGit(root, "remote", "get-url", "--push", "--all", "upstream")
    .split(/\r?\n/)
    .filter(Boolean);
  const headCommit = runGit(root, "rev-parse", "HEAD");
  const notice = existsSync(resolve(root, baseline.noticeFile)) ? readText(root, baseline.noticeFile) : "";
  const workflowDirectory = resolve(root, ".github/workflows");
  const actualWorkflows = readdirSync(workflowDirectory)
    .filter((path) => /\.ya?ml$/.test(path))
    .sort();
  const allowedWorkflows = [...baseline.allowedWorkflows].sort();
  const expectedRepositoryGuard = "${{ github.repository == '" + baseline.forkRepository + "' }}";
  const workflowFailures = actualWorkflows.flatMap((path) =>
    validateWorkflow(root, path, expectedRepositoryGuard).map((failure) => `${path}: ${failure}`),
  );
  const licenseExists = existsSync(resolve(root, baseline.licenseFile));
  const licenseHash = licenseExists ? sha256(root, baseline.licenseFile) : "missing";
  const originHasCredentials = hasEmbeddedCredentials(originUrl);
  const upstreamHasCredentials = hasEmbeddedCredentials(upstreamUrl);
  const upstreamPushDisplay = upstreamPushUrls.length === 0
    ? "<none>"
    : upstreamPushUrls.map(safeRemoteDisplay).join(", ");

  return [
    [
      "origin repository",
      !originHasCredentials && githubRepositoryFromRemote(originUrl) === baseline.forkRepository,
      safeRemoteDisplay(originUrl),
    ],
    [
      "upstream remote",
      !upstreamHasCredentials && canonicalGitUrl(upstreamUrl) === canonicalGitUrl(baseline.upstreamRepository),
      safeRemoteDisplay(upstreamUrl),
    ],
    [
      "upstream push disabled",
      baseline.upstreamPushUrl === "DISABLED" &&
        upstreamPushUrls.length === 1 &&
        upstreamPushUrls[0] === "DISABLED",
      upstreamPushDisplay,
    ],
    [
      "upstream branch",
      gitSucceeds(root, "check-ref-format", "--branch", baseline.upstreamBranch) &&
        gitSucceeds(root, "show-ref", "--verify", upstreamRef),
      upstreamRef,
    ],
    [
      "upstream baseline provenance",
      gitSucceeds(root, "merge-base", "--is-ancestor", baseline.upstreamCommit, upstreamRef),
      baseline.upstreamCommit,
    ],
    [
      "upstream candidate provenance",
      gitSucceeds(root, "merge-base", "--is-ancestor", baseline.upstreamCandidateCommit, upstreamRef),
      baseline.upstreamCandidateCommit,
    ],
    [
      "upstream candidate order",
      gitSucceeds(root, "merge-base", "--is-ancestor", baseline.upstreamCommit, baseline.upstreamCandidateCommit),
      `${baseline.upstreamCommit}..${baseline.upstreamCandidateCommit}`,
    ],
    [
      "integrated upstream baseline",
      gitSucceeds(root, "merge-base", "--is-ancestor", baseline.upstreamCommit, "HEAD"),
      headCommit,
    ],
    ["upstream version", baselineAppPackage.version === baseline.upstreamVersion, baselineAppPackage.version],
    ["Go version", goVersion === baseline.goVersion, goVersion],
    [
      "package manager",
      baselineAppPackage.packageManager === baseline.packageManager,
      baselineAppPackage.packageManager,
    ],
    ["license identifier", baseline.license === "AGPL-3.0-or-later", baseline.license],
    ["license file", licenseExists, baseline.licenseFile],
    ["license hash", licenseExists && licenseHash === baseline.licenseSha256, licenseHash],
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
      existsSync(resolve(root, baseline.architectureDocument)),
      baseline.architectureDocument,
    ],
  ];
}

function main() {
  const checks = verifyUpstreamBaseline();
  const failures = checks.filter(([, passed]) => !passed);
  for (const [name, passed, actual] of checks) {
    process.stdout.write(`${passed ? "PASS" : "FAIL"} ${name}: ${String(actual)}\n`);
  }
  if (failures.length > 0) {
    process.exitCode = 1;
  }
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  main();
}
