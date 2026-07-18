import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const allowedApiArgonNativePackage = "@node-rs/argon2-linux-x64-gnu";
const forbiddenProductionPackages = new Set(["benchmark", "mysql2", "prisma", "seq-queue", "transport", "typescript"]);

function readArgumentValue(args, index, option) {
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error("Missing value for " + option);
  }
  return value;
}

function parseArguments(args) {
  let apiImage;
  let apiPath;
  let workerImage;
  let workerPath;
  let outputPath;
  let webPath;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--api-image") {
      apiImage = readArgumentValue(args, index, argument);
      index += 1;
    } else if (argument === "--api") {
      apiPath = readArgumentValue(args, index, argument);
      index += 1;
    } else if (argument === "--worker-image") {
      workerImage = readArgumentValue(args, index, argument);
      index += 1;
    } else if (argument === "--worker") {
      workerPath = readArgumentValue(args, index, argument);
      index += 1;
    } else if (argument === "--output") {
      outputPath = readArgumentValue(args, index, argument);
      index += 1;
    } else if (argument === "--web") {
      webPath = readArgumentValue(args, index, argument);
      index += 1;
    } else {
      throw new Error("Unknown argument: " + String(argument));
    }
  }
  if (
    apiImage === undefined ||
    apiPath === undefined ||
    workerImage === undefined ||
    workerPath === undefined ||
    outputPath === undefined ||
    webPath === undefined
  ) {
    throw new Error(
      "Usage: verify-production-sbom.mjs --api-image <image> --api <api.cdx.json> " +
        "--worker-image <image> --worker <worker.cdx.json> " +
        "--web <web.cdx.json> --output <result.json>",
    );
  }
  return { apiImage, apiPath, outputPath, webPath, workerImage, workerPath };
}

function readSbom(path) {
  const sbom = JSON.parse(readFileSync(resolve(repositoryRoot, path), "utf8"));
  if (sbom.bomFormat !== "CycloneDX" || !Array.isArray(sbom.components)) {
    throw new Error("Production SBOM is not a CycloneDX document: " + path);
  }
  return sbom;
}

function npmPurl(name, version) {
  const scoped = name.match(/^(@[^/]+)\/(.+)$/u);
  const encodedName = scoped === null
    ? encodeURIComponent(name)
    : encodeURIComponent(scoped[1]) + "/" + encodeURIComponent(scoped[2]);
  return "pkg:npm/" + encodedName + "@" + encodeURIComponent(version);
}

function readRuntimePackages(image, root, imageName) {
  const program = [
    'const { existsSync, readFileSync, realpathSync } = require("node:fs");',
    'const { createRequire } = require("node:module");',
    'const { join } = require("node:path");',
    `const root = ${JSON.stringify(root)};`,
    'const queue = [root];',
    'const seen = new Set();',
    'const packages = [];',
    'function purl(name, version) {',
    '  const scoped = name.match(/^(@[^/]+)\\/(.+)$/u);',
    '  const encoded = scoped === null',
    '    ? encodeURIComponent(name)',
    '    : encodeURIComponent(scoped[1]) + "/" + encodeURIComponent(scoped[2]);',
    '  return "pkg:npm/" + encoded + "@" + encodeURIComponent(version);',
    '}',
    'while (queue.length > 0) {',
    '  const manifestPath = realpathSync(queue.shift());',
    '  if (seen.has(manifestPath)) continue;',
    '  seen.add(manifestPath);',
    '  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));',
    '  if (typeof manifest.name !== "string" || typeof manifest.version !== "string") {',
    '    throw new Error("Runtime package manifest has no name or version: " + manifestPath);',
    '  }',
    '  packages.push({ name: manifest.name, purl: purl(manifest.name, manifest.version), version: manifest.version });',
    '  const required = manifest.dependencies ?? {};',
    '  const optional = manifest.optionalDependencies ?? {};',
    '  const localRequire = createRequire(manifestPath);',
    '  for (const name of new Set([...Object.keys(required), ...Object.keys(optional)])) {',
    '    let dependencyManifest = null;',
    '    for (const base of localRequire.resolve.paths(name) ?? []) {',
    '      const candidate = join(base, name, "package.json");',
    '      if (existsSync(candidate)) { dependencyManifest = candidate; break; }',
    '    }',
    '    if (dependencyManifest === null) {',
    '      if (Object.hasOwn(required, name) && !Object.hasOwn(optional, name)) {',
    '        throw new Error("Missing runtime dependency: " + name);',
    '      }',
    '    } else {',
    '      queue.push(dependencyManifest);',
    '    }',
    '  }',
    '}',
    'packages.sort((left, right) => left.purl.localeCompare(right.purl));',
    'process.stdout.write(JSON.stringify(packages));',
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
    ],
    { encoding: "utf8" },
  );
  if (result.status !== 0) {
    throw new Error(`Unable to enumerate the ${imageName} runtime dependency graph`);
  }
  let packages;
  try {
    packages = JSON.parse(result.stdout);
  } catch {
    throw new Error(`${imageName} runtime dependency graph returned invalid JSON`);
  }
  if (!Array.isArray(packages) || packages.length === 0) {
    throw new Error(`${imageName} runtime dependency graph is empty`);
  }
  const packagesByPurl = new Map();
  for (const component of packages) {
    if (
      typeof component?.name !== "string" ||
      typeof component.version !== "string" ||
      component.purl !== npmPurl(component.name, component.version)
    ) {
      throw new Error(`${imageName} runtime dependency graph contains an invalid package identity`);
    }
    packagesByPurl.set(component.purl, component);
  }
  return [...packagesByPurl.values()];
}

function readNpmPackage(component) {
  if (typeof component?.purl !== "string" || !component.purl.startsWith("pkg:npm/")) {
    return null;
  }
  if (
    typeof component.name !== "string" ||
    component.name.length === 0 ||
    typeof component.version !== "string" ||
    component.version.length === 0
  ) {
    throw new Error("Production SBOM npm component has no exact name and version: " + component.purl);
  }
  const group = typeof component.group === "string" && component.group.length > 0 ? component.group : null;
  const name = group === null ? component.name : group + "/" + component.name;
  if (component.purl !== npmPurl(name, component.version)) {
    throw new Error("Production SBOM npm component identity does not match its PURL: " + component.purl);
  }
  return { name, purl: component.purl, version: component.version };
}

function analyzeNodeRuntime(image, components, runtimePackages, requireApiArgon) {
  const packages = components.map(readNpmPackage).filter((value) => value !== null);
  const actualPurls = new Set(packages.map((component) => component.purl));
  const runtimePurls = new Set(runtimePackages.map((component) => component.purl));
  const allowedArgonPurls = new Set();
  const violations = [];
  for (const component of runtimePackages) {
    if (forbiddenProductionPackages.has(component.name)) {
      violations.push({
        image,
        package: component.purl,
        reason: "forbidden production dependency",
      });
    }
    if (requireApiArgon && component.name === allowedApiArgonNativePackage) {
      allowedArgonPurls.add(component.purl);
    } else if (requireApiArgon && component.name.startsWith("@node-rs/argon2-")) {
      violations.push({
        image,
        package: component.purl,
        reason: "non-linux-x64-gnu Argon2 native package",
      });
    }
  }
  for (const purl of runtimePurls) {
    if (!actualPurls.has(purl)) {
      violations.push({ image, package: purl, reason: "runtime package missing from raw SBOM" });
    }
  }
  for (const purl of actualPurls) {
    if (!runtimePurls.has(purl)) {
      violations.push({ image, package: purl, reason: "raw SBOM package is unreachable from the runtime root" });
    }
  }
  if (requireApiArgon && allowedArgonPurls.size !== 1) {
    violations.push({
      image,
      package: allowedApiArgonNativePackage,
      reason: "expected exactly one Linux x64 GNU Argon2 native package version",
    });
  }
  return { packageCount: packages.length, runtimePackageCount: runtimePackages.length, violations };
}

function analyzeWeb(components) {
  const packages = components.map(readNpmPackage).filter((value) => value !== null);
  return {
    packageCount: packages.length,
    violations: packages.map((component) => ({
      image: "web",
      package: component.purl,
      reason: "static Web runtime contains a Node package",
    })),
  };
}

const { apiImage, apiPath, outputPath, webPath, workerImage, workerPath } = parseArguments(process.argv.slice(2));
const api = analyzeNodeRuntime(
  "api",
  readSbom(apiPath).components,
  readRuntimePackages(apiImage, "/opt/singularity-api/package.json", "API"),
  true,
);
const worker = analyzeNodeRuntime(
  "worker",
  readSbom(workerPath).components,
  readRuntimePackages(workerImage, "/opt/singularity-worker/package.json", "Worker"),
  false,
);
const web = analyzeWeb(readSbom(webPath).components);
const violations = [...api.violations, ...worker.violations, ...web.violations].sort((left, right) =>
  (left.image + "\u0000" + left.package + "\u0000" + left.reason).localeCompare(
    right.image + "\u0000" + right.package + "\u0000" + right.reason,
  ),
);
const report = {
  apiNpmPackageCount: api.packageCount,
  apiRuntimePackageCount: api.runtimePackageCount,
  passed: violations.length === 0,
  violations,
  webNpmPackageCount: web.packageCount,
  workerNpmPackageCount: worker.packageCount,
  workerRuntimePackageCount: worker.runtimePackageCount,
};
writeFileSync(resolve(repositoryRoot, outputPath), JSON.stringify(report, null, 2) + "\n", "utf8");
process.stdout.write(
  (report.passed ? "PASS" : "FAIL") +
    " production SBOM policy: " +
    String(violations.length) +
    " dependency closure violations\n",
);
if (!report.passed) {
  process.exitCode = 1;
}
