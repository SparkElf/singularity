import type {App} from "../index";
import type {
    ProtylePluginEvent,
    ProtylePluginPort,
} from "../../../enterprise/packages/protyle-browser/src/contracts";
import {Constants} from "../constants";
import {merge} from "../protyle/util/merge";

type ProtyleToolbar = Array<string | IMenuItem>;

const applyCustomToolbarHotkeys = (
    plugin: import("../plugin").Plugin,
    toolbar: ProtyleToolbar,
) => {
    toolbar.forEach((toolbarItem) => {
        if (typeof toolbarItem === "string" || Constants.INLINE_TYPE.includes(toolbarItem.name)) {
            return;
        }
        if (typeof toolbarItem.hotkey !== "string") {
            toolbarItem.hotkey = "";
        }
        const pluginKeymap = window.siyuan.config.keymap.plugin?.[plugin.name]?.[toolbarItem.name];
        if (pluginKeymap) {
            toolbarItem.hotkey = pluginKeymap.custom;
        }
    });
};

export const createAppProtylePluginPort = (app: App): ProtylePluginPort<
    IProtyleOptions | undefined,
    ProtyleToolbar,
    IProtyle
> => ({
    extendOptions: (options) => {
        let extendedOptions = options;
        app.plugins.forEach((plugin) => {
            if (plugin.protyleOptions) {
                extendedOptions = merge(extendedOptions, plugin.protyleOptions);
            }
        });
        return extendedOptions;
    },
    extendToolbar: (toolbar, normalizeToolbar) => {
        let extendedToolbar = toolbar;
        app.plugins.forEach((plugin) => {
            extendedToolbar = plugin.updateProtyleToolbar(extendedToolbar);
            applyCustomToolbarHotkeys(plugin, extendedToolbar);
            extendedToolbar = normalizeToolbar(extendedToolbar);
        });
        return extendedToolbar;
    },
    emit: <TDetail extends object>(event: ProtylePluginEvent<TDetail>) => {
        app.plugins.forEach((plugin) => {
            plugin.eventBus.emit(event.type, event.detail);
        });
    },
    runEditorCommand: (editor, event, matchesHotkey) => {
        for (const plugin of app.plugins) {
            for (const command of plugin.commands) {
                if (command.editorCallback && matchesHotkey(command.customHotkey ?? "", event)) {
                    command.editorCallback(editor);
                    return true;
                }
            }
        }
        return false;
    },
    forEachSlashItem: (visitor) => {
        app.plugins.forEach((plugin) => {
            plugin.protyleSlash.forEach((item) => {
                visitor(plugin.name, item);
            });
        });
    },
    runSlashItem: (pluginName, itemId, editor, nodeElement) => {
        const plugin = app.plugins.find((item) => item.name === pluginName);
        const slashItem = plugin?.protyleSlash.find((item) => item.id === itemId);
        if (!slashItem) {
            return false;
        }
        slashItem.callback(editor.getInstance(), nodeElement);
        return true;
    },
    transformPaste: async (editor, payload) => {
        const transformed = {...payload};
        for (const plugin of app.plugins) {
            const response = await new Promise<Partial<typeof transformed> | undefined>((resolve) => {
                const emitted = plugin.eventBus.emit("paste", {
                    ...transformed,
                    protyle: editor,
                    resolve,
                });
                if (emitted) {
                    resolve(undefined);
                }
            });
            if (response) {
                Object.assign(transformed, response);
            }
        }
        return transformed;
    },
    dispose: () => undefined,
});
