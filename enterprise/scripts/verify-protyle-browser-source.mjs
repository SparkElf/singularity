import { builtinModules } from "node:module";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import {
  auditRegistryMigrationAst,
  collectModuleLoads,
} from "./protyle-browser-source-audit.mjs";

const enterpriseRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(enterpriseRoot, "..");
const protyleRoot = join(repositoryRoot, "app/src/protyle");
const nativeMobileRoot = join(repositoryRoot, "app/src/mobile");
const legacyPluginRoot = join(repositoryRoot, "app/src/plugin");
const legacyPluginMenuFile = join(legacyPluginRoot, "Menu");
const boundaryIntegrationFiles = [
  join(repositoryRoot, "app/src/host/plugin.ts"),
  join(repositoryRoot, "app/src/host/protyle.ts"),
  join(repositoryRoot, "app/src/index.ts"),
  join(repositoryRoot, "app/src/types/protyle.d.ts"),
];
const canonicalContractsFile = join(
  repositoryRoot,
  "enterprise/packages/protyle-browser/src/contracts",
);
const forbiddenHostActionModules = new Set([
  "app/src/card/openCard",
  "app/src/card/viewCards",
  "app/src/history/doc",
  "app/src/layout/dock/util",
  "app/src/search/spread",
  "app/src/search/util",
].map((modulePath) => join(repositoryRoot, modulePath)));
const forbiddenHostActionExports = new Map([
  [join(repositoryRoot, "app/src/card/makeCard"), new Set(["makeCard"])],
  [join(repositoryRoot, "app/src/editor/openLink"), new Set(["openByMobile"])],
  [join(repositoryRoot, "app/src/editor/util"), new Set(["openAsset", "openBy", "openFileById"])],
  [join(repositoryRoot, "app/src/menus/commonMenuItem"), new Set(["openMenu"])],
  [join(repositoryRoot, "app/src/menus/util"), new Set(["openEditorTab"])],
]);
const sourceExtensions = new Set([".ts", ".tsx", ".mts", ".cts"]);
const builtinPackageNames = new Set(
  builtinModules.map((name) => name.replace(/^node:/, "").split("/")[0]),
);

function isInside(parent, candidate) {
  const pathFromParent = relative(parent, candidate);
  return pathFromParent === "" || (!pathFromParent.startsWith(`..${sep}`) && pathFromParent !== "..");
}

function collectTypeScriptFiles(directory) {
  return readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const entryPath = join(directory, entry.name);
      if (entry.isDirectory()) {
        return collectTypeScriptFiles(entryPath);
      }
      return sourceExtensions.has(extname(entry.name)) ? [entryPath] : [];
    })
    .sort();
}

function getAccessName(node) {
  if (ts.isPropertyAccessExpression(node)) {
    return node.name.text;
  }
  if (ts.isElementAccessExpression(node) && node.argumentExpression &&
    ts.isStringLiteralLike(node.argumentExpression)) {
    return node.argumentExpression.text;
  }
  return null;
}

function isAppAccess(node) {
  return (ts.isIdentifier(node) && node.text === "app") || getAccessName(node) === "app";
}

function collectPluginRegistryAccesses(sourceFile) {
  const accesses = [];

  function visit(node) {
    if (getAccessName(node) === "plugins" &&
      (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) &&
      isAppAccess(node.expression)) {
      accesses.push(node);
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return accesses;
}

function isNodeBuiltin(specifier) {
  const normalized = specifier.replace(/^node:/, "");
  return builtinPackageNames.has(normalized.split("/")[0]);
}

const violations = [];
const files = collectTypeScriptFiles(protyleRoot);

for (const file of files) {
  const sourceText = readFileSync(file, "utf8");
  const scriptKind = extname(file) === ".tsx" ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sourceFile = ts.createSourceFile(file, sourceText, ts.ScriptTarget.Latest, true, scriptKind);
  const relativeFile = relative(repositoryRoot, file);

  for (const diagnostic of sourceFile.parseDiagnostics) {
    const line = diagnostic.start === undefined
      ? 1
      : sourceFile.getLineAndCharacterOfPosition(diagnostic.start).line + 1;
    const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, " ");
    violations.push(`${relativeFile}:${line}: TypeScript syntax error TS${diagnostic.code}: ${message}`);
  }

  for (const access of collectPluginRegistryAccesses(sourceFile)) {
    const line = sourceFile.getLineAndCharacterOfPosition(access.getStart(sourceFile)).line + 1;
    violations.push(`${relativeFile}:${line}: direct App.plugins access is forbidden; use ProtylePluginPort`);
  }

  for (const violation of auditRegistryMigrationAst(file, sourceFile)) {
    violations.push(`${relativeFile}:${violation.line}: ${violation.message}`);
  }

  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !statement.moduleSpecifier ||
      !ts.isStringLiteralLike(statement.moduleSpecifier) || !statement.moduleSpecifier.text.startsWith(".")) {
      continue;
    }
    const importedTarget = resolve(dirname(file), statement.moduleSpecifier.text)
      .replace(/\.(?:ts|tsx|mts|cts)$/, "");
    if (importedTarget === canonicalContractsFile && !statement.importClause?.isTypeOnly) {
      violations.push(`${relativeFile}: canonical Protyle contracts must be imported with import type`);
    }
    const forbiddenExports = forbiddenHostActionExports.get(importedTarget);
    if (!forbiddenExports) {
      continue;
    }
    const namedBindings = statement.importClause?.namedBindings;
    if (statement.importClause?.name || !namedBindings || !ts.isNamedImports(namedBindings)) {
      violations.push(`${relativeFile}: workspace host action module ${JSON.stringify(statement.moduleSpecifier.text)} must use audited named imports`);
      continue;
    }
    for (const element of namedBindings.elements) {
      const importedName = element.propertyName?.text ?? element.name.text;
      if (forbiddenExports.has(importedName)) {
        violations.push(`${relativeFile}: workspace host action import ${JSON.stringify(importedName)} from ${JSON.stringify(statement.moduleSpecifier.text)} is forbidden; dispatch ProtyleHostEvent instead`);
      }
    }
  }

  for (const statement of sourceFile.statements) {
    if (!ts.isExportDeclaration(statement) || !statement.moduleSpecifier ||
      !ts.isStringLiteralLike(statement.moduleSpecifier) || !statement.moduleSpecifier.text.startsWith(".")) {
      continue;
    }
    const exportedTarget = resolve(dirname(file), statement.moduleSpecifier.text)
      .replace(/\.(?:ts|tsx|mts|cts)$/, "");
    if (exportedTarget === canonicalContractsFile && !statement.isTypeOnly) {
      violations.push(`${relativeFile}: canonical Protyle contracts must be re-exported with export type`);
    }
    const forbiddenExports = forbiddenHostActionExports.get(exportedTarget);
    if (!forbiddenExports) {
      continue;
    }
    if (!statement.exportClause || !ts.isNamedExports(statement.exportClause)) {
      violations.push(`${relativeFile}: workspace host action module ${JSON.stringify(statement.moduleSpecifier.text)} cannot be re-exported wholesale`);
      continue;
    }
    for (const element of statement.exportClause.elements) {
      const exportedName = element.propertyName?.text ?? element.name.text;
      if (forbiddenExports.has(exportedName)) {
        violations.push(`${relativeFile}: workspace host action re-export ${JSON.stringify(exportedName)} from ${JSON.stringify(statement.moduleSpecifier.text)} is forbidden`);
      }
    }
  }

  for (const moduleLoad of collectModuleLoads(sourceFile)) {
    if (moduleLoad.kind === "require") {
      violations.push(`${relativeFile}: CommonJS require is forbidden in Protyle browser source`);
      continue;
    }
    if (!moduleLoad.specifier) {
      violations.push(`${relativeFile}: non-literal ${moduleLoad.kind} import cannot be audited`);
      continue;
    }

    const specifier = moduleLoad.specifier;
    if (specifier === "electron" || specifier.startsWith("electron/") || specifier.startsWith("@electron/")) {
      violations.push(`${relativeFile}: Electron import ${JSON.stringify(specifier)} is forbidden`);
      continue;
    }
    if (isNodeBuiltin(specifier)) {
      violations.push(`${relativeFile}: Node built-in import ${JSON.stringify(specifier)} is forbidden`);
      continue;
    }
    if (/^[a-zA-Z][a-zA-Z\d+.-]*:/.test(specifier)) {
      violations.push(`${relativeFile}: URL import ${JSON.stringify(specifier)} is forbidden`);
      continue;
    }
    if (isAbsolute(specifier)) {
      violations.push(`${relativeFile}: absolute source import ${JSON.stringify(specifier)} is forbidden`);
      continue;
    }
    if (specifier.startsWith(".")) {
      const importedTarget = resolve(dirname(file), specifier).replace(/\.(?:ts|tsx|mts|cts)$/, "");
      if (isInside(nativeMobileRoot, importedTarget)) {
        violations.push(`${relativeFile}: native mobile import ${JSON.stringify(specifier)} is forbidden`);
      } else if (isInside(legacyPluginRoot, importedTarget) && importedTarget !== legacyPluginMenuFile) {
        violations.push(`${relativeFile}: legacy plugin runtime import ${JSON.stringify(specifier)} is forbidden; use ProtylePluginPort`);
      } else if (forbiddenHostActionModules.has(importedTarget)) {
        violations.push(`${relativeFile}: workspace host action import ${JSON.stringify(specifier)} is forbidden; dispatch ProtyleHostEvent instead`);
      }
    }
  }
}

for (const file of boundaryIntegrationFiles) {
  const sourceText = readFileSync(file, "utf8");
  const scriptKind = extname(file) === ".tsx" ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sourceFile = ts.createSourceFile(file, sourceText, ts.ScriptTarget.Latest, true, scriptKind);
  const relativeFile = relative(repositoryRoot, file);
  for (const diagnostic of sourceFile.parseDiagnostics) {
    const line = diagnostic.start === undefined
      ? 1
      : sourceFile.getLineAndCharacterOfPosition(diagnostic.start).line + 1;
    const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, " ");
    violations.push(`${relativeFile}:${line}: TypeScript syntax error TS${diagnostic.code}: ${message}`);
  }

  for (const violation of auditRegistryMigrationAst(file, sourceFile)) {
    violations.push(`${relativeFile}:${violation.line}: ${violation.message}`);
  }

  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !statement.moduleSpecifier ||
      !ts.isStringLiteralLike(statement.moduleSpecifier) || !statement.moduleSpecifier.text.startsWith(".")) {
      continue;
    }
    const importedTarget = resolve(dirname(file), statement.moduleSpecifier.text)
      .replace(/\.(?:ts|tsx|mts|cts)$/, "");
    if (importedTarget === canonicalContractsFile && !statement.importClause?.isTypeOnly) {
      violations.push(`${relativeFile}: canonical Protyle contracts must be imported with import type`);
    }
  }
}

if (violations.length > 0) {
  console.error(violations.join("\n"));
  process.exitCode = 1;
} else {
  console.log(`Verified Protyle browser platform source: ${files.length} core files, ${boundaryIntegrationFiles.length} boundary files`);
}
