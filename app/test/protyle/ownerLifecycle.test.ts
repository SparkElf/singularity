import {describe, it} from "node:test";
import * as assert from "node:assert/strict";
import {OwnerLifecycle} from "../../src/protyle/runtime/ownerLifecycle";

describe("Owner lifecycle", () => {
    it("aborts the previous generation and rejects stale or unmounted work", () => {
        const lifecycle = new OwnerLifecycle();
        const first = lifecycle.begin();

        assert.equal(lifecycle.isCurrent(first, true), true);
        assert.equal(lifecycle.isCurrent(first, false), false);

        const second = lifecycle.begin();

        assert.equal(first.signal.aborted, true);
        assert.equal(lifecycle.isCurrent(first, true), false);
        assert.equal(lifecycle.isCurrent(second, true), true);
    });

    it("runs terminal cleanup once and cannot restart after idempotent destroy", () => {
        const lifecycle = new OwnerLifecycle();
        const current = lifecycle.begin();
        let cleanupCount = 0;
        lifecycle.addCleanup(() => cleanupCount++);

        lifecycle.destroy();
        lifecycle.destroy();

        assert.equal(cleanupCount, 1);
        assert.equal(lifecycle.signal.aborted, true);
        assert.equal(current.signal.aborted, true);
        assert.equal(lifecycle.isCurrent(current, true), false);
        assert.throws(() => lifecycle.begin(), /terminated owner cannot begin work/);
    });
});
