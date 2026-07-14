import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, test } from "node:test";
import assert from "node:assert/strict";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const scriptPath = resolve(repositoryRoot, "scripts/singularity/check-license-reports.mjs");
const policyPath = resolve(repositoryRoot, "config/license-policy.json");
const temporaryDirectories = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

function runPolicy(license) {
  const directory = mkdtempSync(resolve(tmpdir(), "singularity-license-policy-"));
  temporaryDirectories.push(directory);
  const reportPath = resolve(directory, "report.json");
  const outputPath = resolve(directory, "result.json");
  writeFileSync(
    reportPath,
    JSON.stringify({
      Results: [
        {
          Licenses: [license],
          Target: "policy-fixture",
        },
      ],
    }),
    "utf8",
  );

  const result = spawnSync(
    process.execPath,
    [scriptPath, "--policy", policyPath, "--output", outputPath, reportPath],
    { cwd: repositoryRoot, encoding: "utf8" },
  );
  return {
    output: JSON.parse(readFileSync(outputPath, "utf8")),
    status: result.status,
  };
}

test("denied licenses fail the policy gate", () => {
  const result = runPolicy({
    Category: "restricted",
    Name: "CC-BY-NC-4.0",
    PkgName: "policy-fixture",
  });

  assert.equal(result.status, 1);
  assert.deepEqual(result.output.summary, { allowed: 0, denied: 1, unknown: 0 });
});

test("unreviewed licenses fail the policy gate", () => {
  const result = runPolicy({
    Category: "unknown",
    Name: "LicenseRef-Unreviewed",
    PkgName: "policy-fixture",
  });

  assert.equal(result.status, 1);
  assert.deepEqual(result.output.summary, { allowed: 0, denied: 0, unknown: 1 });
});

test("reviewed package-specific findings pass", () => {
  const result = runPolicy({
    Category: "unknown",
    Name: "custom",
    PkgName: "aom-libs",
  });

  assert.equal(result.status, 0);
  assert.deepEqual(result.output.summary, { allowed: 1, denied: 0, unknown: 0 });
  assert.equal(result.output.findings[0].policyRule, "finding");
});

test("package-specific findings do not allow another package", () => {
  const result = runPolicy({
    Category: "unknown",
    Name: "custom",
    PkgName: "unreviewed-package",
  });

  assert.equal(result.status, 1);
  assert.deepEqual(result.output.summary, { allowed: 0, denied: 0, unknown: 1 });
});
