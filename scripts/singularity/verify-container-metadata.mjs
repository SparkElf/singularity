import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, "../..");
const baselinePath = resolve(repositoryRoot, "config/upstream-baseline.json");

const SOURCE = "https://github.com/SparkElf/singularity";
const LICENSE = "AGPL-3.0-or-later";
const IMAGE_CONTRACTS = new Map([
  [
    "Singularity Enterprise API",
    {
      command: ["dist/main.js"],
      healthcheck: [
        "CMD",
        "/nodejs/bin/node",
        "-e",
        "fetch('http://127.0.0.1:'+(process.env.PORT||'3001')+'/api/v1/health/database').then((response)=>process.exit(response.ok?0:1)).catch(()=>process.exit(1))",
      ],
      port: "3001/tcp",
      user: "65532",
    },
  ],
  [
    "Singularity Enterprise Web",
    {
      command: ["nginx", "-g", "daemon off;"],
      healthcheck: ["CMD", "wget", "-q", "-O", "-", "http://127.0.0.1:8080/healthz"],
      port: "8080/tcp",
      user: "101",
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
    throw new Error("Usage: verify-container-metadata.mjs --revision <sha> -- <api-image> <web-image>");
  }
  return { images, options };
}

function arraysEqual(actual, expected) {
  return Array.isArray(actual) &&
    actual.length === expected.length &&
    actual.every((value, index) => value === expected[index]);
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
    if (!Object.hasOwn(config?.ExposedPorts ?? {}, contract.port)) {
      failures.push(`${image}: exposed port mismatch for ${title}`);
    }
    if (!arraysEqual(config?.Cmd, contract.command)) {
      failures.push(`${image}: command mismatch for ${title}`);
    }
    if (!arraysEqual(config?.Healthcheck?.Test, contract.healthcheck)) {
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

function main() {
  const { images, options } = parseArguments(process.argv.slice(2));
  const baseline = JSON.parse(readFileSync(baselinePath, "utf8"));
  const inspect = spawnSync("docker", ["image", "inspect", ...images], { encoding: "utf8" });
  if (inspect.status !== 0) {
    throw new Error(inspect.stderr.trim() || inspect.error?.message || "docker image inspect failed");
  }

  const failures = validateContainerMetadata(images, JSON.parse(inspect.stdout), {
    revision: options.revision,
    upstreamCommit: baseline.upstreamCommit,
  });
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
