import { copyFile, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import runtimeAssets from "../protyle-runtime-assets.json" with { type: "json" };

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(webRoot, "../../..");
const publicRoot = resolve(webRoot, runtimeAssets.publicDirectory);

const compareNames = (left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0;

if (runtimeAssets.schemaVersion !== 1) {
  throw new Error(`Unsupported Protyle runtime manifest schema: ${runtimeAssets.schemaVersion}`);
}

async function copyDirectory(source, target) {
  await mkdir(target, { recursive: true });
  const entries = await readdir(source, { withFileTypes: true });
  entries.sort(compareNames);

  for (const entry of entries) {
    const sourceEntry = join(source, entry.name);
    const targetEntry = join(target, entry.name);
    if (entry.isDirectory()) {
      await copyDirectory(sourceEntry, targetEntry);
    } else if (entry.isFile()) {
      await copyFile(sourceEntry, targetEntry);
    } else {
      throw new Error(`Unsupported Protyle runtime asset: ${sourceEntry}`);
    }
  }
}

const appPackagePath = resolve(repositoryRoot, "app/package.json");
const appPackage = JSON.parse(await readFile(appPackagePath, "utf8"));
if (appPackage.version !== runtimeAssets.upstreamVersion) {
  throw new Error(
    `Protyle runtime manifest targets SiYuan ${runtimeAssets.upstreamVersion}, ` +
      `but app/package.json declares ${appPackage.version}`,
  );
}

await rm(publicRoot, { recursive: true, force: true });
await mkdir(publicRoot, { recursive: true });

for (const directory of runtimeAssets.directories) {
  await copyDirectory(
    resolve(repositoryRoot, directory.source),
    resolve(publicRoot, directory.target),
  );
}

for (const file of runtimeAssets.files) {
  const target = resolve(publicRoot, file.target);
  await mkdir(dirname(target), { recursive: true });
  await copyFile(resolve(repositoryRoot, file.source), target);
}

const themeTarget = resolve(publicRoot, runtimeAssets.style.theme.target);
await mkdir(dirname(themeTarget), { recursive: true });
await copyFile(resolve(repositoryRoot, runtimeAssets.style.theme.source), themeTarget);

const requireFromApp = createRequire(appPackagePath);
const sass = requireFromApp("sass");
const styleTarget = resolve(publicRoot, runtimeAssets.style.target);
const compiledStyle = await sass.compileAsync(
  resolve(repositoryRoot, runtimeAssets.style.source),
  {
    charset: false,
    style: "compressed",
  },
);
await mkdir(dirname(styleTarget), { recursive: true });
await writeFile(styleTarget, compiledStyle.css);

// 企业 Web 不依赖旧工作台全局状态，并统一把 HTML 块收敛为惰性、安全的 DOM 渲染。
const protyleHtmlTarget = resolve(publicRoot, "stage/protyle/js/protyle-html.js");
const protyleHtmlRuntime = await readFile(protyleHtmlTarget, "utf8");
const legacyHtmlElementOffset = protyleHtmlRuntime.lastIndexOf("class ProtyleHtml extends HTMLElement {");
if (legacyHtmlElementOffset < 0) {
  throw new Error("Unable to locate the upstream protyle-html custom element");
}
const enterpriseHtmlElement = await readFile(
  resolve(webRoot, "src/editor/protyle-html.enterprise.js"),
  "utf8",
);
await writeFile(
  protyleHtmlTarget,
  `${protyleHtmlRuntime.slice(0, legacyHtmlElementOffset)}${enterpriseHtmlElement}`,
);
