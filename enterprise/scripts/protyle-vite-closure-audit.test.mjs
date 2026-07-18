import assert from "node:assert/strict";
import { describe, test } from "node:test";
import ts from "typescript";

import {
  auditProductionClosure,
  collectModuleLoads,
  formatAuditReport,
} from "./protyle-vite-closure-audit.mjs";

describe("Vite Protyle production closure audit", () => {
  test("loads the real Core through the dedicated public package entry with no violations", () => {
    const report = auditProductionClosure();
    assert.ok(report.productionFiles.includes("enterprise/apps/web/src/main.tsx"));
    assert.ok(report.productionFiles.includes("enterprise/packages/protyle-browser/src/core.ts"));
    assert.ok(report.productionFiles.includes("app/src/protyle/browser-entry.ts"));
    assert.ok(report.productionFiles.includes("app/src/protyle/index.ts"));
    assert.deepEqual(report.candidateFiles, []);
    assert.deepEqual(report.violations, [], formatAuditReport(report));
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

  test("distinguishes erased type-only loads from runtime module edges", () => {
    const source = ts.createSourceFile(
      "fixture.ts",
      [
        'import type { Contract } from "./contract.ts";',
        'export type { Result } from "./result.ts";',
        'type Deferred = import("./deferred.ts").Deferred;',
        'import type Legacy = require("./legacy.ts");',
        'import { type MenuSurface, openMenu } from "./menu.ts";',
      ].join("\n"),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );

    assert.deepEqual(
      collectModuleLoads(source).map((load) => [
        load.kind,
        load.specifier,
        load.typeOnly,
      ]),
      [
        ["static", "./contract.ts", true],
        ["re-export", "./result.ts", true],
        ["type-import", "./deferred.ts", true],
        ["require", "./legacy.ts", true],
        ["static", "./menu.ts", false],
      ],
    );
  });

  test("does not add stylesheet imports to the TypeScript closure", () => {
    const report = auditProductionClosure();
    assert.ok(!report.productionFiles.includes("enterprise/apps/web/src/styles.css"));
  });
});
