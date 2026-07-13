import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

let createAppProtylePluginPort;

function createPlugin(overrides = {}) {
  return {
    commands: [],
    eventBus: { emit: vi.fn(() => true) },
    name: "plugin",
    protyleOptions: undefined,
    protyleSlash: [],
    updateProtyleToolbar: vi.fn((toolbar) => toolbar),
    ...overrides,
  };
}

beforeAll(async () => {
  globalThis.SIYUAN_VERSION = "test";
  globalThis.NODE_ENV = "test";
  ({ createAppProtylePluginPort } = await import(
    "../../../../../app/src/host/plugin.ts"
  ));
});

beforeEach(() => {
  globalThis.window.siyuan = {
    config: {
      keymap: {
        plugin: {},
      },
    },
  };
});

describe("createAppProtylePluginPort", () => {
  it("preserves option and toolbar order, custom hotkeys, and the zero-plugin baseline", () => {
    const customItem = { extra: "preserved", hotkey: "default", name: "custom" };
    const normalizedStrong = { name: "strong" };
    const first = createPlugin({
      name: "first",
      protyleOptions: { extension: { first: true }, render: { title: false } },
      updateProtyleToolbar: vi.fn((toolbar) => [...toolbar, customItem]),
    });
    const second = createPlugin({
      name: "second",
      protyleOptions: { render: { title: true } },
      updateProtyleToolbar: vi.fn((toolbar) => toolbar),
    });
    globalThis.window.siyuan.config.keymap.plugin.first = {
      custom: { custom: "user-hotkey", default: "default" },
    };
    const normalizeToolbar = vi.fn((toolbar) =>
      toolbar.map((item) => (item === "strong" ? normalizedStrong : item)),
    );
    const port = createAppProtylePluginPort({ plugins: [first, second] });

    expect(port.extendOptions({ render: { title: true } })).toEqual({
      extension: { first: true },
      render: { title: true },
    });
    const toolbar = port.extendToolbar(["strong"], normalizeToolbar);

    expect(first.updateProtyleToolbar).toHaveBeenCalledWith(["strong"]);
    expect(second.updateProtyleToolbar).toHaveBeenCalledWith([normalizedStrong, customItem]);
    expect(normalizeToolbar).toHaveBeenCalledTimes(2);
    expect(toolbar).toEqual([normalizedStrong, customItem]);
    expect(customItem).toMatchObject({ extra: "preserved", hotkey: "user-hotkey" });

    const options = { render: { title: true } };
    const baseToolbar = [normalizedStrong];
    const emptyPort = createAppProtylePluginPort({ plugins: [] });
    expect(emptyPort.extendOptions(options)).toBe(options);
    expect(emptyPort.extendToolbar(baseToolbar, normalizeToolbar)).toBe(baseToolbar);
  });

  it("broadcasts the same mutable event detail to every plugin", () => {
    const menu = {
      items: [],
      addItem(item) {
        this.items.push(item);
      },
    };
    const detail = { languages: ["typescript"], menu };
    const first = createPlugin({
      eventBus: {
        emit: vi.fn((_type, received) => {
          expect(received).toBe(detail);
          received.languages.push("rust");
          received.menu.addItem({ id: "first-item" });
          return true;
        }),
      },
      name: "first",
    });
    const second = createPlugin({
      eventBus: {
        emit: vi.fn((_type, received) => {
          expect(received).toBe(detail);
          expect(received.languages).toEqual(["typescript", "rust"]);
          expect(received.menu.items).toEqual([{ id: "first-item" }]);
          return true;
        }),
      },
      name: "second",
    });

    createAppProtylePluginPort({ plugins: [first, second] }).emit({
      type: "code-language-update",
      detail,
    });

    expect(first.eventBus.emit).toHaveBeenCalledOnce();
    expect(second.eventBus.emit).toHaveBeenCalledOnce();
    expect(menu.items).toEqual([{ id: "first-item" }]);
  });

  it("runs only the first matching editor command", () => {
    const firstCommand = vi.fn();
    const secondCommand = vi.fn();
    const first = createPlugin({
      commands: [{ customHotkey: "A", editorCallback: firstCommand }],
      name: "first",
    });
    const second = createPlugin({
      commands: [{ customHotkey: "A", editorCallback: secondCommand }],
      name: "second",
    });
    const port = createAppProtylePluginPort({ plugins: [first, second] });
    const editor = {};
    const event = new globalThis.KeyboardEvent("keydown", { key: "A" });
    const matchesHotkey = (hotkey, keyboardEvent) => hotkey === keyboardEvent.key;

    expect(port.runEditorCommand(editor, event, matchesHotkey)).toBe(true);
    expect(firstCommand).toHaveBeenCalledWith(editor);
    expect(secondCommand).not.toHaveBeenCalled();
    expect(createAppProtylePluginPort({ plugins: [] })
      .runEditorCommand(editor, event, matchesHotkey)).toBe(false);
  });

  it("preserves slash item order and resolves callbacks by plugin identity", () => {
    const firstSlash = {
      callback: vi.fn(),
      extra: { preserved: true },
      filter: ["first"],
      html: "first",
      id: "shared",
    };
    const secondSlash = {
      callback: vi.fn(),
      filter: ["second"],
      html: "second",
      id: "shared",
    };
    const port = createAppProtylePluginPort({
      plugins: [
        createPlugin({ name: "first", protyleSlash: [firstSlash] }),
        createPlugin({ name: "second", protyleSlash: [secondSlash] }),
      ],
    });

    const slashItems = [];
    port.forEachSlashItem((pluginName, item) => slashItems.push({ item, pluginName }));
    expect(slashItems).toEqual([
      { item: firstSlash, pluginName: "first" },
      { item: secondSlash, pluginName: "second" },
    ]);

    const instance = {};
    const editor = { getInstance: () => instance };
    const nodeElement = globalThis.document.createElement("div");
    expect(port.runSlashItem("second", "shared", editor, nodeElement)).toBe(true);
    expect(firstSlash.callback).not.toHaveBeenCalled();
    expect(secondSlash.callback).toHaveBeenCalledWith(instance, nodeElement);
    expect(port.runSlashItem("missing", "shared", editor, nodeElement)).toBe(false);

    const emptyVisitor = vi.fn();
    createAppProtylePluginPort({ plugins: [] }).forEachSlashItem(emptyVisitor);
    expect(emptyVisitor).not.toHaveBeenCalled();
  });

  it("waits for paste handlers in order and carries ordinary, local-file, and extra fields", async () => {
    const seen = [];
    const first = createPlugin({
      eventBus: {
        emit: vi.fn((type, detail) => {
          if (type !== "paste") {
            return true;
          }
          seen.push("first");
          globalThis.queueMicrotask(() => {
            if (detail.localFiles) {
              detail.resolve({ localFiles: ["first-local"], pluginFlag: false });
            } else {
              detail.resolve({ pluginFlag: false, textPlain: "first" });
            }
          });
          return false;
        }),
      },
      name: "first",
    });
    const second = createPlugin({
      eventBus: {
        emit: vi.fn((type, detail) => {
          if (type !== "paste") {
            return true;
          }
          seen.push("second");
          expect(detail.pluginFlag).toBe(false);
          if (detail.localFiles) {
            expect(detail.localFiles).toEqual(["first-local"]);
            detail.resolve({ localFiles: ["second-local"], pluginFlag: true });
          } else {
            expect(detail.textPlain).toBe("first");
            detail.resolve({ pluginFlag: true, textHTML: "second" });
          }
          return false;
        }),
      },
      name: "second",
    });
    const passthrough = createPlugin({ name: "passthrough" });
    const port = createAppProtylePluginPort({ plugins: [first, second, passthrough] });
    const source = {
      files: { length: 0 },
      siyuanHTML: "",
      textHTML: "initial-html",
      textPlain: "initial-plain",
    };

    const transformed = await port.transformPaste({}, source);
    expect(transformed).toEqual({
      files: source.files,
      pluginFlag: true,
      siyuanHTML: "",
      textHTML: "second",
      textPlain: "first",
    });
    expect(source).toEqual({
      files: { length: 0 },
      siyuanHTML: "",
      textHTML: "initial-html",
      textPlain: "initial-plain",
    });

    const local = await port.transformPaste({}, { localFiles: ["source-local"] });
    expect(local).toEqual({ localFiles: ["second-local"], pluginFlag: true });
    expect(seen).toEqual(["first", "second", "first", "second"]);

    const emptySource = { textPlain: "unchanged" };
    const emptyResult = await createAppProtylePluginPort({ plugins: [] })
      .transformPaste({}, emptySource);
    expect(emptyResult).toEqual(emptySource);
    expect(emptyResult).not.toBe(emptySource);
  });
});
