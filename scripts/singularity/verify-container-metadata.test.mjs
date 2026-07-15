import assert from "node:assert/strict";
import { test } from "node:test";

import {
  parseArguments,
  validateContainerMetadata,
} from "./verify-container-metadata.mjs";

const revision = "revision-123";
const upstreamCommit = "upstream-123";

function inspectedImage({ command, healthcheck, port, title, user }) {
  return {
    Config: {
      Cmd: command,
      ExposedPorts: { [port]: {} },
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

function validate(images, inspectedImages) {
  return validateContainerMetadata(images, inspectedImages, { revision, upstreamCommit });
}

test("API and Web runtime contracts are selected by OCI title rather than argument order", () => {
  assert.deepEqual(
    validate(["web:test", "api:test"], [webImage(), apiImage()]),
    [],
  );
});

test("API metadata requires its nonroot user, port, and command", () => {
  const api = apiImage();
  api.Config.User = "0";
  api.Config.ExposedPorts = { "8080/tcp": {} };
  api.Config.Cmd = ["other.js"];

  assert.deepEqual(validate(["api:test", "web:test"], [api, webImage()]), [
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

  assert.deepEqual(validate(["api:test", "web:test"], [apiImage(), web]), [
    "web:test: user mismatch for Singularity Enterprise Web",
    "web:test: exposed port mismatch for Singularity Enterprise Web",
    "web:test: command mismatch for Singularity Enterprise Web",
  ]);
});

test("API metadata rejects an arbitrary successful healthcheck command", () => {
  const api = apiImage();
  api.Config.Healthcheck.Test = ["CMD", "true"];

  assert.deepEqual(validate(["api:test", "web:test"], [api, webImage()]), [
    "api:test: healthcheck mismatch for Singularity Enterprise API",
  ]);
});

test("Web metadata rejects an arbitrary successful healthcheck command", () => {
  const web = webImage();
  web.Config.Healthcheck.Test = ["CMD", "true"];

  assert.deepEqual(validate(["api:test", "web:test"], [apiImage(), web]), [
    "web:test: healthcheck mismatch for Singularity Enterprise Web",
  ]);
});

test("OCI provenance labels remain mandatory", () => {
  const api = apiImage();
  api.Config.Labels["org.opencontainers.image.revision"] = "wrong";
  api.Config.Labels["io.singularity.upstream.commit"] = "wrong";
  api.Config.Labels["org.opencontainers.image.licenses"] = "wrong";
  api.Config.Labels["org.opencontainers.image.source"] = "wrong";

  assert.deepEqual(validate(["api:test", "web:test"], [api, webImage()]), [
    "api:test: revision label mismatch",
    "api:test: upstream label mismatch",
    "api:test: license label mismatch",
    "api:test: source label mismatch",
  ]);
});

test("the image set must contain exactly one API and one Web identity", () => {
  assert.deepEqual(validate(["first:test", "second:test"], [apiImage(), apiImage()]), [
    "Singularity Enterprise API: expected exactly one image, found 2",
    "Singularity Enterprise Web: expected exactly one image, found 0",
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
      "web:test",
    ]),
    /upstream is read from config\/upstream-baseline\.json/,
  );
});
