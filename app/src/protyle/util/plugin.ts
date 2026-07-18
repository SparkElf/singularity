import type {
    ProtyleLocalizationPort,
    ProtyleMenuSurface,
    ProtylePluginEventType,
} from "../../../../enterprise/packages/protyle-browser/src/contracts";

const createPluginSubMenu = () => {
    const menus: IMenu[] = [];
    return {
        menus,
        addSeparator(index?: number, id?: string) {
            const item: IMenu = {id, type: "separator"};
            if (typeof index === "number") {
                menus.splice(index, 0, item);
            } else {
                menus.push(item);
            }
        },
        addItem(item: IMenu) {
            if (typeof item.index === "number") {
                menus.splice(item.index, 0, item);
            } else {
                menus.push(item);
            }
        },
    };
};

export const emitProtylePluginMenu = <TDetail extends object>(options: {
    localization: ProtyleLocalizationPort,
    menu: ProtyleMenuSurface,
    plugins: TProtylePluginPort,
    type: ProtylePluginEventType,
    detail: TDetail,
    separatorPosition?: "top" | "bottom",
}) => {
    const pluginSubMenu = createPluginSubMenu();
    const detail = Object.assign(options.detail, {menu: pluginSubMenu});
    options.plugins.emit({type: options.type, detail});
    if (pluginSubMenu.menus.length === 0) {
        return;
    }
    if (options.separatorPosition === "top") {
        options.menu.addItem({id: "separator_pluginTop", type: "separator"});
    }
    options.menu.addItem({
        id: "plugin",
        label: options.localization.text("plugin"),
        icon: "iconPlugin",
        type: "submenu",
        submenu: pluginSubMenu.menus,
    });
    if (options.separatorPosition === "bottom") {
        options.menu.addItem({id: "separator_pluginBottom", type: "separator"});
    }
};
