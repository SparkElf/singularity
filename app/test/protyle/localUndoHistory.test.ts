import {describe, it} from "node:test";
import * as assert from "node:assert/strict";
import {LocalUndoHistory} from "../../src/protyle/undo/history";

describe("LocalUndo history", () => {
    it("preserves operation order and clears redo after a new add", () => {
        const history = new LocalUndoHistory(3);
        history.add([
            {action: "insert", id: "do-first"},
            {action: "update", id: "do-second"},
        ], [
            {action: "update", id: "undo-first"},
            {action: "delete", id: "undo-second"},
        ]);

        assert.equal(history.undo((operations) => {
            assert.deepEqual(operations.undoOperations.map((operation) => operation.id), ["undo-first", "undo-second"]);
        }), true);
        assert.equal(history.redo((operations) => {
            assert.deepEqual(operations.doOperations.map((operation) => operation.id), ["do-first", "do-second"]);
        }), true);
        assert.equal(history.undo(() => undefined), true);

        history.add([{action: "insert", id: "branched"}], [{action: "delete", id: "branched"}]);

        assert.equal(history.canRedo, false);
        assert.equal(history.redo(() => assert.fail("redo branch must be cleared")), false);

        history.clear();

        assert.equal(history.canUndo, false);
        assert.equal(history.canRedo, false);
        assert.equal(history.undo(() => assert.fail("cleared undo history must stay empty")), false);
    });

    it("keeps only the configured number of undo entries", () => {
        const history = new LocalUndoHistory(2);
        history.add([{action: "insert", id: "first"}], [{action: "delete", id: "first"}]);
        history.add([{action: "insert", id: "second"}], [{action: "delete", id: "second"}]);
        history.add([{action: "insert", id: "third"}], [{action: "delete", id: "third"}]);
        const undone: string[] = [];

        assert.equal(history.undo((operations) => undone.push(operations.doOperations[0].id)), true);
        assert.equal(history.undo((operations) => undone.push(operations.doOperations[0].id)), true);
        assert.equal(history.undo(() => assert.fail("oldest entry must be evicted")), false);
        assert.deepEqual(undone, ["third", "second"]);
    });
});
