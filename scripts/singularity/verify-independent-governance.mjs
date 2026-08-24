import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, "../..");
const enterpriseRequire = createRequire(resolve(repositoryRoot, "enterprise/package.json"));
const { parseDocument } = enterpriseRequire("yaml");

const ALLOWED_STATUS = new Set(["planned", "active", "retired"]);
const REQUIRED_PR_HEADINGS = [
  "## At a glance",
  "## Product design",
  "## Architecture",
  "## Frontend design",
  "## Implementation",
  "## Code review",
  "## Test governance",
  "## Verification",
  "## Upstream impact",
  "## Diff records",
  "## Migration and security",
  "## Related issue",
];
const COMPATIBILITY_UPSTREAM_IDENTITY_FIELDS = [
  "upstreamRepository",
  "upstreamBranch",
  "upstreamCommit",
  "upstreamCandidateCommit",
  "upstreamVersion",
];

const readText = (path) => readFileSync(resolve(repositoryRoot, path), "utf8");
const readJson = (path) => JSON.parse(readText(path));

function parseYaml(contents, label) {
  const document = parseDocument(contents, { prettyErrors: true, uniqueKeys: true });
  if (document.errors.length > 0) {
    throw new Error(`${label}: ${document.errors.map((error) => error.message).join("; ")}`);
  }
  return document.toJS();
}

function readYaml(path) {
  return parseYaml(readText(path), path);
}

function runGit(...args) {
  return execFileSync("git", args, { cwd: repositoryRoot, encoding: "utf8" }).trim();
}

function requireString(value, label, failures) {
  if (typeof value !== "string" || value.trim().length === 0) {
    failures.push(`${label} must be a non-empty string`);
  }
}

function validateRegistry(path, kind, baselineCommit, failures) {
  const registry = readYaml(path);
  if (registry?.version !== 1 || !Array.isArray(registry?.records)) {
    failures.push(`${path} must declare version: 1 and a records array`);
    return;
  }

  const ids = new Set();
  for (const [index, record] of registry.records.entries()) {
    const prefix = `${path} record ${String(index + 1)}`;
    requireString(record?.id, `${prefix} id`, failures);
    requireString(record?.title, `${prefix} title`, failures);
    requireString(record?.owner, `${prefix} owner`, failures);
    requireString(record?.compatibility, `${prefix} compatibility`, failures);
    if (!ALLOWED_STATUS.has(record?.status)) {
      failures.push(`${prefix} status must be planned, active, or retired`);
    }
    if (typeof record?.id === "string") {
      if (ids.has(record.id)) failures.push(`${path} contains duplicate id ${record.id}`);
      ids.add(record.id);
    }
    if (!Array.isArray(record?.paths) || record.paths.length === 0) {
      failures.push(`${prefix} paths must be a non-empty array`);
    }
    if (!Array.isArray(record?.verification) || record.verification.length === 0) {
      failures.push(`${prefix} verification must be a non-empty array`);
    }
    if (!Array.isArray(record?.capability) || record.capability.length === 0) {
      failures.push(`${prefix} capability must be a non-empty array`);
    }

    if (kind === "upstream") {
      if (record?.source?.repository !== "siyuan-note/siyuan") {
        failures.push(`${prefix} source.repository must be siyuan-note/siyuan`);
      }
      if (record?.status === "active" && record?.source?.baseline_commit !== baselineCommit) {
        failures.push(`${prefix} active baseline_commit must match upstream/baseline.yaml`);
      }
    } else if (record?.source?.relationship !== "product-owned") {
      failures.push(`${prefix} source.relationship must be product-owned`);
    }
  }
}

function governanceRangeFromEnvironment() {
  const base = process.env.SINGULARITY_GOVERNANCE_BASE_SHA?.trim();
  const head = process.env.SINGULARITY_GOVERNANCE_HEAD_SHA?.trim();
  return base && head ? { base, head } : null;
}

function changedFilesFromEnvironment() {
  const range = governanceRangeFromEnvironment();
  if (range === null) return [];
  return runGit("diff", "--name-only", `${range.base}...${range.head}`).split(/\r?\n/).filter(Boolean);
}

function readJsonAtRef(ref, path) {
  return JSON.parse(runGit("show", `${ref}:${path}`));
}

function readYamlAtRef(ref, path) {
  return parseYaml(runGit("show", `${ref}:${path}`), `${ref}:${path}`);
}

export function compatibilityUpstreamIdentity(value) {
  return Object.fromEntries(COMPATIBILITY_UPSTREAM_IDENTITY_FIELDS.map((field) => [field, value?.[field] ?? null]));
}

export function canonicalUpstreamIdentity(value) {
  return {
    repository: value?.upstream?.repository ?? null,
    branch: value?.upstream?.branch ?? null,
    version: value?.baseline?.version ?? null,
    tag: value?.baseline?.tag ?? null,
    commit: value?.baseline?.commit ?? null,
  };
}

function identitiesDiffer(left, right) {
  return JSON.stringify(left) !== JSON.stringify(right);
}

function upstreamIdentityChangedFromEnvironment(changedFiles) {
  const range = governanceRangeFromEnvironment();
  if (range === null) return false;

  try {
    if (changedFiles.includes("upstream/baseline.yaml")) {
      const before = canonicalUpstreamIdentity(readYamlAtRef(range.base, "upstream/baseline.yaml"));
      const after = canonicalUpstreamIdentity(readYamlAtRef(range.head, "upstream/baseline.yaml"));
      if (identitiesDiffer(before, after)) return true;
    }

    if (changedFiles.includes("config/upstream-baseline.json")) {
      const before = compatibilityUpstreamIdentity(readJsonAtRef(range.base, "config/upstream-baseline.json"));
      const after = compatibilityUpstreamIdentity(readJsonAtRef(range.head, "config/upstream-baseline.json"));
      if (identitiesDiffer(before, after)) return true;
    }
  } catch {
    // When identity metadata cannot be read at either side of the range, fail closed
    // and require the explicit upstream registry update instead of silently accepting it.
    return true;
  }

  return false;
}

export function verifyIndependentGovernance() {
  const failures = [];
  const requiredFiles = [
    ".agents/README.md",
    ".agents/skills/singularity-product-design/SKILL.md",
    ".agents/skills/singularity-architecture-planning/SKILL.md",
    ".agents/skills/singularity-frontend-design/SKILL.md",
    ".agents/skills/singularity-implementation/SKILL.md",
    ".agents/skills/singularity-code-review/SKILL.md",
    ".agents/skills/singularity-test-governance/SKILL.md",
    ".agents/skills/singularity-verification/SKILL.md",
    ".agents/skills/singularity-maintain-diffs/SKILL.md",
    ".agents/skills/singularity-upstream-promotion/SKILL.md",
    ".agents/skills/singularity-pre-push-checks/SKILL.md",
    ".agents/skills/singularity-simplification-review/SKILL.md",
    ".agents/skills/singularity-pr-authoring/SKILL.md",
    ".agents/skills/singularity-release-notes/SKILL.md",
    ".github/PULL_REQUEST_TEMPLATE.md",
    "DIFFS.md",
    "docs/adr/0038-independent-repository-and-controlled-upstream-promotion.md",
    "docs/ci-cd.md",
    "docs/repository-rebuild.md",
    "docs/ui-governance.md",
    "upstream/baseline.yaml",
    "diffs/upstream/registry.yaml",
    "diffs/product/registry.yaml",
  ];
  for (const path of requiredFiles) {
    if (!existsSync(resolve(repositoryRoot, path))) failures.push(`missing required governance file: ${path}`);
  }
  if (failures.length > 0) return failures;

  const baseline = readYaml("upstream/baseline.yaml");
  const compatibilityBaseline = readJson("config/upstream-baseline.json");
  if (baseline?.version !== 1) failures.push("upstream/baseline.yaml must declare version: 1");
  if (baseline?.canonical?.repository !== "SparkElf/singularity") failures.push("canonical repository must be SparkElf/singularity");
  if (baseline?.canonical?.branch !== "main") failures.push("canonical branch must be main");
  if (baseline?.upstream?.repository !== "siyuan-note/siyuan") failures.push("baseline upstream repository must be siyuan-note/siyuan");
  if (baseline?.upstream?.branch !== "master") failures.push("baseline upstream branch must be master");
  if (!/^[0-9a-f]{40}$/.test(baseline?.baseline?.commit ?? "")) failures.push("baseline commit must be a full 40-character SHA");
  if (baseline?.tracking?.mode !== "controlled-promotion") failures.push("tracking mode must be controlled-promotion");
  if (baseline?.tracking?.automatic_merge !== false) failures.push("automatic upstream merge must remain false");
  if (baseline?.tracking?.require_pull_request !== true) failures.push("upstream promotion must require a pull request");
  if (baseline?.tracking?.require_full_governance !== true) failures.push("upstream promotion must require full governance");

  if (compatibilityBaseline?.canonicalRepository !== baseline?.canonical?.repository) {
    failures.push("config/upstream-baseline.json canonicalRepository must match upstream/baseline.yaml");
  }
  if (compatibilityBaseline?.canonicalBranch !== baseline?.canonical?.branch) {
    failures.push("config/upstream-baseline.json canonicalBranch must match upstream/baseline.yaml");
  }
  if (compatibilityBaseline?.upstreamBranch !== baseline?.upstream?.branch) {
    failures.push("config/upstream-baseline.json upstreamBranch must match upstream/baseline.yaml");
  }
  if (compatibilityBaseline?.upstreamCommit !== baseline?.baseline?.commit) {
    failures.push("config/upstream-baseline.json upstreamCommit must match upstream/baseline.yaml");
  }
  if (compatibilityBaseline?.upstreamVersion !== baseline?.baseline?.version) {
    failures.push("config/upstream-baseline.json upstreamVersion must match upstream/baseline.yaml");
  }

  const baselineCommit = baseline?.baseline?.commit;
  if (typeof baselineCommit === "string") {
    try {
      runGit("cat-file", "-e", `${baselineCommit}^{commit}`);
      runGit("merge-base", "--is-ancestor", baselineCommit, "HEAD");
    } catch {
      failures.push(`baseline commit ${baselineCommit} must exist in and be an ancestor of HEAD`);
    }
  }

  validateRegistry("diffs/upstream/registry.yaml", "upstream", baselineCommit, failures);
  validateRegistry("diffs/product/registry.yaml", "product", baselineCommit, failures);

  const prTemplate = readText(".github/PULL_REQUEST_TEMPLATE.md");
  for (const heading of REQUIRED_PR_HEADINGS) {
    if (!prTemplate.includes(heading)) failures.push(`PR template is missing required heading: ${heading}`);
  }

  const changedFiles = changedFilesFromEnvironment();
  if (changedFiles.some((path) => path.startsWith("app/") || path.startsWith("kernel/"))) {
    if (!changedFiles.includes("diffs/upstream/registry.yaml")) {
      failures.push("changes to app/** or kernel/** must update diffs/upstream/registry.yaml in the same pull request");
    }
  }
  if (upstreamIdentityChangedFromEnvironment(changedFiles) && !changedFiles.includes("diffs/upstream/registry.yaml")) {
    failures.push("an upstream identity or promoted baseline change must update diffs/upstream/registry.yaml");
  }

  return failures;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const failures = verifyIndependentGovernance();
  if (failures.length > 0) {
    console.error("Independent repository governance failed:\n" + failures.map((failure) => `- ${failure}`).join("\n"));
    process.exit(1);
  }
  console.log("Independent repository governance passed.");
}
