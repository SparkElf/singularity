import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const baseline = JSON.parse(readFileSync(resolve(repositoryRoot, "config/upstream-baseline.json"), "utf8"));

function runGit(args, acceptedStatuses = [0]) {
  const result = spawnSync("git", args, {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
  if (!acceptedStatuses.includes(result.status ?? -1)) {
    throw new Error(result.stderr.trim() || `git ${args.join(" ")} failed`);
  }
  return { status: result.status, stdout: result.stdout };
}

function parseArguments(args) {
  const options = {
    candidate: baseline.upstreamCandidateCommit,
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

function writeOutput(path, contents) {
  const absolutePath = resolve(repositoryRoot, path);
  mkdirSync(dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, contents, "utf8");
}

const options = parseArguments(process.argv.slice(2));
const commitPattern = /^[0-9a-f]{40}$/;
if (!commitPattern.test(baseline.upstreamCommit) || !commitPattern.test(options.candidate)) {
  throw new Error("Upstream baseline and candidate must be full commit SHAs");
}

const baselineCommit = runGit(["rev-parse", `${baseline.upstreamCommit}^{commit}`]).stdout.trim();
const candidateCommit = runGit(["rev-parse", `${options.candidate}^{commit}`]).stdout.trim();
const headCommit = runGit(["rev-parse", "HEAD^{commit}"]).stdout.trim();
runGit(["merge-base", "--is-ancestor", baselineCommit, candidateCommit]);

const changedPaths = runGit(["diff", "--name-only", "-z", baselineCommit, candidateCommit])
  .stdout.split("\u0000")
  .filter(Boolean)
  .sort();
const moduleCounts = {};
for (const path of changedPaths) {
  const module = moduleForPath(path);
  moduleCounts[module] = (moduleCounts[module] ?? 0) + 1;
}

const mergeResult = runGit(
  ["merge-tree", "--write-tree", "--name-only", "--no-messages", "-z", headCommit, candidateCommit],
  [0, 1],
);
const mergeFields = mergeResult.stdout.split("\u0000").filter(Boolean);
const mergeTree = mergeFields.shift() ?? null;
const conflictPaths = mergeFields.sort();
const report = {
  baselineCommit,
  candidateCommit,
  changedFileCount: changedPaths.length,
  changedPaths,
  forkHeadCommit: headCommit,
  generatedAt: new Date().toISOString(),
  merge: {
    clean: mergeResult.status === 0,
    conflictCount: conflictPaths.length,
    conflictPaths,
    tree: mergeTree,
  },
  moduleCounts,
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
const markdown = `# Singularity Upstream Impact Report

- Baseline: \`${baselineCommit}\`
- Candidate: \`${candidateCommit}\`
- Fork HEAD: \`${headCommit}\`
- Changed files: ${String(changedPaths.length)}
- Merge result: ${report.merge.clean ? "clean" : `${String(conflictPaths.length)} conflict(s)`}

## Module Impact

| Module | Changed files |
| --- | ---: |
${moduleRows}

## Conflict Paths

${conflictRows}
`;

if (options.json !== undefined) {
  writeOutput(options.json, `${JSON.stringify(report, null, 2)}\n`);
}
if (options.markdown !== undefined) {
  writeOutput(options.markdown, markdown);
}
if (options.json === undefined && options.markdown === undefined) {
  process.stdout.write(markdown);
}
