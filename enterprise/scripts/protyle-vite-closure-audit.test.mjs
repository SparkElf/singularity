import assert from "node:assert/strict";
import { describe, test } from "node:test";
import ts from "typescript";

import {
  auditProductionClosure,
  collectModuleLoads,
} from "./protyle-vite-closure-audit.mjs";

describe("Vite Protyle production closure audit", () => {
  test("loads the real Core through the dedicated public package entry", () => {
    const report = auditProductionClosure();
    assert.ok(report.productionFiles.includes("enterprise/apps/web/src/main.tsx"));
    assert.ok(report.productionFiles.includes("enterprise/packages/protyle-browser/src/core.ts"));
    assert.ok(report.productionFiles.includes("app/src/protyle/browser-entry.ts"));
    assert.ok(report.productionFiles.includes("app/src/protyle/index.ts"));
    assert.ok(!report.violations.some((item) => item.ruleId === "core-entry-missing"));
    assert.ok(!report.violations.some((item) => item.ruleId === "core-composition-root"));
    assert.ok(!report.violations.some((item) =>
      item.file === "enterprise/packages/protyle-browser/src/core.ts" &&
      item.ruleId === "source-escape"));
  });

  test("audits the connected Core only as part of the production graph", () => {
    const report = auditProductionClosure();
    assert.deepEqual(report.candidateFiles, []);
    assert.ok(report.violations.every((item) => item.phase === "production"));
  });

  test("collects non-literal dynamic and CommonJS loads as auditable violations", () => {
    const source = ts.createSourceFile(
      "fixture.ts",
      "import(moduleName); require(moduleName);",
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    const loads = collectModuleLoads(source);
    assert.deepEqual(
      loads.map((load) => [load.kind, load.specifier]),
      [["dynamic", null], ["require", null]],
    );
  });

  test("does not add stylesheet imports to the TypeScript closure", () => {
    const report = auditProductionClosure();
    assert.ok(!report.productionFiles.includes("enterprise/apps/web/src/styles.css"));
  });
});
