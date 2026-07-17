import {describe, it} from "node:test";
import * as assert from "node:assert/strict";
import {PopoverCaptureState} from "../../src/block/popoverCapture";

const target = (attributes: Record<string, string> = {}, isConnected = true) => ({
    isConnected,
    hasAttribute: (name: string) => Object.prototype.hasOwnProperty.call(attributes, name),
    getAttribute: (name: string) => attributes[name] ?? null,
}) as unknown as HTMLElement;

describe("popover modifier capture", () => {
    it("uses the target's explicit notebook instead of its editor content owner", () => {
        const attributes = {"data-notebook-id": "target-notebook"};
        const element = target(attributes);
        const state = new PopoverCaptureState();
        const capture = state.capture(element, "editor-notebook");

        assert.deepEqual(capture, {target: element, notebookId: "target-notebook"});
        attributes["data-notebook-id"] = "changed-after-capture";
        assert.equal(state.get(element), capture);
        assert.equal(state.get(element)?.notebookId, "target-notebook");
    });

    it("uses the editor content owner only when the target has no explicit notebook attribute", () => {
        const state = new PopoverCaptureState();
        const inherited = target();

        assert.deepEqual(state.capture(inherited, "editor-notebook"), {
            target: inherited,
            notebookId: "editor-notebook",
        });

        const explicitlyUnbound = target({"data-notebook-id": ""});
        assert.equal(state.capture(explicitlyUnbound, "editor-notebook"), undefined);
        assert.equal(state.get(), undefined);
    });

    it("keeps the target and notebook from one capture together for modifier replay", () => {
        const first = target();
        const second = target({"data-notebook-id": "target-notebook"});
        const state = new PopoverCaptureState();
        state.capture(first, "first-editor");
        const current = state.capture(second, "second-editor");

        assert.equal(state.get(first), undefined);
        assert.equal(state.get(second), current);
        assert.deepEqual(current, {target: second, notebookId: "target-notebook"});
    });

    it("rejects detached and explicitly cleared targets before modifier replay", () => {
        const element = target({}, false);
        const state = new PopoverCaptureState();

        assert.equal(state.capture(element, "notebook-a"), undefined);
        assert.equal(state.get(element), undefined);

        const connected = target();
        state.capture(connected, "notebook-a");
        (connected as unknown as { isConnected: boolean }).isConnected = false;
        assert.equal(state.get(connected), undefined);

        const replacement = target();
        state.capture(replacement, "notebook-a");
        state.clear();

        assert.equal(state.get(replacement), undefined);
    });
});
