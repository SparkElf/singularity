import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { afterEach, test } from "node:test";
import { spawnSync } from "node:child_process";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const scriptPath = resolve(repositoryRoot, "scripts/singularity/enrich-materialized-license-sbom.mjs");
const temporaryDirectories = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

function repositoryPath(path) {
  return relative(repositoryRoot, path).replaceAll("\\", "/");
}

function createFixture({ manifestVersion = "1.0.0", componentVersion = manifestVersion } = {}) {
  const directory = mkdtempSync(resolve(repositoryRoot, ".tmp-materialized-license-"));
  temporaryDirectories.push(directory);
  const root = resolve(directory, "workspace");
  const packageDirectory = resolve(
    root,
    "node_modules/.pnpm/@scope+binding@1.0.0/node_modules/@scope/binding",
  );
  mkdirSync(packageDirectory, { recursive: true });
  writeFileSync(
    resolve(packageDirectory, "package.json"),
    JSON.stringify({ license: "MIT", name: "@scope/binding", version: manifestVersion }),
    "utf8",
  );
  const sbomPath = resolve(directory, "bom.cdx.json");
  writeFileSync(
    sbomPath,
    JSON.stringify({
      bomFormat: "CycloneDX",
      components: [
        {
          name: "@scope/binding",
          purl: `pkg:npm/%40scope/binding@${componentVersion}`,
          type: "library",
          version: componentVersion,
        },
      ],
      specVersion: "1.7",
    }),
    "utf8",
  );
  return { root, sbomPath };
}

function runFixture(fixture) {
  return spawnSync(
    process.execPath,
    [
      scriptPath,
      "--root",
      repositoryPath(fixture.root),
      "--sbom",
      repositoryPath(fixture.sbomPath),
    ],
    { cwd: repositoryRoot, encoding: "utf8" },
  );
}

test("adds license evidence from an exact materialized scoped package", () => {
  const fixture = createFixture();
  const result = runFixture(fixture);
  assert.equal(result.status, 0, result.stderr);
  const sbom = JSON.parse(readFileSync(fixture.sbomPath, "utf8"));
  assert.deepEqual(sbom.components[0].licenses, [{ expression: "MIT" }]);
  assert.equal(
    sbom.components[0].properties.find((property) => property.name.endsWith(".kind"))?.value,
    "materialized-package-manifest",
  );
});

test("does not apply a materialized license to a different package version", () => {
  const fixture = createFixture({ componentVersion: "2.0.0" });
  const result = runFixture(fixture);
  assert.equal(result.status, 0, result.stderr);
  const sbom = JSON.parse(readFileSync(fixture.sbomPath, "utf8"));
  assert.equal(sbom.components[0].licenses, undefined);
});
