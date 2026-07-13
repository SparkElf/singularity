import { readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const protyleRoot = join(repositoryRoot, "app/src/protyle");
const writeChanges = process.argv.includes("--write");
const supportedArguments = new Set(["--check", "--write"]);
const unknownArguments = process.argv.slice(2).filter((argument) => !supportedArguments.has(argument));

if (unknownArguments.length > 0) {
  throw new Error(`Unknown arguments: ${unknownArguments.join(", ")}`);
}
if (process.argv.includes("--check") && writeChanges) {
  throw new Error("Use either --check or --write, not both");
}

const flags = new Map([
  ["BROWSER", true],
  ["MOBILE", false],
]);
const sourceExtensions = new Set([".ts", ".tsx", ".mts", ".cts"]);

function evaluateCondition(expression, file, lineNumber) {
  return expression.split(/\s*&&\s*/).every((term) => {
    const trimmedTerm = term.trim();
    const negated = trimmedTerm.startsWith("!");
    const flagName = negated ? trimmedTerm.slice(1) : trimmedTerm;
    if (!flags.has(flagName)) {
      throw new Error(`${file}:${lineNumber}: unsupported condition ${JSON.stringify(expression)}`);
    }
    const value = flags.get(flagName);
    return negated ? !value : value;
  });
}

function resolveDirectives(source, file) {
  const newline = source.includes("\r\n") ? "\r\n" : "\n";
  const lines = source.split(/\r?\n/);
  const output = [];
  const stack = [];
  let directiveCount = 0;

  lines.forEach((line, index) => {
    const lineNumber = index + 1;
    const directive = line.match(/^\s*\/\/\/\s*#(if|else|endif)(?:\s+(.+?))?\s*$/);
    if (!directive) {
      if (stack.every((frame) => frame.active)) {
        output.push(line);
      }
      return;
    }

    directiveCount += 1;
    const command = directive[1];
    const expression = directive[2];

    if (command === "if") {
      if (!expression) {
        throw new Error(`${file}:${lineNumber}: missing directive condition`);
      }
      const parentActive = stack.every((frame) => frame.active);
      const condition = evaluateCondition(expression, file, lineNumber);
      stack.push({
        active: parentActive && condition,
        condition,
        elseSeen: false,
        lineNumber,
        parentActive,
      });
      return;
    }

    const frame = stack.at(-1);
    if (!frame) {
      throw new Error(`${file}:${lineNumber}: orphan #${command}`);
    }

    if (command === "else") {
      if (expression) {
        throw new Error(`${file}:${lineNumber}: #else cannot have a condition`);
      }
      if (frame.elseSeen) {
        throw new Error(`${file}:${lineNumber}: duplicate #else for #if at line ${frame.lineNumber}`);
      }
      frame.elseSeen = true;
      frame.active = frame.parentActive && !frame.condition;
      return;
    }

    if (expression) {
      throw new Error(`${file}:${lineNumber}: #endif cannot have a condition`);
    }
    stack.pop();
  });

  if (stack.length > 0) {
    throw new Error(`${file}: unclosed #if at line ${stack.at(-1).lineNumber}`);
  }

  return {
    directiveCount,
    source: output.join(newline),
  };
}

async function collectTypeScriptFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nestedFiles = await Promise.all(entries.map(async (entry) => {
    const entryPath = join(directory, entry.name);
    if (entry.isDirectory()) {
      return collectTypeScriptFiles(entryPath);
    }
    return sourceExtensions.has(extname(entry.name)) ? [entryPath] : [];
  }));
  return nestedFiles.flat();
}

const files = (await collectTypeScriptFiles(protyleRoot)).sort();
let changedFileCount = 0;
let directiveCount = 0;

for (const file of files) {
  const source = await readFile(file, "utf8");
  const result = resolveDirectives(source, relative(repositoryRoot, file));
  directiveCount += result.directiveCount;
  if (result.source === source) {
    continue;
  }
  changedFileCount += 1;
  if (writeChanges) {
    await writeFile(file, result.source, "utf8");
  }
}

if (!writeChanges && directiveCount > 0) {
  console.error(`Protyle browser source still contains ${directiveCount} platform directives in ${changedFileCount} files`);
  process.exitCode = 1;
} else if (writeChanges) {
  console.log(`Resolved ${directiveCount} platform directives in ${changedFileCount} Protyle files`);
} else {
  console.log(`Verified Protyle browser source: ${files.length} TypeScript files, no platform directives`);
}
