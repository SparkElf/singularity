import { describe, expect, it } from "vitest";
import { auditRegistryMigrationSource } from "../../../../scripts/protyle-browser-source-audit.mjs";

const coreMigrationFile = "app/src/protyle/util/editorCommonEvent.ts";
const hostMigrationFile = "app/src/host/protyle.ts";

const ruleIds = (file, sourceText) => auditRegistryMigrationSource({ file, sourceText })
  .map((violation) => violation.ruleId);

describe("Protyle Registry source boundary", () => {
  it.each([
    [coreMigrationFile, 'import { getAllEditor } from "../../layout/getAll";'],
    [coreMigrationFile, 'import("../../layout/getAll");'],
    [hostMigrationFile, 'import editors = require("../layout/getAll");'],
    [coreMigrationFile, 'export { getAllEditor } from "../../layout/getAll";'],
    [coreMigrationFile, 'export * from "../../layout/getAll";'],
    [coreMigrationFile, 'type Editors = import("../../layout/getAll").TAllEditor;'],
    [hostMigrationFile, 'require("../layout/getAll");'],
  ])("rejects legacy editor modules across TypeScript load forms", (file, sourceText) => {
    expect(ruleIds(file, sourceText)).toContain("legacy-editor-module");
  });

  it("rejects non-literal module loads that cannot be audited", () => {
    expect(ruleIds(coreMigrationFile, "import(modulePath);")).toContain("legacy-editor-module-unauditable");
  });

  it.each([
    "window.siyuan.blockPanels;",
    'window.siyuan["blockPanels"];',
    "window.siyuan?.blockPanels;",
    "const { blockPanels } = window.siyuan;",
    "const { blockPanels: panels } = window.siyuan;",
    'const { ["blockPanels"]: panels } = window.siyuan;',
    "let panels; ({ blockPanels: panels } = window.siyuan);",
    "const blockPanels = []; ({ blockPanels });",
  ])("rejects static blockPanels access and destructuring", (sourceText) => {
    expect(ruleIds(coreMigrationFile, sourceText)).toContain("legacy-editor-collection");
  });

  it("allows unrelated imports and B4-owned blockPanels access", () => {
    expect(ruleIds(coreMigrationFile, 'import { resize } from "../ui/resize";')).toEqual([]);
    expect(ruleIds("app/src/protyle/ui/hideElements.ts", "window.siyuan.blockPanels;")).toEqual([]);
  });
});
