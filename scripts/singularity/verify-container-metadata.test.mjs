import assert from "node:assert/strict";
import { test } from "node:test";

import {
  parseArguments,
  validateContainerMetadata,
} from "./verify-container-metadata.mjs";

const revision = "revision-123";
const upstreamCommit = "upstream-123";

function inspectedImage({ command, healthcheck, port, title, user }) {
  const exposedPorts = port === null ? {} : { [port]: {} };
  return {
    Config: {
      Cmd: command,
      ExposedPorts: exposedPorts,
      Healthcheck: { Test: healthcheck },
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
    healthcheck: [
      "CMD",
      "/nodejs/bin/node",
      "-e",
      "fetch('http://127.0.0.1:'+(process.env.PORT||'3001')+'/api/v1/health/database').then((response)=>process.exit(response.ok?0:1)).catch(()=>process.exit(1))",
    ],
    port: "3001/tcp",
    title: "Singularity Enterprise API",
    user: "65532",
  });
}

function webImage() {
  return inspectedImage({
    command: ["nginx", "-g", "daemon off;"],
    healthcheck: ["CMD", "wget", "-q", "-O", "-", "http://127.0.0.1:8080/healthz"],
    port: "8080/tcp",
    title: "Singularity Enterprise Web",
    user: "101",
  });
}

function workerImage() {
  return inspectedImage({
    command: ["dist/main.js"],
    healthcheck: [
      "CMD",
      "/nodejs/bin/node",
      "-e",
      "try{process.kill(1,0)}catch{process.exit(1)}",
    ],
    port: null,
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

test("Worker metadata requires its nonroot user, command, and process healthcheck", () => {
  const worker = workerImage();
  worker.Config.User = "0";
  worker.Config.Cmd = ["other.js"];
  worker.Config.Healthcheck.Test = ["CMD", "true"];
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
