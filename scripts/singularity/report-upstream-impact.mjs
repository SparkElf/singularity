import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const enterpriseRequire = createRequire(resolve(repositoryRoot, "enterprise/package.json"));
const { parseDocument } = enterpriseRequire("yaml");

function runGit(root, args, acceptedStatuses = [0]) {
  const result = spawnSync("git", args, {
    cwd: root,
    encoding: "utf8",
  });
  if (!acceptedStatuses.includes(result.status ?? -1)) {
    throw new Error(result.stderr.trim() || `git ${args.join(" ")} failed`);
  }
  return { status: result.status, stdout: result.stdout };
}

function parseArguments(args) {
  const options = {
    candidate: undefined,
    json: undefined,
    markdown: undefined,
  };

  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if (value === undefined || !["--candidate", "--json", "--markdown"].includes(name)) {
      throw new Error(`Invalid argument: ${name ?? ""}`);
    }
    options[name.slice(2)] = value;
  }
  return options;
}

function moduleForPath(path) {
  if (path.startsWith("app/")) return "app";
  if (path.startsWith("kernel/")) return "kernel";
  if (path.startsWith("enterprise/")) return "enterprise";
  if (path.startsWith("docs/")) return "docs";
  if (path.startsWith(".github/")) return "github";
  if (path.startsWith("scripts/")) return "scripts";
  return "repository";
}

function reviewSignalForPath(path) {
  if (/\/(ai|agent)(\/|\.|$)/i.test(path) || path.startsWith("app/src/ai/")) return "ai-agent";
  if (/\/mcp(\/|\.|$)/i.test(path)) return "mcp";
  if (/\/(search|fts)(\/|\.|$)/i.test(path)) return "search-discovery";
  if (/\/(auth|identity|oauth|oidc)(\/|\.|$)/i.test(path)) return "identity-auth";
  if (/\/(sync|collab|share|permission)(\/|\.|$)/i.test(path)) return "sharing-collaboration";
  if (path.startsWith("app/src/protyle/") || path.startsWith("kernel/model/")) return "editor-content";
  if (path.startsWith("scripts/") || path.startsWith(".github/") || path.startsWith("Dockerfile")) return "packaging-release";
  return null;
}

function pathMatchesPattern(path, pattern) {
  if (pattern.endsWith("/**")) return path.startsWith(pattern.slice(0, -3));
  return path === pattern;
}

function activeRecords(registry) {
  return Array.isArray(registry?.records)
    ? registry.records.filter((record) => record?.status === "active")
    : [];
}

function divergenceImpact(changedPaths, registry) {
  return activeRecords(registry)
    .map((record) => {
      const patterns = Array.isArray(record.paths) ? record.paths : [];
      const matchedPaths = changedPaths.filter((path) => patterns.some((pattern) => pathMatchesPattern(path, pattern)));
      return matchedPaths.length > 0
        ? { id: record.id, title: record.title, owner: record.owner, matchedPaths }
        : null;
    })
    .filter(Boolean);
}

function productReview(changedPaths, registry) {
  const signals = [...new Set(changedPaths.map(reviewSignalForPath).filter(Boolean))].sort();
  if (signals.length === 0) return { signals, records: [] };
  return {
    signals,
    records: activeRecords(registry).map((record) => ({
      id: record.id,
      title: record.title,
      owner: record.owner,
      action: "review-for-upstream-overlap",
    })),
  };
}

function writeOutput(root, path, contents) {
  const absolutePath = resolve(root, path);
  mkdirSync(dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, contents, "utf8");
}

function normalizeBaseline(baseline) {
  if (baseline?.baseline?.commit) {
    return {
      upstreamBranch: baseline.upstream?.branch,
      upstreamCommit: baseline.baseline.commit,
      upstreamRepository: baseline.upstream?.url ?? baseline.upstream?.repository,
    };
  }
  return baseline;
}

export function createUpstreamImpact(root, rawBaseline, candidate, governance = {}) {
  const baseline = normalizeBaseline(rawBaseline);
  const commitPattern = /^[0-9a-f]{40}$/;
  if (!commitPattern.test(baseline.upstreamCommit ?? "")) {
    throw new Error("Upstream baseline must be a full commit SHA");
  }

  const upstreamRef = `refs/remotes/upstream/${baseline.upstreamBranch}`;
  const requestedCandidate = candidate ?? rawBaseline?.upstreamCandidateCommit ?? upstreamRef;
  const baselineCommit = runGit(root, ["rev-parse", `${baseline.upstreamCommit}^{commit}`]).stdout.trim();
  const candidateCommit = runGit(root, ["rev-parse", `${requestedCandidate}^{commit}`]).stdout.trim();
  const headCommit = runGit(root, ["rev-parse", "HEAD^{commit}"]).stdout.trim();
  runGit(root, ["show-ref", "--verify", upstreamRef]);
  runGit(root, ["merge-base", "--is-ancestor", baselineCommit, upstreamRef]);
  runGit(root, ["merge-base", "--is-ancestor", candidateCommit, upstreamRef]);
  runGit(root, ["merge-base", "--is-ancestor", baselineCommit, candidateCommit]);

  const changedPaths = runGit(root, ["diff", "--name-only", "-z", baselineCommit, candidateCommit])
    .stdout.split("\u0000")
    .filter(Boolean)
    .sort();
  const moduleCounts = {};
  for (const path of changedPaths) {
    const module = moduleForPath(path);
    moduleCounts[module] = (moduleCounts[module] ?? 0) + 1;
  }

  const mergeResult = runGit(
    root,
    ["merge-tree", "--write-tree", "--name-only", "--no-messages", "-z", headCommit, candidateCommit],
    [0, 1],
  );
  const mergeFields = mergeResult.stdout.split("\u0000").filter(Boolean);
  const mergeTree = mergeFields.shift() ?? null;
  const conflictPaths = mergeFields.sort();
  const impactedDivergences = divergenceImpact(changedPaths, governance.upstreamRegistry);
  const productCapabilityReview = productReview(changedPaths, governance.productRegistry);
  const report = {
    baselineCommit,
    candidateCommit,
    changedFileCount: changedPaths.length,
    changedPaths,
    forkHeadCommit: headCommit,
    merge: {
      clean: mergeResult.status === 0,
      conflictCount: conflictPaths.length,
      conflictPaths,
      tree: mergeTree,
    },
    moduleCounts,
    impactedDivergences,
    productCapabilityReview,
    promotionRequired: candidateCommit !== baselineCommit,
    upstreamBranch: baseline.upstreamBranch,
    upstreamRepository: baseline.upstreamRepository,
  };

  const moduleRows = Object.entries(moduleCounts)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([module, count]) => `| ${module} | ${String(count)} |`)
    .join("\n");
  const conflictRows = conflictPaths.length === 0
    ? "- None"
    : conflictPaths.map((path) => `- \`${path}\``).join("\n");
  const divergenceRows = impactedDivergences.length === 0
    ? "- None"
    : impactedDivergences.map((record) => `- \`${record.id}\` (${record.owner}): ${String(record.matchedPaths.length)} overlapping path(s)`).join("\n");
  const capabilityRows = productCapabilityReview.signals.length === 0
    ? "- No product-overlap signals detected from paths."
    : [
        `- Signals: ${productCapabilityReview.signals.map((signal) => `\`${signal}\``).join(", ")}`,
        ...productCapabilityReview.records.map((record) => `- Review \`${record.id}\` (${record.owner}) for possible upstream replacement or overlap.`),
      ].join("\n");
  const markdown = `# Singularity Upstream Impact Report

- Baseline: \`${baselineCommit}\`
- Candidate: \`${candidateCommit}\`
- Singularity HEAD: \`${headCommit}\`
- Changed files: ${String(changedPaths.length)}
- Merge result: ${report.merge.clean ? "clean" : `${String(conflictPaths.length)} conflict(s)`}
- Promotion review required: ${report.promotionRequired ? "yes" : "no"}

## Module Impact

| Module | Changed files |
| --- | ---: |
${moduleRows}

## Active Divergence Overlap

${divergenceRows}

## Product Capability Review

${capabilityRows}

## Conflict Paths

${conflictRows}
`;

  return { markdown, report };
}

function readYaml(path) {
  const document = parseDocument(readFileSync(path, "utf8"), { prettyErrors: true, uniqueKeys: true });
  if (document.errors.length > 0) throw new Error(document.errors.map((error) => error.message).join("; "));
  return document.toJS();
}

function main() {
  const baseline = readYaml(resolve(repositoryRoot, "upstream/baseline.yaml"));
  const options = parseArguments(process.argv.slice(2));
  const governance = {
    upstreamRegistry: existsSync(resolve(repositoryRoot, "diffs/upstream/registry.yaml"))
      ? readYaml(resolve(repositoryRoot, "diffs/upstream/registry.yaml"))
      : undefined,
    productRegistry: existsSync(resolve(repositoryRoot, "diffs/product/registry.yaml"))
      ? readYaml(resolve(repositoryRoot, "diffs/product/registry.yaml"))
      : undefined,
  };
  const { markdown, report } = createUpstreamImpact(repositoryRoot, baseline, options.candidate, governance);

  if (options.json !== undefined) {
    writeOutput(repositoryRoot, options.json, `${JSON.stringify(report, null, 2)}\n`);
  }
  if (options.markdown !== undefined) {
    writeOutput(repositoryRoot, options.markdown, markdown);
  }
  if (options.json === undefined && options.markdown === undefined) {
    process.stdout.write(markdown);
  }
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  main();
}
