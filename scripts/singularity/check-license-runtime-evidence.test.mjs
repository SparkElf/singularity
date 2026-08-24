import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { afterEach, test } from "node:test";
import { spawnSync } from "node:child_process";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const scriptPath = resolve(repositoryRoot, "scripts/singularity/check-license-reports.mjs");
const temporaryDirectories = [];
const go1266License = `Copyright 2009 The Go Authors.\n\nRedistribution and use in source and binary forms, with or without\nmodification, are permitted provided that the following conditions are\nmet:\n\n   * Redistributions of source code must retain the above copyright\nnotice, this list of conditions and the following disclaimer.\n   * Redistributions in binary form must reproduce the above\ncopyright notice, this list of conditions and the following disclaimer\nin the documentation and/or other materials provided with the\ndistribution.\n   * Neither the name of Google LLC nor the names of its\ncontributors may be used to endorse or promote products derived from\nthis software without specific prior written permission.\n\nTHIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS\n\"AS IS\" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT\nLIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR\nA PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT\nOWNER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL,\nSPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT\nLIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE,\nDATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY\nTHEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT\n(INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE\nOF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.\n`;

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

function createDirectory() {
  const directory = mkdtempSync(resolve(repositoryRoot, ".tmp-license-runtime-evidence-"));
  temporaryDirectories.push(directory);
  return directory;
}

function repositoryPath(path) {
  return relative(repositoryRoot, path).replaceAll("\\", "/");
}

function writePolicy(directory, { allowedLicenses = ["MIT", "BSD-3-Clause"], deniedLicenses = [] } = {}) {
  const path = resolve(directory, "policy.json");
  writeFileSync(
    path,
    JSON.stringify({
      allowedCategories: ["notice"],
      allowedFindings: [],
      allowedLicenses,
      deniedCategories: ["restricted"],
      deniedLicenses,
      licenseEvidence: [],
      version: 3,
    }),
    "utf8",
  );
  return path;
}

function runPolicy({ directory, env, report, sbom, policy }) {
  const outputPath = resolve(directory, "result.json");
  const reportPath = resolve(directory, "report.json");
  const sbomPath = resolve(directory, "bom.cdx.json");
  writeFileSync(reportPath, JSON.stringify(report), "utf8");
  writeFileSync(sbomPath, JSON.stringify(sbom), "utf8");
  const result = spawnSync(
    process.execPath,
    [
      scriptPath,
      "--policy",
      policy,
      "--output",
      outputPath,
      "--report",
      reportPath,
      "--sbom",
      sbomPath,
    ],
    { cwd: repositoryRoot, encoding: "utf8", env: { ...process.env, ...env } },
  );
  return {
    output: JSON.parse(readFileSync(outputPath, "utf8")),
    result,
  };
}

function createNpmFixture({ integrity = "sha512-reviewed", license = "MIT" } = {}) {
  const directory = createDirectory();
  const packageName = "@scope/binary";
  const version = "1.0.0";
  const purl = "pkg:npm/%40scope/binary@1.0.0";
  const lockfilePath = resolve(directory, "pnpm-lock.yaml");
  const manifestDirectory = resolve(
    directory,
    "node_modules/.pnpm/@scope+binary@1.0.0/node_modules/@scope/binary",
  );
  mkdirSync(manifestDirectory, { recursive: true });
  writeFileSync(
    lockfilePath,
    `lockfileVersion: '9.0'\npackages:\n  '@scope/binary@1.0.0':\n    resolution: {${integrity === null ? "" : `integrity: ${integrity}`}}\n`,
    "utf8",
  );
  writeFileSync(
    resolve(manifestDirectory, "package.json"),
    JSON.stringify({ license, name: packageName, version }),
    "utf8",
  );
  return { directory, lockfilePath, packageName, purl, version };
}

test("exact installed npm manifest evidence fills a lockfile license gap", () => {
  const fixture = createNpmFixture();
  const { output, result } = runPolicy({
    directory: fixture.directory,
    policy: writePolicy(fixture.directory),
    report: {
      Results: [
        {
          Packages: [
            {
              Identifier: { PURL: fixture.purl },
              Name: fixture.packageName,
              Version: fixture.version,
            },
          ],
          Target: repositoryPath(fixture.lockfilePath),
        },
      ],
    },
    sbom: {
      bomFormat: "CycloneDX",
      components: [
        {
          name: "binary",
          purl: fixture.purl,
          type: "library",
          version: fixture.version,
        },
      ],
      specVersion: "1.7",
    },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(output.summary, { allowed: 1, denied: 0, unknown: 0 });
  assert.equal(output.findings[0].license, "MIT");
  assert.match(output.findings[0].filePath, /node_modules\/\.pnpm\/.*package\.json$/u);
});

test("installed npm manifest evidence is ignored without lockfile integrity", () => {
  const fixture = createNpmFixture({ integrity: null });
  const { output, result } = runPolicy({
    directory: fixture.directory,
    policy: writePolicy(fixture.directory),
    report: {
      Results: [
        {
          Packages: [
            {
              Identifier: { PURL: fixture.purl },
              Name: fixture.packageName,
              Version: fixture.version,
            },
          ],
          Target: repositoryPath(fixture.lockfilePath),
        },
      ],
    },
    sbom: {
      bomFormat: "CycloneDX",
      components: [{ name: "binary", purl: fixture.purl, type: "library", version: fixture.version }],
      specVersion: "1.7",
    },
  });

  assert.equal(result.status, 1);
  assert.deepEqual(output.summary, { allowed: 0, denied: 0, unknown: 1 });
  assert.equal(output.findings[0].policyRule, "missing-license");
});

test("reviewed Go 1.26.6 stdlib license evidence fills the binary SBOM gap", () => {
  const directory = createDirectory();
  const binDirectory = resolve(directory, "bin");
  const goRoot = resolve(directory, "go-root");
  mkdirSync(binDirectory);
  mkdirSync(goRoot);
  writeFileSync(resolve(goRoot, "LICENSE"), go1266License, "utf8");
  const goPath = resolve(binDirectory, process.platform === "win32" ? "go.cmd" : "go");
  if (process.platform === "win32") {
    writeFileSync(goPath, `@echo off\necho go1.26.6\necho ${goRoot}\n`, "utf8");
  } else {
    writeFileSync(goPath, `#!/bin/sh\nprintf 'go1.26.6\\n%s\\n' '${goRoot}'\n`, { encoding: "utf8", mode: 0o755 });
    chmodSync(goPath, 0o755);
  }
  const purl = "pkg:golang/stdlib@v1.26.6";
  const { output, result } = runPolicy({
    directory,
    env: { PATH: `${binDirectory}${process.platform === "win32" ? ";" : ":"}${process.env.PATH}` },
    policy: writePolicy(directory),
    report: { Results: [] },
    sbom: {
      bomFormat: "CycloneDX",
      components: [{ name: "stdlib", purl, type: "library", version: "v1.26.6" }],
      specVersion: "1.7",
    },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(output.summary, { allowed: 1, denied: 0, unknown: 0 });
  assert.equal(output.findings[0].license, "BSD-3-Clause");
  assert.equal(output.findings[0].purl, purl);
});
