import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { afterEach, test } from "node:test";
import { spawnSync } from "node:child_process";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const scriptPath = resolve(repositoryRoot, "scripts/singularity/enrich-license-sbom.mjs");
const expHtmlLicensePath = "config/licenses/exp-html/LICENSE.go-weekly-2012-03-27";
const expHtmlModulePath = "github.com/levigross/exp-html";
const expHtmlModuleVersion = "v0.0.0-20120902181939-8df60c69a8f5";
const expHtmlPurl = `pkg:golang/${expHtmlModulePath}@${expHtmlModuleVersion}`;
const expHtmlSourceFiles = [
  "const.go",
  "doc.go",
  "doctype.go",
  "entity.go",
  "escape.go",
  "foreign.go",
  "node.go",
  "parse.go",
  "render.go",
  "token.go",
];
const temporaryDirectories = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function createDirectory() {
  const directory = mkdtempSync(resolve(repositoryRoot, ".tmp-license-evidence-"));
  temporaryDirectories.push(directory);
  return directory;
}

function repositoryPath(path) {
  return relative(repositoryRoot, path).replaceAll("\\", "/");
}

function createSbom(component) {
  return {
    bomFormat: "CycloneDX",
    components: [component],
    specVersion: "1.7",
  };
}

function runEnrichment({ directory, env, evidence, sbom, image }) {
  const inputPath = resolve(directory, "raw.cdx.json");
  const outputPath = resolve(directory, "enriched.cdx.json");
  const policyPath = resolve(directory, "policy.json");
  writeFileSync(inputPath, JSON.stringify(sbom), "utf8");
  writeFileSync(policyPath, JSON.stringify({ licenseEvidence: [evidence], version: 3 }), "utf8");
  const args = [scriptPath, "--policy", policyPath, "--input", inputPath, "--output", outputPath];
  if (image !== undefined) {
    args.push("--image", image);
  }
  const result = spawnSync(process.execPath, args, {
    cwd: repositoryRoot,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  return {
    output: result.status === 0 ? JSON.parse(readFileSync(outputPath, "utf8")) : null,
    result,
  };
}

function createExpHtmlFixture() {
  const directory = createDirectory();
  const binDirectory = resolve(directory, "bin");
  const moduleDirectory = resolve(directory, "module");
  const goPath = resolve(binDirectory, "go");
  const archiveReference = "Copied from Go weekly.2012-03-27.\n";
  mkdirSync(binDirectory);
  mkdirSync(moduleDirectory);
  writeFileSync(resolve(moduleDirectory, "README"), archiveReference, "utf8");
  const files = expHtmlSourceFiles.map((path) => {
    const content = `reviewed ${path}\n`;
    writeFileSync(resolve(moduleDirectory, path), content, "utf8");
    return { path, sha256: sha256(content) };
  });
  writeFileSync(
    goPath,
    `#!/usr/bin/env node\nif(process.env.GOPROXY!=="off"||process.env.GOSUMDB!=="off"||process.env.GOTOOLCHAIN!=="local"){process.exit(90);}\nprocess.stdout.write(JSON.stringify({Path:${JSON.stringify(expHtmlModulePath)},Version:${JSON.stringify(expHtmlModuleVersion)},Dir:${JSON.stringify(moduleDirectory)}}));\n`,
    { encoding: "utf8", mode: 0o755 },
  );
  chmodSync(goPath, 0o755);
  return {
    directory,
    env: { PATH: `${binDirectory}:${process.env.PATH}` },
    evidence: {
      goModule: { path: expHtmlModulePath, version: expHtmlModuleVersion },
      kind: "go-source-release",
      license: "BSD-3-Clause",
      path: expHtmlLicensePath,
      purls: [expHtmlPurl],
      reason: "Reviewed historical Go source release",
      sha256: sha256(readFileSync(resolve(repositoryRoot, expHtmlLicensePath))),
      sourceRelease: {
        archiveReference: { path: "README", sha256: sha256(archiveReference) },
        commit: "3895b5051df256b442d0b0af50debfffd8d75164",
        directory: "src/pkg/exp/html",
        files,
        repository: "https://github.com/golang/go.git",
        tag: "weekly.2012-03-27",
      },
    },
    moduleDirectory,
  };
}

function createExpHtmlSbom() {
  return createSbom({
    name: expHtmlModulePath,
    purl: expHtmlPurl,
    type: "library",
    version: expHtmlModuleVersion,
  });
}

test("repository evidence enriches one exact locked package", () => {
  const directory = createDirectory();
  const license = "MIT fixture\n";
  const licensePath = resolve(directory, "LICENSE");
  const lockfilePath = resolve(directory, "pnpm-lock.yaml");
  const manifestPath = resolve(directory, "package.json");
  writeFileSync(licensePath, license, "utf8");
  writeFileSync(manifestPath, JSON.stringify({ name: "fixture", version: "1.0.0" }), "utf8");
  writeFileSync(
    lockfilePath,
    "lockfileVersion: '9.0'\npackages:\n  fixture@1.0.0:\n    resolution: {integrity: sha512-reviewed}\n",
    "utf8",
  );
  const purl = "pkg:npm/fixture@1.0.0";
  const { output, result } = runEnrichment({
    directory,
    evidence: {
      kind: "repository-file",
      license: "MIT",
      package: {
        integrity: "sha512-reviewed",
        lockfileKey: "fixture@1.0.0",
        lockfilePath: repositoryPath(lockfilePath),
        manifestName: "fixture",
        manifestPath: repositoryPath(manifestPath),
        manifestVersion: "1.0.0",
      },
      path: repositoryPath(licensePath),
      purls: [purl],
      reason: "Reviewed fixture package license",
      sha256: sha256(license),
    },
    sbom: createSbom({ name: "fixture", purl, type: "library", version: "1.0.0" }),
  });

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(output.components[0].licenses, [{ expression: "MIT" }]);
  assert.deepEqual(
    output.components[0].properties.map((property) => property.name),
    [
      "io.singularity.license.evidence.kind",
      "io.singularity.license.evidence.path",
      "io.singularity.license.evidence.reason",
      "io.singularity.license.evidence.sha256",
    ],
  );
});

test("repository evidence rejects a changed license file", () => {
  const directory = createDirectory();
  const licensePath = resolve(directory, "LICENSE");
  writeFileSync(licensePath, "changed\n", "utf8");
  const purl = "pkg:golang/example.com/root";
  const { result } = runEnrichment({
    directory,
    evidence: {
      kind: "repository-file",
      license: "AGPL-3.0",
      path: repositoryPath(licensePath),
      purls: [purl],
      reason: "Reviewed fixture repository license",
      sha256: sha256("reviewed\n"),
    },
    sbom: createSbom({ name: "example.com/root", purl, type: "library" }),
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /License evidence SHA-256 does not match/);
});

test("repository package evidence rejects an SBOM component identity mismatch", () => {
  const directory = createDirectory();
  const purl = "pkg:npm/fixture@1.0.0";
  const { result } = runEnrichment({
    directory,
    evidence: {
      kind: "repository-file",
      license: "MIT",
      package: {
        integrity: "sha512-reviewed",
        lockfileKey: "fixture@1.0.0",
        lockfilePath: "unused-lockfile.yaml",
        manifestName: "fixture",
        manifestPath: "unused-package.json",
        manifestVersion: "1.0.0",
      },
      path: "unused-license",
      purls: [purl],
      reason: "Reviewed fixture package license",
      sha256: "a".repeat(64),
    },
    sbom: createSbom({ name: "fixture-renamed", purl, type: "library", version: "1.0.0" }),
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Package license evidence does not match SBOM component identity/);
});

test("repository evidence paths cannot escape the repository", async (t) => {
  const cases = [
    ["absolute license", (evidence) => { evidence.path = "/tmp/LICENSE"; }],
    ["parent license", (evidence) => { evidence.path = "../LICENSE"; }],
    ["absolute manifest", (evidence) => { evidence.package.manifestPath = "/tmp/package.json"; }],
    ["parent manifest", (evidence) => { evidence.package.manifestPath = "../package.json"; }],
    ["absolute lockfile", (evidence) => { evidence.package.lockfilePath = "/tmp/pnpm-lock.yaml"; }],
    ["parent lockfile", (evidence) => { evidence.package.lockfilePath = "../pnpm-lock.yaml"; }],
  ];
  for (const [name, mutate] of cases) {
    await t.test(name, () => {
      const directory = createDirectory();
      const purl = "pkg:npm/fixture@1.0.0";
      const evidence = {
        kind: "repository-file",
        license: "MIT",
        package: {
          integrity: "sha512-reviewed",
          lockfileKey: "fixture@1.0.0",
          lockfilePath: "pnpm-lock.yaml",
          manifestName: "fixture",
          manifestPath: "package.json",
          manifestVersion: "1.0.0",
        },
        path: "LICENSE",
        purls: [purl],
        reason: "Reviewed fixture package license",
        sha256: "a".repeat(64),
      };
      mutate(evidence);
      const { result } = runEnrichment({
        directory,
        evidence,
        sbom: createSbom({ name: "fixture", purl, type: "library", version: "1.0.0" }),
      });
      assert.equal(result.status, 1);
      assert.match(result.stderr, /must be a relative path without parent traversal/);
    });
  }
});

test("container evidence requires the exact Debian source coordinate", () => {
  const directory = createDirectory();
  const binDirectory = resolve(directory, "bin");
  const dockerPath = resolve(binDirectory, "docker");
  const expectedSha256 = "a".repeat(64);
  mkdirSync(binDirectory);
  writeFileSync(dockerPath, `#!/usr/bin/env node\nprocess.stdout.write("${expectedSha256}");\n`, {
    encoding: "utf8",
    mode: 0o755,
  });
  chmodSync(dockerPath, 0o755);
  const purl = "pkg:deb/debian/libfixture@1.0-1?arch=amd64&distro=debian-13";
  const { output, result } = runEnrichment({
    directory,
    env: { PATH: `${binDirectory}:${process.env.PATH}` },
    evidence: {
      kind: "container-file",
      license: "GPL-3.0-or-later WITH GCC-exception-3.1",
      path: "/usr/share/doc/source/copyright",
      purls: [purl],
      reason: "Reviewed fixture source package license",
      sha256: expectedSha256,
      sourcePackage: { name: "source", release: "1", version: "1.0" },
    },
    image: "fixture:local",
    sbom: createSbom({
      name: "libfixture",
      properties: [
        { name: "aquasecurity:trivy:SrcName", value: "source" },
        { name: "aquasecurity:trivy:SrcRelease", value: "1" },
        { name: "aquasecurity:trivy:SrcVersion", value: "1.0" },
      ],
      purl,
      type: "library",
      version: "1.0-1",
    }),
  });

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(output.components[0].licenses, [
    { expression: "GPL-3.0-or-later WITH GCC-exception-3.1" },
  ]);
});

test("container evidence rejects source-package drift before reading the image", () => {
  const directory = createDirectory();
  const purl = "pkg:deb/debian/libfixture@2.0-1?arch=amd64&distro=debian-13";
  const { result } = runEnrichment({
    directory,
    evidence: {
      kind: "container-file",
      license: "GPL-3.0-or-later WITH GCC-exception-3.1",
      path: "/usr/share/doc/source/copyright",
      purls: [purl],
      reason: "Reviewed fixture source package license",
      sha256: "a".repeat(64),
      sourcePackage: { name: "source", release: "1", version: "1.0" },
    },
    image: "fixture:local",
    sbom: createSbom({
      name: "libfixture",
      properties: [
        { name: "aquasecurity:trivy:SrcName", value: "source" },
        { name: "aquasecurity:trivy:SrcRelease", value: "1" },
        { name: "aquasecurity:trivy:SrcVersion", value: "2.0" },
      ],
      purl,
      type: "library",
      version: "2.0-1",
    }),
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /License evidence source package does not match/);
});

test("unrelated duplicate PURLs do not block exact evidence", () => {
  const directory = createDirectory();
  const license = "reviewed\n";
  const licensePath = resolve(directory, "LICENSE");
  writeFileSync(licensePath, license, "utf8");
  const purl = "pkg:golang/example.com/root";
  const duplicate = { name: "benchmark", purl: "pkg:npm/benchmark@1.0.0", type: "library", version: "1.0.0" };
  const { output, result } = runEnrichment({
    directory,
    evidence: {
      kind: "repository-file",
      license: "AGPL-3.0",
      path: repositoryPath(licensePath),
      purls: [purl],
      reason: "Reviewed fixture repository license",
      sha256: sha256(license),
    },
    sbom: {
      bomFormat: "CycloneDX",
      components: [
        { name: "example.com/root", purl, type: "library" },
        duplicate,
        { ...duplicate },
      ],
      specVersion: "1.7",
    },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(output.components[0].licenses, [{ expression: "AGPL-3.0" }]);
  assert.equal(output.components[1].licenses, undefined);
  assert.equal(output.components[2].licenses, undefined);
});

test("Go module evidence resolves one exact module archive", () => {
  const directory = createDirectory();
  const binDirectory = resolve(directory, "bin");
  const moduleDirectory = resolve(directory, "module");
  const goPath = resolve(binDirectory, "go");
  const licensePath = resolve(moduleDirectory, "LICENSE");
  const license = "module license\n";
  mkdirSync(binDirectory);
  mkdirSync(moduleDirectory);
  writeFileSync(licensePath, license, "utf8");
  writeFileSync(
    goPath,
    `#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify({Path:"example.com/module",Version:"v1.2.3",Dir:${JSON.stringify(moduleDirectory)}}));\n`,
    { encoding: "utf8", mode: 0o755 },
  );
  chmodSync(goPath, 0o755);
  const purl = "pkg:golang/example.com/module@v1.2.3";
  const { output, result } = runEnrichment({
    directory,
    env: { PATH: `${binDirectory}:${process.env.PATH}` },
    evidence: {
      goModule: { path: "example.com/module", version: "v1.2.3" },
      kind: "go-module-file",
      license: "MIT",
      path: "LICENSE",
      purls: [purl],
      reason: "Reviewed fixture Go module license",
      sha256: sha256(license),
    },
    sbom: createSbom({ name: "example.com/module", purl, type: "library", version: "v1.2.3" }),
  });

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(output.components[0].licenses, [{ expression: "MIT" }]);
  assert.equal(
    output.components[0].properties.find((property) => property.name.endsWith(".module"))?.value,
    "example.com/module@v1.2.3",
  );
});

test("Go module evidence rejects archive license drift", () => {
  const directory = createDirectory();
  const binDirectory = resolve(directory, "bin");
  const moduleDirectory = resolve(directory, "module");
  const goPath = resolve(binDirectory, "go");
  mkdirSync(binDirectory);
  mkdirSync(moduleDirectory);
  writeFileSync(resolve(moduleDirectory, "LICENSE"), "changed module license\n", "utf8");
  writeFileSync(
    goPath,
    `#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify({Path:"example.com/module",Version:"v1.2.3",Dir:${JSON.stringify(moduleDirectory)}}));\n`,
    { encoding: "utf8", mode: 0o755 },
  );
  chmodSync(goPath, 0o755);
  const purl = "pkg:golang/example.com/module@v1.2.3";
  const { result } = runEnrichment({
    directory,
    env: { PATH: `${binDirectory}:${process.env.PATH}` },
    evidence: {
      goModule: { path: "example.com/module", version: "v1.2.3" },
      kind: "go-module-file",
      license: "MIT",
      path: "LICENSE",
      purls: [purl],
      reason: "Reviewed fixture Go module license",
      sha256: sha256("reviewed module license\n"),
    },
    sbom: createSbom({ name: "example.com/module", purl, type: "library", version: "v1.2.3" }),
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /License evidence SHA-256 does not match/);
});

test("Go module evidence rejects an SBOM component identity mismatch", () => {
  const directory = createDirectory();
  const purl = "pkg:golang/example.com/module@v1.2.3";
  const { result } = runEnrichment({
    directory,
    evidence: {
      goModule: { path: "example.com/module", version: "v1.2.3" },
      kind: "go-module-file",
      license: "MIT",
      path: "LICENSE",
      purls: [purl],
      reason: "Reviewed fixture Go module license",
      sha256: "a".repeat(64),
    },
    sbom: createSbom({ name: "example.com/other", purl, type: "library", version: "v1.2.3" }),
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Go module license evidence does not match SBOM component identity/);
});

test("Go module evidence cannot use an available network proxy when the module is uncached", () => {
  const directory = createDirectory();
  const binDirectory = resolve(directory, "bin");
  const goPath = resolve(binDirectory, "go");
  mkdirSync(binDirectory);
  writeFileSync(
    goPath,
    "#!/usr/bin/env node\n" +
      "if(process.env.GOPROXY==='off'&&process.env.GOSUMDB==='off'&&process.env.GOTOOLCHAIN==='local'){process.exit(77);}\n" +
      "process.stdout.write(JSON.stringify({Path:'example.com/module',Version:'v1.2.3',Dir:'/network/module'}));\n",
    { encoding: "utf8", mode: 0o755 },
  );
  chmodSync(goPath, 0o755);
  const purl = "pkg:golang/example.com/module@v1.2.3";
  const { result } = runEnrichment({
    directory,
    env: {
      GOPROXY: "https://proxy.example.invalid",
      PATH: `${binDirectory}:${process.env.PATH}`,
    },
    evidence: {
      goModule: { path: "example.com/module", version: "v1.2.3" },
      kind: "go-module-file",
      license: "MIT",
      path: "LICENSE",
      purls: [purl],
      reason: "Reviewed fixture Go module license",
      sha256: "a".repeat(64),
    },
    sbom: createSbom({ name: "example.com/module", purl, type: "library", version: "v1.2.3" }),
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Unable to resolve Go module license evidence/);
});

test("Go source release evidence verifies the complete reviewed exp-html chain", () => {
  const fixture = createExpHtmlFixture();
  const { output, result } = runEnrichment({
    directory: fixture.directory,
    env: fixture.env,
    evidence: fixture.evidence,
    sbom: createExpHtmlSbom(),
  });

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(output.components[0].licenses, [{ expression: "BSD-3-Clause" }]);
  assert.equal(
    output.components[0].properties.find((property) => property.name.endsWith(".source.commit"))?.value,
    "3895b5051df256b442d0b0af50debfffd8d75164",
  );
});

test("Go source release evidence rejects reviewed source-coordinate drift", async (t) => {
  const cases = [
    ["repository", (evidence) => { evidence.sourceRelease.repository = "https://example.invalid/go.git"; }],
    ["commit", (evidence) => { evidence.sourceRelease.commit = "0".repeat(40); }],
    ["directory", (evidence) => { evidence.sourceRelease.directory = "src/pkg/other"; }],
    ["tag", (evidence) => { evidence.sourceRelease.tag = "weekly.2012-03-20"; }],
  ];
  for (const [name, mutate] of cases) {
    await t.test(name, () => {
      const fixture = createExpHtmlFixture();
      mutate(fixture.evidence);
      const { result } = runEnrichment({
        directory: fixture.directory,
        env: fixture.env,
        evidence: fixture.evidence,
        sbom: createExpHtmlSbom(),
      });
      assert.equal(result.status, 1);
      assert.match(result.stderr, /does not match the reviewed exp-html source coordinate/);
    });
  }
});

test("Go source release evidence rejects an archive reference that omits the reviewed tag", () => {
  const fixture = createExpHtmlFixture();
  const changedReference = "Copied from an unspecified Go release.\n";
  writeFileSync(resolve(fixture.moduleDirectory, "README"), changedReference, "utf8");
  fixture.evidence.sourceRelease.archiveReference.sha256 = sha256(changedReference);
  const { result } = runEnrichment({
    directory: fixture.directory,
    env: fixture.env,
    evidence: fixture.evidence,
    sbom: createExpHtmlSbom(),
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /archive reference does not name weekly\.2012-03-27/);
});

test("Go source release evidence rejects archive reference content drift", () => {
  const fixture = createExpHtmlFixture();
  writeFileSync(
    resolve(fixture.moduleDirectory, "README"),
    "Changed text that still names Go weekly.2012-03-27.\n",
    "utf8",
  );
  const { result } = runEnrichment({
    directory: fixture.directory,
    env: fixture.env,
    evidence: fixture.evidence,
    sbom: createExpHtmlSbom(),
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /archive reference SHA-256 does not match/);
});

test("Go source release evidence rejects an incomplete production file set", () => {
  const fixture = createExpHtmlFixture();
  fixture.evidence.sourceRelease.files.pop();
  const { result } = runEnrichment({
    directory: fixture.directory,
    env: fixture.env,
    evidence: fixture.evidence,
    sbom: createExpHtmlSbom(),
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /must cover the complete reviewed exp-html production file set/);
});

test("Go source release evidence rejects an extra production file in the module archive", () => {
  const fixture = createExpHtmlFixture();
  writeFileSync(resolve(fixture.moduleDirectory, "extra.go"), "package html\n", "utf8");
  const { result } = runEnrichment({
    directory: fixture.directory,
    env: fixture.env,
    evidence: fixture.evidence,
    sbom: createExpHtmlSbom(),
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /module archive contains an unexpected production file set/);
});

test("Go source release evidence rejects production file drift", () => {
  const fixture = createExpHtmlFixture();
  writeFileSync(resolve(fixture.moduleDirectory, "parse.go"), "changed parse implementation\n", "utf8");
  const { result } = runEnrichment({
    directory: fixture.directory,
    env: fixture.env,
    evidence: fixture.evidence,
    sbom: createExpHtmlSbom(),
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Go source release file SHA-256 does not match parse\.go/);
});

test("Go source release evidence rejects historical license drift", () => {
  const fixture = createExpHtmlFixture();
  fixture.evidence.sha256 = "0".repeat(64);
  const { result } = runEnrichment({
    directory: fixture.directory,
    env: fixture.env,
    evidence: fixture.evidence,
    sbom: createExpHtmlSbom(),
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /License evidence SHA-256 does not match/);
});

test("Go source release evidence rejects unsafe archive reference paths", async (t) => {
  for (const path of ["../README", "/tmp/README"]) {
    await t.test(path, () => {
      const fixture = createExpHtmlFixture();
      fixture.evidence.sourceRelease.archiveReference.path = path;
      const { result } = runEnrichment({
        directory: fixture.directory,
        env: fixture.env,
        evidence: fixture.evidence,
        sbom: createExpHtmlSbom(),
      });
      assert.equal(result.status, 1);
      assert.match(result.stderr, /must be a relative path without parent traversal/);
    });
  }
});

test("Go source release evidence remains restricted to the reviewed exp-html PURL", () => {
  const fixture = createExpHtmlFixture();
  const otherPurl = "pkg:golang/example.com/other@v1.0.0";
  fixture.evidence.purls = [otherPurl];
  const { result } = runEnrichment({
    directory: fixture.directory,
    env: fixture.env,
    evidence: fixture.evidence,
    sbom: createSbom({ name: "example.com/other", purl: otherPurl, type: "library", version: "v1.0.0" }),
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /restricted to the reviewed exp-html module/);
});
