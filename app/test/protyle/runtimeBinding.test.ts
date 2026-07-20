import {describe, it} from "node:test";
import * as assert from "node:assert/strict";
import {resolveProtyleRuntimeBinding} from "../../src/protyle/runtime/binding";

describe("Protyle Runtime binding", () => {
    it("uses the Runtime owned by an enterprise Session", () => {
        const runtime = {name: "enterprise"};
        const session = {runtime};

        assert.deepEqual(resolveProtyleRuntimeBinding({session}), {runtime, session});
    });

    it("uses an explicit upstream local Runtime without creating a Session", () => {
        const upstreamLocalRuntime = {localAppId: "local-app"};

        assert.deepEqual(resolveProtyleRuntimeBinding({upstreamLocalRuntime}), {
            runtime: upstreamLocalRuntime,
            session: undefined,
        });
    });

    it("rejects a missing binding instead of falling back to local capabilities", () => {
        assert.throws(
            // @ts-expect-error Exercises the JavaScript construction boundary.
            () => resolveProtyleRuntimeBinding({}),
            /Core requires an explicit Session or upstream local Runtime/,
        );
    });
});
