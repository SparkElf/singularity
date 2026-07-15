import assert from "node:assert/strict";
import { mock, test } from "node:test";

import { resolveAgentBlockMentions } from "../../src/host/agentMentions";

test("agent mentions preserve block order and omit empty identities", async () => {
    const loadReferenceText = mock.fn(async (blockId: string) => ({
        code: 0,
        data: `title:${blockId}`,
        msg: "",
    }));

    await assert.doesNotReject(async () => {
        assert.deepEqual(
            await resolveAgentBlockMentions(["block-b", "", "block-a"], loadReferenceText),
            [
                { id: "block-b", label: "title:block-b" },
                { id: "block-a", label: "title:block-a" },
            ],
        );
    });
    assert.deepEqual(loadReferenceText.mock.calls.map((call) => call.arguments[0]), ["block-b", "block-a"]);
});

test("agent mentions reject the complete batch without an identity fallback", async () => {
    const loadReferenceText = mock.fn(async (blockId: string) => blockId === "block-b"
        ? { code: 1, data: "", msg: "reference unavailable" }
        : { code: 0, data: "Title A", msg: "" });

    await assert.rejects(
        resolveAgentBlockMentions(["block-a", "block-b"], loadReferenceText),
        /reference unavailable/,
    );
    assert.equal(loadReferenceText.mock.callCount(), 2);
});

test("agent mentions reject successful responses without a non-empty reference title", async () => {
    for (const data of [undefined, "", 42]) {
        await assert.rejects(
            resolveAgentBlockMentions(["block-a"], async () => ({code: 0, data, msg: ""})),
            Error,
        );
    }
});
