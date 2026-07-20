import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  contentDirectoryDocumentSchema,
  contentDirectoryNotebookSchema,
} from "../dist/index.js";

const notebookId = "20260720130000-dirnote";
const documentId = "20260720130001-dirdocu";

describe("content directory payload contracts", () => {
  test("requires notebook-owned graph capability without copying it to documents", () => {
    const notebook = {
      icon: "",
      locked: true,
      name: "Encrypted notebook",
      notebookId,
      supportsGraph: false,
    };
    assert.deepEqual(contentDirectoryNotebookSchema.parse(notebook), notebook);
    assert.equal(
      contentDirectoryNotebookSchema.safeParse({
        icon: "",
        locked: false,
        name: "Ordinary notebook",
        notebookId,
      }).success,
      false,
    );

    const document = {
      documentId,
      hasChildren: false,
      icon: "",
      notebookId,
      title: "Document",
    };
    assert.deepEqual(contentDirectoryDocumentSchema.parse(document), document);
    assert.equal(
      contentDirectoryDocumentSchema.safeParse({
        ...document,
        supportsGraph: false,
      }).success,
      false,
    );
  });
});
