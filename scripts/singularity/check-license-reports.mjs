import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

function readArgumentValue(args, index, option) {
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`Missing value for ${option}`);
  }
  return value;
}

function parseArguments(args) {
  let outputPath;
  let pendingReportPath;
  let policyPath;
  const inputs = [];

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--output") {
      outputPath = readArgumentValue(args, index, argument);
      index += 1;
    } else if (argument === "--policy") {
      policyPath = readArgumentValue(args, index, argument);
      index += 1;
    } else if (argument === "--report") {
      if (pendingReportPath !== undefined) {
        throw new Error("Each --report must be followed by one --sbom");
      }
      pendingReportPath = readArgumentValue(args, index, argument);
      index += 1;
    } else if (argument === "--sbom") {
      if (pendingReportPath === undefined) {
        throw new Error("Each --sbom must follow one --report");
      }
      inputs.push({
        reportPath: pendingReportPath,
        sbomPath: readArgumentValue(args, index, argument),
      });
      pendingReportPath = undefined;
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${String(argument)}`);
    }
  }

  if (pendingReportPath !== undefined) {
    throw new Error("Each --report must be followed by one --sbom");
  }
  if (outputPath === undefined || policyPath === undefined || inputs.length === 0) {
    throw new Error(
      "Usage: check-license-reports.mjs --policy <policy.json> --output <result.json> " +
        "--report <licenses.json> --sbom <bom.cdx.json> [--report <licenses.json> --sbom <bom.cdx.json> ...]",
    );
  }

  return { inputs, outputPath, policyPath };
}

function readJson(path) {
  return JSON.parse(readFileSync(resolve(repositoryRoot, path), "utf8"));
}

function readStringSet(policy, field) {
  const values = policy[field];
  if (!Array.isArray(values) || values.some((value) => typeof value !== "string" || value.length === 0)) {
    throw new Error(`License policy field ${field} must be a string array`);
  }
  return new Set(values);
}

function readAllowedFindings(policy) {
  if (!Array.isArray(policy.allowedFindings)) {
    throw new Error("License policy field allowedFindings must be an array");
  }

  return policy.allowedFindings.map((finding, index) => {
    if (
      finding === null ||
      typeof finding !== "object" ||
      typeof finding.license !== "string" ||
      finding.license.length === 0 ||
      typeof finding.target !== "string" ||
      finding.target.length === 0 ||
      !Array.isArray(finding.purls) ||
      finding.purls.length === 0 ||
      finding.purls.some((purl) => typeof purl !== "string" || !purl.startsWith("pkg:")) ||
      typeof finding.reason !== "string" ||
      finding.reason.length === 0
    ) {
      throw new Error(`Invalid allowedFindings entry at index ${String(index)}`);
    }
    return {
      license: finding.license,
      purls: new Set(finding.purls),
      reason: finding.reason,
      target: finding.target,
    };
  });
}

function readTrimmedString(value) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function readPackagePurl(packageEntry) {
  return readTrimmedString(packageEntry?.Identifier?.PURL);
}

function readComponentLicenseNames(component) {
  if (!Array.isArray(component.licenses) || component.licenses.length === 0) {
    return { evidenceCount: 0, invalidCount: 0, names: [] };
  }

  const names = new Set();
  let invalidCount = 0;
  for (const licenseEntry of component.licenses) {
    const name =
      readTrimmedString(licenseEntry?.license?.id) ??
      readTrimmedString(licenseEntry?.license?.name) ??
      readTrimmedString(licenseEntry?.expression);
    if (name === null) {
      invalidCount += 1;
    } else {
      names.add(name);
    }
  }
  return { evidenceCount: component.licenses.length, invalidCount, names: [...names] };
}

function readPackageLicenseNames(packageEntry) {
  if (!Array.isArray(packageEntry?.Licenses)) {
    return [];
  }
  return packageEntry.Licenses.map(readTrimmedString).filter((license) => license !== null);
}

function uniqueValue(values) {
  const uniqueValues = [...new Set(values.filter((value) => value !== null))];
  return uniqueValues.length === 1 ? uniqueValues[0] : null;
}

function findingKey(...values) {
  return values.map((value) => value ?? "").join("\u0000");
}

function addToIndex(index, key, value) {
  const values = index.get(key);
  if (values === undefined) {
    index.set(key, [value]);
  } else {
    values.push(value);
  }
}

function createCoverageFinding({ packageName, policyRule, purl, reportPath, sbomPath, target, version }) {
  return {
    category: "unknown",
    decision: "unknown",
    filePath: null,
    license: null,
    packageName,
    policyRule,
    purl,
    reason: null,
    report: reportPath,
    sbom: sbomPath,
    target,
    version,
  };
}

function evaluateLicense({ category, filePath, license, packageName, purl, reportPath, sbomPath, target, version }, policy) {
  let decision;
  let policyRule;
  let reason = null;

  if (policy.deniedLicenses.has(license)) {
    decision = "denied";
    policyRule = "license";
  } else if (policy.allowedLicenses.has(license)) {
    decision = "allowed";
    policyRule = "license";
  } else if (purl !== null && target !== null) {
    const allowedFinding = policy.allowedFindings.find(
      (finding) => finding.license === license && finding.target === target && finding.purls.has(purl),
    );
    if (allowedFinding !== undefined) {
      decision = "allowed";
      policyRule = "finding";
      reason = allowedFinding.reason;
    }
  }

  if (decision === undefined && policy.deniedCategories.has(category)) {
    decision = "denied";
    policyRule = "category";
  } else if (decision === undefined && policy.allowedCategories.has(category)) {
    decision = "allowed";
    policyRule = "category";
  } else if (decision === undefined) {
    decision = "unknown";
    policyRule = "unmatched";
  }

  return {
    category,
    decision,
    filePath,
    license,
    packageName,
    policyRule,
    purl,
    reason,
    report: reportPath,
    sbom: sbomPath,
    target,
    version,
  };
}

function inspectInput(input, policy) {
  const report = readJson(input.reportPath);
  const sbom = readJson(input.sbomPath);
  if (!Array.isArray(report.Results)) {
    throw new Error(`Trivy report has no Results array: ${input.reportPath}`);
  }
  if (sbom.bomFormat !== "CycloneDX" || !Array.isArray(sbom.components)) {
    throw new Error(`SBOM is not a CycloneDX document with components: ${input.sbomPath}`);
  }

  const libraryComponents = sbom.components.filter((component) => component?.type === "library");
  if (libraryComponents.length === 0) {
    throw new Error(`CycloneDX SBOM contains no library components: ${input.sbomPath}`);
  }

  const licenseContexts = [];
  const packageEntries = [];
  const packageEntriesByPurl = new Map();
  for (const result of report.Results) {
    if (result?.Packages !== undefined && result.Packages !== null && !Array.isArray(result.Packages)) {
      throw new Error(`Trivy report result has an invalid Packages field: ${input.reportPath}`);
    }
    if (result?.Licenses !== undefined && result.Licenses !== null && !Array.isArray(result.Licenses)) {
      throw new Error(`Trivy report result has an invalid Licenses field: ${input.reportPath}`);
    }

    for (const packageEntry of result?.Packages ?? []) {
      const entry = {
        licenses: readPackageLicenseNames(packageEntry),
        packageName: readTrimmedString(packageEntry?.Name),
        purl: readPackagePurl(packageEntry),
        target: readTrimmedString(result?.Target),
        version: readTrimmedString(packageEntry?.Version),
      };
      packageEntries.push(entry);
      if (entry.purl !== null) {
        addToIndex(packageEntriesByPurl, entry.purl, entry);
      }
    }

    for (const licenseEntry of result?.Licenses ?? []) {
      const name = readTrimmedString(licenseEntry?.Name);
      if (name === null) {
        throw new Error(`Trivy report contains a license without a name: ${input.reportPath}`);
      }
      licenseContexts.push({
        category: readTrimmedString(licenseEntry?.Category)?.toLowerCase() ?? "unknown",
        filePath: readTrimmedString(licenseEntry?.FilePath),
        license: name,
        packageName: readTrimmedString(licenseEntry?.PkgName),
        target: readTrimmedString(result?.Target),
      });
    }
  }

  const contextsByLicense = new Map();
  const contextsByPackage = new Map();
  const contextsByPackageLicense = new Map();
  for (const context of licenseContexts) {
    addToIndex(contextsByLicense, context.license, context);
    if (context.packageName !== null) {
      addToIndex(contextsByPackage, context.packageName, context);
      addToIndex(contextsByPackageLicense, findingKey(context.packageName, context.license), context);
    }
  }

  const findings = [];
  const componentPurls = new Set();
  const componentPurlLicenses = new Set();
  for (const component of libraryComponents) {
    const purl = readTrimmedString(component?.purl);
    const matchedPackages = purl === null ? [] : packageEntriesByPurl.get(purl) ?? [];
    const componentName = readTrimmedString(component?.name);
    const packageName = uniqueValue(matchedPackages.map((entry) => entry.packageName)) ?? componentName;
    const version = readTrimmedString(component?.version);
    const packageTarget = uniqueValue(matchedPackages.map((entry) => entry.target));
    if (purl !== null) {
      componentPurls.add(purl);
    }

    if (purl === null) {
      findings.push(
        createCoverageFinding({
          packageName,
          policyRule: "missing-component-purl",
          purl,
          reportPath: input.reportPath,
          sbomPath: input.sbomPath,
          target: packageTarget,
          version,
        }),
      );
    } else if (matchedPackages.length === 0) {
      findings.push(
        createCoverageFinding({
          packageName,
          policyRule: "missing-report-package",
          purl,
          reportPath: input.reportPath,
          sbomPath: input.sbomPath,
          target: null,
          version,
        }),
      );
    }

    const componentLicenses = readComponentLicenseNames(component);
    if (componentLicenses.evidenceCount === 0) {
      findings.push(
        createCoverageFinding({
          packageName,
          policyRule: "missing-license",
          purl,
          reportPath: input.reportPath,
          sbomPath: input.sbomPath,
          target: packageTarget,
          version,
        }),
      );
    }
    for (let index = 0; index < componentLicenses.invalidCount; index += 1) {
      findings.push(
        createCoverageFinding({
          packageName,
          policyRule: "invalid-license-evidence",
          purl,
          reportPath: input.reportPath,
          sbomPath: input.sbomPath,
          target: packageTarget,
          version,
        }),
      );
    }

    for (const license of componentLicenses.names) {
      if (purl !== null) {
        componentPurlLicenses.add(findingKey(purl, license));
      }
      const specificContexts = contextsByPackageLicense.get(findingKey(packageName, license)) ?? [];
      const packageContexts = contextsByPackage.get(packageName) ?? [];
      const looseContexts = (contextsByLicense.get(license) ?? []).filter((context) => context.packageName === null);
      const contexts = specificContexts.length > 0 ? specificContexts : looseContexts;
      const category = uniqueValue(contexts.map((context) => context.category)) ?? "unknown";
      const target =
        uniqueValue(specificContexts.map((context) => context.target)) ??
        uniqueValue(packageContexts.map((context) => context.target)) ??
        packageTarget;
      findings.push(
        evaluateLicense(
          {
            category,
            filePath: uniqueValue(specificContexts.map((context) => context.filePath)),
            license,
            packageName,
            purl,
            reportPath: input.reportPath,
            sbomPath: input.sbomPath,
            target,
            version,
          },
          policy,
        ),
      );
    }
  }

  const unmatchedPackagePurls = new Set();
  for (const packageEntry of packageEntries) {
    if (packageEntry.purl === null) {
      findings.push(
        createCoverageFinding({
          packageName: packageEntry.packageName,
          policyRule: "missing-report-package-purl",
          purl: null,
          reportPath: input.reportPath,
          sbomPath: input.sbomPath,
          target: packageEntry.target,
          version: packageEntry.version,
        }),
      );
    } else if (!componentPurls.has(packageEntry.purl) && !unmatchedPackagePurls.has(packageEntry.purl)) {
      unmatchedPackagePurls.add(packageEntry.purl);
      findings.push(
        createCoverageFinding({
          packageName: packageEntry.packageName,
          policyRule: "missing-sbom-component",
          purl: packageEntry.purl,
          reportPath: input.reportPath,
          sbomPath: input.sbomPath,
          target: packageEntry.target,
          version: packageEntry.version,
        }),
      );
    }
  }

  const evaluatedReportPackageLicenses = new Set();
  for (const context of licenseContexts) {
    if (context.packageName === null) {
      findings.push(
        evaluateLicense(
          {
            category: context.category,
            filePath: context.filePath,
            license: context.license,
            packageName: null,
            purl: null,
            reportPath: input.reportPath,
            sbomPath: input.sbomPath,
            target: context.target,
            version: null,
          },
          policy,
        ),
      );
      continue;
    }

    const matchingPackages = packageEntries.filter(
      (packageEntry) =>
        packageEntry.packageName === context.packageName && packageEntry.licenses.includes(context.license),
    );
    if (matchingPackages.length === 0) {
      findings.push(
        createCoverageFinding({
          packageName: context.packageName,
          policyRule: "unmatched-license-finding",
          purl: null,
          reportPath: input.reportPath,
          sbomPath: input.sbomPath,
          target: context.target,
          version: null,
        }),
      );
      continue;
    }

    for (const packageEntry of matchingPackages) {
      const reportFindingKey = findingKey(packageEntry.purl, context.license, context.target);
      if (
        (packageEntry.purl !== null && componentPurlLicenses.has(findingKey(packageEntry.purl, context.license))) ||
        evaluatedReportPackageLicenses.has(reportFindingKey)
      ) {
        continue;
      }
      evaluatedReportPackageLicenses.add(reportFindingKey);
      findings.push(
        evaluateLicense(
          {
            category: context.category,
            filePath: context.filePath,
            license: context.license,
            packageName: context.packageName,
            purl: packageEntry.purl,
            reportPath: input.reportPath,
            sbomPath: input.sbomPath,
            target: context.target,
            version: packageEntry.version,
          },
          policy,
        ),
      );
    }
  }

  return {
    findings,
    summary: {
      componentCount: sbom.components.length,
      libraryCount: libraryComponents.length,
      report: input.reportPath,
      sbom: input.sbomPath,
    },
  };
}

const { inputs, outputPath, policyPath } = parseArguments(process.argv.slice(2));
const policyDocument = readJson(policyPath);
if (policyDocument.version !== 3) {
  throw new Error("Unsupported license policy version");
}

const policy = {
  allowedCategories: readStringSet(policyDocument, "allowedCategories"),
  allowedFindings: readAllowedFindings(policyDocument),
  allowedLicenses: readStringSet(policyDocument, "allowedLicenses"),
  deniedCategories: readStringSet(policyDocument, "deniedCategories"),
  deniedLicenses: readStringSet(policyDocument, "deniedLicenses"),
};

for (const value of policy.allowedCategories) {
  if (policy.deniedCategories.has(value)) {
    throw new Error(`License category appears in both allowed and denied sets: ${value}`);
  }
}
for (const value of policy.allowedLicenses) {
  if (policy.deniedLicenses.has(value)) {
    throw new Error(`License appears in both allowed and denied sets: ${value}`);
  }
}

const findings = [];
const reportSummaries = [];
for (const input of inputs) {
  const inspected = inspectInput(input, policy);
  findings.push(...inspected.findings);
  reportSummaries.push(inspected.summary);
}

findings.sort((left, right) =>
  findingKey(
    left.decision,
    left.license,
    left.purl,
    left.report,
    left.target,
    left.policyRule,
  ).localeCompare(
    findingKey(
      right.decision,
      right.license,
      right.purl,
      right.report,
      right.target,
      right.policyRule,
    ),
  ),
);
const summary = findings.reduce(
  (counts, finding) => {
    counts[finding.decision] += 1;
    return counts;
  },
  { allowed: 0, denied: 0, unknown: 0 },
);
const result = {
  findings,
  policy: policyPath,
  reports: reportSummaries,
  summary,
};

writeFileSync(resolve(repositoryRoot, outputPath), `${JSON.stringify(result, null, 2)}\n`, "utf8");
const passed = summary.denied === 0 && summary.unknown === 0;
process.stdout.write(
  `${passed ? "PASS" : "FAIL"} license policy: ${String(summary.allowed)} allowed, ` +
    `${String(summary.denied)} denied, ${String(summary.unknown)} unknown\n`,
);
if (!passed) {
  process.exitCode = 1;
}
