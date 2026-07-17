import {describe, it} from "node:test";
import * as assert from "node:assert/strict";
import {GlobalUndoState, UndoDocumentIdentity} from "../../src/protyle/undo/globalUndoState";
import {mobileEditorOwner} from "../../src/mobile/util/mobileEditorOwner";

const documentIdentity = (notebookId: string, rootID = "same-root"): UndoDocumentIdentity => ({
    notebookId,
    rootID,
});

describe("global undo state ownership", () => {
    it("isolates same-root mirrors by notebook", () => {
        const state = new GlobalUndoState();
        const first = documentIdentity("notebook-a");
        const second = documentIdentity("notebook-b");

        state.mark(first, {canUndo: true});
        state.mark(second, {canRedo: true});

        assert.deepEqual(state.get(first), {canUndo: true, canRedo: false});
        assert.deepEqual(state.get(second), {canUndo: false, canRedo: true});
    });

    it("accepts only the latest initialization generation for a notebook-root owner", () => {
        const state = new GlobalUndoState();
        const identity = documentIdentity("notebook-a");
        const otherNotebook = documentIdentity("notebook-b");
        const first = state.beginInitialization(identity);
        const other = state.beginInitialization(otherNotebook);
        const second = state.beginInitialization(identity);

        assert.equal(state.applyInitialization(first, {canUndo: true, canRedo: false}), false);
        assert.equal(state.applyInitialization(other, {canUndo: true, canRedo: false}), true);
        assert.equal(state.applyInitialization(second, {canUndo: false, canRedo: true}), true);
        assert.deepEqual(state.get(identity), {canUndo: false, canRedo: true});
        assert.deepEqual(state.get(otherNotebook), {canUndo: true, canRedo: false});
    });

    it("does not let an initialization response overwrite a newer local edit", () => {
        const state = new GlobalUndoState();
        const identity = documentIdentity("notebook-a");
        const initialization = state.beginInitialization(identity);

        state.mark(identity, {canUndo: true});

        assert.equal(state.applyInitialization(initialization, {canUndo: false, canRedo: false}), false);
        assert.deepEqual(state.get(identity), {canUndo: true, canRedo: false});
    });

    it("releases the request lock after undo and redo failures", async () => {
        const state = new GlobalUndoState();
        const identity = documentIdentity("notebook-a");
        const applied: string[] = [];

        await assert.rejects(state.runRequest(identity, async () => {
            throw new Error("undo failed");
        }, () => identity, () => assert.fail("failed undo must not commit")), /undo failed/);
        assert.equal(await state.runRequest(identity, async () => "undo", () => identity,
            value => applied.push(value)), "applied");

        await assert.rejects(state.runRequest(identity, async () => {
            throw new Error("redo failed");
        }, () => identity, () => assert.fail("failed redo must not commit")), /redo failed/);
        assert.equal(await state.runRequest(identity, async () => "redo", () => identity,
            value => applied.push(value)), "applied");
        assert.deepEqual(applied, ["undo", "redo"]);
    });

    it("drops a late response after navigation changes the notebook-root identity", async () => {
        const state = new GlobalUndoState();
        const origin = documentIdentity("notebook-a");
        let current = origin;
        let resolveRequest!: (value: string) => void;
        const response = new Promise<string>((resolve) => {
            resolveRequest = resolve;
        });
        const applied: string[] = [];

        const pending = state.runRequest(origin, () => response, () => current, value => applied.push(value));
        current = documentIdentity("notebook-b");
        resolveRequest("late operations");

        assert.equal(await pending, "stale");
        assert.deepEqual(applied, []);
    });

    it("releases a never-returning request when mobile navigation starts the next owner generation", async () => {
        const state = new GlobalUndoState();
        const identity = documentIdentity("notebook-a");
        const firstNavigation = mobileEditorOwner.begin();
        const detachedResponse = new Promise<string>(() => undefined);
        const applied: string[] = [];

        const detached = state.runRequest(identity, () => detachedResponse, () => identity,
            value => applied.push(value), firstNavigation.signal);
        const secondNavigation = mobileEditorOwner.begin();

        assert.equal(firstNavigation.signal.aborted, true);
        assert.equal(secondNavigation.signal.aborted, false);
        assert.equal(await detached, "cancelled");
        assert.equal(await state.runRequest(identity, async () => "current", () => identity,
            value => applied.push(value), secondNavigation.signal), "applied");
        assert.deepEqual(applied, ["current"]);
    });
});
