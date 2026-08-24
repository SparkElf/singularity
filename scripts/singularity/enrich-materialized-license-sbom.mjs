import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const repositoryRoot = resolve(dirname(scriptPath), "../..");
const evidencePropertyPrefix = "io.singularity.license.evidence";

function readArgumentValue(args, index, option) {
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`Missing value for ${option}`);
  }
  return value;
}

function parseArguments(args) {
  const roots = [];
  const sboms = [];
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--root") {
      roots.push(readArgumentValue(args, index, argument));
      index += 1;
    } else if (argument === "--sbom") {
      sboms.push(readArgumentValue(args, index, argument));
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${String(argument)}`);
    }
  }
  if (roots.length === 0 || sboms.length === 0) {
    throw new Error(
      "Usage: enrich-materialized-license-sbom.mjs --root <workspace> [--root <workspace> ...] " +
        "--sbom <bom.cdx.json> [--sbom <bom.cdx.json> ...]",
    );
  }
  return { roots, sboms };
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function repositoryPath(path) {
  return relative(repositoryRoot, path).replaceAll("\\", "/");
}

function readManifest(path) {
  const manifestPath = resolve(path, "package.json");
  if (!existsSync(manifestPath)) {
    return null;
  }
  const bytes = readFileSync(manifestPath);
  const manifest = JSON.parse(bytes.toString("utf8"));
  if (
    typeof manifest.name !== "string" ||
    manifest.name.length === 0 ||
    typeof manifest.version !== "string" ||
    manifest.version.length === 0 ||
    typeof manifest.license !== "string" ||
    manifest.license.trim().length === 0
  ) {
    return null;
  }
  return {
    license: manifest.license.trim(),
    name: manifest.name,
    path: repositoryPath(manifestPath),
    sha256: sha256(bytes),
    version: manifest.version,
  };
}

function packageDirectories(nodeModulesPath) {
  if (!existsSync(nodeModulesPath)) {
    return [];
  }
  const directories = [];
  for (const entry of readdirSync(nodeModulesPath, { withFileTypes: true })) {
    const path = resolve(nodeModulesPath, entry.name);
    if (entry.name.startsWith("@") && entry.isDirectory()) {
      for (const scopedEntry of readdirSync(path, { withFileTypes: true })) {
        if (scopedEntry.isDirectory()) {
          directories.push(resolve(path, scopedEntry.name));
        }
      }
    } else if (entry.isDirectory()) {
      directories.push(path);
    }
  }
  return directories;
}

function readMaterializedPackages(root) {
  const pnpmStore = resolve(repositoryRoot, root, "node_modules/.pnpm");
  if (!existsSync(pnpmStore)) {
    return [];
  }
  const packages = [];
  for (const storeEntry of readdirSync(pnpmStore, { withFileTypes: true })) {
    if (!storeEntry.isDirectory()) {
      continue;
    }
    const nodeModulesPath = resolve(pnpmStore, storeEntry.name, "node_modules");
    for (const packageDirectory of packageDirectories(nodeModulesPath)) {
      const manifest = readManifest(packageDirectory);
      if (manifest !== null) {
        packages.push(manifest);
      }
    }
  }
  return packages;
}

function packageKey(name, version) {
  return `${name}\u0000${version}`;
}

function buildPackageIndex(roots) {
  const index = new Map();
  for (const root of roots) {
    for (const packageManifest of readMaterializedPackages(root)) {
      const key = packageKey(packageManifest.name, packageManifest.version);
      const existing = index.get(key);
      if (existing !== undefined && existing.license !== packageManifest.license) {
        throw new Error(
          `Conflicting materialized licenses for ${packageManifest.name}@${packageManifest.version}`,
        );
      }
      index.set(key, existing ?? packageManifest);
    }
  }
  return index;
}

function hasLicense(component) {
  return Array.isArray(component?.licenses) && component.licenses.length > 0;
}

function enrichSbom(path, packageIndex) {
  const absolutePath = resolve(repositoryRoot, path);
  const sbom = JSON.parse(readFileSync(absolutePath, "utf8"));
  if (sbom.bomFormat !== "CycloneDX" || !Array.isArray(sbom.components)) {
    throw new Error(`SBOM is not a CycloneDX document with components: ${path}`);
  }

  let enriched = 0;
  for (const component of sbom.components) {
    if (
      hasLicense(component) ||
      typeof component?.purl !== "string" ||
      !component.purl.startsWith("pkg:npm/") ||
      typeof component.name !== "string" ||
      typeof component.version !== "string"
    ) {
      continue;
    }
    const evidence = packageIndex.get(packageKey(component.name, component.version));
    if (evidence === undefined) {
      continue;
    }
    component.licenses = [{ expression: evidence.license }];
    component.properties ??= [];
    component.properties.push(
      { name: `${evidencePropertyPrefix}.kind`, value: "materialized-package-manifest" },
      { name: `${evidencePropertyPrefix}.path`, value: evidence.path },
      { name: `${evidencePropertyPrefix}.sha256`, value: evidence.sha256 },
    );
    enriched += 1;
  }

  writeFileSync(absolutePath, `${JSON.stringify(sbom, null, 2)}\n`, "utf8");
  return enriched;
}

export function enrichMaterializedLicenseSboms({ roots, sboms }) {
  const packageIndex = buildPackageIndex(roots);
  let enriched = 0;
  for (const sbom of sboms) {
    enriched += enrichSbom(sbom, packageIndex);
  }
  return enriched;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === scriptPath) {
  const { roots, sboms } = parseArguments(process.argv.slice(2));
  const enriched = enrichMaterializedLicenseSboms({ roots, sboms });
  process.stdout.write(
    `Enriched ${String(enriched)} CycloneDX components from materialized package manifests\n`,
  );
}
