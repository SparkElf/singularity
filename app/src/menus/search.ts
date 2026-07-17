import {MenuItem} from "./Menu";
import {copySubMenu} from "./commonMenuItem";

export const initSearchMenu = (id: string, notebookId: string) => {
    window.siyuan.menus.menu.remove();
    window.siyuan.menus.menu.append(new MenuItem({
        id: "copy",
        icon: "iconCopy",
        label: window.siyuan.languages.copy,
        type: "submenu",
        submenu: copySubMenu([id], true, undefined, undefined, notebookId)
    }).element);
    return window.siyuan.menus.menu;
};
