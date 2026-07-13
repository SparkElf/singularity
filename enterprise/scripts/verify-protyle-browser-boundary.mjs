import { builtinModules } from "node:module";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const enterpriseRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourceRoot = join(enterpriseRoot, "packages/protyle-browser/src");
const entry = join(sourceRoot, "index.ts");
const forbiddenPackages = new Set(["electron", ...builtinModules, ...builtinModules.map((name) => `node:${name}`)]);
const allowedExternalPackages = new Set();
const sourceExtensions = [".ts", ".tsx", ".mts", ".cts"];

function isInside(parent, candidate) {
  const pathFromParent = relative(parent, candidate);
  return pathFromParent === "" || (!pathFromParent.startsWith(`..${sep}`) && pathFromParent !== "..");
}

function resolveSourceFile(importer, specifier) {
  const absoluteTarget = resolve(dirname(importer), specifier);
  const extension = extname(absoluteTarget);
  const withoutExtension = extension ? absoluteTarget.slice(0, -extension.length) : absoluteTarget;
  const candidates = [
    absoluteTarget,
    ...sourceExtensions.map((sourceExtension) => `${withoutExtension}${sourceExtension}`),
    ...sourceExtensions.map((sourceExtension) => join(absoluteTarget, `index${sourceExtension}`)),
  ];

  return candidates.find((candidate) => existsSync(candidate) && statSync(candidate).isFile());
}

function collectModuleLoads(sourceFile) {
  const moduleLoads = [];

  function visit(node) {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)) {
      moduleLoads.push({ kind: "static", specifier: node.moduleSpecifier.text });
    }

    if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      const expression = node.moduleReference.expression;
      moduleLoads.push({
        kind: "require",
        specifier: expression && ts.isStringLiteralLike(expression) ? expression.text : null,
      });
    }

    if (ts.isImportTypeNode(node)) {
      const argument = node.argument;
      moduleLoads.push({
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

const pending = [entry];
const visited = new Set();
const violations = [];

while (pending.length > 0) {
  const file = pending.pop();
  if (!file || visited.has(file)) {
    continue;
  }
  visited.add(file);

  const sourceText = readFileSync(file, "utf8");
  const relativeFile = relative(enterpriseRoot, file);
  if (/^\s*\/\/\/\s*#(?:if|else|endif)\b/m.test(sourceText)) {
    violations.push(`${relativeFile}: ifdef-loader directive is forbidden`);
  }

  const scriptKind = extname(file) === ".tsx" ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sourceFile = ts.createSourceFile(file, sourceText, ts.ScriptTarget.Latest, true, scriptKind);
  for (const moduleLoad of collectModuleLoads(sourceFile)) {
    if (moduleLoad.kind === "require") {
      violations.push(`${relativeFile}: CommonJS require is forbidden in the browser package`);
      continue;
    }
    if (!moduleLoad.specifier) {
      violations.push(`${relativeFile}: non-literal ${moduleLoad.kind} import cannot be audited`);
      continue;
    }
    const specifier = moduleLoad.specifier;
    if (/^[a-zA-Z][a-zA-Z\d+.-]*:/.test(specifier)) {
      violations.push(`${relativeFile}: URL import ${JSON.stringify(specifier)} is forbidden`);
      continue;
    }
    if (!specifier.startsWith(".") && !isAbsolute(specifier)) {
      const segments = specifier.split("/");
      const packageName = specifier.startsWith("@") ? segments.slice(0, 2).join("/") : segments[0];
      if (forbiddenPackages.has(specifier) || forbiddenPackages.has(packageName) || specifier.startsWith("@electron/")) {
        violations.push(`${relativeFile}: forbidden browser import ${JSON.stringify(specifier)}`);
      } else if (!packageName || !allowedExternalPackages.has(packageName)) {
        violations.push(`${relativeFile}: external package ${JSON.stringify(packageName)} is not approved`);
      }
      continue;
    }

    if (isAbsolute(specifier)) {
      violations.push(`${relativeFile}: absolute source import ${JSON.stringify(specifier)} is forbidden`);
      continue;
    }

    const importedFile = resolveSourceFile(file, specifier);
    if (!importedFile) {
      violations.push(`${relativeFile}: cannot resolve ${JSON.stringify(specifier)}`);
      continue;
    }
    if (!isInside(sourceRoot, importedFile)) {
      violations.push(`${relativeFile}: import escapes the browser package: ${JSON.stringify(specifier)}`);
      continue;
    }
    pending.push(importedFile);
  }
}

if (violations.length > 0) {
  console.error(violations.join("\n"));
  process.exitCode = 1;
} else {
  console.log(`Verified Protyle browser boundary: ${visited.size} TypeScript files`);
}
