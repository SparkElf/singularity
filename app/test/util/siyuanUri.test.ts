import {describe, it} from "node:test";
import * as assert from "node:assert/strict";
import {buildSiYuanBlockUri} from "../../src/util/siyuanUri";

describe("SiYuan block URI", () => {
    it("carries the explicit notebook identity", () => {
        assert.equal(
            buildSiYuanBlockUri("20260716010101-abcdefg", "20260716020202-a/b cde"),
            "siyuan://blocks/20260716010101-abcdefg?notebook=20260716020202-a%2Fb%20cde"
        );
    });

    it("rejects identity-free document links", () => {
        assert.throws(
            () => buildSiYuanBlockUri("20260716010101-abcdefg", ""),
            /requires blockId and notebookId/
        );
    });
});
