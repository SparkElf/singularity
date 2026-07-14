import { spawnSync } from "node:child_process";

function parseArguments(args) {
  const separator = args.indexOf("--");
  const optionArgs = separator === -1 ? args : args.slice(0, separator);
  const images = separator === -1 ? [] : args.slice(separator + 1);
  const options = {};

  for (let index = 0; index < optionArgs.length; index += 2) {
    const name = optionArgs[index];
    const value = optionArgs[index + 1];
    if (value === undefined || !["--revision", "--upstream"].includes(name)) {
      throw new Error(`Invalid argument: ${name ?? ""}`);
    }
    options[name.slice(2)] = value;
  }

  if (options.revision === undefined || options.upstream === undefined || images.length === 0) {
    throw new Error("Usage: verify-container-metadata.mjs --revision <sha> --upstream <sha> -- <image>...");
  }
  return { images, options };
}

const { images, options } = parseArguments(process.argv.slice(2));
const inspect = spawnSync("docker", ["image", "inspect", ...images], { encoding: "utf8" });
if (inspect.status !== 0) {
  throw new Error(inspect.stderr.trim() || "docker image inspect failed");
}

const inspectedImages = JSON.parse(inspect.stdout);
const failures = [];
for (const [index, image] of images.entries()) {
  const labels = inspectedImages[index]?.Config?.Labels;
  if (labels?.["org.opencontainers.image.revision"] !== options.revision) {
    failures.push(`${image}: revision label mismatch`);
  }
  if (labels?.["io.singularity.upstream.commit"] !== options.upstream) {
    failures.push(`${image}: upstream label mismatch`);
  }
  if (labels?.["org.opencontainers.image.licenses"] !== "AGPL-3.0-or-later") {
    failures.push(`${image}: license label mismatch`);
  }
  if (labels?.["org.opencontainers.image.source"] !== "https://github.com/SparkElf/singularity") {
    failures.push(`${image}: source label mismatch`);
  }
}

if (failures.length > 0) {
  for (const failure of failures) {
    process.stderr.write(`FAIL container metadata: ${failure}\n`);
  }
  process.exitCode = 1;
} else {
  process.stdout.write(`PASS container metadata: ${images.join(", ")}\n`);
}
