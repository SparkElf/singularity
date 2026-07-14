import {describe, it} from "node:test";
import * as assert from "node:assert/strict";
import {
    canChangeDocumentReadOnly,
    canWriteProtyleContent,
    createProtyleReadOnlyState,
    isProtyleReadOnly,
    setDocumentReadOnlyAttribute,
    setDocumentReadOnlyFromResponse,
    setHostReadOnly,
} from "./readOnly";

describe("Protyle read-only policy", () => {
    it("keeps host and document sources independent", () => {
        const state = createProtyleReadOnlyState(false);

        setDocumentReadOnlyFromResponse(state, true);
        assert.equal(isProtyleReadOnly(state), true);
        assert.equal(canWriteProtyleContent(state), false);

        setHostReadOnly(state, true);
        setDocumentReadOnlyFromResponse(state, false);
        assert.equal(isProtyleReadOnly(state), true);

        setHostReadOnly(state, false);
        assert.equal(isProtyleReadOnly(state), false);
        assert.equal(canWriteProtyleContent(state), true);
    });

    it("does not start a document attribute request while the host is read-only", async () => {
        const state = createProtyleReadOnlyState(true);
        setDocumentReadOnlyFromResponse(state, true);
        let requested = false;

        const changed = await setDocumentReadOnlyAttribute(state, false, async () => {
            requested = true;
            return false;
        });

        assert.equal(changed, false);
        assert.equal(requested, false);
        assert.equal(state.document, true);
        assert.equal(isProtyleReadOnly(state), true);
    });

    it("keeps the document locked until a pending unlock succeeds", async () => {
        const state = createProtyleReadOnlyState(false);
        setDocumentReadOnlyFromResponse(state, true);
        let resolveRequest: (readOnly: boolean) => void;
        const request = new Promise<boolean>((resolve) => {
            resolveRequest = resolve;
        });

        const result = setDocumentReadOnlyAttribute(state, false, () => request);

        assert.equal(state.documentUpdatePending, true);
        assert.equal(canChangeDocumentReadOnly(state), false);
        assert.equal(isProtyleReadOnly(state), true);

        resolveRequest(false);
        assert.equal(await result, true);
        assert.equal(state.documentUpdatePending, false);
        assert.equal(isProtyleReadOnly(state), false);
    });

    it("preserves the document source after a failed unlock", async () => {
        const state = createProtyleReadOnlyState(false);
        setDocumentReadOnlyFromResponse(state, true);
        const failure = new Error("attribute update failed");

        await assert.rejects(
            setDocumentReadOnlyAttribute(state, false, async () => {
                throw failure;
            }),
            failure,
        );

        assert.equal(state.documentUpdatePending, false);
        assert.equal(state.document, true);
        assert.equal(isProtyleReadOnly(state), true);
    });

    it("reapplies a host constraint that arrives during a successful unlock", async () => {
        const state = createProtyleReadOnlyState(false);
        setDocumentReadOnlyFromResponse(state, true);

        const changed = await setDocumentReadOnlyAttribute(state, false, async () => {
            setHostReadOnly(state, true);
            return false;
        });

        assert.equal(changed, true);
        assert.equal(state.document, false);
        assert.equal(state.host, true);
        assert.equal(isProtyleReadOnly(state), true);
    });
});
