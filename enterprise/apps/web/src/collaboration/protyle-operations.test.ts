import { describe, expect, it } from "vitest";

import {
  collaborationBroadcastToProtyleMessage,
  mapProtyleOperation,
} from "@/collaboration/protyle-operations.ts";

const identity = {
  documentId: "20260722090000-docabcd",
  notebookId: "20260722090001-bookabc",
  organizationId: "11111111-1111-4111-8111-111111111111",
  spaceId: "22222222-2222-4222-8222-222222222222",
};

describe("Protyle collaboration semantic mapper", () => {
  it("maps a plain text update to the minimal changed range", () => {
    expect(mapProtyleOperation({
      action: "update",
      context: { collaborationPreviousHTML: "<div data-type=\"NodeParagraph\"><div contenteditable=\"true\">aoldb</div></div>" },
      data: "<div data-type=\"NodeParagraph\"><div contenteditable=\"true\">anewb</div></div>",
      id: "20260722090002-block01",
    })).toEqual([
      {
        blockId: "20260722090002-block01",
        from: 1,
        kind: "text.delete",
        to: 4,
      },
      {
        blockId: "20260722090002-block01",
        kind: "text.insert",
        position: 1,
        text: "new",
      },
    ]);
  });

  it("rejects rich text instead of guessing a semantic operation", () => {
    expect(mapProtyleOperation({
      action: "update",
      context: { collaborationPreviousHTML: "<div data-type=\"NodeParagraph\"><div contenteditable=\"true\">old</div></div>" },
      data: "<div data-type=\"NodeParagraph\"><div contenteditable=\"true\"><strong>new</strong></div></div>",
      id: "20260722090002-block01",
    })).toBeNull();
  });

  it("requires the transaction supplied collaboration index for block insertion", () => {
    expect(mapProtyleOperation({
      action: "insert",
      context: { collaborationIndex: "2" },
      data: "<div data-type=\"NodeParagraph\"><div contenteditable=\"true\">hello</div></div>",
      id: "20260722090002-block01",
      parentID: "20260722090000-parent01",
    })).toEqual([
      {
        blockId: "20260722090002-block01",
        blockType: "paragraph",
        content: "hello",
        index: 2,
        kind: "block.insert",
        parentBlockId: "20260722090000-parent01",
      },
    ]);
    expect(mapProtyleOperation({
      action: "insert",
      data: "<div data-type=\"NodeParagraph\"><div contenteditable=\"true\">hello</div></div>",
      id: "20260722090002-block01",
    })).toBeNull();
  });

  it("maps a block reference change from explicit DOM target identity", () => {
    expect(mapProtyleOperation({
      action: "update",
      context: {
        collaborationPreviousHTML: "<div data-type=\"NodeParagraph\"><div contenteditable=\"true\"><span data-type=\"block-ref\" data-id=\"20260722090003-oldref1\" data-notebook-id=\"20260722090001-bookabc\" data-document-id=\"20260722090004-olddoc1\">old</span></div></div>",
      },
      data: "<div data-type=\"NodeParagraph\"><div contenteditable=\"true\"><span data-type=\"block-ref\" data-id=\"20260722090005-newref1\" data-notebook-id=\"20260722090001-bookabc\" data-document-id=\"20260722090006-newdoc1\">new</span></div></div>",
      id: "20260722090002-block01",
    })).toEqual([{
      blockId: "20260722090002-block01",
      kind: "reference.update",
      target: {
        blockId: "20260722090005-newref1",
        documentId: "20260722090006-newdoc1",
        notebookId: "20260722090001-bookabc",
      },
    }]);
  });

  it("maps embed conversion only when the transaction carries explicit target identity", () => {
    expect(mapProtyleOperation({
      action: "update",
      context: {
        collaborationPreviousHTML: "<div data-type=\"NodeParagraph\"><div contenteditable=\"true\"><span data-type=\"block-ref\" data-id=\"20260722090003-oldref1\" data-notebook-id=\"20260722090001-bookabc\" data-document-id=\"20260722090004-olddoc1\">old</span></div></div>",
        collaborationTargetBlockID: "20260722090005-newref1",
        collaborationTargetDocumentID: "20260722090006-newdoc1",
        collaborationTargetNotebookID: "20260722090001-bookabc",
      },
      data: "<div data-content=\"select * from blocks\" data-node-id=\"20260722090002-block01\" data-type=\"NodeBlockQueryEmbed\"></div>",
      id: "20260722090002-block01",
    })).toEqual([{
      blockId: "20260722090002-block01",
      embedType: "block-query",
      kind: "embed.update",
      target: {
        blockId: "20260722090005-newref1",
        documentId: "20260722090006-newdoc1",
        notebookId: "20260722090001-bookabc",
      },
    }]);
    expect(mapProtyleOperation({
      action: "update",
      context: { collaborationPreviousHTML: "<div data-type=\"NodeBlockQueryEmbed\"></div>" },
      data: "<div data-type=\"NodeBlockQueryEmbed\"></div>",
      id: "20260722090002-block01",
    })).toBeNull();
  });

  it("keeps the Kernel attribute-view cell value shape instead of flattening it", () => {
    expect(mapProtyleOperation({
      action: "updateAttrViewCell",
      avID: "20260722090007-avview1",
      data: { text: { content: "updated" }, type: "text" },
      id: "20260722090008-cell01",
      keyID: "20260722090009-column1",
      rowID: "20260722090010-row0001",
    })).toEqual([{
      attributeViewId: "20260722090007-avview1",
      columnId: "20260722090009-column1",
      kind: "attribute-view.cell-set",
      rowId: "20260722090010-row0001",
      value: { text: { content: "updated" }, type: "text" },
    }]);
  });

  it("rejects a broadcast whose four-part identity is not the bound document", () => {
    expect(() => collaborationBroadcastToProtyleMessage(identity, {
      identity,
      operation: {
        causalContext: {},
        clientId: "33333333-3333-4333-8333-333333333333",
        clientSequence: 1,
        identity: { ...identity, documentId: "20260722090003-other01" },
        operation: { blockId: "20260722090002-block01", kind: "block.delete" },
        operationId: "44444444-4444-4444-8444-444444444444",
        sessionGeneration: 1,
      },
      serverSequence: 1,
    })).toThrow("identity does not match");
  });

  it("maps a valid broadcast to an explicit semantic Protyle message", () => {
    expect(collaborationBroadcastToProtyleMessage(identity, {
      identity,
      operation: {
        causalContext: {},
        clientId: "55555555-5555-4555-8555-555555555555",
        clientSequence: 1,
        identity,
        operation: {blockId: "20260722090002-block01", kind: "block.delete"},
        operationId: "44444444-4444-4444-8444-444444444444",
        sessionGeneration: 1,
      },
      serverSequence: 7,
    })).toEqual({
      cmd: "collaboration-operation",
      data: {
        identity,
        operation: {blockId: "20260722090002-block01", kind: "block.delete"},
        operationId: "44444444-4444-4444-8444-444444444444",
        serverSequence: 7,
      },
      sid: "collaboration:55555555-5555-4555-8555-555555555555",
    });
  });
});
