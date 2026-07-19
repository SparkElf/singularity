import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, "../..");
const baselinePath = resolve(repositoryRoot, "config/upstream-baseline.json");

const SOURCE = "https://github.com/SparkElf/singularity";
const LICENSE = "AGPL-3.0-or-later";
const WORKER_TITLE = "Singularity Enterprise Worker";
const WORKER_HEALTHCHECK = [
  "CMD",
  "/nodejs/bin/node",
  "-e",
  "const fs=require('node:fs'),path=require('node:path');try{process.kill(1,0);if(process.versions.node.split('.')[0]!=='24')throw new Error();for(const file of [process.env.SINGULARITY_WORKER_RESTORE_ARCHIVE_TOOL,process.env.SINGULARITY_WORKER_RESTORE_KERNEL_BINARY])fs.accessSync(file,fs.constants.X_OK);fs.accessSync(path.join(process.env.SINGULARITY_WORKER_RESTORE_KERNEL_WORKING_DIRECTORY,'appearance','langs','en.json'),fs.constants.R_OK)}catch{process.exit(1)}",
];
const WORKER_ENVIRONMENT = [
  "HOME=/var/lib/singularity-worker/home",
  "NODE_ENV=production",
  "SINGULARITY_WORKER_OBJECT_STORE_ROOT=/var/lib/singularity-worker/objects",
  "SINGULARITY_WORKER_RESTORE_ARCHIVE_TOOL=/opt/singularity-kernel/kernel",
  "SINGULARITY_WORKER_RESTORE_KERNEL_BINARY=/opt/singularity-kernel/kernel",
  "SINGULARITY_WORKER_RESTORE_KERNEL_WORKING_DIRECTORY=/opt/singularity-kernel",
  "SINGULARITY_WORKER_RESTORE_RUNTIME_ROOT=/var/lib/singularity-worker/runtime",
];
const IMAGE_CONTRACTS = new Map([
  [
    "Singularity Enterprise API",
    {
      command: ["dist/main.js"],
      healthcheck: {
        interval: 30_000_000_000,
        retries: 3,
        startPeriod: 10_000_000_000,
        test: [
          "CMD",
          "/nodejs/bin/node",
          "-e",
          "fetch('http://127.0.0.1:'+(process.env.PORT||'3001')+'/api/v1/health/database').then((response)=>process.exit(response.ok?0:1)).catch(()=>process.exit(1))",
        ],
        timeout: 5_000_000_000,
      },
      port: "3001/tcp",
      user: "65532",
    },
  ],
  [
    "Singularity Enterprise Web",
    {
      command: ["nginx", "-g", "daemon off;"],
      healthcheck: {
        interval: 30_000_000_000,
        retries: 3,
        startPeriod: 5_000_000_000,
        test: ["CMD", "wget", "-q", "-O", "-", "http://127.0.0.1:8080/healthz"],
        timeout: 5_000_000_000,
      },
      port: "8080/tcp",
      user: "101",
    },
  ],
  [
    WORKER_TITLE,
    {
      command: ["dist/main.js"],
      environment: WORKER_ENVIRONMENT,
      healthcheck: {
        interval: 30_000_000_000,
        retries: 3,
        startPeriod: 10_000_000_000,
        test: WORKER_HEALTHCHECK,
        timeout: 5_000_000_000,
      },
      port: null,
      user: "65532",
    },
  ],
]);

export function parseArguments(args) {
  const separator = args.indexOf("--");
  const optionArgs = separator === -1 ? args : args.slice(0, separator);
  const images = separator === -1 ? [] : args.slice(separator + 1);
  const options = {};

  for (let index = 0; index < optionArgs.length; index += 2) {
    const name = optionArgs[index];
    const value = optionArgs[index + 1];
    if (name === "--upstream") {
      throw new Error("Invalid argument: --upstream; upstream is read from config/upstream-baseline.json");
    }
    if (value === undefined || name !== "--revision" || options.revision !== undefined) {
      throw new Error(`Invalid argument: ${name ?? ""}`);
    }
    options.revision = value;
  }

  if (options.revision === undefined || images.length !== IMAGE_CONTRACTS.size) {
    throw new Error("Usage: verify-container-metadata.mjs --revision <sha> -- <api-image> <worker-image> <web-image>");
  }
  return { images, options };
}

function arraysEqual(actual, expected) {
  return Array.isArray(actual) &&
    actual.length === expected.length &&
    actual.every((value, index) => value === expected[index]);
}

function healthchecksEqual(actual, expected) {
  return arraysEqual(actual?.Test, expected.test) &&
    actual?.Interval === expected.interval &&
    actual?.Retries === expected.retries &&
    actual?.StartPeriod === expected.startPeriod &&
    actual?.Timeout === expected.timeout;
}

export function validateContainerMetadata(images, inspectedImages, { revision, upstreamCommit }) {
  const failures = [];
  const identityCounts = new Map([...IMAGE_CONTRACTS.keys()].map((title) => [title, 0]));

  for (const [index, image] of images.entries()) {
    const config = inspectedImages[index]?.Config;
    const labels = config?.Labels;
    const title = labels?.["org.opencontainers.image.title"];
    const contract = IMAGE_CONTRACTS.get(title);

    if (contract === undefined) {
      failures.push(`${image}: title label mismatch`);
    } else {
      identityCounts.set(title, identityCounts.get(title) + 1);
    }
    if (labels?.["org.opencontainers.image.revision"] !== revision) {
      failures.push(`${image}: revision label mismatch`);
    }
    if (labels?.["io.singularity.upstream.commit"] !== upstreamCommit) {
      failures.push(`${image}: upstream label mismatch`);
    }
    if (labels?.["org.opencontainers.image.licenses"] !== LICENSE) {
      failures.push(`${image}: license label mismatch`);
    }
    if (labels?.["org.opencontainers.image.source"] !== SOURCE) {
      failures.push(`${image}: source label mismatch`);
    }

    if (contract === undefined) {
      continue;
    }
    if (config?.User !== contract.user) {
      failures.push(`${image}: user mismatch for ${title}`);
    }
    const environment = Array.isArray(config?.Env) ? config.Env : [];
    for (const expected of contract.environment ?? []) {
      const separator = expected.indexOf("=");
      const name = expected.slice(0, separator);
      const matches = environment.filter((entry) => entry.startsWith(name + "="));
      if (matches.length !== 1 || matches[0] !== expected) {
        failures.push(`${image}: environment mismatch for ${title}: ${name}`);
      }
    }
    const exposedPorts = config?.ExposedPorts ?? {};
    if (contract.port === null) {
      if (Object.keys(exposedPorts).length !== 0) {
        failures.push(`${image}: unexpected exposed port for ${title}`);
      }
    } else if (!Object.hasOwn(exposedPorts, contract.port)) {
      failures.push(`${image}: exposed port mismatch for ${title}`);
    }
    if (!arraysEqual(config?.Cmd, contract.command)) {
      failures.push(`${image}: command mismatch for ${title}`);
    }
    if (!healthchecksEqual(config?.Healthcheck, contract.healthcheck)) {
      failures.push(`${image}: healthcheck mismatch for ${title}`);
    }
  }

  for (const [title, count] of identityCounts) {
    if (count !== 1) {
      failures.push(`${title}: expected exactly one image, found ${String(count)}`);
    }
  }

  return failures;
}

const WORKER_FILESYSTEM_PROBE = [
  'const fs = require("node:fs");',
  'const path = require("node:path");',
  'if (process.versions.node.split(".")[0] !== "24") throw new Error("Worker runtime is not Node 24");',
  'for (const file of [process.env.SINGULARITY_WORKER_RESTORE_ARCHIVE_TOOL, process.env.SINGULARITY_WORKER_RESTORE_KERNEL_BINARY]) {',
  '  fs.accessSync(file, fs.constants.X_OK);',
  '}',
  'const languagePath = path.join(process.env.SINGULARITY_WORKER_RESTORE_KERNEL_WORKING_DIRECTORY, "appearance", "langs", "en.json");',
  'fs.accessSync(languagePath, fs.constants.R_OK);',
  'const language = JSON.parse(fs.readFileSync(languagePath, "utf8"));',
  'if (language === null || typeof language !== "object" || Array.isArray(language)) throw new Error("Worker appearance language is invalid");',
].join("");

export function probeWorkerRuntimeArtifacts(image, run = spawnSync) {
  const probes = [
    {
      args: [
        "run",
        "--rm",
        "--network=none",
        "--pull=never",
        "--read-only",
        "--entrypoint=/nodejs/bin/node",
        image,
        "-e",
        WORKER_FILESYSTEM_PROBE,
      ],
      failure: "Node 24, Kernel executable, or appearance artifact probe failed",
    },
    {
      args: [
        "run",
        "--rm",
        "--network=none",
        "--pull=never",
        "--read-only",
        "--entrypoint=/opt/singularity-kernel/kernel",
        image,
        "workspace",
        "restore-archive",
        "--help",
      ],
      failure: "Kernel restore-archive executable probe failed",
    },
  ];
  const failures = [];
  for (const probe of probes) {
    const result = run("docker", probe.args, { encoding: "utf8" });
    if (result.status !== 0) {
      failures.push(`${image}: ${probe.failure}`);
    }
  }
  return failures;
}

function main() {
  const { images, options } = parseArguments(process.argv.slice(2));
  const baseline = JSON.parse(readFileSync(baselinePath, "utf8"));
  const inspect = spawnSync("docker", ["image", "inspect", ...images], { encoding: "utf8" });
  if (inspect.status !== 0) {
    throw new Error(inspect.stderr.trim() || inspect.error?.message || "docker image inspect failed");
  }

  const inspectedImages = JSON.parse(inspect.stdout);
  const failures = validateContainerMetadata(images, inspectedImages, {
    revision: options.revision,
    upstreamCommit: baseline.upstreamCommit,
  });
  if (failures.length === 0) {
    const workerIndex = inspectedImages.findIndex(
      (inspectedImage) => inspectedImage?.Config?.Labels?.["org.opencontainers.image.title"] === WORKER_TITLE,
    );
    failures.push(...probeWorkerRuntimeArtifacts(images[workerIndex]));
  }
  if (failures.length > 0) {
    for (const failure of failures) {
      process.stderr.write(`FAIL container metadata: ${failure}\n`);
    }
    process.exitCode = 1;
  } else {
    process.stdout.write(`PASS container metadata: ${images.join(", ")}\n`);
  }
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  main();
}
