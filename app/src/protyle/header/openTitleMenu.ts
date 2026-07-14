import {fetchPost, fetchSyncPost} from "../../util/fetch";
import {MenuItem} from "../../menus/Menu";
import {copySubMenu, exportMd, movePathToMenu, openFileAttr, openFileWechatNotify,} from "../../menus/commonMenuItem";
import {deleteFile} from "../../editor/deleteFile";
import {encodeBase64, updateHotkeyTip} from "../util/compatibility";
import {Constants} from "../../constants";
import {quickMakeCard} from "../../card/makeCard";
import {emitProtylePluginMenu} from "../util/plugin";
import * as dayjs from "dayjs";
import {hideTooltip} from "../../dialog/tooltip";
import {transferBlockRef} from "../../menus/block";
import {addEditorToDatabase} from "../render/av/addToDatabase";
import {hasTopClosestByClassName} from "../util/hasClosest";
import {showMessage} from "../../dialog/message";
import {removeZWJ} from "../util/normalizeText";

export const openTitleMenu = (protyle: IProtyle, position: IPosition, from: string) => {
    hideTooltip();
    if (!window.siyuan.menus.menu.element.classList.contains("fn__none") &&
        window.siyuan.menus.menu.element.getAttribute("data-name") === Constants.MENU_TITLE) {
        window.siyuan.menus.menu.remove();
        return;
    }
    fetchPost("/api/block/getDocInfo", {
        id: protyle.block.rootID
    }, (response) => {
        window.siyuan.menus.menu.remove();
        window.siyuan.menus.menu.element.setAttribute("data-name", Constants.MENU_TITLE);
        const popoverElement = hasTopClosestByClassName(protyle.element, "block__popover", true);
        window.siyuan.menus.menu.element.setAttribute("data-from", popoverElement ? popoverElement.dataset.level + "popover-" + from : "app-" + from);
        const submenu = copySubMenu([protyle.block.rootID], true, undefined, protyle.block.showAll ? protyle.block.id : protyle.block.rootID);
        submenu.push({
            iconHTML: "",
            label: window.siyuan.languages.copyDoc,
            accelerator: undefined,
            click: async () => {
                const [responseHTML, responseText] = await Promise.all([
                    fetchSyncPost("/api/block/getBlockDOM", {id: protyle.block.rootID}),
                    fetchSyncPost("/api/export/exportMdContent", {
                        id: protyle.block.rootID,
                        refMode: 3,
                        embedMode: 1,
                        yfm: false,
                        fillCSSVar: false,
                        adjustHeadingLevel: false
                    })
                ]);

                const textHTML = `<!--data-siyuan='${encodeBase64(responseHTML.data.dom)}'-->${removeZWJ(responseHTML.data.dom)}`;
                await navigator.clipboard.write([
                    new ClipboardItem({
                        "text/plain": new Blob([responseText.data.content], {type: "text/plain"}),
                        "text/html": new Blob([textHTML], {type: "text/html"}),
                    })
                ]);

                showMessage(window.siyuan.languages.copied);
            }
        });
        window.siyuan.menus.menu.append(new MenuItem({
            id: "copy",
            label: window.siyuan.languages.copy,
            icon: "iconCopy",
            type: "submenu",
            submenu,
        }).element);
        if (!protyle.disabled) {
            window.siyuan.menus.menu.append(movePathToMenu([protyle.path]));
            const range = getSelection().rangeCount > 0 ? getSelection().getRangeAt(0) : undefined;
            window.siyuan.menus.menu.append(new MenuItem({
                id: "addToDatabase",
                label: window.siyuan.languages.addToDatabase,
                accelerator: window.siyuan.config.keymap.general.addToDatabase.custom,
                icon: "iconDatabase",
                click: () => {
                    addEditorToDatabase(protyle, range, "title");
                }
            }).element);
            window.siyuan.menus.menu.append(new MenuItem({
                id: "delete",
                icon: "iconTrashcan",
                label: window.siyuan.languages.delete,
                click: () => {
                    deleteFile(protyle.notebookId, protyle.path);
                }
            }).element);
        }
        window.siyuan.menus.menu.append(new MenuItem({id: "separator_1", type: "separator"}).element);
        window.siyuan.menus.menu.append(new MenuItem({
            id: "outline",
            icon: "iconOutline",
            label: window.siyuan.languages.outline,
            accelerator: window.siyuan.config.keymap.editor.general.outline.custom,
            click: () => {
                protyle.session.runtime.host.dispatch({
                    type: "open-outline",
                    documentId: protyle.block.rootID,
                    preview: !protyle.preview.element.classList.contains("fn__none"),
                });
            }
        }).element);
        window.siyuan.menus.menu.append(new MenuItem({
            id: "backlinks",
            icon: "iconLink",
            label: window.siyuan.languages.backlinks,
            accelerator: window.siyuan.config.keymap.editor.general.backlinks.custom,
            click: () => {
                protyle.session.runtime.host.dispatch({
                    type: "open-backlinks",
                    documentId: protyle.block.showAll ? protyle.block.id : protyle.block.rootID,
                });
            }
        }).element);
        window.siyuan.menus.menu.append(new MenuItem({
            id: "graphView",
            icon: "iconGraph",
            label: window.siyuan.languages.graphView,
            accelerator: window.siyuan.config.keymap.editor.general.graphView.custom,
            click: () => {
                protyle.session.runtime.host.dispatch({
                    type: "open-graph",
                    scope: "document",
                    documentId: protyle.block.id,
                });
            }
        }).element);
        window.siyuan.menus.menu.append(new MenuItem({id: "separator_2", type: "separator"}).element);
        window.siyuan.menus.menu.append(new MenuItem({
            id: "attr",
            label: window.siyuan.languages.attr,
            icon: "iconAttr",
            accelerator: window.siyuan.config.keymap.editor.general.attr.custom + "/" + updateHotkeyTip("⇧" + window.siyuan.languages.click),
            click() {
                openFileAttr(response.data.ial, "bookmark", protyle);
            }
        }).element);
        if (!window.siyuan.config.readonly) {
            if (window.siyuan.config.cloudRegion === 0) {
                window.siyuan.menus.menu.append(new MenuItem({
                    id: "wechatReminder",
                    label: window.siyuan.languages.wechatReminder,
                    icon: "iconMp",
                    click() {
                        openFileWechatNotify(protyle);
                    }
                }).element);
            }
            const isCardMade = !!response.data.ial[Constants.CUSTOM_RIFF_DECKS];
            const riffCardMenu: IMenu[] = [{
                id: "spaceRepetition",
                iconHTML: "",
                label: window.siyuan.languages.spaceRepetition,
                accelerator: window.siyuan.config.keymap.editor.general.spaceRepetition.custom,
                click: () => {
                    protyle.session.runtime.host.dispatch({
                        type: "open-card-review",
                        documentId: protyle.block.rootID,
                    });
                }
            }, {
                id: "manage",
                iconHTML: "",
                label: window.siyuan.languages.manage,
                click: () => {
                    protyle.session.runtime.host.dispatch({
                        type: "open-card-browser",
                        documentId: protyle.block.rootID,
                    });
                }
            }, {
                id: isCardMade ? "removeCard" : "quickMakeCard",
                iconHTML: "",
                label: isCardMade ? window.siyuan.languages.removeCard : window.siyuan.languages.quickMakeCard,
                accelerator: window.siyuan.config.keymap.editor.general.quickMakeCard.custom,
                click: () => {
                    let titleElement = protyle.title?.element;
                    if (!titleElement) {
                        titleElement = document.createElement("div");
                        titleElement.setAttribute("data-node-id", protyle.block.rootID);
                        titleElement.setAttribute(Constants.CUSTOM_RIFF_DECKS, response.data.ial[Constants.CUSTOM_RIFF_DECKS]);
                    }
                    quickMakeCard(protyle, [titleElement]);
                }
            }];
            if (window.siyuan.config.flashcard.deck) {
                riffCardMenu.push({
                    id: "addToDeck",
                    iconHTML: "",
                    label: window.siyuan.languages.addToDeck,
                    click: () => {
                        protyle.session.runtime.host.dispatch({
                            type: "open-card-deck-picker",
                            blockIds: [protyle.block.rootID],
                        });
                    }
                });
            }
            window.siyuan.menus.menu.append(new MenuItem({
                id: "riffCard",
                label: window.siyuan.languages.riffCard,
                type: "submenu",
                icon: "iconRiffCard",
                submenu: riffCardMenu,
            }).element);
        }
        window.siyuan.menus.menu.append(new MenuItem({
            id: "search",
            label: window.siyuan.languages.search,
            icon: "iconSearch",
            accelerator: window.siyuan.config.keymap.general.search.custom,
            click() {
                protyle.session.runtime.host.dispatch({
                    type: "open-document-search",
                    documentId: protyle.block.rootID,
                });
            }
        }).element);
        if (!protyle.disabled) {
            transferBlockRef(protyle.block.rootID);
        }
        window.siyuan.menus.menu.append(new MenuItem({id: "separator_3", type: "separator"}).element);
        if (!protyle.model) {
            window.siyuan.menus.menu.append(new MenuItem({
                id: "openBy",
                label: window.siyuan.languages.openBy,
                icon: "iconOpen",
                click() {
                    protyle.session.runtime.host.dispatch({
                        type: "open-document",
                        documentId: protyle.block.id,
                        disposition: "current",
                        scope: protyle.block.rootID !== protyle.block.id ? "subtree" : "context",
                        attention: protyle.block.rootID !== protyle.block.id ? "focus" : "none",
                        scroll: "auto",
                        restoreScroll: "never",
                        zoom: false,
                    });
                }
            }).element);
        }
        if (!protyle.disabled) {
            window.siyuan.menus.menu.append(new MenuItem({
                id: "fileHistory",
                label: window.siyuan.languages.fileHistory,
                icon: "iconHistory",
                click() {
                    protyle.session.runtime.host.dispatch({
                        type: "open-document-history",
                        documentId: protyle.block.rootID,
                    });
                }
            }).element);
        }
        window.siyuan.menus.menu.append(exportMd(protyle.block.showAll ? protyle.block.id : protyle.block.rootID));

        window.siyuan.menus.menu.append(new MenuItem({id: "separator_4", type: "separator"}).element);
        emitProtylePluginMenu({
            plugins: protyle.session.runtime.plugins,
            type: "click-editortitleicon",
            detail: {
                protyle,
                data: response.data,
            },
            separatorPosition: "bottom",
        });
        window.siyuan.menus.menu.append(new MenuItem({
            id: "updateAndCreatedAt",
            iconHTML: "",
            type: "readonly",
            // 不能换行，否则移动端间距过大
            label: `${window.siyuan.languages.modifiedAt} ${dayjs(response.data.ial.updated).format("YYYY-MM-DD HH:mm:ss")}<br>${window.siyuan.languages.createdAt} ${dayjs(response.data.ial.id.substr(0, 14)).format("YYYY-MM-DD HH:mm:ss")}`
        }).element);
        window.siyuan.menus.menu.popup(position);
    });
};
