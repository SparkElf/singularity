import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

function parseArguments(args) {
  let outputPath;
  let policyPath;
  const reportPaths = [];

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--output") {
      outputPath = args[index + 1];
      index += 1;
    } else if (argument === "--policy") {
      policyPath = args[index + 1];
      index += 1;
    } else if (argument?.startsWith("--")) {
      throw new Error(`Unknown argument: ${argument}`);
    } else if (argument !== undefined) {
      reportPaths.push(argument);
    }
  }

  if (outputPath === undefined || policyPath === undefined || reportPaths.length === 0) {
    throw new Error("Usage: check-license-reports.mjs --policy <policy.json> --output <result.json> <report.json>...");
  }

  return { outputPath, policyPath, reportPaths };
}

function readJson(path) {
  return JSON.parse(readFileSync(resolve(repositoryRoot, path), "utf8"));
}

function readStringSet(policy, field) {
  const values = policy[field];
  if (!Array.isArray(values) || values.some((value) => typeof value !== "string" || value.length === 0)) {
    throw new Error(`License policy field ${field} must be a non-empty string array`);
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
      !Array.isArray(finding.packages) ||
      finding.packages.length === 0 ||
      finding.packages.some((packageName) => typeof packageName !== "string" || packageName.length === 0) ||
      typeof finding.reason !== "string" ||
      finding.reason.length === 0
    ) {
      throw new Error(`Invalid allowedFindings entry at index ${String(index)}`);
    }
    return {
      license: finding.license,
      packages: new Set(finding.packages),
      reason: finding.reason,
    };
  });
}

const { outputPath, policyPath, reportPaths } = parseArguments(process.argv.slice(2));
const policy = readJson(policyPath);
if (policy.version !== 1) {
  throw new Error("Unsupported license policy version");
}

const allowedCategories = readStringSet(policy, "allowedCategories");
const allowedLicenses = readStringSet(policy, "allowedLicenses");
const allowedFindings = readAllowedFindings(policy);
const deniedCategories = readStringSet(policy, "deniedCategories");
const deniedLicenses = readStringSet(policy, "deniedLicenses");

for (const value of allowedCategories) {
  if (deniedCategories.has(value)) {
    throw new Error(`License category appears in both allowed and denied sets: ${value}`);
  }
}
for (const value of allowedLicenses) {
  if (deniedLicenses.has(value)) {
    throw new Error(`License appears in both allowed and denied sets: ${value}`);
  }
}

const findings = [];
const reportSummaries = [];
for (const reportPath of reportPaths) {
  const report = readJson(reportPath);
  if (!Array.isArray(report.Results)) {
    throw new Error(`Trivy report has no Results array: ${reportPath}`);
  }

  let reportLicenseCount = 0;
  for (const result of report.Results) {
    const licenses = Array.isArray(result?.Licenses) ? result.Licenses : [];
    for (const license of licenses) {
      const name = typeof license?.Name === "string" ? license.Name.trim() : "";
      const category = typeof license?.Category === "string" ? license.Category.trim().toLowerCase() : "unknown";
      const packageName = typeof license?.PkgName === "string" ? license.PkgName : null;
      if (name.length === 0) {
        throw new Error(`Trivy report contains a license without a name: ${reportPath}`);
      }

      reportLicenseCount += 1;
      let decision;
      let policyRule;
      let reason = null;
      if (allowedLicenses.has(name)) {
        decision = "allowed";
        policyRule = "license";
      } else if (packageName !== null) {
        const allowedFinding = allowedFindings.find(
          (finding) => finding.license === name && finding.packages.has(packageName),
        );
        if (allowedFinding !== undefined) {
          decision = "allowed";
          policyRule = "finding";
          reason = allowedFinding.reason;
        }
      }
      if (decision === undefined && (deniedLicenses.has(name) || deniedCategories.has(category))) {
        decision = "denied";
        policyRule = deniedLicenses.has(name) ? "license" : "category";
      } else if (decision === undefined && allowedCategories.has(category)) {
        decision = "allowed";
        policyRule = "category";
      } else if (decision === undefined) {
        decision = "unknown";
        policyRule = "unmatched";
      }

      findings.push({
        category,
        decision,
        filePath: typeof license.FilePath === "string" ? license.FilePath : null,
        license: name,
        packageName,
        policyRule,
        reason,
        report: reportPath,
        target: typeof result.Target === "string" ? result.Target : null,
      });
    }
  }

  if (reportLicenseCount === 0) {
    throw new Error(`Trivy report contains no license findings: ${reportPath}`);
  }
  reportSummaries.push({ licenseCount: reportLicenseCount, report: reportPath });
}

findings.sort((left, right) =>
  `${left.decision}\u0000${left.license}\u0000${left.report}\u0000${left.target ?? ""}`.localeCompare(
    `${right.decision}\u0000${right.license}\u0000${right.report}\u0000${right.target ?? ""}`,
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
  `${passed ? "PASS" : "FAIL"} license policy: ${String(summary.allowed)} allowed, ${String(summary.denied)} denied, ${String(summary.unknown)} unknown\n`,
);
if (!passed) {
  process.exitCode = 1;
}
