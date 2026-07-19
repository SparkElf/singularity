import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, test } from "node:test";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const scriptPath = resolve(repositoryRoot, "scripts/singularity/verify-production-sbom.mjs");
const enterpriseRequire = createRequire(resolve(repositoryRoot, "enterprise/package.json"));
const { parseDocument } = enterpriseRequire("yaml");
const temporaryDirectories = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

function npmComponent(name, version = "1.0.0", group) {
  const purlName = group === undefined ? name : encodeURIComponent(group) + "/" + name;
  return {
    group,
    name,
    purl: "pkg:npm/" + purlName + "@" + version,
    type: "library",
    version,
  };
}

function runtimePackage(component) {
  return {
    name: component.group === undefined ? component.name : component.group + "/" + component.name,
    purl: component.purl,
    version: component.version,
  };
}

function runPolicy({
  apiComponents,
  runtimePackages = apiComponents.map(runtimePackage),
  workerComponents = validWorkerComponents(),
  workerRuntimePackages = workerComponents.map(runtimePackage),
  webComponents = [],
}) {
  const directory = mkdtempSync(resolve(tmpdir(), "singularity-production-sbom-"));
  temporaryDirectories.push(directory);
  const apiPath = resolve(directory, "api.cdx.json");
  const binDirectory = resolve(directory, "bin");
  const dockerPath = resolve(binDirectory, "docker");
  const outputPath = resolve(directory, "result.json");
  const webPath = resolve(directory, "web.cdx.json");
  const workerPath = resolve(directory, "worker.cdx.json");
  mkdirSync(binDirectory);
  writeFileSync(
    dockerPath,
    "#!/usr/bin/env node\n" +
      `const expectedPrefix=${JSON.stringify([
        "run",
        "--rm",
        "--network=none",
        "--pull=never",
        "--read-only",
        "--entrypoint=/nodejs/bin/node",
      ])};\n` +
      `const runtimes=${JSON.stringify({
        "fixture:api": runtimePackages,
        "fixture:worker": workerRuntimePackages,
      })};\n` +
      "const args=process.argv.slice(2);\n" +
      "if(expectedPrefix.some((value,index)=>args[index]!==value)||args[7]!==\"-e\"||runtimes[args[6]]===undefined){process.exit(91);}\n" +
      "process.stdout.write(JSON.stringify(runtimes[args[6]]));\n",
    { encoding: "utf8", mode: 0o755 },
  );
  chmodSync(dockerPath, 0o755);
  writeFileSync(
    apiPath,
    JSON.stringify({ bomFormat: "CycloneDX", components: apiComponents, specVersion: "1.7" }),
    "utf8",
  );
  writeFileSync(
    webPath,
    JSON.stringify({ bomFormat: "CycloneDX", components: webComponents, specVersion: "1.7" }),
    "utf8",
  );
  writeFileSync(
    workerPath,
    JSON.stringify({ bomFormat: "CycloneDX", components: workerComponents, specVersion: "1.7" }),
    "utf8",
  );
  const result = spawnSync(
    process.execPath,
    [
      scriptPath,
      "--api-image",
      "fixture:api",
      "--api",
      apiPath,
      "--worker-image",
      "fixture:worker",
      "--worker",
      workerPath,
      "--web",
      webPath,
      "--output",
      outputPath,
    ],
    {
      cwd: repositoryRoot,
      encoding: "utf8",
      env: { ...process.env, PATH: `${binDirectory}:${process.env.PATH}` },
    },
  );
  return {
    report: existsSync(outputPath) ? JSON.parse(readFileSync(outputPath, "utf8")) : null,
    result,
  };
}

function validApiComponents() {
  return [
    npmComponent("argon2", "2.0.2", "@node-rs"),
    npmComponent("argon2-linux-x64-gnu", "2.0.2", "@node-rs"),
    npmComponent("client", "7.8.0", "@prisma"),
  ];
}

function validWorkerComponents() {
  return [npmComponent("worker-runtime", "0.1.0")];
}

function readYaml(path) {
  const document = parseDocument(readFileSync(resolve(repositoryRoot, path), "utf8"), {
    prettyErrors: true,
    uniqueKeys: true,
  });
  assert.deepEqual(document.errors, []);
  return document.toJS();
}

function readSupplyChainSteps() {
  return readYaml(".github/workflows/singularity-l0.yml").jobs["supply-chain"].steps;
}

function normalizeRunCommand(run) {
  return run.replace(/\\\s+/gu, " ").replace(/\s+/gu, " ").trim();
}

test("production SBOM policy accepts API and Worker runtime closures and static Web image", () => {
  const { report, result } = runPolicy({ apiComponents: validApiComponents() });

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(report.violations, []);
  assert.equal(report.apiNpmPackageCount, 3);
  assert.equal(report.apiRuntimePackageCount, 3);
  assert.equal(report.webNpmPackageCount, 0);
  assert.equal(report.workerNpmPackageCount, 1);
  assert.equal(report.workerRuntimePackageCount, 1);
});

test("production SBOM policy rejects tool packages in the Worker runtime", () => {
  const { report, result } = runPolicy({
    apiComponents: validApiComponents(),
    workerComponents: [...validWorkerComponents(), npmComponent("typescript")],
  });

  assert.equal(result.status, 1);
  assert.deepEqual(report.violations, [
    {
      image: "worker",
      package: "pkg:npm/typescript@1.0.0",
      reason: "forbidden production dependency",
    },
  ]);
});

test("production SBOM policy rejects tool and optional database packages", async (t) => {
  for (const name of ["benchmark", "mysql2", "prisma", "seq-queue", "transport", "typescript"]) {
    await t.test(name, () => {
      const { report, result } = runPolicy({
        apiComponents: [...validApiComponents(), npmComponent(name)],
      });
      assert.equal(result.status, 1);
      assert.deepEqual(report.violations, [
        {
          image: "api",
          package: "pkg:npm/" + name + "@1.0.0",
          reason: "forbidden production dependency",
        },
      ]);
    });
  }
});

test("production SBOM policy rejects a package unreachable from the runtime root", () => {
  const runtimePackages = validApiComponents().map(runtimePackage);
  const { report, result } = runPolicy({
    apiComponents: [...validApiComponents(), npmComponent("vitest", "4.1.10")],
    runtimePackages,
  });

  assert.equal(result.status, 1);
  assert.deepEqual(report.violations, [
    {
      image: "api",
      package: "pkg:npm/vitest@4.1.10",
      reason: "raw SBOM package is unreachable from the runtime root",
    },
  ]);
});

test("production SBOM policy rejects a runtime package missing from the raw SBOM", () => {
  const components = validApiComponents();
  const { report, result } = runPolicy({
    apiComponents: components.filter((component) => component.name !== "client"),
    runtimePackages: components.map(runtimePackage),
  });

  assert.equal(result.status, 1);
  assert.deepEqual(report.violations, [
    {
      image: "api",
      package: "pkg:npm/%40prisma/client@7.8.0",
      reason: "runtime package missing from raw SBOM",
    },
  ]);
});

test("production SBOM policy rejects an npm component whose fields disagree with its PURL", () => {
  const apiComponents = validApiComponents();
  apiComponents[0].purl = "pkg:npm/%40node-rs/argon2@9.9.9";
  const { report, result } = runPolicy({
    apiComponents,
    runtimePackages: validApiComponents().map(runtimePackage),
  });

  assert.equal(result.status, 1);
  assert.equal(report, null);
  assert.match(result.stderr, /Production SBOM npm component identity does not match its PURL/);
});

test("production SBOM policy rejects a non-Linux Argon2 native package", () => {
  const { report, result } = runPolicy({
    apiComponents: [...validApiComponents(), npmComponent("argon2-darwin-arm64", "2.0.2", "@node-rs")],
  });

  assert.equal(result.status, 1);
  assert.equal(report.violations.length, 1);
  assert.equal(report.violations[0].reason, "non-linux-x64-gnu Argon2 native package");
});

test("production SBOM policy requires the Linux x64 GNU Argon2 native package", () => {
  const { report, result } = runPolicy({
    apiComponents: [npmComponent("argon2", "2.0.2", "@node-rs")],
  });

  assert.equal(result.status, 1);
  assert.deepEqual(report.violations, [
    {
      image: "api",
      package: "@node-rs/argon2-linux-x64-gnu",
      reason: "expected exactly one Linux x64 GNU Argon2 native package version",
    },
  ]);
});

test("production SBOM policy rejects Node packages in the static Web runtime", () => {
  const { report, result } = runPolicy({
    apiComponents: validApiComponents(),
    webComponents: [npmComponent("typescript")],
  });

  assert.equal(result.status, 1);
  assert.deepEqual(report.violations, [
    {
      image: "web",
      package: "pkg:npm/typescript@1.0.0",
      reason: "static Web runtime contains a Node package",
    },
  ]);
});

test("enterprise source vulnerability scanning consumes the shared dev-dependency Trivy policy", () => {
  const step = readSupplyChainSteps().find((candidate) => candidate.id === "enterprise_vulnerability");
  const trivyConfig = readYaml("config/trivy.yaml");

  assert.equal(step.with["trivy-config"], "config/trivy.yaml");
  assert.equal(trivyConfig.pkg["include-dev-deps"], true);
});

test("shared Trivy policy performs full license analysis without scanning generated reports", () => {
  const trivyConfig = readYaml("config/trivy.yaml");

  assert.equal(trivyConfig.license.full, true);
  assert.deepEqual(trivyConfig.scan["skip-dirs"], ["artifacts/supply-chain"]);
});

test("L0 workflow preserves source plus all three image report pairings", () => {
  const steps = readSupplyChainSteps();
  const licensePolicy = normalizeRunCommand(
    steps.find((candidate) => candidate.id === "license_policy").run,
  );
  const mappings = [
    ["source", "source.trivy.cdx.json", "source.cdx.json", "source-licenses.json"],
    ["api", "api.trivy.cdx.json", "api.cdx.json", "api-licenses.json"],
    ["worker", "worker.trivy.cdx.json", "worker.cdx.json", "worker-licenses.json"],
    ["web", "web.trivy.cdx.json", "web.cdx.json", "web-licenses.json"],
  ];

  for (const [prefix, rawName, canonicalName, reportName] of mappings) {
    const rawPath = "artifacts/supply-chain/" + rawName;
    const canonicalPath = "artifacts/supply-chain/" + canonicalName;
    const reportPath = "artifacts/supply-chain/" + reportName;
    const sbomStep = steps.find((candidate) => candidate.id === prefix + "_sbom");
    const evidenceStep = steps.find((candidate) => candidate.id === prefix + "_sbom_evidence");
    const licenseStep = steps.find((candidate) => candidate.id === prefix + "_license");

    assert.equal(sbomStep.with.output, rawPath, prefix);
    assert.match(normalizeRunCommand(evidenceStep.run), new RegExp("--input " + rawPath.replaceAll(".", "\\.")));
    assert.match(
      normalizeRunCommand(evidenceStep.run),
      new RegExp("--output " + canonicalPath.replaceAll(".", "\\.")),
    );
    assert.equal(licenseStep.with.output, reportPath, prefix);
    assert.ok(licensePolicy.includes("--report " + reportPath + " --sbom " + canonicalPath), prefix);
  }
});

test("L0 vulnerability policy consumes the enterprise, API, Worker, and Web scan reports", () => {
  const steps = readSupplyChainSteps();
  const enterpriseStep = steps.find((candidate) => candidate.id === "enterprise_vulnerability");
  const apiStep = steps.find((candidate) => candidate.id === "api_vulnerability");
  const workerStep = steps.find((candidate) => candidate.id === "worker_vulnerability");
  const webStep = steps.find((candidate) => candidate.id === "web_vulnerability");
  const policyRun = normalizeRunCommand(
    steps.find((candidate) => candidate.id === "vulnerability_policy").run,
  );
  const reportPaths = [...policyRun.matchAll(/--report ([^ ]+)/gu)].map((match) => match[1]);

  for (const step of [enterpriseStep, apiStep, workerStep, webStep]) {
    assert.equal(step.with.scanners, "vuln");
    assert.equal(step.with.severity, "HIGH,CRITICAL");
    assert.equal(step.with["ignore-unfixed"], false);
  }
  assert.equal(enterpriseStep.with["scan-type"], "fs");
  assert.equal(enterpriseStep.with["scan-ref"], "enterprise");
  assert.equal(enterpriseStep.with["vuln-type"], "library");
  assert.equal(enterpriseStep.with.output, "artifacts/supply-chain/enterprise-vulnerabilities.json");
  assert.equal(enterpriseStep.with["trivy-config"], "config/trivy.yaml");
  assert.equal(apiStep.with["scan-type"], "image");
  assert.equal(apiStep.with["image-ref"], "${{ env.API_IMAGE }}");
  assert.equal(apiStep.with["vuln-type"], "os,library");
  assert.equal(apiStep.with.output, "artifacts/supply-chain/api-vulnerabilities.json");
  assert.equal(workerStep.with["scan-type"], "image");
  assert.equal(workerStep.with["image-ref"], "${{ env.WORKER_IMAGE }}");
  assert.equal(workerStep.with["vuln-type"], "os,library");
  assert.equal(workerStep.with.output, "artifacts/supply-chain/worker-vulnerabilities.json");
  assert.equal(webStep.with["scan-type"], "image");
  assert.equal(webStep.with["image-ref"], "${{ env.WEB_IMAGE }}");
  assert.equal(webStep.with["vuln-type"], "os,library");
  assert.equal(webStep.with.output, "artifacts/supply-chain/web-vulnerabilities.json");
  assert.deepEqual(reportPaths, [
    "artifacts/supply-chain/enterprise-vulnerabilities.json",
    "artifacts/supply-chain/api-vulnerabilities.json",
    "artifacts/supply-chain/worker-vulnerabilities.json",
    "artifacts/supply-chain/web-vulnerabilities.json",
  ]);
});

test("L0 workflow gates the raw API, Worker, and Web SBOM production closure result", () => {
  const steps = readSupplyChainSteps();
  const policyStep = steps.find((candidate) => candidate.id === "production_sbom_policy");
  const outcomeStep = steps.find((candidate) => candidate.name === "Enforce supply-chain outcomes");

  assert.equal(policyStep["continue-on-error"], true);
  assert.match(policyStep.run, /--api-image "\$API_IMAGE"/);
  assert.match(policyStep.run, /--api artifacts\/supply-chain\/api\.trivy\.cdx\.json/);
  assert.match(policyStep.run, /--worker-image "\$WORKER_IMAGE"/);
  assert.match(policyStep.run, /--worker artifacts\/supply-chain\/worker\.trivy\.cdx\.json/);
  assert.match(policyStep.run, /--web artifacts\/supply-chain\/web\.trivy\.cdx\.json/);
  assert.equal(outcomeStep.env.PRODUCTION_SBOM_POLICY, "${{ steps.production_sbom_policy.outcome }}");
  assert.match(outcomeStep.run, /"\$PRODUCTION_SBOM_POLICY"/);
});

test("L0 image smoke waits for Docker health and gives API and Worker the same audit key", () => {
  const steps = readSupplyChainSteps();
  const smoke = normalizeRunCommand(
    steps.find((candidate) => candidate.name === "Smoke enterprise images").run,
  );

  for (const container of [
    "singularity-api-smoke",
    "singularity-worker-smoke",
    "singularity-web-smoke",
  ]) {
    assert.ok(smoke.includes("wait_for_health " + container), container);
  }
  const apiStart = smoke.indexOf("docker run --detach --name singularity-api-smoke");
  const workerStart = smoke.indexOf("docker run --detach --name singularity-worker-smoke");
  const webStart = smoke.indexOf("docker run --detach --name singularity-web-smoke");
  assert.ok(apiStart >= 0 && apiStart < workerStart && workerStart < webStart);
  for (const command of [
    smoke.slice(apiStart, workerStart),
    smoke.slice(workerStart, webStart),
  ]) {
    assert.ok(command.includes('--env SINGULARITY_AUDIT_HMAC_KEY="$audit_key"'));
    assert.ok(command.includes('--env SINGULARITY_AUDIT_KEY_VERSION="ci-audit-v1"'));
  }
});

test("L0 workflow enforces every independently continuing supply-chain outcome", () => {
  const steps = readSupplyChainSteps();
  const outcomeStep = steps.find((candidate) => candidate.name === "Enforce supply-chain outcomes");
  const gatedSteps = [
    ["api_license", "API_LICENSE"],
    ["api_sbom", "API_SBOM"],
    ["api_sbom_evidence", "API_SBOM_EVIDENCE"],
    ["api_vulnerability", "API_VULNERABILITY"],
    ["enterprise_vulnerability", "ENTERPRISE_VULNERABILITY"],
    ["license_policy", "LICENSE_POLICY"],
    ["production_sbom_policy", "PRODUCTION_SBOM_POLICY"],
    ["source_license", "SOURCE_LICENSE"],
    ["source_sbom", "SOURCE_SBOM"],
    ["source_sbom_evidence", "SOURCE_SBOM_EVIDENCE"],
    ["vulnerability_policy", "VULNERABILITY_POLICY"],
    ["web_license", "WEB_LICENSE"],
    ["web_sbom", "WEB_SBOM"],
    ["web_sbom_evidence", "WEB_SBOM_EVIDENCE"],
    ["web_vulnerability", "WEB_VULNERABILITY"],
    ["worker_license", "WORKER_LICENSE"],
    ["worker_sbom", "WORKER_SBOM"],
    ["worker_sbom_evidence", "WORKER_SBOM_EVIDENCE"],
    ["worker_vulnerability", "WORKER_VULNERABILITY"],
  ];
  const continuingStepIds = steps
    .filter((step) => step["continue-on-error"] === true)
    .map((step) => step.id)
    .sort();
  assert.deepEqual(continuingStepIds, gatedSteps.map(([stepId]) => stepId).sort());

  for (const [stepId, environmentName] of gatedSteps) {
    const step = steps.find((candidate) => candidate.id === stepId);
    assert.equal(step["continue-on-error"], true, stepId);
    assert.equal(outcomeStep.env[environmentName], `\${{ steps.${stepId}.outcome }}`, stepId);
    assert.ok(outcomeStep.run.includes(`"$${environmentName}"`), environmentName);
  }
});
