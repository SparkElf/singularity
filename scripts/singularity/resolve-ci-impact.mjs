import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";

const FULL_LANES = {
  governance: true,
  native_app: true,
  enterprise_static: true,
  integration: true,
  browser: true,
  e2e: true,
  package: true,
  upstream: true,
};

const GOVERNANCE_ONLY_PREFIXES = [
  ".agents/",
  ".github/",
  "docs/",
  "output/md/",
  "plans/",
  "scripts/singularity/",
  "diffs/",
  "upstream/",
];

const GOVERNANCE_ONLY_FILES = new Set([
  ".dockerignore",
  ".gitignore",
  ".gitattributes",
  "AGENTS.md",
  "CHANGELOG.md",
  "CODE_OF_CONDUCT.md",
  "CONTRIBUTING.md",
  "DIFFS.md",
  "LICENSE",
  "NOTICE",
  "README.md",
  "README.zh-CN.md",
  "README.ja.md",
  "README.tr.md",
]);

function fullPlan(reason, changedFiles) {
  return {
    mode: "full",
    reason,
    changed_count: changedFiles.length,
    ...FULL_LANES,
  };
}

function isGovernanceOnly(path) {
  return GOVERNANCE_ONLY_FILES.has(path) || GOVERNANCE_ONLY_PREFIXES.some((prefix) => path.startsWith(prefix));
}

export function resolveCiImpact(changedFiles, { forceFull = false } = {}) {
  const files = [...new Set(changedFiles.filter(Boolean))].sort();
  if (forceFull) return fullPlan("forced full validation", files);
  if (files.length === 0) return fullPlan("no changed paths were resolved; fail open", files);

  if (files.includes("upstream/baseline.yaml") || files.includes("config/upstream-baseline.json")) {
    return fullPlan("upstream baseline metadata changed", files);
  }

  const plan = {
    mode: "targeted",
    reason: "recognized changed paths",
    changed_count: files.length,
    governance: true,
    native_app: false,
    enterprise_static: false,
    integration: false,
    browser: false,
    e2e: false,
    package: false,
    upstream: files.some((path) => path.startsWith("diffs/upstream/") || path.startsWith("upstream/")),
  };

  for (const path of files) {
    if (isGovernanceOnly(path)) continue;

    if (path.startsWith("app/")) {
      plan.native_app = true;
      plan.enterprise_static = true;
      plan.browser = true;
      plan.e2e = true;
      continue;
    }

    if (path.startsWith("kernel/")) {
      plan.integration = true;
      plan.e2e = true;
      plan.package = true;
      continue;
    }

    if (path.startsWith("enterprise/apps/web/")) {
      plan.enterprise_static = true;
      plan.browser = true;
      plan.e2e = true;
      continue;
    }

    if (
      path.startsWith("enterprise/apps/api/") ||
      path.startsWith("enterprise/apps/worker/") ||
      path.startsWith("enterprise/packages/")
    ) {
      plan.enterprise_static = true;
      plan.integration = true;
      plan.e2e = true;
      continue;
    }

    if (
      path === "enterprise/package.json" ||
      path === "enterprise/pnpm-lock.yaml" ||
      path === "enterprise/pnpm-workspace.yaml" ||
      path === "enterprise/eslint.config.mjs" ||
      path === "enterprise/tsconfig.base.json" ||
      path === "enterprise/tsconfig.node.json" ||
      path.startsWith("enterprise/scripts/")
    ) {
      plan.enterprise_static = true;
      plan.integration = true;
      plan.browser = true;
      plan.e2e = true;
      continue;
    }

    if (path.startsWith("config/")) {
      plan.integration = true;
      plan.e2e = true;
      continue;
    }

    if (path.startsWith("Dockerfile") || path.endsWith(".dockerfile") || path.startsWith("deploy/")) {
      plan.package = true;
      continue;
    }

    return fullPlan(`unclassified path ${path}; fail open`, files);
  }

  if (Object.entries(plan).every(([key, value]) => ["mode", "reason", "changed_count", "governance", "upstream"].includes(key) || value === false)) {
    plan.reason = "governance or documentation only";
  }

  return plan;
}

function parseArgs(argv) {
  const parsed = { base: "", head: "", githubOutput: "", forceFull: false, json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--base") parsed.base = argv[++index] ?? "";
    else if (value === "--head") parsed.head = argv[++index] ?? "";
    else if (value === "--github-output") parsed.githubOutput = argv[++index] ?? "";
    else if (value === "--force-full") parsed.forceFull = true;
    else if (value === "--json") parsed.json = true;
    else throw new Error(`Unknown argument: ${value}`);
  }
  if (!parsed.base || !parsed.head) throw new Error("--base and --head are required");
  return parsed;
}

function changedFiles(base, head) {
  return execFileSync("git", ["diff", "--name-only", `${base}...${head}`], { encoding: "utf8" })
    .split(/\r?\n/)
    .filter(Boolean);
}

function writeGitHubOutput(path, plan) {
  for (const [key, value] of Object.entries(plan)) {
    appendFileSync(path, `${key}=${String(value)}\n`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const files = changedFiles(args.base, args.head);
    const plan = resolveCiImpact(files, { forceFull: args.forceFull });
    if (args.githubOutput) writeGitHubOutput(args.githubOutput, plan);
    if (args.json || !args.githubOutput) console.log(JSON.stringify({ changed_files: files, ...plan }, null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
