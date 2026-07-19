import {describe, it} from "node:test";
import * as assert from "node:assert/strict";
import {
    buildSiYuanBlockUri,
    parseSiYuanBlockUri,
} from "../../src/protyle/util/blockUri";

describe("SiYuan block URI", () => {
    it("round-trips the target block and complete content identity", () => {
        const uri = buildSiYuanBlockUri(
            "20260716010101-abcdefg",
            "20260716020202-a/b cde",
            "20260716030303-d/e fgh",
        );

        assert.equal(uri, "siyuan://blocks/20260716010101-abcdefg?notebook=20260716020202-a%2Fb%20cde&document=20260716030303-d%2Fe%20fgh");
        assert.deepEqual(parseSiYuanBlockUri(uri), {
            blockId: "20260716010101-abcdefg",
            documentId: "20260716030303-d/e fgh",
            notebookId: "20260716020202-a/b cde",
        });
    });

    it("rejects identity-free and legacy partial links", () => {
        assert.throws(
            () => buildSiYuanBlockUri("20260716010101-abcdefg", "20260716020202-box0001", ""),
            /requires block, notebook, and document identity/,
        );
        assert.equal(
            parseSiYuanBlockUri("siyuan://blocks/20260716010101-abcdefg?notebook=20260716020202-box0001"),
            undefined,
        );
    });
});
