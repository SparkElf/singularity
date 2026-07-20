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
import { parse as parseYaml } from "yaml";

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

function exportedDefineConfigObject(sourceFile) {
  const assignments = sourceFile.statements.filter(ts.isExportAssignment);
  assert.equal(assignments.length, 1, `${sourceFile.fileName} must have one default export`);
  const expression = assignments[0].expression;
  assert.ok(
    ts.isCallExpression(expression) && expression.expression.getText() === "defineConfig",
    `${sourceFile.fileName} must export defineConfig(...)`,
  );
  const config = expression.arguments[0];
  assert.ok(
    config !== undefined && ts.isObjectLiteralExpression(config),
    `${sourceFile.fileName} defineConfig argument must be an object literal`,
  );
  return config;
}

function directPropertyInitializer(object, name) {
  const properties = object.properties.filter((property) =>
    ts.isPropertyAssignment(property) &&
    ((ts.isIdentifier(property.name) && property.name.text === name) ||
      (ts.isStringLiteral(property.name) && property.name.text === name))
  );
  assert.ok(properties.length <= 1, `${name} must not be declared more than once`);
  return properties[0]?.initializer;
}

function propertyInitializers(sourceFile, name) {
  const initializers = [];
  const visit = (node) => {
    if (
      ts.isPropertyAssignment(node) &&
      ((ts.isIdentifier(node.name) && node.name.text === name) ||
        (ts.isStringLiteral(node.name) && node.name.text === name))
    ) {
      initializers.push(node.initializer);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return initializers;
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

function stringProperty(object, name) {
  const initializer = directPropertyInitializer(object, name);
  assert.ok(
    initializer !== undefined && ts.isStringLiteral(initializer),
    `${name} must be a string literal`,
  );
  return initializer.text;
}

async function resolveLocalSource(importer, specifier) {
  const base = resolve(dirname(importer), specifier);
  const candidates = extname(base) === ""
    ? [
        ...[...sourceExtensions].map((extension) => `${base}${extension}`),
        ...[...sourceExtensions].map((extension) => join(base, `index${extension}`)),
      ]
    : [base];
  for (const candidate of candidates) {
    if (await exists(candidate)) {
      assert.ok(
        sourceExtensions.has(extname(candidate)),
        `${relative(repositoryRoot, importer)} imports unsupported local source ${specifier}`,
      );
      return candidate;
    }
  }
  throw new Error(
    `${relative(repositoryRoot, importer)} has unresolved local import ${specifier}`,
  );
}

async function collectLocalSourceClosure(entries) {
  const files = new Set();
  const pending = [...entries];
  while (pending.length > 0) {
    const file = pending.pop();
    if (file === undefined || files.has(file)) {
      continue;
    }
    files.add(file);
    const sourceFile = parseSource(file, await readFile(file, "utf8"));
    for (const moduleLoad of collectModuleLoads(sourceFile)) {
      if (moduleLoad.specifier?.startsWith(".")) {
        pending.push(await resolveLocalSource(file, moduleLoad.specifier));
      }
    }
  }
  return [...files].sort();
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

function finalDockerStage(instructions) {
  const finalFrom = instructions.findLastIndex(({ instruction }) => instruction === "FROM");
  assert.notEqual(finalFrom, -1, "Dockerfile must contain a FROM instruction");
  return instructions.slice(finalFrom);
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
  const configObject = exportedDefineConfigObject(config);
  const integrationConfig = parseSource(
    "playwright.integration.config.ts",
    await source("enterprise/apps/web/playwright.integration.config.ts"),
  );
  const integrationConfigObject = exportedDefineConfigObject(integrationConfig);
  const packageJson = JSON.parse(await source("enterprise/apps/web/package.json"));
  const workspacePackageJson = JSON.parse(await source("enterprise/package.json"));
  const workflow = parseYaml(await source(".github/workflows/singularity-l0.yml"));

  assert.equal(stringProperty(configObject, "testDir"), "./tests/e2e");
  assert.equal(stringProperty(configObject, "globalSetup"), "./tests/e2e/global-setup.ts");
  assert.equal(stringProperty(configObject, "outputDir"), "./test-results/e2e");
  assert.equal(
    directPropertyInitializer(configObject, "fullyParallel")?.kind,
    ts.SyntaxKind.FalseKeyword,
  );
  assert.equal(directPropertyInitializer(configObject, "workers")?.getText(), "1");
  assert.equal(
    stringProperty(integrationConfigObject, "testDir"),
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
  assert.equal(
    workspacePackageJson.scripts["test:e2e"],
    "pnpm --filter @singularity/web test:e2e",
  );
  assert.deepEqual(
    Object.keys(workspacePackageJson.scripts).filter((name) => /e2e/i.test(name)),
    ["test:e2e"],
  );
  const workflowRunners = workflow.jobs["p5-e2e"].steps.filter((step) =>
    typeof step.run === "string" && /(?:^|\s)pnpm test:e2e(?:\s|$)/.test(step.run)
  );
  assert.deepEqual(workflowRunners.map(({ run, "working-directory": directory }) => ({
    directory,
    run,
  })), [{
    directory: "enterprise",
    run: "pnpm test:e2e",
  }]);
});

test("space component tests share one Vitest directory entry", async () => {
  const packageJson = JSON.parse(await source("enterprise/apps/web/package.json"));
  const workspacePackageJson = JSON.parse(await source("enterprise/package.json"));
  assert.equal(
    packageJson.scripts["test:space-access"],
    "vitest run src/app/App.test.tsx src/spaces",
  );
  assert.deepEqual(
    Object.keys(packageJson.scripts).filter((name) => /space-access/i.test(name)),
    ["test:space-access"],
  );
  assert.equal(
    workspacePackageJson.scripts["test:s0-s3"].match(
      /pnpm --filter @singularity\/web test:space-access/g,
    )?.length,
    1,
  );
  const spaceTests = (await readdir(join(webRoot, "src/spaces"), {
    withFileTypes: true,
  }))
    .filter((entry) => entry.isFile() && /\.test\.[cm]?[jt]sx?$/.test(entry.name))
    .map((entry) => entry.name)
    .sort();
  assert.ok(spaceTests.includes("ContentDirectory.test.tsx"));
  assert.ok(spaceTests.includes("SpaceSessionRoot.test.tsx"));
  for (const [name, command] of Object.entries(packageJson.scripts)) {
    if (name === "test:space-access") {
      continue;
    }
    assert.doesNotMatch(
      command,
      /(?:ContentDirectory|SpaceSessionRoot)\.test\./,
      `${name} must not create a per-file space test runner`,
    );
  }
});

test("real P5 E2E sources do not replace the React, Gateway, or Kernel chain", async () => {
  const entries = await collectSourceFiles(e2eRoot);
  const specs = entries.filter((file) => file.endsWith(".e2e.spec.ts"));
  assert.ok(specs.length > 0, "P5 must contain at least one real E2E case");
  const files = await collectLocalSourceClosure(entries);
  for (const file of files) {
    const sourceFile = parseSource(file, await readFile(file, "utf8"));
    assert.deepEqual(
      interceptedChainCalls(sourceFile),
      [],
      `${file} substitutes part of the target chain`,
    );
  }
});

test("P5 setup binds the real Kernel identity and runner-owned binary", async () => {
  const stackSource = parseSource(
    "start-stack.mjs",
    await source("enterprise/apps/web/tests/e2e/support/start-stack.mjs"),
  );
  const binaryPaths = variableInitializers(stackSource, "kernelBinary").filter((initializer) =>
    ts.isCallExpression(initializer) && initializer.expression.getText() === "join"
  );
  assert.equal(binaryPaths.length, 1);
  assert.equal(binaryPaths[0].arguments[0]?.getText(), "runtimeRoot");

  const kernelIdentities = variableInitializers(stackSource, "kernelInstanceId");
  assert.ok(kernelIdentities.some((initializer) =>
    ts.isAwaitExpression(initializer) &&
    ts.isCallExpression(initializer.expression) &&
    initializer.expression.expression.getText() === "readKernelInstanceId",
  ));
  assert.equal(kernelIdentities.some((initializer) => initializer.getText() === "randomUUID()"), false);
  const listenAddresses = propertyInitializers(
    stackSource,
    "SINGULARITY_KERNEL_LISTEN_ADDRESS",
  );
  assert.equal(listenAddresses.length, 1);
  assert.ok(ts.isStringLiteral(listenAddresses[0]));
  assert.equal(listenAddresses[0].text, "127.0.0.1");
  const restoreListenAddresses = propertyInitializers(
    stackSource,
    "SINGULARITY_WORKER_RESTORE_KERNEL_LISTEN_ADDRESS",
  );
  assert.equal(restoreListenAddresses.length, 1);
  assert.ok(ts.isStringLiteral(restoreListenAddresses[0]));
  assert.equal(restoreListenAddresses[0].text, "127.0.0.1");
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
  assert.ok(instructions.some(({ argument, instruction }) =>
    instruction === "COPY" &&
    argument ===
      "app/package.json app/pnpm-lock.yaml app/pnpm-workspace.yaml app/.npmrc /workspace/app/"
  ));
  const runtimeStage = finalDockerStage(instructions);
  assert.match(runtimeStage[0].argument, /\sAS runtime$/i);
  assert.deepEqual(
    runtimeStage
      .filter(({ instruction }) => instruction === "COPY" || instruction === "ADD")
      .map(({ argument, instruction }) => ({ argument, instruction })),
    [
      {
        argument: "enterprise/apps/web/nginx.conf /etc/nginx/nginx.conf",
        instruction: "COPY",
      },
      {
        argument: "--from=build /workspace/enterprise/apps/web/dist/ /usr/share/nginx/html/",
        instruction: "COPY",
      },
      {
        argument: "LICENSE NOTICE /usr/share/licenses/singularity/",
        instruction: "COPY",
      },
    ],
  );
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
  } catch (error) {
    if (error !== null && typeof error === "object" && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}
