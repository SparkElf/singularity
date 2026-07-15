import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { afterEach, test } from "node:test";
import assert from "node:assert/strict";

import { createUpstreamImpact } from "./report-upstream-impact.mjs";

const temporaryDirectories = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

function runGit(root, ...args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

function write(root, path, contents) {
  const absolutePath = resolve(root, path);
  mkdirSync(dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, contents, "utf8");
}

function commitAll(root, message) {
  runGit(root, "add", ".");
  runGit(root, "commit", "-m", message);
  return runGit(root, "rev-parse", "HEAD");
}

function createRepositoryFixture() {
  const root = mkdtempSync(resolve(tmpdir(), "singularity-upstream-impact-"));
  temporaryDirectories.push(root);
  runGit(root, "init", "--initial-branch=master");
  runGit(root, "config", "user.email", "impact-test@example.invalid");
  runGit(root, "config", "user.name", "Impact Test");

  write(root, "README.md", "baseline\n");
  const baselineCommit = commitAll(root, "upstream baseline");
  write(root, "app/candidate.txt", "candidate\n");
  const candidateCommit = commitAll(root, "upstream candidate");
  runGit(root, "update-ref", "refs/remotes/upstream/master", candidateCommit);

  runGit(root, "switch", "--quiet", "--create", "fork", baselineCommit);
  write(root, "enterprise/fork.txt", "fork\n");
  const forkCommit = commitAll(root, "fork change");

  return {
    baseline: {
      upstreamBranch: "master",
      upstreamCandidateCommit: candidateCommit,
      upstreamCommit: baselineCommit,
      upstreamRepository: "https://github.com/siyuan-note/siyuan.git",
    },
    candidateCommit,
    forkCommit,
    root,
  };
}

test("the same upstream Git inputs produce byte-identical impact reports", () => {
  const { baseline, candidateCommit, forkCommit, root } = createRepositoryFixture();

  const first = createUpstreamImpact(root, baseline);
  const second = createUpstreamImpact(root, baseline);

  assert.equal(JSON.stringify(second), JSON.stringify(first));
  assert.equal(first.report.candidateCommit, candidateCommit);
  assert.equal(first.report.forkHeadCommit, forkCommit);
  assert.deepEqual(first.report.changedPaths, ["app/candidate.txt"]);
  assert.deepEqual(first.report.moduleCounts, { app: 1 });
});

test("a fork-only commit cannot be reported as an upstream candidate", () => {
  const { baseline, forkCommit, root } = createRepositoryFixture();

  assert.throws(
    () => createUpstreamImpact(root, baseline, forkCommit),
    /git merge-base --is-ancestor .* failed/,
  );
});

test("a fork-only commit cannot be reported as the upstream baseline", () => {
  const { baseline, candidateCommit, forkCommit, root } = createRepositoryFixture();

  assert.throws(
    () => createUpstreamImpact(root, {
      ...baseline,
      upstreamCommit: forkCommit,
    }, candidateCommit),
    /git merge-base --is-ancestor .* failed/,
  );
});
