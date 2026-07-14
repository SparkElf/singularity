import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { auditRegistryMigrationSource } from "./protyle-browser-source-audit.mjs";

const coreMigrationFile = "app/src/protyle/util/editorCommonEvent.ts";
const hostMigrationFile = "app/src/host/protyle.ts";

function ruleIds(file, sourceText) {
  return auditRegistryMigrationSource({ file, sourceText })
    .map((violation) => violation.ruleId);
}

function assertRejected(file, sourceText, ruleId) {
  assert.ok(
    ruleIds(file, sourceText).includes(ruleId),
    `Expected ${ruleId} for ${file}: ${sourceText}`,
  );
}

describe("Protyle Registry source boundary", () => {
  const forbiddenModuleLoads = [
    ["static import", coreMigrationFile, 'import { getAllEditor } from "../../layout/getAll";'],
    ["dynamic import", coreMigrationFile, 'import("../../layout/getAll");'],
    ["import equals", hostMigrationFile, 'import editors = require("../layout/getAll");'],
    ["named re-export", coreMigrationFile, 'export { getAllEditor } from "../../layout/getAll";'],
    ["wildcard re-export", coreMigrationFile, 'export * from "../../layout/getAll";'],
    ["import type expression", coreMigrationFile, 'type Editors = import("../../layout/getAll").TAllEditor;'],
    ["CommonJS require", hostMigrationFile, 'require("../layout/getAll");'],
  ];

  for (const [loadKind, file, sourceText] of forbiddenModuleLoads) {
    test(`rejects the legacy editor module through ${loadKind}`, () => {
      assertRejected(file, sourceText, "legacy-editor-module");
    });
  }

  test("rejects a non-literal module load that cannot be audited", () => {
    assertRejected(coreMigrationFile, "import(modulePath);", "legacy-editor-module-unauditable");
  });

  const forbiddenCollectionAccesses = [
    ["property access", "window.siyuan.blockPanels;"],
    ["element access", 'window.siyuan["blockPanels"];'],
    ["optional property access", "window.siyuan?.blockPanels;"],
    ["binding shorthand", "const { blockPanels } = window.siyuan;"],
    ["binding alias", "const { blockPanels: panels } = window.siyuan;"],
    ["computed binding", 'const { ["blockPanels"]: panels } = window.siyuan;'],
    ["assignment alias", "let panels; ({ blockPanels: panels } = window.siyuan);"],
    ["assignment shorthand", "const blockPanels = []; ({ blockPanels });"],
  ];

  for (const [accessKind, sourceText] of forbiddenCollectionAccesses) {
    test(`rejects legacy blockPanels ${accessKind}`, () => {
      assertRejected(coreMigrationFile, sourceText, "legacy-editor-collection");
    });
  }

  test("allows an unrelated source import", () => {
    assert.deepEqual(ruleIds(coreMigrationFile, 'import { resize } from "../ui/resize";'), []);
  });

  test("allows blockPanels in the B4-owned source", () => {
    assert.deepEqual(
      ruleIds("app/src/protyle/ui/hideElements.ts", "window.siyuan.blockPanels;"),
      [],
    );
  });
});
