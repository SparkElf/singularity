import { builtinModules } from "node:module";
import {
  existsSync,
  readFileSync,
  statSync,
} from "node:fs";
import {
  dirname,
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const enterpriseRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(enterpriseRoot, "..");
const webRoot = join(enterpriseRoot, "apps/web");
const webEntry = join(webRoot, "src/main.tsx");
const coreEntry = join(repositoryRoot, "app/src/protyle/browser-entry.ts");
const coreRoot = join(repositoryRoot, "app/src/protyle");
const browserPackageRoot = join(enterpriseRoot, "packages/protyle-browser/src");
const publicCoreEntry = join(browserPackageRoot, "core.ts");
const publicCoreSpecifier = "@singularity/protyle-browser/core";
const sourceExtensions = [
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".d.ts",
];
const builtinPackageNames = new Set(
  builtinModules.map((name) => name.replace(/^node:/, "").split("/")[0]),
);
const forbiddenPackagePrefixes = ["electron", "@electron/"];
const forbiddenAppRoots = [
  "app/src/index.ts",
  "app/src/layout",
  "app/src/editor",
  "app/src/search",
  "app/src/history",
  "app/src/card",
  "app/src/plugin",
  "app/src/menus",
  "app/src/mobile",
  "app/src/window",
  "app/src/electron",
];
const allowedCoreRoots = [
  "app/src/protyle",
  "app/src/constants.ts",
  "app/src/types/config.d.ts",
  "app/src/types/protyle.d.ts",
  "app/src/types/index.d.ts",
  "app/src/util/genID.ts",
  "app/src/util/pathName.ts",
  "app/src/util/escape.ts",
];
const nonSourceExtensions = new Set([
  ".css",
  ".scss",
  ".sass",
  ".less",
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".avif",
  ".svg",
  ".woff",
  ".woff2",
]);
const auditableSourceExtensions = new Set(sourceExtensions);

function canonical(file) {
  return resolve(file).replace(/\\/g, "/");
}

function relativeRepository(file) {
  return relative(repositoryRoot, file).replace(/\\/g, "/");
}

function isInside(parent, candidate) {
  const pathFromParent = relative(parent, candidate);
  return pathFromParent === "" ||
    (!pathFromParent.startsWith(`..${sep}`) && pathFromParent !== "..");
}

function pathMatchesRoot(file, root) {
  const absoluteRoot = join(repositoryRoot, root);
  return canonical(file) === canonical(absoluteRoot) ||
    isInside(absoluteRoot, file);
}

function isApprovedPublicCoreEdge(file, target) {
  return canonical(file) === canonical(publicCoreEntry) &&
    canonical(target) === canonical(coreEntry);
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return {};
  }
}

function packageName(specifier) {
  const segments = specifier.split("/");
  return specifier.startsWith("@")
    ? segments.slice(0, 2).join("/")
    : segments[0];
}

function packageNames(file) {
  const manifest = readJson(file);
  return Object.keys({
    ...(manifest.dependencies ?? {}),
    ...(manifest.devDependencies ?? {}),
    ...(manifest.peerDependencies ?? {}),
  });
}

const declaredBrowserPackages = new Set([
  ...packageNames(join(enterpriseRoot, "package.json")),
  ...packageNames(join(webRoot, "package.json")),
  ...packageNames(join(repositoryRoot, "app/package.json")),
]);

function resolveSourceFile(importer, specifier) {
  let absoluteTarget;
  if (specifier.startsWith("@/")) {
    absoluteTarget = join(webRoot, "src", specifier.slice(2));
  } else if (specifier === "@singularity/protyle-browser" ||
    specifier.startsWith("@singularity/protyle-browser/")) {
    const subpath = specifier === "@singularity/protyle-browser"
      ? "index.ts"
      : specifier.slice("@singularity/protyle-browser/".length).replace(/^src\//, "");
    absoluteTarget = join(browserPackageRoot, subpath);
  } else if (specifier.startsWith("@singularity/")) {
    const packagePart = specifier.slice("@singularity/".length).split("/")[0];
    const packageRoot = join(enterpriseRoot, "packages", packagePart, "src");
    const subpath = specifier.split("/").slice(2).join("/").replace(/^src\//, "");
    absoluteTarget = join(packageRoot, subpath);
    if (specifier === `@singularity/${packagePart}`) {
      absoluteTarget = join(packageRoot, "index.ts");
    }
  } else if (specifier.startsWith(".")) {
    absoluteTarget = resolve(dirname(importer), specifier);
  } else if (isAbsolute(specifier)) {
    absoluteTarget = specifier;
  } else {
    return null;
  }

  const extension = extname(absoluteTarget);
  const withoutExtension = extension
    ? absoluteTarget.slice(0, -extension.length)
    : absoluteTarget;
  const candidates = [
    absoluteTarget,
    ...sourceExtensions.map((sourceExtension) => `${withoutExtension}${sourceExtension}`),
    ...sourceExtensions.map((sourceExtension) => join(absoluteTarget, `index${sourceExtension}`)),
  ];

  // Vite accepts a source extension in an import that was authored with the
  // emitted JavaScript extension; resolve both forms for the static audit.
  if ([".js", ".jsx", ".mjs", ".cjs"].includes(extension)) {
    const sourceWithoutExtension = absoluteTarget.slice(0, -extension.length);
    candidates.push(
      ...[".ts", ".tsx", ".mts", ".cts"].map((sourceExtension) =>
        `${sourceWithoutExtension}${sourceExtension}`),
    );
  }

  return candidates.find((candidate) =>
    existsSync(candidate) && statSync(candidate).isFile());
}

function scriptKind(file) {
  return [".tsx", ".jsx"].includes(extname(file))
    ? ts.ScriptKind.TSX
    : [".js", ".mjs", ".cjs"].includes(extname(file))
      ? ts.ScriptKind.JS
      : ts.ScriptKind.TS;
}

function isAuditableSourceFile(file) {
  return auditableSourceExtensions.has(extname(file));
}

function lineOf(sourceFile, node) {
  return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
}

/**
 * 收集所有会影响浏览器闭包的模块加载形式；type-only 边仍被审计，但不进入运行时图。
 */
export function collectModuleLoads(sourceFile) {
  const moduleLoads = [];

  function visit(node) {
    if (ts.isImportDeclaration(node) && node.moduleSpecifier) {
      moduleLoads.push({
        kind: "static",
        node,
        specifier: ts.isStringLiteralLike(node.moduleSpecifier)
          ? node.moduleSpecifier.text
          : null,
        typeOnly: node.importClause?.isTypeOnly === true,
      });
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
      moduleLoads.push({
        kind: "re-export",
        node,
        specifier: ts.isStringLiteralLike(node.moduleSpecifier)
          ? node.moduleSpecifier.text
          : null,
        typeOnly: node.isTypeOnly === true,
      });
    }

    if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      const expression = node.moduleReference.expression;
      moduleLoads.push({
        kind: "require",
        node,
        specifier: expression && ts.isStringLiteralLike(expression)
          ? expression.text
          : null,
        typeOnly: false,
      });
    }

    if (ts.isImportTypeNode(node)) {
      const argument = node.argument;
      moduleLoads.push({
        kind: "type-import",
        node,
        specifier: ts.isLiteralTypeNode(argument) && ts.isStringLiteralLike(argument.literal)
          ? argument.literal.text
          : null,
        typeOnly: true,
      });
    }

    if (ts.isCallExpression(node)) {
      const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire = ts.isIdentifier(node.expression) && node.expression.text === "require";
      if (isDynamicImport || isRequire) {
        const argument = node.arguments[0];
        moduleLoads.push({
          kind: isRequire ? "require" : "dynamic",
          node,
          specifier: argument && ts.isStringLiteralLike(argument)
            ? argument.text
            : null,
          typeOnly: false,
        });
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return moduleLoads;
}

function violation(ruleId, file, line, message, phase = "production") {
  return {
    file: relativeRepository(file),
    line,
    message,
    phase,
    ruleId,
  };
}

function sourceViolations(file, sourceFile, phase) {
  const sourceText = readFileSync(file, "utf8");
  const violations = [];
  const relativeFile = relativeRepository(file);
  if (/^\s*\/\/\/\s*#(?:if|else|endif)\b/m.test(sourceText)) {
    violations.push(violation("ifdef-directive", file, 1,
      "ifdef-loader 指令不能进入 Vite 浏览器闭包", phase));
  }
  const legacyGlobal = /\b(?:window|globalThis|self)\s*(?:\.\s*siyuan|\[\s*["']siyuan["']\s*\])/;
  if (legacyGlobal.test(sourceText)) {
    violations.push(violation("legacy-global", file, 1,
      "浏览器 Core 闭包不能读取 window.siyuan 全局状态", phase));
  }
  if (/\b(?:fetchPost|fetchGet|fetchSyncPost|fetchSyncGet)\b/.test(sourceText)) {
    violations.push(violation("legacy-transport", file, 1,
      "浏览器 Core 闭包不能直接使用旧 fetch transport", phase));
  }
  if (/\b(?:window|globalThis)\s*\.\s*process\b|\bprocess\s*\./.test(sourceText)) {
    violations.push(violation("node-process", file, 1,
      "浏览器 Core 闭包不能读取 Node process 全局", phase));
  }
  if (/\bnew\s+Model\b|\bModel\s*\.\s*(?:prototype|connect)\b/.test(sourceText)) {
    violations.push(violation("legacy-model", file, 1,
      "浏览器 Core 闭包不能装配旧 layout Model", phase));
  }
  if (relativeFile === "app/src/index.ts") {
    violations.push(violation("legacy-app-entry", file, 1,
      "浏览器 Core 闭包不能导入旧 App 应用壳", phase));
  }
  return violations;
}

function auditModuleLoad({ file, sourceFile, moduleLoad, phase }) {
  const violations = [];
  const line = lineOf(sourceFile, moduleLoad.node);
  const relativeFile = relativeRepository(file);
  if (!moduleLoad.specifier) {
    violations.push(violation("non-literal-module-load", file, line,
      `${relativeFile} 的 ${moduleLoad.kind} 加载不是字面量，无法审计`, phase));
    return violations;
  }

  const specifier = moduleLoad.specifier;
  const name = packageName(specifier);
  if (moduleLoad.kind === "require") {
    violations.push(violation("require", file, line,
      `CommonJS require ${JSON.stringify(specifier)} 禁止进入 Vite 浏览器闭包`, phase));
    return violations;
  }
  if (specifier === "electron" || forbiddenPackagePrefixes.some((prefix) =>
    specifier.startsWith(prefix))) {
    violations.push(violation("electron-import", file, line,
      `Electron import ${JSON.stringify(specifier)} 禁止进入浏览器闭包`, phase));
    return violations;
  }
  if (specifier.startsWith("node:") || builtinPackageNames.has(name)) {
    violations.push(violation("node-builtin", file, line,
      `Node 内置模块 ${JSON.stringify(specifier)} 禁止进入浏览器闭包`, phase));
    return violations;
  }
  if (/^[a-zA-Z][a-zA-Z\d+.-]*:/.test(specifier)) {
    violations.push(violation("url-import", file, line,
      `URL import ${JSON.stringify(specifier)} 禁止进入浏览器闭包`, phase));
    return violations;
  }

  if (!specifier.startsWith(".") && !specifier.startsWith("@/") && !specifier.startsWith("@singularity/") && !isAbsolute(specifier)) {
    if (!declaredBrowserPackages.has(name)) {
      violations.push(violation("undeclared-external", file, line,
        `外部包 ${JSON.stringify(name)} 未在企业或上游浏览器依赖中声明`, phase));
    }
    return violations;
  }

  if (isAbsolute(specifier)) {
    violations.push(violation("absolute-import", file, line,
      `绝对源码路径 ${JSON.stringify(specifier)} 禁止进入浏览器闭包`, phase));
  }
  return violations;
}

function classifyRelativeTarget(file, target, phase) {
  const violations = [];
  const fileIsCore = phase === "candidate-core" || isInside(coreRoot, file);
  if (!fileIsCore) {
    if (!isInside(enterpriseRoot, target) &&
      !isApprovedPublicCoreEdge(file, target)) {
      violations.push(violation("source-escape", file, 1,
        `生产入口依赖越出 enterprise：${relativeRepository(target)}`, phase));
    }
    return violations;
  }

  if (forbiddenAppRoots.some((root) => pathMatchesRoot(target, root))) {
    violations.push(violation("legacy-app-boundary", file, 1,
      `Core 入口依赖旧应用边界：${relativeRepository(target)}`, phase));
    return violations;
  }
  if (isInside(enterpriseRoot, target) &&
    !isInside(browserPackageRoot, target)) {
    violations.push(violation("core-contract-boundary", file, 1,
      `Core 入口依赖未批准的 enterprise 源码根：${relativeRepository(target)}`, phase));
  } else if (!isInside(enterpriseRoot, target) &&
    !allowedCoreRoots.some((root) => pathMatchesRoot(target, root))) {
    violations.push(violation("core-source-boundary", file, 1,
      `Core 入口依赖未批准的源码根：${relativeRepository(target)}`, phase));
  }
  return violations;
}

function createAuditState() {
  return {
    candidateVisited: new Set(),
    productionVisited: new Set(),
    violations: [],
  };
}

function visitGraph({ entry, phase, state }) {
  const pending = [canonical(entry)];
  const visited = phase === "production" ? state.productionVisited : state.candidateVisited;

  while (pending.length > 0) {
    const file = pending.pop();
    if (!file || visited.has(file)) {
      continue;
    }
    visited.add(file);

    if (!existsSync(file) || !statSync(file).isFile()) {
      state.violations.push(violation("missing-entry", file, 1,
        "入口文件不存在", phase));
      continue;
    }

    const sourceText = readFileSync(file, "utf8");
    const sourceFile = ts.createSourceFile(
      file,
      sourceText,
      ts.ScriptTarget.Latest,
      true,
      scriptKind(file),
    );
    for (const diagnostic of sourceFile.parseDiagnostics) {
      state.violations.push(violation("syntax", file, lineOf(sourceFile, {
        getStart: () => diagnostic.start ?? 0,
      }), ts.flattenDiagnosticMessageText(diagnostic.messageText, " "), phase));
    }
    state.violations.push(...sourceViolations(file, sourceFile, phase));

    for (const moduleLoad of collectModuleLoads(sourceFile)) {
      state.violations.push(...auditModuleLoad({ file, sourceFile, moduleLoad, phase }));
      if (!moduleLoad.specifier || moduleLoad.typeOnly) {
        continue;
      }
      const target = resolveSourceFile(file, moduleLoad.specifier);
      if (!target) {
        if ((moduleLoad.specifier.startsWith(".") || moduleLoad.specifier.startsWith("@/")) &&
          !nonSourceExtensions.has(extname(moduleLoad.specifier))) {
          state.violations.push(violation("unresolved-import", file,
            lineOf(sourceFile, moduleLoad.node),
            `无法解析源码依赖 ${JSON.stringify(moduleLoad.specifier)}`, phase));
        }
        continue;
      }
      if (!isAuditableSourceFile(target)) {
        continue;
      }
      if (canonical(target) === canonical(publicCoreEntry) &&
        (canonical(file) !== canonical(webEntry) ||
          moduleLoad.specifier !== publicCoreSpecifier)) {
        state.violations.push(violation("core-composition-root", file,
          lineOf(sourceFile, moduleLoad.node),
          `真实 Core 公共子入口只能由企业组合根 ${relativeRepository(webEntry)} 加载`, phase));
      }
      const targetBoundaryViolations = classifyRelativeTarget(file, target, phase);
      state.violations.push(...targetBoundaryViolations.map((item) => ({
        ...item,
        line: lineOf(sourceFile, moduleLoad.node),
      })));
      if (phase === "production" && !isInside(enterpriseRoot, target) &&
        !isInside(coreRoot, target)) {
        continue;
      }
      if (phase === "candidate-core" && targetBoundaryViolations.length > 0) {
        continue;
      }
      pending.push(canonical(target));
    }
  }
}

export function auditProductionClosure({
  productionEntry = webEntry,
  candidateCoreEntry = coreEntry,
} = {}) {
  const state = createAuditState();
  visitGraph({ entry: productionEntry, phase: "production", state });

  const canonicalCoreEntry = canonical(candidateCoreEntry);
  if (!state.productionVisited.has(canonicalCoreEntry)) {
    state.violations.push(violation("core-entry-missing", productionEntry, 1,
      `企业生产入口未加载真实 Core 入口 ${relativeRepository(candidateCoreEntry)}`, "production"));
    // 入口尚未接线时仍审计候选闭包，以便输出可操作的迁移阻塞，而不是只报缺失。
    visitGraph({ entry: candidateCoreEntry, phase: "candidate-core", state });
  }

  state.violations.sort((left, right) =>
    `${left.phase}:${left.file}:${left.line}:${left.ruleId}`
      .localeCompare(`${right.phase}:${right.file}:${right.line}:${right.ruleId}`));
  return {
    candidateFiles: [...state.candidateVisited].map(relativeRepository).sort(),
    productionFiles: [...state.productionVisited].map(relativeRepository).sort(),
    violations: state.violations,
  };
}

export function formatAuditReport(report) {
  const lines = [
    `Production files: ${report.productionFiles.length}`,
    `Candidate Core files: ${report.candidateFiles.length}`,
  ];
  if (report.violations.length === 0) {
    lines.push("Verified Vite Protyle production closure");
    return lines.join("\n");
  }
  lines.push(...report.violations.map((item) =>
    `${item.phase} ${item.file}:${item.line} [${item.ruleId}] ${item.message}`));
  return lines.join("\n");
}

if (process.argv[1] && canonical(process.argv[1]) === canonical(fileURLToPath(import.meta.url))) {
  const report = auditProductionClosure();
  console.log(formatAuditReport(report));
  if (report.violations.length > 0) {
    process.exitCode = 1;
  }
}
