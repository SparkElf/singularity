import assert from "node:assert/strict";
import { test } from "node:test";

import {
  canonicalUpstreamIdentity,
  compatibilityUpstreamIdentity,
} from "./verify-independent-governance.mjs";

test("compatibility workflow metadata is not part of upstream identity", () => {
  const before = {
    canonicalRepository: "SparkElf/singularity",
    canonicalBranch: "main",
    upstreamRepository: "https://github.com/siyuan-note/siyuan.git",
    upstreamBranch: "master",
    upstreamCommit: "a".repeat(40),
    upstreamCandidateCommit: "a".repeat(40),
    upstreamVersion: "3.7.2",
    allowedWorkflows: ["a.yml"],
  };
  const after = {
    ...before,
    allowedWorkflows: ["a.yml", "singularity-release.yml"],
  };

  assert.deepEqual(
    compatibilityUpstreamIdentity(after),
    compatibilityUpstreamIdentity(before),
  );
});

test("compatibility upstream commit and version are identity fields", () => {
  const before = {
    upstreamRepository: "https://github.com/siyuan-note/siyuan.git",
    upstreamBranch: "master",
    upstreamCommit: "a".repeat(40),
    upstreamCandidateCommit: "a".repeat(40),
    upstreamVersion: "3.7.2",
  };
  const after = {
    ...before,
    upstreamCommit: "b".repeat(40),
    upstreamCandidateCommit: "b".repeat(40),
    upstreamVersion: "3.8.0",
  };

  assert.notDeepEqual(
    compatibilityUpstreamIdentity(after),
    compatibilityUpstreamIdentity(before),
  );
});

test("canonical tracking policy changes do not masquerade as upstream identity", () => {
  const before = {
    canonical: { repository: "SparkElf/singularity", branch: "main" },
    upstream: { repository: "siyuan-note/siyuan", branch: "master" },
    baseline: {
      version: "3.7.2",
      tag: "v3.7.2",
      commit: "a".repeat(40),
    },
    tracking: { automatic_merge: false, require_pull_request: true },
  };
  const after = {
    ...before,
    tracking: { ...before.tracking, require_full_governance: true },
  };

  assert.deepEqual(canonicalUpstreamIdentity(after), canonicalUpstreamIdentity(before));
});

test("canonical promoted baseline changes are upstream identity changes", () => {
  const before = {
    upstream: { repository: "siyuan-note/siyuan", branch: "master" },
    baseline: {
      version: "3.7.2",
      tag: "v3.7.2",
      commit: "a".repeat(40),
    },
  };
  const after = {
    ...before,
    baseline: {
      version: "3.8.0",
      tag: "v3.8.0",
      commit: "b".repeat(40),
    },
  };

  assert.notDeepEqual(canonicalUpstreamIdentity(after), canonicalUpstreamIdentity(before));
});
