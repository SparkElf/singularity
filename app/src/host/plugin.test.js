import assert from "node:assert/strict";
import {before, beforeEach, describe, it} from "node:test";

let createAppProtylePluginPort;

const createPlugin = (overrides = {}) => ({
    commands: [],
    eventBus: {emit: () => true},
    name: "plugin",
    protyleOptions: undefined,
    protyleSlash: [],
    updateProtyleToolbar: (toolbar) => toolbar,
    ...overrides,
});

before(async () => {
    globalThis.SIYUAN_VERSION = "test";
    globalThis.NODE_ENV = "test";
    ({createAppProtylePluginPort} = await import("./plugin.ts"));
});

beforeEach(() => {
    globalThis.window = {
        siyuan: {
            config: {
                keymap: {
                    plugin: {},
                },
            },
        },
    };
});

describe("createAppProtylePluginPort", () => {
    it("preserves option and toolbar order, custom hotkeys, and the zero-plugin baseline", () => {
        const customItem = {extra: "preserved", hotkey: "default", name: "custom"};
        const normalizedStrong = {name: "strong"};
        const firstToolbarCalls = [];
        const secondToolbarCalls = [];
        const normalizeCalls = [];
        const first = createPlugin({
            name: "first",
            protyleOptions: {extension: {first: true}, render: {title: false}},
            updateProtyleToolbar: (toolbar) => {
                firstToolbarCalls.push(toolbar);
                return [...toolbar, customItem];
            },
        });
        const second = createPlugin({
            name: "second",
            protyleOptions: {render: {title: true}},
            updateProtyleToolbar: (toolbar) => {
                secondToolbarCalls.push(toolbar);
                return toolbar;
            },
        });
        globalThis.window.siyuan.config.keymap.plugin.first = {
            custom: {custom: "user-hotkey", default: "default"},
        };
        const normalizeToolbar = (toolbar) => {
            normalizeCalls.push(toolbar);
            return toolbar.map((item) => item === "strong" ? normalizedStrong : item);
        };
        const port = createAppProtylePluginPort({plugins: [first, second]});

        assert.deepEqual(port.extendOptions({render: {title: true}}), {
            extension: {first: true},
            render: {title: true},
        });
        const toolbar = port.extendToolbar(["strong"], normalizeToolbar);

        assert.deepEqual(firstToolbarCalls, [["strong"]]);
        assert.deepEqual(secondToolbarCalls, [[normalizedStrong, customItem]]);
        assert.equal(normalizeCalls.length, 2);
        assert.deepEqual(toolbar, [normalizedStrong, customItem]);
        assert.deepEqual(customItem, {
            extra: "preserved",
            hotkey: "user-hotkey",
            name: "custom",
        });

        const options = {render: {title: true}};
        const baseToolbar = [normalizedStrong];
        const emptyPort = createAppProtylePluginPort({plugins: []});
        assert.equal(emptyPort.extendOptions(options), options);
        assert.equal(emptyPort.extendToolbar(baseToolbar, normalizeToolbar), baseToolbar);
    });

    it("broadcasts the same mutable event detail to every plugin", () => {
        const menu = {
            items: [],
            addItem(item) {
                this.items.push(item);
            },
        };
        const detail = {languages: ["typescript"], menu};
        let firstDetail;
        let secondDetail;
        const first = createPlugin({
            eventBus: {
                emit: (_type, received) => {
                    firstDetail = received;
                    received.languages.push("rust");
                    received.menu.addItem({id: "first-item"});
                    return true;
                },
            },
            name: "first",
        });
        const second = createPlugin({
            eventBus: {
                emit: (_type, received) => {
                    secondDetail = received;
                    return true;
                },
            },
            name: "second",
        });

        createAppProtylePluginPort({plugins: [first, second]}).emit({
            type: "code-language-update",
            detail,
        });

        assert.equal(firstDetail, detail);
        assert.equal(secondDetail, detail);
        assert.deepEqual(detail.languages, ["typescript", "rust"]);
        assert.deepEqual(menu.items, [{id: "first-item"}]);
    });

    it("runs only the first matching editor command", () => {
        const commandCalls = [];
        const first = createPlugin({
            commands: [{
                customHotkey: "A",
                editorCallback: (editor) => commandCalls.push(["first", editor]),
            }],
            name: "first",
        });
        const second = createPlugin({
            commands: [{
                customHotkey: "A",
                editorCallback: (editor) => commandCalls.push(["second", editor]),
            }],
            name: "second",
        });
        const port = createAppProtylePluginPort({plugins: [first, second]});
        const editor = {};
        const event = {key: "A"};
        const matchesHotkey = (hotkey, keyboardEvent) => hotkey === keyboardEvent.key;

        assert.equal(port.runEditorCommand(editor, event, matchesHotkey), true);
        assert.deepEqual(commandCalls, [["first", editor]]);
        assert.equal(
            createAppProtylePluginPort({plugins: []})
                .runEditorCommand(editor, event, matchesHotkey),
            false,
        );
    });

    it("preserves slash item order and resolves callbacks by object identity", () => {
        const slashCalls = [];
        const firstSlash = {
            callback: (...args) => slashCalls.push(["first", ...args]),
            extra: {preserved: true},
            filter: ["first"],
            html: "first",
            id: "shared",
        };
        const secondSlash = {
            callback: (...args) => slashCalls.push(["second", ...args]),
            filter: ["second"],
            html: "second",
            id: "shared",
        };
        const port = createAppProtylePluginPort({
            plugins: [
                createPlugin({name: "first", protyleSlash: [firstSlash]}),
                createPlugin({name: "second", protyleSlash: [secondSlash]}),
            ],
        });
        const slashItems = [];

        port.forEachSlashItem((pluginName, item) => slashItems.push({item, pluginName}));
        assert.deepEqual(slashItems, [
            {item: firstSlash, pluginName: "first"},
            {item: secondSlash, pluginName: "second"},
        ]);

        const instance = {};
        const editor = {getInstance: () => instance};
        const nodeElement = {};
        assert.equal(port.runSlashItem("second", secondSlash, editor, nodeElement), true);
        assert.deepEqual(slashCalls, [["second", instance, nodeElement]]);
        assert.equal(port.runSlashItem("second", firstSlash, editor, nodeElement), false);

        let visited = false;
        createAppProtylePluginPort({plugins: []}).forEachSlashItem(() => {
            visited = true;
        });
        assert.equal(visited, false);
    });

    it("waits for paste handlers in order and preserves extra fields", async () => {
        const seen = [];
        const first = createPlugin({
            eventBus: {
                emit: (type, detail) => {
                    if (type !== "paste") {
                        return true;
                    }
                    seen.push("first");
                    queueMicrotask(() => {
                        if (detail.localFiles) {
                            detail.resolve({localFiles: ["first-local"], pluginFlag: false});
                        } else {
                            detail.resolve({pluginFlag: false, textPlain: "first"});
                        }
                    });
                    return false;
                },
            },
            name: "first",
        });
        const second = createPlugin({
            eventBus: {
                emit: (type, detail) => {
                    if (type !== "paste") {
                        return true;
                    }
                    seen.push("second");
                    assert.equal(detail.pluginFlag, false);
                    if (detail.localFiles) {
                        assert.deepEqual(detail.localFiles, ["first-local"]);
                        detail.resolve({localFiles: ["second-local"], pluginFlag: true});
                    } else {
                        assert.equal(detail.textPlain, "first");
                        detail.resolve({pluginFlag: true, textHTML: "second"});
                    }
                    return false;
                },
            },
            name: "second",
        });
        const port = createAppProtylePluginPort({
            plugins: [first, second, createPlugin({name: "passthrough"})],
        });
        const source = {
            files: {length: 0},
            siyuanHTML: "",
            textHTML: "initial-html",
            textPlain: "initial-plain",
        };

        assert.deepEqual(await port.transformPaste({}, source), {
            files: source.files,
            pluginFlag: true,
            siyuanHTML: "",
            textHTML: "second",
            textPlain: "first",
        });
        assert.deepEqual(source, {
            files: {length: 0},
            siyuanHTML: "",
            textHTML: "initial-html",
            textPlain: "initial-plain",
        });
        assert.deepEqual(
            await port.transformPaste({}, {localFiles: ["source-local"]}),
            {localFiles: ["second-local"], pluginFlag: true},
        );
        assert.deepEqual(seen, ["first", "second", "first", "second"]);

        const emptySource = {textPlain: "unchanged"};
        const emptyResult = await createAppProtylePluginPort({plugins: []})
            .transformPaste({}, emptySource);
        assert.deepEqual(emptyResult, emptySource);
        assert.notStrictEqual(emptyResult, emptySource);
    });
});
