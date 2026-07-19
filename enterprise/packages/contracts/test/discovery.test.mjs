import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  documentDiscoveryBacklinksDataSchema,
  documentDiscoveryGraphDataSchema,
  documentDiscoveryHistoryDataSchema,
  documentDiscoveryOutlineDataSchema,
  spaceDiscoveryQuerySchema,
  spaceDiscoverySearchResponseSchema,
} from "../dist/index.js";

const notebookId = "20260719150000-noteb01";
const documentId = "20260719150001-docum01";
const blockId = "20260719150002-block01";

describe("document discovery payload contracts", () => {
  test("accepts source-derived content identities and non-navigable tag nodes", () => {
    const graph = {
      links: [{ from: blockId, to: "knowledge/tag" }],
      nodes: [
        {
          documentId,
          id: blockId,
          label: "Knowledge",
          notebookId,
        },
        {
          documentId: null,
          id: "knowledge/tag",
          label: "knowledge/tag",
          notebookId: null,
        },
      ],
    };

    assert.deepEqual(documentDiscoveryGraphDataSchema.parse(graph), graph);
    assert.equal(
      documentDiscoveryGraphDataSchema.safeParse({
        ...graph,
        nodes: [{ ...graph.nodes[0], notebookId: null }],
      }).success,
      false,
    );
    assert.equal(
      documentDiscoveryGraphDataSchema.safeParse({
        ...graph,
        links: [{ from: blockId, to: "missing/tag" }],
      }).success,
      false,
    );
  });

  test("rejects legacy response aliases at the raw Kernel boundary", () => {
    assert.equal(
      spaceDiscoverySearchResponseSchema.safeParse({
        blocks: [
          {
            box: notebookId,
            content: "Alpha",
            id: blockId,
            rootID: documentId,
          },
        ],
        matchedBlockCount: 1,
        pageCount: 1,
      }).success,
      false,
    );
    assert.equal(
      documentDiscoveryBacklinksDataSchema.safeParse({
        backlinks: [{ box: notebookId, id: documentId, title: "Alpha" }],
        backmentions: [],
      }).success,
      false,
    );
  });

  test("keeps history scoped data free of document or path aliases", () => {
    const history = {
      histories: ["2026-07-19 15:00:00"],
      pageCount: 1,
      totalCount: 1,
    };
    assert.deepEqual(documentDiscoveryHistoryDataSchema.parse(history), history);
    assert.equal(
      documentDiscoveryHistoryDataSchema.safeParse({
        ...history,
        documentId,
      }).success,
      false,
    );
  });

  test("keeps recursive outlines canonical and rejects legacy path aliases", () => {
    const outline = [{
      children: [{ children: [], id: blockId, name: "Nested heading" }],
      id: documentId,
      name: "Document heading",
    }];

    assert.deepEqual(documentDiscoveryOutlineDataSchema.parse(outline), outline);
    assert.equal(
      documentDiscoveryOutlineDataSchema.safeParse([{
        ...outline[0],
        hPath: "/Document heading",
      }]).success,
      false,
    );
    assert.equal(
      documentDiscoveryOutlineDataSchema.safeParse([{
        id: documentId,
        name: "Document heading",
      }]).success,
      false,
    );
  });

  test("counts discovery limits in Unicode code points", () => {
    assert.equal(
      spaceDiscoveryQuerySchema.safeParse("😀".repeat(512)).success,
      true,
    );
    assert.equal(
      spaceDiscoveryQuerySchema.safeParse("😀".repeat(513)).success,
      false,
    );

    const response = {
      blocks: [{
        content: "😀".repeat(4096),
        documentId,
        id: blockId,
        notebookId,
      }],
      matchedBlockCount: 1,
      pageCount: 1,
    };
    assert.equal(spaceDiscoverySearchResponseSchema.safeParse(response).success, true);
    assert.equal(
      spaceDiscoverySearchResponseSchema.safeParse({
        ...response,
        blocks: [{ ...response.blocks[0], content: "😀".repeat(4097) }],
      }).success,
      false,
    );
  });
});
