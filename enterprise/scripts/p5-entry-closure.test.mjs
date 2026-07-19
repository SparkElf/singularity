import assert from "node:assert/strict";
import {
  access,
  readdir,
  readFile,
} from "node:fs/promises";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import ts from "typescript";

import {
  auditProductionClosure,
  formatAuditReport,
} from "./protyle-vite-closure-audit.mjs";

const scriptsDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = join(scriptsDirectory, "../..");
const webRoot = join(repositoryRoot, "enterprise/apps/web");
const e2eRoot = join(webRoot, "tests/e2e");
const sourceExtensions = new Set([".js", ".mjs", ".ts", ".tsx"]);

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

test("obsolete enterprise browser runners and Webpack entries are physically absent", async () => {
  await access(join(webRoot, "index.html"));
  await access(join(webRoot, "src/main.tsx"));
  await access(join(webRoot, "vite.config.ts"));
  await access(join(webRoot, "playwright.integration.config.ts"));
  await access(join(webRoot, "playwright.e2e.config.ts"));
  assert.equal(await exists(join(webRoot, "playwright.shell.config.ts")), false);
  assert.equal(await exists(join(webRoot, "tests/shell")), false);
  assert.equal(await exists(join(e2eRoot, ".gitkeep")), false);

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
