import assert from "node:assert/strict";
import {
  access,
  readdir,
  readFile,
} from "node:fs/promises";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import ts from "typescript";

import {
  auditProductionClosure,
  collectModuleLoads,
  formatAuditReport,
} from "./protyle-vite-closure-audit.mjs";

const scriptsDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = join(scriptsDirectory, "../..");
const webRoot = join(repositoryRoot, "enterprise/apps/web");
const e2eRoot = join(webRoot, "tests/e2e");
const sourceExtensions = new Set([".js", ".mjs", ".ts", ".tsx"]);
const forbiddenLegacyAppTargets = new Set([
  "app/src/index",
  "app/src/block/Panel",
  "app/src/host/plugin",
  "app/src/host/protyle",
  "app/src/layout/Model",
  "app/src/protyle/EmbeddedProtyleOwner",
].map((path) => resolve(repositoryRoot, path)));

async function source(path) {
  return readFile(join(repositoryRoot, path), "utf8");
}

function parseSource(path, contents) {
  const extension = extname(path);
  const scriptKind = extension === ".tsx"
    ? ts.ScriptKind.TSX
    : extension === ".ts"
      ? ts.ScriptKind.TS
      : ts.ScriptKind.JS;
  return ts.createSourceFile(
    path,
    contents,
    ts.ScriptTarget.Latest,
    true,
    scriptKind,
  );
}

function propertyName(node) {
  if (ts.isPropertyAccessExpression(node.expression)) {
    return {
      name: node.expression.name.text,
      receiver: node.expression.expression.getText(),
    };
  }
  if (
    ts.isElementAccessExpression(node.expression) &&
    ts.isStringLiteral(node.expression.argumentExpression)
  ) {
    return {
      name: node.expression.argumentExpression.text,
      receiver: node.expression.expression.getText(),
    };
  }
  return null;
}

function interceptedChainCalls(sourceFile) {
  const violations = [];
  const alwaysForbidden = new Set([
    "continue",
    "fallback",
    "fulfill",
    "route",
    "routeFromHAR",
    "routeWebSocket",
  ]);
  const visit = (node) => {
    if (ts.isCallExpression(node)) {
      const property = propertyName(node);
      if (
        property !== null &&
        (
          alwaysForbidden.has(property.name) ||
          (property.name === "abort" && /route/i.test(property.receiver))
        )
      ) {
        const position = sourceFile.getLineAndCharacterOfPosition(node.getStart());
        violations.push({
          column: position.character + 1,
          line: position.line + 1,
          name: property.name,
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return violations;
}

async function collectSourceFiles(root) {
  const files = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...await collectSourceFiles(path));
    } else if (entry.isFile() && sourceExtensions.has(extname(entry.name))) {
      files.push(path);
    }
  }
  return files.sort();
}

function propertyInitializer(sourceFile, name) {
  let initializer;
  const visit = (node) => {
    if (
      initializer === undefined &&
      ts.isPropertyAssignment(node) &&
      ((ts.isIdentifier(node.name) && node.name.text === name) ||
        (ts.isStringLiteral(node.name) && node.name.text === name))
    ) {
      initializer = node.initializer;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return initializer;
}

function variableInitializers(sourceFile, name) {
  const initializers = [];
  const visit = (node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === name &&
      node.initializer !== undefined
    ) {
      initializers.push(node.initializer);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return initializers;
}

function stringProperty(sourceFile, name) {
  const initializer = propertyInitializer(sourceFile, name);
  assert.ok(
    initializer !== undefined && ts.isStringLiteral(initializer),
    `${name} must be a string literal`,
  );
  return initializer.text;
}

function dockerInstructions(contents) {
  const logicalLines = [];
  let current = "";
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) {
      continue;
    }
    const continued = line.endsWith("\\");
    current += `${current === "" ? "" : " "}${continued ? line.slice(0, -1).trim() : line}`;
    if (!continued) {
      logicalLines.push(current);
      current = "";
    }
  }
  if (current !== "") {
    logicalLines.push(current);
  }
  return logicalLines.map((line) => {
    const separator = line.search(/\s/);
    return separator === -1
      ? { argument: "", instruction: line.toUpperCase() }
      : {
          argument: line.slice(separator + 1).trim(),
          instruction: line.slice(0, separator).toUpperCase(),
        };
  });
}

function htmlScriptEntries(contents) {
  const entries = [];
  for (const script of contents.matchAll(/<script\b([^>]*)>/gi)) {
    const attributes = new Map();
    for (const attribute of script[1].matchAll(/([\w:-]+)\s*=\s*(["'])(.*?)\2/g)) {
      attributes.set(attribute[1].toLowerCase(), attribute[3]);
    }
    entries.push({
      src: attributes.get("src") ?? null,
      type: attributes.get("type") ?? null,
    });
  }
  return entries;
}

function webSourceBoundary(file, sourceFile) {
  const forbiddenLegacyImports = [];
  let publicCoreImports = 0;
  for (const moduleLoad of collectModuleLoads(sourceFile)) {
    if (moduleLoad.specifier === "@singularity/protyle-browser/core") {
      publicCoreImports += 1;
    }
    if (moduleLoad.specifier === null || !moduleLoad.specifier.startsWith(".")) {
      continue;
    }
    const target = resolve(dirname(file), moduleLoad.specifier)
      .replace(/\.(?:[cm]?[jt]sx?)$/, "");
    if (forbiddenLegacyAppTargets.has(target)) {
      forbiddenLegacyImports.push(
        `${relative(repositoryRoot, file)} -> ${relative(repositoryRoot, target)}`,
      );
    }
  }
  return {forbiddenLegacyImports, publicCoreImports};
}

test("P5 has one independent non-parallel Playwright entry", async () => {
  const config = parseSource(
    "playwright.e2e.config.ts",
    await source("enterprise/apps/web/playwright.e2e.config.ts"),
  );
  const integrationConfig = parseSource(
    "playwright.integration.config.ts",
    await source("enterprise/apps/web/playwright.integration.config.ts"),
  );
  const packageJson = JSON.parse(await source("enterprise/apps/web/package.json"));

  assert.equal(stringProperty(config, "testDir"), "./tests/e2e");
  assert.equal(stringProperty(config, "globalSetup"), "./tests/e2e/global-setup.ts");
  assert.equal(stringProperty(config, "outputDir"), "./test-results/e2e");
  assert.equal(propertyInitializer(config, "fullyParallel")?.kind, ts.SyntaxKind.FalseKeyword);
  assert.equal(propertyInitializer(config, "workers")?.getText(), "1");
  assert.equal(
    stringProperty(integrationConfig, "testDir"),
    "./tests/browser-integration",
  );
  assert.equal(
    packageJson.scripts["test:e2e"],
    "playwright test --config playwright.e2e.config.ts",
  );
  assert.deepEqual(
    Object.keys(packageJson.scripts).filter((name) => /e2e/i.test(name)),
    ["test:e2e"],
  );
});

test("real P5 E2E sources do not replace the React, Gateway, or Kernel chain", async () => {
  const files = await collectSourceFiles(e2eRoot);
  const specs = files.filter((file) => file.endsWith(".e2e.spec.ts"));
  assert.ok(specs.length > 0, "P5 must contain at least one real E2E case");
  for (const file of files) {
    const sourceFile = parseSource(file, await readFile(file, "utf8"));
    assert.deepEqual(
      interceptedChainCalls(sourceFile),
      [],
      `${file} substitutes part of the target chain`,
    );
  }
});

test("P5 setup binds the real Kernel identity and keeps the CLI binary in the app tree", async () => {
  const stackSource = parseSource(
    "start-stack.mjs",
    await source("enterprise/apps/web/tests/e2e/support/start-stack.mjs"),
  );
  const binaryRoots = variableInitializers(stackSource, "kernelBinaryRoot");
  assert.equal(binaryRoots.length, 1);
  assert.ok(ts.isCallExpression(binaryRoots[0]));
  assert.equal(binaryRoots[0].expression.getText(), "join");
  assert.equal(binaryRoots[0].arguments[0]?.getText(), "appRoot");

  const kernelIdentities = variableInitializers(stackSource, "kernelInstanceId");
  assert.ok(kernelIdentities.some((initializer) =>
    ts.isAwaitExpression(initializer) &&
    ts.isCallExpression(initializer.expression) &&
    initializer.expression.expression.getText() === "readKernelInstanceId",
  ));
  assert.equal(kernelIdentities.some((initializer) => initializer.getText() === "randomUUID()"), false);
  assert.equal(
    stringProperty(stackSource, "SINGULARITY_KERNEL_LISTEN_ADDRESS"),
    "127.0.0.1",
  );
});

test("the Vite production closure excludes the upstream shell and migration adapters", () => {
  const report = auditProductionClosure();
  assert.deepEqual(report.violations, [], formatAuditReport(report));
  for (const legacyFile of [
    "app/src/index.ts",
    "app/src/block/Panel.ts",
    "app/src/host/plugin.ts",
    "app/src/host/protyle.ts",
    "app/src/protyle/EmbeddedProtyleOwner.ts",
  ]) {
    assert.equal(report.productionFiles.includes(legacyFile), false, legacyFile);
  }
});

test("the enterprise production web image builds and serves only the Vite artifact", async () => {
  const instructions = dockerInstructions(
    await source("enterprise/apps/web/Dockerfile"),
  );
  assert.ok(instructions.some(
    ({ argument, instruction }) =>
      instruction === "RUN" && argument.includes("pnpm --filter @singularity/web build"),
  ));
  assert.ok(instructions.some(
    ({ argument, instruction }) =>
      instruction === "COPY" &&
      argument.includes("/workspace/enterprise/apps/web/dist/") &&
      argument.includes("/usr/share/nginx/html/"),
  ));
  for (const { argument } of instructions) {
    const normalized = argument.toLowerCase();
    assert.equal(normalized.includes("webpack.config"), false);
    assert.equal(normalized.includes("stage/build/app"), false);
    assert.equal(normalized.includes("stage/build/desktop"), false);
    assert.equal(normalized.includes("stage/build/mobile"), false);
  }
});

test("the enterprise HTML entry and browser runner files have one Vite production path", async () => {
  const indexHtml = await source("enterprise/apps/web/index.html");
  const packageJson = JSON.parse(await source("enterprise/apps/web/package.json"));

  assert.deepEqual(htmlScriptEntries(indexHtml), [{
    src: "/src/main.tsx",
    type: "module",
  }]);
  assert.match(packageJson.scripts.build, /(?:^|&&\s*)vite build$/);
  assert.equal(
    Object.values(packageJson.scripts).some((command) => /\bwebpack\b/i.test(command)),
    false,
  );

  await access(join(webRoot, "src/main.tsx"));
  await access(join(webRoot, "vite.config.ts"));
  await access(join(webRoot, "playwright.integration.config.ts"));
  await access(join(webRoot, "playwright.e2e.config.ts"));
  for (const obsoletePath of [
    "playwright.shell.config.ts",
    "tests/shell",
    "tests/e2e/.gitkeep",
    "src/editor/AppProtylePluginPort.test.js",
    "src/editor/ModelReconnectLifecycle.test.js",
  ]) {
    assert.equal(await exists(join(webRoot, obsoletePath)), false, obsoletePath);
  }

  const publicCoreImporters = [];
  for (const file of await collectSourceFiles(join(webRoot, "src"))) {
    const sourceFile = parseSource(file, await readFile(file, "utf8"));
    const boundary = webSourceBoundary(file, sourceFile);
    assert.deepEqual(
      boundary.forbiddenLegacyImports,
      [],
      `${file} imports an upstream legacy shell owner`,
    );
    for (let index = 0; index < boundary.publicCoreImports; index += 1) {
      publicCoreImporters.push(relative(repositoryRoot, file));
    }
  }
  assert.deepEqual(publicCoreImporters, ["enterprise/apps/web/src/main.tsx"]);

  const rootEntries = await readdir(webRoot);
  assert.deepEqual(
    rootEntries.filter((name) => /^webpack(?:\.|-)/i.test(name)),
    [],
  );
  assert.deepEqual(
    rootEntries.filter((name) => /^playwright\..*e2e.*\.config\./i.test(name)),
    ["playwright.e2e.config.ts"],
  );
});

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
