import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { afterEach, test } from "node:test";
import assert from "node:assert/strict";

import {
  REQUIRED_L0_TRIGGER_PATHS,
  validateWorkflowDocument,
  verifyUpstreamBaseline,
} from "./verify-upstream-baseline.mjs";

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
  const root = mkdtempSync(resolve(tmpdir(), "singularity-upstream-baseline-"));
  temporaryDirectories.push(root);
  runGit(root, "init", "--initial-branch=master");
  runGit(root, "config", "user.email", "governance-test@example.invalid");
  runGit(root, "config", "user.name", "Governance Test");

  const license = "fixture AGPL-3.0 license\n";
  write(root, "app/package.json", `${JSON.stringify({ packageManager: "pnpm@11.9.0", version: "1.0.0" })}\n`);
  write(root, "kernel/go.mod", "module example.invalid/upstream\n\ngo 1.25.4\n");
  write(root, "LICENSE", license);
  const baselineCommit = commitAll(root, "upstream baseline");

  write(root, "upstream-candidate.txt", "candidate\n");
  const candidateCommit = commitAll(root, "upstream candidate");
  runGit(root, "update-ref", "refs/remotes/upstream/master", candidateCommit);

  write(root, "app/package.json", `${JSON.stringify({ packageManager: "canonical-only", version: "9.9.9" })}\n`);
  const canonicalCommit = commitAll(root, "canonical-only change");

  runGit(root, "remote", "add", "origin", "https://github.com/SparkElf/singularity.git");
  runGit(root, "remote", "add", "upstream", "https://github.com/siyuan-note/siyuan.git");
  runGit(root, "remote", "set-url", "--push", "upstream", "DISABLED");

  write(
    root,
    ".github/workflows/governance.yml",
    `name: Governance\non:\n  push:\npermissions:\n  contents: read\njobs:\n  verify:\n    if: \${{ github.repository == 'SparkElf/singularity' }}\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo verified\n`,
  );
  write(root, "docs/architecture.md", "# Architecture\n");
  write(
    root,
    "NOTICE",
    `https://github.com/siyuan-note/siyuan.git\n${baselineCommit}\n1.0.0\nAGPL-3.0\n`,
  );

  const baseline = {
    allowedWorkflows: ["governance.yml"],
    architectureDocument: "docs/architecture.md",
    canonicalRepository: "SparkElf/singularity",
    goVersion: "1.25.4",
    license: "AGPL-3.0-or-later",
    licenseFile: "LICENSE",
    licenseSha256: createHash("sha256").update(license).digest("hex"),
    noticeFile: "NOTICE",
    packageManager: "pnpm@11.9.0",
    upstreamBranch: "master",
    upstreamCandidateCommit: candidateCommit,
    upstreamCommit: baselineCommit,
    upstreamPushUrl: "DISABLED",
    upstreamRepository: "https://github.com/siyuan-note/siyuan.git",
    upstreamVersion: "1.0.0",
  };
  return { baseline, canonicalCommit, root };
}

test("upstream facts come from the remote branch and baseline commit", () => {
  const { baseline, root } = createRepositoryFixture();
  const checks = verifyUpstreamBaseline(root, baseline);

  assert.deepEqual(checks.filter(([, passed]) => !passed), []);
  assert.equal(checks.find(([name]) => name === "upstream version")?.[2], "1.0.0");
});

test("a canonical-only commit cannot be used as the upstream baseline", () => {
  const { baseline, canonicalCommit, root } = createRepositoryFixture();
  const checks = verifyUpstreamBaseline(root, {
    ...baseline,
    upstreamCommit: canonicalCommit,
  });
  const provenance = checks.find(([name]) => name === "upstream baseline provenance");

  assert.equal(provenance?.[1], false);
});

test("a canonical-only commit cannot be used as the upstream candidate", () => {
  const { baseline, canonicalCommit, root } = createRepositoryFixture();
  const checks = verifyUpstreamBaseline(root, {
    ...baseline,
    upstreamCandidateCommit: canonicalCommit,
  });
  const provenance = checks.find(([name]) => name === "upstream candidate provenance");

  assert.equal(provenance?.[1], false);
});

test("credential-bearing remotes fail without disclosing credentials", () => {
  const { baseline, root } = createRepositoryFixture();
  runGit(root, "remote", "set-url", "origin", "https://credential-sentinel@github.com/SparkElf/singularity.git");

  const originCheck = verifyUpstreamBaseline(root, baseline).find(([name]) => name === "origin repository");

  assert.equal(originCheck?.[1], false);
  assert.doesNotMatch(String(originCheck?.[2]), /credential-sentinel/);
});

test("upstream requires exactly one disabled push URL and redacts every diagnostic URL", () => {
  const { baseline, root } = createRepositoryFixture();
  runGit(
    root,
    "remote",
    "set-url",
    "--add",
    "--push",
    "upstream",
    "https://credential-one:secret-one@github.com/siyuan-note/siyuan.git",
  );
  runGit(
    root,
    "remote",
    "set-url",
    "--add",
    "--push",
    "upstream",
    "https://credential-two:secret-two@example.invalid/private.git",
  );

  const pushCheck = verifyUpstreamBaseline(root, baseline)
    .find(([name]) => name === "upstream push disabled");

  assert.equal(pushCheck?.[1], false);
  assert.equal(
    pushCheck?.[2],
    "DISABLED, https://github.com/siyuan-note/siyuan.git, https://example.invalid/private.git",
  );
});

test("reusable workflow jobs cannot bypass action pinning", () => {
  const failures = validateWorkflowDocument(
    {
      jobs: {
        delegated: {
          if: "${{ github.repository == 'SparkElf/singularity' }}",
          uses: "owner/repository/.github/workflows/reusable.yml@main",
        },
      },
      permissions: { contents: "read" },
    },
    "governance.yml",
    "${{ github.repository == 'SparkElf/singularity' }}",
  );

  assert.ok(failures.includes("job delegated must not call a reusable workflow"));
  assert.ok(failures.includes("job delegated must define steps"));
});

test("L0 workflow triggers include Docker build context changes", () => {
  const pullRequestPaths = [...REQUIRED_L0_TRIGGER_PATHS];
  const pushPaths = REQUIRED_L0_TRIGGER_PATHS.filter((path) => path !== ".dockerignore");
  const failures = validateWorkflowDocument(
    {
      jobs: {
        verify: {
          if: "${{ github.repository == 'SparkElf/singularity' }}",
          steps: [{ run: "echo verified" }],
        },
      },
      on: {
        pull_request: { paths: pullRequestPaths },
        push: { paths: pushPaths },
      },
      permissions: { contents: "read" },
    },
    "singularity-l0.yml",
    "${{ github.repository == 'SparkElf/singularity' }}",
  );

  assert.deepEqual(failures, ["push paths must include .dockerignore"]);
});

test("release workflow permits isolated CI evidence, package, and release authorities", () => {
  const failures = validateWorkflowDocument(
    {
      jobs: {
        verify: {
          if: "${{ github.repository == 'SparkElf/singularity' }}",
          permissions: { actions: "read", contents: "read" },
          steps: [{
            name: "Require successful canonical L0 evidence",
            run: "gh api repos/SparkElf/singularity/actions/workflows/singularity-l0.yml/runs | jq '.workflow_runs[] | .head_sha'",
          }],
        },
        images: {
          if: "${{ github.repository == 'SparkElf/singularity' }}",
          permissions: { contents: "read", packages: "write" },
          steps: [{ run: "echo images" }],
        },
        "github-release": {
          if: "${{ github.repository == 'SparkElf/singularity' }}",
          permissions: { contents: "write" },
          steps: [{ run: "echo release" }],
        },
      },
      on: {
        push: { tags: ["singularity-v*"] },
        workflow_dispatch: {},
      },
      permissions: { contents: "read" },
    },
    "singularity-release.yml",
    "${{ github.repository == 'SparkElf/singularity' }}",
  );

  assert.deepEqual(failures, []);
});

test("release workflow rejects missing L0 evidence and over-broad verify permissions", () => {
  const failures = validateWorkflowDocument(
    {
      jobs: {
        verify: {
          if: "${{ github.repository == 'SparkElf/singularity' }}",
          permissions: { actions: "write", contents: "read" },
          steps: [{ run: "echo verified" }],
        },
        images: {
          if: "${{ github.repository == 'SparkElf/singularity' }}",
          permissions: { contents: "read", packages: "write" },
          steps: [{ run: "echo images" }],
        },
        "github-release": {
          if: "${{ github.repository == 'SparkElf/singularity' }}",
          permissions: { contents: "write" },
          steps: [{ run: "echo release" }],
        },
      },
      on: {
        push: { tags: ["singularity-v*"] },
        workflow_dispatch: {},
      },
      permissions: { contents: "read" },
    },
    "singularity-release.yml",
    "${{ github.repository == 'SparkElf/singularity' }}",
  );

  assert.ok(failures.includes("release verify job must require successful canonical Singularity L0 evidence by source SHA"));
  assert.ok(failures.includes("release job verify may use actions permission only as actions: read on verify"));
  assert.ok(failures.includes("release verify job permissions must be exactly actions: read and contents: read"));
});

test("release workflow rejects pull requests and combined release/package writers", () => {
  const failures = validateWorkflowDocument(
    {
      jobs: {
        publish: {
          if: "${{ github.repository == 'SparkElf/singularity' }}",
          permissions: { contents: "write", packages: "write", "id-token": "write" },
          steps: [{ run: "echo publish" }],
        },
      },
      on: {
        pull_request: {},
        push: { tags: ["singularity-v*"] },
        workflow_dispatch: {},
      },
      permissions: { contents: "read" },
    },
    "singularity-release.yml",
    "${{ github.repository == 'SparkElf/singularity' }}",
  );

  assert.ok(failures.includes("release workflow must not run on pull_request"));
  assert.ok(failures.includes("release job publish may only declare actions/contents/packages permissions"));
  assert.ok(failures.includes("release job publish may use packages: write only on images"));
  assert.ok(failures.includes("release job publish may use contents: write only on github-release"));
  assert.ok(failures.includes("release job publish must not combine contents: write with packages: write"));
});
