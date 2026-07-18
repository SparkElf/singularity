import { describe, expect, it } from "vitest";

import { createProtyleApplicationPort } from "./protyle-application-port.ts";

function createStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  };
}

describe("createProtyleApplicationPort", () => {
  it("persists display state under the authorized space and keys positions by content identity", async () => {
    const storage = createStorage();
    const identity = {
      documentId: "20260718000100-docum01",
      notebookId: "20260718000000-noteb01",
    };
    const application = createProtyleApplicationPort({
      spaceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      storage,
    });
    const position = { rootId: identity.documentId, scrollTop: 120 };

    application.settings.editor.setFontSize(18);
    application.settings.localFilePosition.set(identity, position);
    await application.settings.recentEmojis.add("1f600");
    await application.settings.editor.persist();

    const restored = createProtyleApplicationPort({
      spaceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      storage,
    });
    const otherNotebook = createProtyleApplicationPort({
      spaceId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      storage,
    });

    expect(restored.settings.editor.fontSize).toBe(18);
    expect(restored.settings.features).toEqual({
      aiActions: false,
      aiWriting: false,
      assetRename: false,
      blockAttributes: false,
      blockMove: false,
      blockRefTransfer: false,
      cloudAssetUpload: false,
      communityShare: false,
      documentDelete: false,
      documentExport: false,
      documentMove: false,
      flashcardDeck: false,
      fullscreen: false,
      quickFlashcard: false,
      tableMenu: false,
      webBlockLink: false,
      wechatReminder: false,
      widget: false,
    });
    expect(restored.settings.hotkeys.editor.general.insertRight).toBe("⌥.");
    expect(restored.settings.icons.file).toBe("1f4c4");
    expect(restored.settings.localFilePosition.get(identity)).toEqual(position);
    expect(restored.settings.navigation.openFilesUseCurrentTab).toBe(false);
    expect(restored.settings.recentEmojis.values).toEqual(["1f600"]);
    expect(restored.localization.text("uploading")).toBe("上传中...");
    expect(otherNotebook.settings.localFilePosition.get(identity)).toBeUndefined();
    expect(otherNotebook.settings.recentEmojis.values).toEqual([]);
    expect(Object.keys(restored).sort()).toEqual(["localization", "settings"]);
  });
});
