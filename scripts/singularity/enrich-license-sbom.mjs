import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, posix, resolve, win32 } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const enterpriseRequire = createRequire(resolve(repositoryRoot, "enterprise/package.json"));
const { parseDocument } = enterpriseRequire("yaml");
const evidencePropertyPrefix = "io.singularity.license.evidence";
const expHtmlPurl = "pkg:golang/github.com/levigross/exp-html@v0.0.0-20120902181939-8df60c69a8f5";
const expHtmlSourceReleaseContract = {
  archiveReferencePath: "README",
  commit: "3895b5051df256b442d0b0af50debfffd8d75164",
  directory: "src/pkg/exp/html",
  files: [
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
  ],
  license: "BSD-3-Clause",
  licensePath: "config/licenses/exp-html/LICENSE.go-weekly-2012-03-27",
  modulePath: "github.com/levigross/exp-html",
  moduleVersion: "v0.0.0-20120902181939-8df60c69a8f5",
  repository: "https://github.com/golang/go.git",
  tag: "weekly.2012-03-27",
};

function readArgumentValue(args, index, option) {
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`Missing value for ${option}`);
  }
  return value;
}

function parseArguments(args) {
  let image;
  let inputPath;
  let outputPath;
  let policyPath;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--image") {
      image = readArgumentValue(args, index, argument);
      index += 1;
    } else if (argument === "--input") {
      inputPath = readArgumentValue(args, index, argument);
      index += 1;
    } else if (argument === "--output") {
      outputPath = readArgumentValue(args, index, argument);
      index += 1;
    } else if (argument === "--policy") {
      policyPath = readArgumentValue(args, index, argument);
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${String(argument)}`);
    }
  }

  if (inputPath === undefined || outputPath === undefined || policyPath === undefined) {
    throw new Error(
      "Usage: enrich-license-sbom.mjs --policy <policy.json> --input <raw.cdx.json> " +
        "--output <enriched.cdx.json> [--image <image-ref>]",
    );
  }
  return { image, inputPath, outputPath, policyPath };
}

function readJson(path) {
  return JSON.parse(readFileSync(resolve(repositoryRoot, path), "utf8"));
}

function readRequiredString(value, field) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`License evidence field ${field} must be a non-empty string`);
  }
  return value;
}

function readRelativePath(value, field) {
  const path = readRequiredString(value, field);
  if (posix.isAbsolute(path) || win32.isAbsolute(path) || path.split(/[\\/]/u).includes("..")) {
    throw new Error(`License evidence field ${field} must be a relative path without parent traversal`);
  }
  return path;
}

function readStringArray(value, field) {
  if (!Array.isArray(value) || value.length === 0 || value.some((entry) => typeof entry !== "string" || entry.length === 0)) {
    throw new Error(`License evidence field ${field} must be a non-empty string array`);
  }
  if (new Set(value).size !== value.length) {
    throw new Error(`License evidence field ${field} must not contain duplicates`);
  }
  return value;
}

function readPackageEvidence(value, index) {
  if (value === undefined) {
    return undefined;
  }
  if (value === null || typeof value !== "object") {
    throw new Error(`License evidence package at index ${String(index)} must be an object`);
  }
  return {
    integrity: readRequiredString(value.integrity, `licenseEvidence[${String(index)}].package.integrity`),
    lockfileKey: readRequiredString(value.lockfileKey, `licenseEvidence[${String(index)}].package.lockfileKey`),
    lockfilePath: readRelativePath(value.lockfilePath, `licenseEvidence[${String(index)}].package.lockfilePath`),
    manifestName: readRequiredString(value.manifestName, `licenseEvidence[${String(index)}].package.manifestName`),
    manifestPath: readRelativePath(value.manifestPath, `licenseEvidence[${String(index)}].package.manifestPath`),
    manifestVersion: readRequiredString(value.manifestVersion, `licenseEvidence[${String(index)}].package.manifestVersion`),
  };
}

function readGoModule(value, index) {
  if (value === undefined) {
    return undefined;
  }
  if (value === null || typeof value !== "object") {
    throw new Error(`License evidence goModule at index ${String(index)} must be an object`);
  }
  return {
    path: readRequiredString(value.path, `licenseEvidence[${String(index)}].goModule.path`),
    version: readRequiredString(value.version, `licenseEvidence[${String(index)}].goModule.version`),
  };
}

function readSha256(value, field) {
  const hash = readRequiredString(value, field);
  if (!/^[0-9a-f]{64}$/.test(hash)) {
    throw new Error(`License evidence field ${field} must be a SHA-256 digest`);
  }
  return hash;
}

function readSourceRelease(value, index) {
  if (value === undefined) {
    return undefined;
  }
  if (value === null || typeof value !== "object") {
    throw new Error(`License evidence sourceRelease at index ${String(index)} must be an object`);
  }
  const archiveReference = value.archiveReference;
  if (archiveReference === null || typeof archiveReference !== "object") {
    throw new Error(`License evidence sourceRelease archiveReference at index ${String(index)} must be an object`);
  }
  if (!Array.isArray(value.files) || value.files.length === 0) {
    throw new Error(`License evidence sourceRelease files at index ${String(index)} must be a non-empty array`);
  }
  const paths = new Set();
  const files = value.files.map((file, fileIndex) => {
    if (file === null || typeof file !== "object") {
      throw new Error(`License evidence sourceRelease file ${String(fileIndex)} at index ${String(index)} is invalid`);
    }
    const path = readRelativePath(
      file.path,
      `licenseEvidence[${String(index)}].sourceRelease.files[${String(fileIndex)}].path`,
    );
    if (paths.has(path)) {
      throw new Error(`License evidence sourceRelease file path is invalid or duplicated: ${path}`);
    }
    paths.add(path);
    return {
      path,
      sha256: readSha256(
        file.sha256,
        `licenseEvidence[${String(index)}].sourceRelease.files[${String(fileIndex)}].sha256`,
      ),
    };
  });
  const commit = readRequiredString(value.commit, `licenseEvidence[${String(index)}].sourceRelease.commit`);
  if (!/^[0-9a-f]{40}$/.test(commit)) {
    throw new Error(`License evidence sourceRelease commit at index ${String(index)} is invalid`);
  }
  return {
    archiveReference: {
      path: readRelativePath(
        archiveReference.path,
        `licenseEvidence[${String(index)}].sourceRelease.archiveReference.path`,
      ),
      sha256: readSha256(
        archiveReference.sha256,
        `licenseEvidence[${String(index)}].sourceRelease.archiveReference.sha256`,
      ),
    },
    commit,
    directory: readRequiredString(value.directory, `licenseEvidence[${String(index)}].sourceRelease.directory`),
    files,
    repository: readRequiredString(value.repository, `licenseEvidence[${String(index)}].sourceRelease.repository`),
    tag: readRequiredString(value.tag, `licenseEvidence[${String(index)}].sourceRelease.tag`),
  };
}

function readSourcePackage(value, index) {
  if (value === undefined) {
    return undefined;
  }
  if (value === null || typeof value !== "object") {
    throw new Error(`License evidence sourcePackage at index ${String(index)} must be an object`);
  }
  return {
    name: readRequiredString(value.name, `licenseEvidence[${String(index)}].sourcePackage.name`),
    release: readRequiredString(value.release, `licenseEvidence[${String(index)}].sourcePackage.release`),
    version: readRequiredString(value.version, `licenseEvidence[${String(index)}].sourcePackage.version`),
  };
}

function readLicenseEvidence(policy) {
  if (!Array.isArray(policy.licenseEvidence)) {
    throw new Error("License policy field licenseEvidence must be an array");
  }

  const claimedPurls = new Set();
  return policy.licenseEvidence.map((value, index) => {
    if (value === null || typeof value !== "object") {
      throw new Error(`License evidence at index ${String(index)} must be an object`);
    }
    const kind = readRequiredString(value.kind, `licenseEvidence[${String(index)}].kind`);
    if (
      kind !== "container-file" &&
      kind !== "go-module-file" &&
      kind !== "go-source-release" &&
      kind !== "repository-file"
    ) {
      throw new Error(`Unsupported license evidence kind at index ${String(index)}: ${kind}`);
    }
    const goModule = readGoModule(value.goModule, index);
    const packageEvidence = readPackageEvidence(value.package, index);
    const sourcePackage = readSourcePackage(value.sourcePackage, index);
    const sourceRelease = readSourceRelease(value.sourceRelease, index);
    if (
      kind === "container-file" &&
      (sourcePackage === undefined || goModule !== undefined || packageEvidence !== undefined || sourceRelease !== undefined)
    ) {
      throw new Error(`Container license evidence at index ${String(index)} requires sourcePackage`);
    }
    if (
      kind === "go-module-file" &&
      (goModule === undefined || sourcePackage !== undefined || packageEvidence !== undefined || sourceRelease !== undefined)
    ) {
      throw new Error(`Go module license evidence at index ${String(index)} requires goModule`);
    }
    if (
      kind === "go-source-release" &&
      (goModule === undefined || sourceRelease === undefined || sourcePackage !== undefined || packageEvidence !== undefined)
    ) {
      throw new Error(`Go source release evidence at index ${String(index)} requires goModule and sourceRelease`);
    }
    if (kind === "repository-file" && (sourcePackage !== undefined || goModule !== undefined || sourceRelease !== undefined)) {
      throw new Error(`Repository license evidence at index ${String(index)} has incompatible source metadata`);
    }
    const purls = readStringArray(value.purls, `licenseEvidence[${String(index)}].purls`);
    for (const purl of purls) {
      if (!purl.startsWith("pkg:") || claimedPurls.has(purl)) {
        throw new Error(`License evidence PURL must be unique and valid: ${purl}`);
      }
      claimedPurls.add(purl);
    }
    if (kind === "go-source-release" && (purls.length !== 1 || purls[0] !== expHtmlPurl)) {
      throw new Error("Go source release evidence is restricted to the reviewed exp-html module");
    }
    return {
      kind,
      license: readRequiredString(value.license, `licenseEvidence[${String(index)}].license`),
      goModule,
      package: packageEvidence,
      path: kind === "repository-file"
        ? readRelativePath(value.path, `licenseEvidence[${String(index)}].path`)
        : readRequiredString(value.path, `licenseEvidence[${String(index)}].path`),
      purls,
      reason: readRequiredString(value.reason, `licenseEvidence[${String(index)}].reason`),
      sha256: readSha256(value.sha256, `licenseEvidence[${String(index)}].sha256`),
      sourcePackage,
      sourceRelease,
    };
  });
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(resolve(repositoryRoot, path))).digest("hex");
}

function verifyPackageEvidence(evidence) {
  if (evidence.package === undefined) {
    return;
  }
  const manifest = readJson(evidence.package.manifestPath);
  if (manifest.name !== evidence.package.manifestName || manifest.version !== evidence.package.manifestVersion) {
    throw new Error(`License evidence package manifest does not match ${evidence.purls.join(", ")}`);
  }

  const lockfile = parseDocument(readFileSync(resolve(repositoryRoot, evidence.package.lockfilePath), "utf8"));
  if (lockfile.errors.length > 0) {
    throw new Error(`License evidence lockfile is invalid: ${evidence.package.lockfilePath}`);
  }
  const integrity = lockfile.getIn(["packages", evidence.package.lockfileKey, "resolution", "integrity"]);
  if (integrity !== evidence.package.integrity) {
    throw new Error(`License evidence lockfile integrity does not match ${evidence.package.lockfileKey}`);
  }
}

function readContainerSha256(image, path) {
  const program = [
    'const { createHash } = require("node:crypto");',
    'const { readFileSync } = require("node:fs");',
    'process.stdout.write(createHash("sha256").update(readFileSync(process.argv[1])).digest("hex"));',
  ].join("");
  const result = spawnSync(
    "docker",
    [
      "run",
      "--rm",
      "--network=none",
      "--pull=never",
      "--read-only",
      "--entrypoint=/nodejs/bin/node",
      image,
      "-e",
      program,
      path,
    ],
    { encoding: "utf8" },
  );
  if (result.status !== 0 || !/^[0-9a-f]{64}$/.test(result.stdout.trim())) {
    throw new Error(`Unable to read container license evidence from ${path}`);
  }
  return result.stdout.trim();
}

function resolveGoModule(evidence) {
  if (
    posix.isAbsolute(evidence.path) ||
    win32.isAbsolute(evidence.path) ||
    evidence.path.split(/[\\/]/u).includes("..")
  ) {
    throw new Error(`Go module license evidence path must be relative: ${evidence.path}`);
  }
  const result = spawnSync(
    "go",
    ["mod", "download", "-json", `${evidence.goModule.path}@${evidence.goModule.version}`],
    {
      cwd: resolve(repositoryRoot, "kernel"),
      encoding: "utf8",
      env: {
        ...process.env,
        GOPROXY: "off",
        GOSUMDB: "off",
        GOTOOLCHAIN: "local",
      },
    },
  );
  if (result.status !== 0) {
    throw new Error(`Unable to resolve Go module license evidence for ${evidence.goModule.path}`);
  }
  let module;
  try {
    module = JSON.parse(result.stdout);
  } catch {
    throw new Error(`Go module license evidence returned invalid JSON for ${evidence.goModule.path}`);
  }
  if (
    module?.Path !== evidence.goModule.path ||
    module?.Version !== evidence.goModule.version ||
    typeof module?.Dir !== "string" ||
    module.Dir.length === 0 ||
    module.Error !== undefined
  ) {
    throw new Error(`Go module license evidence coordinate does not match ${evidence.goModule.path}`);
  }
  return module;
}

function readGoModuleSha256(evidence) {
  const module = resolveGoModule(evidence);
  return createHash("sha256").update(readFileSync(resolve(module.Dir, evidence.path))).digest("hex");
}

function verifyGoSourceReleaseContract(evidence) {
  const sourceRelease = evidence.sourceRelease;
  if (
    evidence.goModule.path !== expHtmlSourceReleaseContract.modulePath ||
    evidence.goModule.version !== expHtmlSourceReleaseContract.moduleVersion ||
    evidence.license !== expHtmlSourceReleaseContract.license ||
    evidence.path !== expHtmlSourceReleaseContract.licensePath ||
    sourceRelease.archiveReference.path !== expHtmlSourceReleaseContract.archiveReferencePath ||
    sourceRelease.commit !== expHtmlSourceReleaseContract.commit ||
    sourceRelease.directory !== expHtmlSourceReleaseContract.directory ||
    sourceRelease.repository !== expHtmlSourceReleaseContract.repository ||
    sourceRelease.tag !== expHtmlSourceReleaseContract.tag
  ) {
    throw new Error("Go source release evidence does not match the reviewed exp-html source coordinate");
  }

  const actualFiles = sourceRelease.files.map((file) => file.path).sort();
  const expectedFiles = [...expHtmlSourceReleaseContract.files].sort();
  if (actualFiles.length !== expectedFiles.length || actualFiles.some((path, index) => path !== expectedFiles[index])) {
    throw new Error("Go source release evidence must cover the complete reviewed exp-html production file set");
  }
}

function verifyGoSourceRelease(evidence) {
  verifyGoSourceReleaseContract(evidence);
  const module = resolveGoModule(evidence);
  const actualProductionFiles = readdirSync(module.Dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".go") && !entry.name.endsWith("_test.go"))
    .map((entry) => entry.name)
    .sort();
  const expectedProductionFiles = [...expHtmlSourceReleaseContract.files].sort();
  if (
    actualProductionFiles.length !== expectedProductionFiles.length ||
    actualProductionFiles.some((path, index) => path !== expectedProductionFiles[index])
  ) {
    throw new Error("Go source release module archive contains an unexpected production file set");
  }
  const archiveReferencePath = resolve(module.Dir, evidence.sourceRelease.archiveReference.path);
  const archiveReference = readFileSync(archiveReferencePath);
  const archiveReferenceSha256 = createHash("sha256").update(archiveReference).digest("hex");
  if (archiveReferenceSha256 !== evidence.sourceRelease.archiveReference.sha256) {
    throw new Error(`Go source release archive reference SHA-256 does not match ${evidence.goModule.path}`);
  }
  if (!archiveReference.toString("utf8").includes(evidence.sourceRelease.tag)) {
    throw new Error(`Go source release archive reference does not name ${evidence.sourceRelease.tag}`);
  }
  for (const file of evidence.sourceRelease.files) {
    const fileSha256 = createHash("sha256")
      .update(readFileSync(resolve(module.Dir, file.path)))
      .digest("hex");
    if (fileSha256 !== file.sha256) {
      throw new Error(`Go source release file SHA-256 does not match ${file.path}`);
    }
  }
}

function readProperty(component, name) {
  const values = (component.properties ?? [])
    .filter((property) => property?.name === name && typeof property.value === "string")
    .map((property) => property.value);
  return values.length === 1 ? values[0] : null;
}

function verifyComponentIdentity(component, evidence) {
  if (!evidence.purls.includes(component.purl)) {
    throw new Error("License evidence resolved an SBOM component outside its reviewed PURLs");
  }
  if (
    evidence.goModule !== undefined &&
    (component.name !== evidence.goModule.path || component.version !== evidence.goModule.version)
  ) {
    throw new Error(`Go module license evidence does not match SBOM component identity ${component.purl}`);
  }
  if (
    evidence.package !== undefined &&
    (component.name !== evidence.package.manifestName || component.version !== evidence.package.manifestVersion)
  ) {
    throw new Error(`Package license evidence does not match SBOM component identity ${component.purl}`);
  }
}

function verifySourcePackage(component, evidence) {
  const actual = {
    name: readProperty(component, "aquasecurity:trivy:SrcName"),
    release: readProperty(component, "aquasecurity:trivy:SrcRelease"),
    version: readProperty(component, "aquasecurity:trivy:SrcVersion"),
  };
  if (
    actual.name !== evidence.sourcePackage.name ||
    actual.release !== evidence.sourcePackage.release ||
    actual.version !== evidence.sourcePackage.version
  ) {
    throw new Error(`License evidence source package does not match ${component.purl}`);
  }
}

function readComponentLicenses(component) {
  return (component.licenses ?? [])
    .map((entry) => entry?.expression ?? entry?.license?.id ?? entry?.license?.name)
    .filter((value) => typeof value === "string" && value.length > 0);
}

function addEvidence(component, evidence) {
  const licenses = readComponentLicenses(component);
  if (licenses.length === 0) {
    component.licenses = [{ expression: evidence.license }];
  } else if (!licenses.includes(evidence.license)) {
    throw new Error(`License evidence conflicts with existing SBOM licenses for ${component.purl}`);
  }

  component.properties ??= [];
  component.properties.push(
    { name: `${evidencePropertyPrefix}.kind`, value: evidence.kind },
    { name: `${evidencePropertyPrefix}.path`, value: evidence.path },
    { name: `${evidencePropertyPrefix}.reason`, value: evidence.reason },
    { name: `${evidencePropertyPrefix}.sha256`, value: evidence.sha256 },
  );
  if (evidence.goModule !== undefined) {
    component.properties.push({
      name: `${evidencePropertyPrefix}.module`,
      value: `${evidence.goModule.path}@${evidence.goModule.version}`,
    });
  }
  if (evidence.sourceRelease !== undefined) {
    component.properties.push(
      { name: `${evidencePropertyPrefix}.source.commit`, value: evidence.sourceRelease.commit },
      { name: `${evidencePropertyPrefix}.source.directory`, value: evidence.sourceRelease.directory },
      { name: `${evidencePropertyPrefix}.source.repository`, value: evidence.sourceRelease.repository },
      { name: `${evidencePropertyPrefix}.source.tag`, value: evidence.sourceRelease.tag },
    );
  }
}

const { image, inputPath, outputPath, policyPath } = parseArguments(process.argv.slice(2));
const policy = readJson(policyPath);
if (policy.version !== 3) {
  throw new Error("Unsupported license policy version");
}
const sbom = readJson(inputPath);
if (sbom.bomFormat !== "CycloneDX" || !Array.isArray(sbom.components)) {
  throw new Error("Input is not a CycloneDX document with components");
}

const componentsByPurl = new Map();
for (const component of sbom.components) {
  if (typeof component?.purl !== "string") {
    continue;
  }
  const components = componentsByPurl.get(component.purl);
  if (components === undefined) {
    componentsByPurl.set(component.purl, [component]);
  } else {
    components.push(component);
  }
}

let appliedCount = 0;
for (const evidence of readLicenseEvidence(policy)) {
  const components = evidence.purls.flatMap((purl) => componentsByPurl.get(purl) ?? []);
  if (components.length === 0) {
    continue;
  }
  for (const component of components) {
    verifyComponentIdentity(component, evidence);
  }

  let actualSha256;
  if (evidence.kind === "repository-file") {
    verifyPackageEvidence(evidence);
    actualSha256 = sha256(evidence.path);
  } else if (evidence.kind === "go-module-file") {
    actualSha256 = readGoModuleSha256(evidence);
  } else if (evidence.kind === "go-source-release") {
    verifyGoSourceRelease(evidence);
    actualSha256 = sha256(evidence.path);
  } else {
    if (image === undefined) {
      throw new Error(`Container license evidence requires --image for ${evidence.purls.join(", ")}`);
    }
    for (const component of components) {
      verifySourcePackage(component, evidence);
    }
    actualSha256 = readContainerSha256(image, evidence.path);
  }
  if (actualSha256 !== evidence.sha256) {
    throw new Error(`License evidence SHA-256 does not match ${evidence.path}`);
  }

  for (const component of components) {
    addEvidence(component, evidence);
    appliedCount += 1;
  }
}

writeFileSync(resolve(repositoryRoot, outputPath), `${JSON.stringify(sbom, null, 2)}\n`, "utf8");
process.stdout.write(`Enriched ${String(appliedCount)} CycloneDX license components\n`);
