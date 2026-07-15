import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, test } from "node:test";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const scriptPath = resolve(repositoryRoot, "scripts/singularity/check-license-reports.mjs");
const temporaryDirectories = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

function createPolicy({ allowedFindings = [], allowedLicenses = [], deniedLicenses = [] } = {}) {
  return {
    allowedCategories: ["notice"],
    allowedFindings,
    allowedLicenses,
    deniedCategories: ["restricted"],
    deniedLicenses,
    licenseEvidence: [],
    version: 3,
  };
}

function createPackage({ license, name, purl, version = "1.0.0" }) {
  return {
    Identifier: { PURL: purl },
    Licenses: license === null ? [] : [license],
    Name: name,
    Version: version,
  };
}

function createComponent({ license, name, purl, version = "1.0.0" }) {
  const component = {
    name,
    purl,
    type: "library",
    version,
  };
  if (license !== null) {
    component.licenses = [{ license: { name: license } }];
  }
  return component;
}

function runPolicy({ component, license, packageEntry, policy, target = "Packages" }) {
  const directory = mkdtempSync(resolve(tmpdir(), "singularity-license-policy-"));
  temporaryDirectories.push(directory);
  const outputPath = resolve(directory, "result.json");
  const policyPath = resolve(directory, "policy.json");
  const reportPath = resolve(directory, "report.json");
  const sbomPath = resolve(directory, "bom.cdx.json");
  writeFileSync(policyPath, JSON.stringify(policy), "utf8");
  writeFileSync(
    reportPath,
    JSON.stringify({
      Results: [
        {
          Packages: packageEntry === null ? [] : [packageEntry],
          Target: target,
          Type: "fixture",
        },
        {
          Licenses:
            license === null
              ? []
              : [
                  {
                    Category: "unknown",
                    Name: license,
                    PkgName: packageEntry?.Name ?? component.name,
                  },
                ],
          Target: target,
        },
      ],
    }),
    "utf8",
  );
  writeFileSync(
    sbomPath,
    JSON.stringify({
      bomFormat: "CycloneDX",
      components: [component],
      specVersion: "1.7",
    }),
    "utf8",
  );

  const result = spawnSync(
    process.execPath,
    [
      scriptPath,
      "--policy",
      policyPath,
      "--output",
      outputPath,
      "--report",
      reportPath,
      "--sbom",
      sbomPath,
    ],
    { cwd: repositoryRoot, encoding: "utf8" },
  );
  return {
    output: JSON.parse(readFileSync(outputPath, "utf8")),
    status: result.status,
  };
}

test("a package exception cannot waive missing SBOM license evidence", () => {
  const purl = "pkg:apk/alpine/reviewed@1.0.0";
  const result = runPolicy({
    component: createComponent({ license: null, name: "reviewed", purl }),
    license: "custom",
    packageEntry: createPackage({ license: "custom", name: "reviewed", purl }),
    policy: createPolicy({
      allowedFindings: [
        {
          license: "custom",
          purls: [purl],
          reason: "Reviewed fixture license",
          target: "Packages",
        },
      ],
    }),
  });

  assert.equal(result.status, 1);
  assert.deepEqual(result.output.summary, { allowed: 1, denied: 0, unknown: 1 });
  assert.equal(
    result.output.findings.some((finding) => finding.policyRule === "missing-license"),
    true,
  );
  assert.equal(
    result.output.findings.some((finding) => finding.policyRule === "finding" && finding.decision === "allowed"),
    true,
  );
});

test("an explicit denied license wins over a matching package exception", () => {
  const purl = "pkg:apk/alpine/blocked@1.0.0";
  const result = runPolicy({
    component: createComponent({ license: "Blocked-1.0", name: "blocked", purl }),
    license: "Blocked-1.0",
    packageEntry: createPackage({ license: "Blocked-1.0", name: "blocked", purl }),
    policy: createPolicy({
      allowedFindings: [
        {
          license: "Blocked-1.0",
          purls: [purl],
          reason: "This exception must not override an explicit denial",
          target: "Packages",
        },
      ],
      deniedLicenses: ["Blocked-1.0"],
    }),
  });

  assert.equal(result.status, 1);
  assert.deepEqual(result.output.summary, { allowed: 0, denied: 1, unknown: 0 });
  assert.equal(result.output.findings[0].policyRule, "license");
  assert.equal(result.output.findings[0].reason, null);
});

test("a package exception does not allow the same package name in another ecosystem", () => {
  const reviewedPurl = "pkg:apk/alpine/shared-name@1.0.0";
  const scannedPurl = "pkg:npm/shared-name@1.0.0";
  const result = runPolicy({
    component: createComponent({ license: "custom", name: "shared-name", purl: scannedPurl }),
    license: "custom",
    packageEntry: createPackage({ license: "custom", name: "shared-name", purl: scannedPurl }),
    policy: createPolicy({
      allowedFindings: [
        {
          license: "custom",
          purls: [reviewedPurl],
          reason: "Only the Alpine package was reviewed",
          target: "Packages",
        },
      ],
    }),
  });

  assert.equal(result.status, 1);
  assert.deepEqual(result.output.summary, { allowed: 0, denied: 0, unknown: 1 });
  assert.equal(result.output.findings[0].purl, scannedPurl);
});

test("a library missing from the paired Trivy package inventory fails coverage", () => {
  const purl = "pkg:npm/unpaired@1.0.0";
  const result = runPolicy({
    component: createComponent({ license: "MIT", name: "unpaired", purl }),
    license: null,
    packageEntry: null,
    policy: createPolicy({ allowedLicenses: ["MIT"] }),
  });

  assert.equal(result.status, 1);
  assert.deepEqual(result.output.summary, { allowed: 1, denied: 0, unknown: 1 });
  assert.equal(
    result.output.findings.some((finding) => finding.policyRule === "missing-report-package"),
    true,
  );
});

test("a paired library with an allowed license passes", () => {
  const purl = "pkg:npm/allowed@1.0.0";
  const result = runPolicy({
    component: createComponent({ license: "MIT", name: "allowed", purl }),
    license: "MIT",
    packageEntry: createPackage({ license: "MIT", name: "allowed", purl }),
    policy: createPolicy({ allowedLicenses: ["MIT"] }),
  });

  assert.equal(result.status, 0);
  assert.deepEqual(result.output.summary, { allowed: 1, denied: 0, unknown: 0 });
  assert.equal(result.output.findings[0].policyRule, "license");
});
