import {describe, it} from "node:test";
import * as assert from "node:assert/strict";
import {ConfirmDialogLifecycle} from "../../src/dialog/confirmDialogLifecycle";

describe("confirm dialog lifecycle", () => {
    it("settles an external dismissal as cancel exactly once", () => {
        const decisions: string[] = [];
        const lifecycle = new ConfirmDialogLifecycle<string>(
            context => decisions.push(`confirm:${context}`),
            context => decisions.push(`cancel:${context}`),
        );

        assert.equal(lifecycle.cancel("scrim"), true);
        assert.equal(lifecycle.cancel("close-icon"), false);
        assert.equal(lifecycle.confirm("button"), false);
        assert.deepEqual(decisions, ["cancel:scrim"]);
    });

    it("does not turn a confirmed decision into cancel during dialog destruction", () => {
        const decisions: string[] = [];
        const lifecycle = new ConfirmDialogLifecycle<string>(
            context => decisions.push(`confirm:${context}`),
            context => decisions.push(`cancel:${context}`),
        );

        assert.equal(lifecycle.confirm("button"), true);
        assert.equal(lifecycle.cancel("destroy"), false);
        assert.deepEqual(decisions, ["confirm:button"]);
    });
});
