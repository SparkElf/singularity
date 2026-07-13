import { dirname, extname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const enterpriseRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(enterpriseRoot, "..");
const protyleRoot = join(repositoryRoot, "app/src/protyle");
const legacyEditorRegistryModules = new Map([
  [join(protyleRoot, "util/editorCommonEvent"), new Set([join(repositoryRoot, "app/src/layout/getAll")])],
  [join(protyleRoot, "util/resize"), new Set([join(repositoryRoot, "app/src/layout/getAll")])],
  [join(protyleRoot, "undo/globalUndo"), new Set([join(repositoryRoot, "app/src/layout/tabUtil")])],
  [join(protyleRoot, "wysiwyg/transaction"), new Set([join(repositoryRoot, "app/src/layout/getAll")])],
  [join(repositoryRoot, "app/src/host/protyle"), new Set([join(repositoryRoot, "app/src/layout/getAll")])],
]);

function withoutSourceExtension(file) {
  return file.replace(/\.(?:[cm]?[jt]sx?)$/, "");
}

function getStaticPropertyName(node) {
  if (ts.isIdentifier(node) || ts.isStringLiteralLike(node) || ts.isNumericLiteral(node)) {
    return node.text;
  }
  if (ts.isComputedPropertyName(node)) {
    return getStaticPropertyName(node.expression);
  }
  return null;
}

function getAccessName(node) {
  if (ts.isPropertyAccessExpression(node)) {
    return getStaticPropertyName(node.name);
  }
  if (ts.isElementAccessExpression(node) && node.argumentExpression) {
    return getStaticPropertyName(node.argumentExpression);
  }
  if (ts.isBindingElement(node)) {
    return getStaticPropertyName(node.propertyName ?? node.name);
  }
  if (ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node)) {
    return getStaticPropertyName(node.name);
  }
  return null;
}

function collectLegacyEditorCollectionAccesses(sourceFile) {
  const accesses = [];

  function visit(node) {
    if (getAccessName(node) === "blockPanels") {
      accesses.push(node);
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return accesses;
}

export function collectModuleLoads(sourceFile) {
  const moduleLoads = [];

  function visit(node) {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
      moduleLoads.push({
        node,
        kind: "static",
        specifier: ts.isStringLiteralLike(node.moduleSpecifier) ? node.moduleSpecifier.text : null,
      });
    }

    if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      const expression = node.moduleReference.expression;
      moduleLoads.push({
        node,
        kind: "require",
        specifier: expression && ts.isStringLiteralLike(expression) ? expression.text : null,
      });
    }

    if (ts.isImportTypeNode(node)) {
      const argument = node.argument;
      moduleLoads.push({
        node,
        kind: "static",
        specifier: ts.isLiteralTypeNode(argument) && ts.isStringLiteralLike(argument.literal)
          ? argument.literal.text
          : null,
      });
    }

    if (ts.isCallExpression(node)) {
      const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire = ts.isIdentifier(node.expression) && node.expression.text === "require";
      const argument = node.arguments[0];
      if (isDynamicImport || isRequire) {
        moduleLoads.push({
          node,
          kind: isRequire ? "require" : "dynamic",
          specifier: argument && ts.isStringLiteralLike(argument) ? argument.text : null,
        });
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return moduleLoads;
}

export function auditRegistryMigrationAst(file, sourceFile) {
  const absoluteFile = isAbsolute(file) ? file : join(repositoryRoot, file);
  const fileWithoutExtension = withoutSourceExtension(absoluteFile);
  const forbiddenModules = legacyEditorRegistryModules.get(fileWithoutExtension);
  if (!forbiddenModules) {
    return [];
  }

  const violations = [];
  const getLine = (node) => sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;

  for (const access of collectLegacyEditorCollectionAccesses(sourceFile)) {
    violations.push({
      ruleId: "legacy-editor-collection",
      line: getLine(access),
      message: "legacy blockPanels editor scan is forbidden; use ProtyleEditorRegistry",
    });
  }

  for (const moduleLoad of collectModuleLoads(sourceFile)) {
    if (!moduleLoad.specifier) {
      violations.push({
        ruleId: "legacy-editor-module-unauditable",
        line: getLine(moduleLoad.node),
        message: `non-literal ${moduleLoad.kind} import cannot be audited in a Registry migration file`,
      });
      continue;
    }
    if (!moduleLoad.specifier.startsWith(".")) {
      continue;
    }
    const importedTarget = withoutSourceExtension(resolve(dirname(absoluteFile), moduleLoad.specifier));
    if (forbiddenModules.has(importedTarget)) {
      violations.push({
        ruleId: "legacy-editor-module",
        line: getLine(moduleLoad.node),
        message: `legacy editor collection import ${JSON.stringify(moduleLoad.specifier)} is forbidden; use ProtyleEditorRegistry`,
      });
    }
  }

  return violations;
}

export function auditRegistryMigrationSource({ file, sourceText }) {
  const scriptKind = extname(file) === ".tsx" ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sourceFile = ts.createSourceFile(file, sourceText, ts.ScriptTarget.Latest, true, scriptKind);
  return auditRegistryMigrationAst(file, sourceFile);
}
