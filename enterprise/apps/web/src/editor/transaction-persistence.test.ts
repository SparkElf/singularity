import { describe, expect, it } from "vitest";

import { persistTransactionOperations } from "../../../../../app/src/protyle/wysiwyg/transactionPersistence.ts";

interface TestOperation {
  readonly action: string;
  data?: string;
  readonly id: string;
  retData?: string | string[];
}

describe("Protyle transaction persistence", () => {
  it("sanitizes do data and undo string retData with minimal copies", () => {
    const assetPath = "assets/persisted.png";
    const gatewaySource = "/api/v1/spaces/example/assets/persisted.png";
    const displayHTML = `<div class="p protyle-wysiwyg--hl"><span class="img"><img data-src="${assetPath}" src="${gatewaySource}"></span></div>`;
    const unchangedOperation: TestOperation = { action: "delete", id: "unchanged" };
    const doOperation: TestOperation = { action: "update", data: displayHTML, id: "do" };
    const undoOperation: TestOperation = { action: "unfoldHeading", id: "undo", retData: displayHTML };
    const doOperations: TestOperation[] = [unchangedOperation, doOperation];
    const undoOperations: TestOperation[] = [unchangedOperation, undoOperation];

    const persistedDo = persistTransactionOperations(doOperations)!;
    const persistedUndo = persistTransactionOperations(undoOperations)!;
    const persistedDoOperation = persistedDo[1]!;
    const persistedUndoOperation = persistedUndo[1]!;

    expect(persistedDo).not.toBe(doOperations);
    expect(persistedUndo).not.toBe(undoOperations);
    expect(persistedDo[0]).toBe(unchangedOperation);
    expect(persistedUndo[0]).toBe(unchangedOperation);
    expect(persistedDoOperation).not.toBe(doOperation);
    expect(persistedUndoOperation).not.toBe(undoOperation);
    expect(persistedDoOperation.data).toContain(`src="${assetPath}"`);
    expect(persistedUndoOperation.retData).toContain(`src="${assetPath}"`);
    expect(persistedDoOperation.data).not.toContain(gatewaySource);
    expect(persistedUndoOperation.retData).not.toContain(gatewaySource);
    expect(persistedDoOperation.data).not.toContain("protyle-wysiwyg--hl");
    expect(persistedUndoOperation.retData).not.toContain("protyle-wysiwyg--hl");
    expect(doOperation.data).toBe(displayHTML);
    expect(undoOperation.retData).toBe(displayHTML);
  });

  it("reuses the array and operation when persistent fields do not change", () => {
    const operation: TestOperation = {
      action: "update",
      data: '<span class="img"><img data-src="assets/a.png" src="assets/a.png"></span>',
      id: "same",
      retData: ["non-string-ret-data"],
    };
    const operations = [operation];

    const persisted = persistTransactionOperations(operations)!;

    expect(persisted).toBe(operations);
    expect(persisted[0]!).toBe(operation);
  });
});
