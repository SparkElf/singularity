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
  [join(repositoryRoot, "app/src/layout/dock/Backlink"), new Set([join(repositoryRoot, "app/src/layout/getAll")])],
  [join(repositoryRoot, "app/src/layout/dock/Outline"), new Set([join(repositoryRoot, "app/src/layout/getAll")])],
]);
const contentScopedHostEvents = new Set([
  "open-document",
  "open-document-search",
  "open-outline",
  "open-backlinks",
  "open-document-history",
  "open-card-review",
  "open-card-browser",
  "open-card-deck-picker",
  "open-asset",
  "add-blocks-to-agent",
  "refresh-outline",
  "refresh-backlinks",
  "close-document",
  "set-document-title",
  "set-document-icon",
  "activate-document",
  "toggle-document-fullscreen",
  "persist-workspace-layout",
  "update-document-statistics",
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

function getObjectProperty(object, name) {
  return object.properties.find((property) =>
    (ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property)) &&
    getStaticPropertyName(property.name) === name);
}

function getStringProperty(object, name) {
  const property = getObjectProperty(object, name);
  if (!property || !ts.isPropertyAssignment(property) || !ts.isStringLiteralLike(property.initializer)) {
    return null;
  }
  return property.initializer.text;
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

export function auditNotebookScopedHostEventsAst(sourceFile) {
  const violations = [];

  function visit(node) {
    if (ts.isCallExpression(node) && getAccessName(node.expression) === "dispatch") {
      const event = node.arguments[0];
      if (event && ts.isObjectLiteralExpression(event)) {
        const type = getStringProperty(event, "type");
        const isDocumentGraph = type === "open-graph" && getStringProperty(event, "scope") !== "space";
        const requiresContentIdentity = contentScopedHostEvents.has(type) || isDocumentGraph;
        if (requiresContentIdentity && !getObjectProperty(event, "notebookId")) {
          violations.push({
            ruleId: "notebook-scope-missing",
            line: sourceFile.getLineAndCharacterOfPosition(event.getStart(sourceFile)).line + 1,
            message: `${type} must carry the source Protyle notebookId`,
          });
        }
        if (requiresContentIdentity && !getObjectProperty(event, "documentId")) {
          violations.push({
            ruleId: "document-scope-missing",
            line: sourceFile.getLineAndCharacterOfPosition(event.getStart(sourceFile)).line + 1,
            message: `${type} must carry the source Protyle documentId`,
          });
        }
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return violations;
}

export function auditNotebookScopedHostEventsSource(sourceText) {
  const sourceFile = ts.createSourceFile("host-event.ts", sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  return auditNotebookScopedHostEventsAst(sourceFile);
}
