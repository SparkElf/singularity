import type {ProtylePluginEventType} from "../../../../enterprise/packages/protyle-browser/src/contracts";
import {MenuItem, subMenu} from "../../menus/Menu";

export const emitProtylePluginMenu = <TDetail extends object>(options: {
    plugins: TProtylePluginPort,
    type: ProtylePluginEventType,
    detail: TDetail,
    separatorPosition?: "top" | "bottom",
}) => {
    const pluginSubMenu = new subMenu();
    const detail = Object.assign(options.detail, {menu: pluginSubMenu});
    options.plugins.emit({type: options.type, detail});
    if (pluginSubMenu.menus.length === 0) {
        return;
    }
    if (options.separatorPosition === "top") {
        window.siyuan.menus.menu.append(new MenuItem({id: "separator_pluginTop", type: "separator"}).element);
    }
    window.siyuan.menus.menu.append(new MenuItem({
        id: "plugin",
        label: window.siyuan.languages.plugin,
        icon: "iconPlugin",
        type: "submenu",
        submenu: pluginSubMenu.menus,
    }).element);
    if (options.separatorPosition === "bottom") {
        window.siyuan.menus.menu.append(new MenuItem({id: "separator_pluginBottom", type: "separator"}).element);
    }
};
