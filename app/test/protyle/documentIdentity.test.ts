import {describe, it} from "node:test";
import * as assert from "node:assert/strict";
import {createProtyleEditorRegistry} from "../../../enterprise/packages/protyle-browser/src/registry";
import {
    forEachProtyleDocumentInstance,
    type ProtyleDocumentInstance,
} from "../../src/protyle/runtime/documentIdentity";

interface TestEditor extends ProtyleDocumentInstance {
    readonly id: string;
}

describe("Protyle document identity", () => {
    it("fans out to every exact notebook and root document match", () => {
        const editors = createProtyleEditorRegistry<TestEditor>();
        const exactA: TestEditor = {
            block: {rootID: "document-a"},
            content: {mode: "bound", notebookId: "notebook-a"},
            id: "exact-a",
        };
        const exactB: TestEditor = {
            block: {rootID: "document-a"},
            content: {mode: "bound", notebookId: "notebook-a"},
            id: "exact-b",
        };
        const otherNotebook: TestEditor = {
            block: {rootID: "document-a"},
            content: {mode: "bound", notebookId: "notebook-b"},
            id: "other-notebook",
        };
        const otherDocument: TestEditor = {
            block: {rootID: "document-b"},
            content: {mode: "bound", notebookId: "notebook-a"},
            id: "other-document",
        };
        [exactA, exactB, otherNotebook, otherDocument].forEach((editor) => editors.register(editor));
        const visited: string[] = [];

        forEachProtyleDocumentInstance(
            editors,
            {documentId: "document-a", notebookId: "notebook-a"},
            (editor) => visited.push(editor.id),
        );

        assert.deepEqual(visited, ["exact-a", "exact-b"]);
    });
});
