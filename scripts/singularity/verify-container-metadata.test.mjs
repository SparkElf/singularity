import assert from "node:assert/strict";
import { test } from "node:test";

import {
  parseArguments,
  probeApiRuntimeArtifacts,
  probeWorkerRuntimeArtifacts,
  validateContainerMetadata,
} from "./verify-container-metadata.mjs";

const revision = "revision-123";
const upstreamCommit = "upstream-123";

function inspectedImage({ command, environment = [], healthcheck, port, startPeriod, title, user }) {
  const exposedPorts = port === null ? {} : { [port]: {} };
  return {
    Config: {
      Cmd: command,
      Env: environment,
      ExposedPorts: exposedPorts,
      Healthcheck: {
        Interval: 30_000_000_000,
        Retries: 3,
        StartPeriod: startPeriod,
        Test: healthcheck,
        Timeout: 5_000_000_000,
      },
      Labels: {
        "io.singularity.upstream.commit": upstreamCommit,
        "org.opencontainers.image.licenses": "AGPL-3.0-or-later",
        "org.opencontainers.image.revision": revision,
        "org.opencontainers.image.source": "https://github.com/SparkElf/singularity",
        "org.opencontainers.image.title": title,
      },
      User: user,
    },
  };
}

function apiImage() {
  return inspectedImage({
    command: ["dist/main.js"],
    environment: ["NODE_ENV=production", "PORT=3001"],
    healthcheck: [
      "CMD",
      "/nodejs/bin/node",
      "-e",
      "fetch('http://127.0.0.1:'+(process.env.PORT||'3001')+'/api/v1/health/database').then((response)=>{if(!response.ok)throw new Error('API healthcheck returned status '+response.status);process.exit(0)}).catch((error)=>{console.error(error);process.exit(1)})",
    ],
    port: "3001/tcp",
    startPeriod: 10_000_000_000,
    title: "Singularity Enterprise API",
    user: "65532",
  });
}

function webImage() {
  return inspectedImage({
    command: ["nginx", "-g", "daemon off;"],
    healthcheck: ["CMD", "wget", "-q", "-O", "-", "http://127.0.0.1:8080/healthz"],
    port: "8080/tcp",
    startPeriod: 5_000_000_000,
    title: "Singularity Enterprise Web",
    user: "101",
  });
}

function workerImage() {
  return inspectedImage({
    command: ["dist/main.js"],
    environment: [
      "HOME=/var/lib/singularity-worker/home",
      "NODE_ENV=production",
      "SINGULARITY_WORKER_OBJECT_STORE_ROOT=/var/lib/singularity-worker/objects",
      "SINGULARITY_WORKER_RESTORE_ARCHIVE_TOOL=/opt/singularity-kernel/kernel",
      "SINGULARITY_WORKER_RESTORE_KERNEL_BINARY=/opt/singularity-kernel/kernel",
      "SINGULARITY_WORKER_RESTORE_KERNEL_LISTEN_ADDRESS=127.0.0.1",
      "SINGULARITY_WORKER_RESTORE_KERNEL_WORKING_DIRECTORY=/opt/singularity-kernel",
      "SINGULARITY_WORKER_RESTORE_RUNTIME_ROOT=/var/lib/singularity-worker/runtime",
    ],
    healthcheck: [
      "CMD",
      "/nodejs/bin/node",
      "-e",
      "const fs=require('node:fs'),path=require('node:path');try{process.kill(1,0);if(process.versions.node.split('.')[0]!=='24')throw new Error('Worker runtime is not Node 24');for(const file of [process.env.SINGULARITY_WORKER_RESTORE_ARCHIVE_TOOL,process.env.SINGULARITY_WORKER_RESTORE_KERNEL_BINARY])fs.accessSync(file,fs.constants.X_OK);fs.accessSync(path.join(process.env.SINGULARITY_WORKER_RESTORE_KERNEL_WORKING_DIRECTORY,'appearance','langs','en.json'),fs.constants.R_OK)}catch(error){console.error(error);process.exit(1)}",
    ],
    port: null,
    startPeriod: 10_000_000_000,
    title: "Singularity Enterprise Worker",
    user: "65532",
  });
}

function validate(images, inspectedImages) {
  return validateContainerMetadata(images, inspectedImages, { revision, upstreamCommit });
}

test("API, Worker, and Web runtime contracts are selected by OCI title rather than argument order", () => {
  assert.deepEqual(
    validate(
      ["web:test", "api:test", "worker:test"],
      [webImage(), apiImage(), workerImage()],
    ),
    [],
  );
});

test("API metadata requires its nonroot user, port, and command", () => {
  const api = apiImage();
  api.Config.User = "0";
  api.Config.ExposedPorts = { "8080/tcp": {} };
  api.Config.Cmd = ["other.js"];

  assert.deepEqual(validate(["api:test", "worker:test", "web:test"], [api, workerImage(), webImage()]), [
    "api:test: user mismatch for Singularity Enterprise API",
    "api:test: exposed port mismatch for Singularity Enterprise API",
    "api:test: command mismatch for Singularity Enterprise API",
  ]);
});

test("API metadata requires the production Node environment", () => {
  const api = apiImage();
  api.Config.Env = ["NODE_ENV=development", "PORT=3001"];

  assert.deepEqual(
    validate(["api:test", "worker:test", "web:test"], [api, workerImage(), webImage()]),
    [
      "api:test: environment mismatch for Singularity Enterprise API: NODE_ENV",
    ],
  );
});

test("Web metadata requires its nonroot user, port, and nginx command", () => {
  const web = webImage();
  web.Config.User = "0";
  web.Config.ExposedPorts = { "3001/tcp": {} };
  web.Config.Cmd = ["nginx"];

  assert.deepEqual(validate(["api:test", "worker:test", "web:test"], [apiImage(), workerImage(), web]), [
    "web:test: user mismatch for Singularity Enterprise Web",
    "web:test: exposed port mismatch for Singularity Enterprise Web",
    "web:test: command mismatch for Singularity Enterprise Web",
  ]);
});

test("Worker metadata requires its nonroot user, command, and complete healthcheck", () => {
  const worker = workerImage();
  worker.Config.User = "0";
  worker.Config.Cmd = ["other.js"];
  worker.Config.Healthcheck.Test = ["CMD", "true"];
  worker.Config.Healthcheck.Interval = 60_000_000_000;
  worker.Config.ExposedPorts = { "9090/tcp": {} };

  assert.deepEqual(
    validate(["api:test", "worker:test", "web:test"], [apiImage(), worker, webImage()]),
    [
      "worker:test: user mismatch for Singularity Enterprise Worker",
      "worker:test: unexpected exposed port for Singularity Enterprise Worker",
      "worker:test: command mismatch for Singularity Enterprise Worker",
      "worker:test: healthcheck mismatch for Singularity Enterprise Worker",
    ],
  );
});

test("Worker metadata requires the production object, Kernel, appearance, and runtime paths", () => {
  const worker = workerImage();
  worker.Config.Env.push(
    "SINGULARITY_WORKER_RESTORE_ARCHIVE_TOOL=/tmp/untrusted-kernel",
  );

  assert.deepEqual(
    validate(["api:test", "worker:test", "web:test"], [apiImage(), worker, webImage()]),
    [
      "worker:test: environment mismatch for Singularity Enterprise Worker: " +
        "SINGULARITY_WORKER_RESTORE_ARCHIVE_TOOL",
    ],
  );
});

test("API artifact probe runs the real entry check read-only and offline", () => {
  const calls = [];
  const run = (command, args, options) => {
    calls.push({ args, command, options });
    return { status: 0 };
  };

  assert.deepEqual(probeApiRuntimeArtifacts("api:test", run), []);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, "docker");
  assert.deepEqual(
    calls[0].args.slice(0, 7),
    [
      "run",
      "--rm",
      "--network=none",
      "--pull=never",
      "--read-only",
      "--entrypoint=/nodejs/bin/node",
      "api:test",
    ],
  );
  assert.equal(calls[0].args[7], "-e");
  assert.match(calls[0].args[8], /NODE_ENV.*production/u);
  assert.match(calls[0].args[8], /dist\/main\.js/u);
  assert.equal(calls[0].options.encoding, "utf8");
});

test("Worker artifact probe runs the image read-only and offline, then executes restore-archive", () => {
  const calls = [];
  const run = (command, args, options) => {
    calls.push({ args, command, options });
    return { status: 0 };
  };

  assert.deepEqual(probeWorkerRuntimeArtifacts("worker:test", run), []);
  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.equal(call.command, "docker");
    assert.deepEqual(call.args.slice(0, 5), ["run", "--rm", "--network=none", "--pull=never", "--read-only"]);
    assert.equal(call.options.encoding, "utf8");
  }
  assert.equal(calls[0].args[5], "--entrypoint=/nodejs/bin/node");
  assert.equal(calls[0].args[6], "worker:test");
  assert.match(calls[0].args[8], /NODE_ENV.*production/u);
  assert.match(calls[0].args[8], /dist\/main\.js/u);
  assert.match(calls[0].args[8], /appearance.*langs.*en\.json/u);
  assert.deepEqual(calls[1].args.slice(5), [
    "--entrypoint=/opt/singularity-kernel/kernel",
    "worker:test",
    "workspace",
    "restore-archive",
    "--help",
  ]);
});

test("Worker artifact probe fails when the bundled restore-archive executable cannot start", () => {
  let call = 0;
  const failures = probeWorkerRuntimeArtifacts("worker:test", () => ({
    status: call++ === 0 ? 0 : 1,
  }));

  assert.deepEqual(failures, [
    "worker:test: Kernel restore-archive executable probe failed",
  ]);
});

test("artifact probe failures retain bounded command tails and the spawn stack", () => {
  const error = new Error("spawn-sentinel");
  const failures = probeApiRuntimeArtifacts("api:test", () => ({
    error,
    status: null,
    stderr: "stderr-sentinel",
    stdout: `${"x".repeat(70_000)}stdout-sentinel`,
  }));

  assert.equal(failures.length, 1);
  assert.match(failures[0], /spawn-sentinel/u);
  assert.match(failures[0], /stdout-sentinel/u);
  assert.match(failures[0], /stderr-sentinel/u);
  assert.ok(failures[0].length < 70_000);
});

test("API metadata rejects an arbitrary successful healthcheck command", () => {
  const api = apiImage();
  api.Config.Healthcheck.Test = ["CMD", "true"];

  assert.deepEqual(validate(["api:test", "worker:test", "web:test"], [api, workerImage(), webImage()]), [
    "api:test: healthcheck mismatch for Singularity Enterprise API",
  ]);
});

test("Web metadata rejects an arbitrary successful healthcheck command", () => {
  const web = webImage();
  web.Config.Healthcheck.Test = ["CMD", "true"];

  assert.deepEqual(validate(["api:test", "worker:test", "web:test"], [apiImage(), workerImage(), web]), [
    "web:test: healthcheck mismatch for Singularity Enterprise Web",
  ]);
});

test("OCI provenance labels remain mandatory", () => {
  const api = apiImage();
  api.Config.Labels["org.opencontainers.image.revision"] = "wrong";
  api.Config.Labels["io.singularity.upstream.commit"] = "wrong";
  api.Config.Labels["org.opencontainers.image.licenses"] = "wrong";
  api.Config.Labels["org.opencontainers.image.source"] = "wrong";

  assert.deepEqual(
    validate(["api:test", "worker:test", "web:test"], [api, workerImage(), webImage()]),
    [
      "api:test: revision label mismatch",
      "api:test: upstream label mismatch",
      "api:test: license label mismatch",
      "api:test: source label mismatch",
    ],
  );
});

test("the image set must contain exactly one API, Worker, and Web identity", () => {
  assert.deepEqual(validate(["first:test", "second:test", "third:test"], [apiImage(), apiImage(), webImage()]), [
    "Singularity Enterprise API: expected exactly one image, found 2",
    "Singularity Enterprise Worker: expected exactly one image, found 0",
  ]);
});

test("the CLI rejects a duplicate upstream option", () => {
  assert.throws(
    () => parseArguments([
      "--revision",
      revision,
      "--upstream",
      upstreamCommit,
      "--",
      "api:test",
      "worker:test",
      "web:test",
    ]),
    /upstream is read from config\/upstream-baseline\.json/,
  );
});
