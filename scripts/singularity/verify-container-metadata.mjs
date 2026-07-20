import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, "../..");
const baselinePath = resolve(repositoryRoot, "config/upstream-baseline.json");

const SOURCE = "https://github.com/SparkElf/singularity";
const LICENSE = "AGPL-3.0-or-later";
const API_TITLE = "Singularity Enterprise API";
const WEB_TITLE = "Singularity Enterprise Web";
const WORKER_TITLE = "Singularity Enterprise Worker";
const DIAGNOSTIC_OUTPUT_LIMIT_CHARACTERS = 64 * 1_024;
const API_HEALTHCHECK = [
  "CMD",
  "/nodejs/bin/node",
  "-e",
  "fetch('http://127.0.0.1:'+(process.env.PORT||'3001')+'/api/v1/health/database').then((response)=>{if(!response.ok)throw new Error('API healthcheck returned status '+response.status);process.exit(0)}).catch((error)=>{console.error(error);process.exit(1)})",
];
const WORKER_HEALTHCHECK = [
  "CMD",
  "/nodejs/bin/node",
  "-e",
  "const fs=require('node:fs'),path=require('node:path');try{process.kill(1,0);if(process.versions.node.split('.')[0]!=='24')throw new Error('Worker runtime is not Node 24');for(const file of [process.env.SINGULARITY_WORKER_RESTORE_ARCHIVE_TOOL,process.env.SINGULARITY_WORKER_RESTORE_KERNEL_BINARY])fs.accessSync(file,fs.constants.X_OK);fs.accessSync(path.join(process.env.SINGULARITY_WORKER_RESTORE_KERNEL_WORKING_DIRECTORY,'appearance','langs','en.json'),fs.constants.R_OK)}catch(error){console.error(error);process.exit(1)}",
];
const API_ENVIRONMENT = [
  "NODE_ENV=production",
  "PORT=3001",
];
const WORKER_ENVIRONMENT = [
  "HOME=/var/lib/singularity-worker/home",
  "NODE_ENV=production",
  "SINGULARITY_WORKER_OBJECT_STORE_ROOT=/var/lib/singularity-worker/objects",
  "SINGULARITY_WORKER_RESTORE_ARCHIVE_TOOL=/opt/singularity-kernel/kernel",
  "SINGULARITY_WORKER_RESTORE_KERNEL_BINARY=/opt/singularity-kernel/kernel",
  "SINGULARITY_WORKER_RESTORE_KERNEL_LISTEN_ADDRESS=127.0.0.1",
  "SINGULARITY_WORKER_RESTORE_KERNEL_WORKING_DIRECTORY=/opt/singularity-kernel",
  "SINGULARITY_WORKER_RESTORE_RUNTIME_ROOT=/var/lib/singularity-worker/runtime",
];
const IMAGE_CONTRACTS = new Map([
  [
    API_TITLE,
    {
      command: ["dist/main.js"],
      environment: API_ENVIRONMENT,
      healthcheck: {
        interval: 30_000_000_000,
        retries: 3,
        startPeriod: 10_000_000_000,
        test: API_HEALTHCHECK,
        timeout: 5_000_000_000,
      },
      port: "3001/tcp",
      user: "65532",
    },
  ],
  [
    WEB_TITLE,
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

function nodeEntryProbe(runtimeName) {
  return [
    'const fs = require("node:fs");',
    `if (process.versions.node.split(".")[0] !== "24") throw new Error("${runtimeName} runtime is not Node 24");`,
    `if (process.env.NODE_ENV !== "production") throw new Error("${runtimeName} NODE_ENV is not production");`,
    'fs.accessSync("dist/main.js", fs.constants.R_OK);',
    'const entry = fs.statSync("dist/main.js");',
    `if (!entry.isFile() || entry.size === 0) throw new Error("${runtimeName} dist/main.js is unavailable");`,
  ].join("");
}

const API_FILESYSTEM_PROBE = nodeEntryProbe("API");
const WORKER_FILESYSTEM_PROBE = [
  nodeEntryProbe("Worker"),
  'const path = require("node:path");',
  'for (const file of [process.env.SINGULARITY_WORKER_RESTORE_ARCHIVE_TOOL, process.env.SINGULARITY_WORKER_RESTORE_KERNEL_BINARY]) {',
  '  fs.accessSync(file, fs.constants.X_OK);',
  '}',
  'const languagePath = path.join(process.env.SINGULARITY_WORKER_RESTORE_KERNEL_WORKING_DIRECTORY, "appearance", "langs", "en.json");',
  'fs.accessSync(languagePath, fs.constants.R_OK);',
  'const language = JSON.parse(fs.readFileSync(languagePath, "utf8"));',
  'if (language === null || typeof language !== "object" || Array.isArray(language)) throw new Error("Worker appearance language is invalid");',
].join("");

function boundedOutput(value) {
  if (value === undefined || value === null) {
    return "";
  }
  return (Buffer.isBuffer(value) ? value.toString("utf8") : String(value)).trim();
}

function spawnErrorStack(error) {
  if (error === undefined || error === null) {
    return "";
  }
  return typeof error.stack === "string" ? error.stack : String(error);
}

function probeFailure(image, failure, result) {
  const error = spawnErrorStack(result.error);
  const output = [
    ["stdout", boundedOutput(result.stdout)],
    ["stderr", boundedOutput(result.stderr)],
  ]
    .filter(([, value]) => value.length > 0)
    .map(([label, value]) => `[${label} tail]\n${value}`)
    .join("\n")
    .slice(-DIAGNOSTIC_OUTPUT_LIMIT_CHARACTERS);
  return [
    `${image}: ${failure}`,
    ...(error.length === 0 ? [] : [`[spawn error]\n${error}`]),
    ...(output.length === 0 ? [] : [`[bounded command output]\n${output}`]),
  ].join("\n");
}

function runContainerProbes(image, probes, run) {
  const failures = [];
  for (const probe of probes) {
    const result = run("docker", probe.args, { encoding: "utf8" });
    if (result.status !== 0 || result.error !== undefined) {
      failures.push(probeFailure(image, probe.failure, result));
    }
  }
  return failures;
}

export function probeApiRuntimeArtifacts(image, run = spawnSync) {
  return runContainerProbes(image, [
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
        API_FILESYSTEM_PROBE,
      ],
      failure: "Node 24, production environment, or API entry artifact probe failed",
    },
  ], run);
}

export function probeWorkerRuntimeArtifacts(image, run = spawnSync) {
  return runContainerProbes(image, [
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
      failure: "Node 24, production environment, Worker entry, Kernel, or appearance artifact probe failed",
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
  ], run);
}

function main() {
  const { images, options } = parseArguments(process.argv.slice(2));
  const baseline = JSON.parse(readFileSync(baselinePath, "utf8"));
  const inspect = spawnSync("docker", ["image", "inspect", ...images], { encoding: "utf8" });
  if (inspect.status !== 0 || inspect.error !== undefined) {
    throw new Error(probeFailure("docker image inspect", "failed", inspect));
  }

  const inspectedImages = JSON.parse(inspect.stdout);
  const failures = validateContainerMetadata(images, inspectedImages, {
    revision: options.revision,
    upstreamCommit: baseline.upstreamCommit,
  });
  if (failures.length === 0) {
    const apiIndex = inspectedImages.findIndex(
      (inspectedImage) => inspectedImage?.Config?.Labels?.["org.opencontainers.image.title"] === API_TITLE,
    );
    const workerIndex = inspectedImages.findIndex(
      (inspectedImage) => inspectedImage?.Config?.Labels?.["org.opencontainers.image.title"] === WORKER_TITLE,
    );
    failures.push(...probeApiRuntimeArtifacts(images[apiIndex]));
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
