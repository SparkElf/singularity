import {describe, it} from "node:test";
import * as assert from "node:assert/strict";
import {
    createSiyuanClipboardHTML,
    encodeBase64,
    getTextSiyuanFromTextHTML,
} from "../../src/protyle/util/clipboard";
import {isSameProtyleContentScope} from "../../src/protyle/runtime/contentScope";

describe("Protyle clipboard identity", () => {
    it("binds internal BlockDOM to its complete source identity", () => {
        const siyuanHTML = '<div data-node-id="20260719000000-block01">知识</div>';
        const visibleHTML = "<p>知识</p>";
        const html = createSiyuanClipboardHTML(siyuanHTML, {
            spaceId: "3d0f70b8-d73d-4e7c-862e-a3529cbf7861",
            notebookId: "20260719000000-box0001",
            documentId: "20260719000000-doc0001",
        }, visibleHTML);

        assert.deepEqual(getTextSiyuanFromTextHTML(html), {
            sourceIdentity: {
                spaceId: "3d0f70b8-d73d-4e7c-862e-a3529cbf7861",
                notebookId: "20260719000000-box0001",
                documentId: "20260719000000-doc0001",
            },
            textSiyuan: siyuanHTML,
            textHtml: visibleHTML,
        });
    });

    it("does not expose an invalid external comment as internal BlockDOM", () => {
        const encoded = encodeBase64(JSON.stringify({
            version: 1,
            source: {spaceId: "", notebookId: "box", documentId: "doc"},
            siyuanHTML: '<div data-node-id="forged">forged</div>',
        }));
        const html = `<!--data-siyuan='${encoded}'--><p>external</p>`;

        assert.deepEqual(getTextSiyuanFromTextHTML(html), {
            textSiyuan: "",
            textHtml: html,
        });
    });

    it("preserves an upstream local application scope without inventing a spaceId", () => {
        const siyuanHTML = '<div data-node-id="20260719000000-block02">local</div>';
        const html = createSiyuanClipboardHTML(siyuanHTML, {
            localAppId: "local-app",
            notebookId: "20260719000000-box0002",
            documentId: "20260719000000-doc0002",
        }, "<p>local</p>");

        assert.deepEqual(getTextSiyuanFromTextHTML(html).sourceIdentity, {
            localAppId: "local-app",
            notebookId: "20260719000000-box0002",
            documentId: "20260719000000-doc0002",
        });
    });

    it("matches cut identity only inside the same discriminated scope", () => {
        const identity = {documentId: "document-a", notebookId: "notebook-a"};

        assert.equal(isSameProtyleContentScope(
            {...identity, localAppId: "local-a"},
            {...identity, localAppId: "local-a"},
        ), true);
        assert.equal(isSameProtyleContentScope(
            {...identity, localAppId: "local-a"},
            {...identity, localAppId: "local-b"},
        ), false);
        assert.equal(isSameProtyleContentScope(
            {...identity, localAppId: "local-a"},
            {...identity, spaceId: "space-a"},
        ), false);
    });
});
