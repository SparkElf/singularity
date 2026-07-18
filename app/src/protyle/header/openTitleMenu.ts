import {fetchPost, fetchSyncPost} from "../../util/fetch";
import {copySubMenu, exportMd, movePathToMenu, openFileAttr, openFileWechatNotify,} from "../../menus/commonMenuItem";
import {deleteFile} from "../../editor/deleteFile";
import {encodeBase64} from "../util/clipboard";
import {updateHotkeyTip} from "../util/keyboard";
import {Constants} from "../../constants";
import {isEncryptedBox} from "../../util/pathName";
import {quickMakeCard} from "../../card/makeCard";
import {emitProtylePluginMenu} from "../util/plugin";
import * as dayjs from "dayjs";
import {hideTooltip} from "../ui/tooltip";
import {transferBlockRef} from "../../menus/block";
import {addEditorToDatabase} from "../render/av/addToDatabase";
import {hasTopClosestByClassName} from "../util/hasClosest";
import {showMessage} from "../../dialog/message";
import {removeZWJ} from "../util/normalizeText";

type TitleMenuHandle = ReturnType<NonNullable<IProtyle["runtime"]>["menu"]["open"]>;

const activeTitleMenus = new WeakMap<IProtyle, TitleMenuHandle>();

const closeTitleMenu = (protyle: IProtyle) => {
    activeTitleMenus.get(protyle)?.close();
};

const createTitleMenu = (protyle: IProtyle) => {
    const handle = protyle.runtime!.menu.open();
    const closeOnOwnerAbort = () => handle.close();
    protyle.requestSignal.addEventListener("abort", closeOnOwnerAbort, {once: true});
    handle.menu.removeCB = () => {
        protyle.requestSignal.removeEventListener("abort", closeOnOwnerAbort);
        if (activeTitleMenus.get(protyle) === handle) {
            activeTitleMenus.delete(protyle);
        }
    };
    activeTitleMenus.set(protyle, handle);
    return handle;
};

export const openTitleMenu = (protyle: IProtyle, position: IPosition, from: string) => {
    hideTooltip(protyle);
    if (activeTitleMenus.has(protyle)) {
        closeTitleMenu(protyle);
        return;
    }
    const menuHandle = createTitleMenu(protyle);
    const {menu} = menuHandle;
    fetchPost("/api/block/getDocInfo", {
        id: protyle.block.rootID,
        notebook: protyle.notebookId,
    }, (response) => {
        if (activeTitleMenus.get(protyle) !== menuHandle) {
            return;
        }
        menu.element.setAttribute("data-name", Constants.MENU_TITLE);
        const popoverElement = hasTopClosestByClassName(protyle.element, "block__popover", true);
        menu.element.setAttribute("data-from", popoverElement ? popoverElement.dataset.level + "popover-" + from : "app-" + from);
        const submenu = copySubMenu(
            [protyle.block.rootID],
            true,
            undefined,
            protyle.block.showAll ? protyle.block.id : protyle.block.rootID,
            protyle.notebookId
        );
        submenu.push({
            iconHTML: "",
            label: window.siyuan.languages.copyDoc,
            accelerator: undefined,
            click: async () => {
                const [responseHTML, responseText] = await Promise.all([
                    fetchSyncPost("/api/block/getBlockDOM", {
                        id: protyle.block.rootID,
                        notebook: protyle.notebookId,
                    }),
                    fetchSyncPost("/api/export/exportMdContent", {
                        id: protyle.block.rootID,
                        notebook: protyle.notebookId,
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
        menu.addItem({
            id: "copy",
            label: window.siyuan.languages.copy,
            icon: "iconCopy",
            type: "submenu",
            submenu,
        });
        if (!protyle.disabled) {
            menu.addItem(movePathToMenu([protyle.path]));
            const range = getSelection().rangeCount > 0 ? getSelection().getRangeAt(0) : undefined;
            menu.addItem({
                id: "addToDatabase",
                label: window.siyuan.languages.addToDatabase,
                accelerator: window.siyuan.config.keymap.general.addToDatabase.custom,
                icon: "iconDatabase",
                click: () => {
                    addEditorToDatabase(protyle, range, "title");
                }
            });
            menu.addItem({
                id: "delete",
                icon: "iconTrashcan",
                label: window.siyuan.languages.delete,
                click: () => {
                    deleteFile(protyle.notebookId, protyle.path);
                }
            });
        }
        menu.addItem({id: "separator_1", type: "separator"});
        menu.addItem({
            id: "outline",
            icon: "iconOutline",
            label: window.siyuan.languages.outline,
            accelerator: window.siyuan.config.keymap.editor.general.outline.custom,
            click: () => {
                protyle.host.dispatch({
                    type: "open-outline",
                    notebookId: protyle.notebookId,
                    documentId: protyle.block.rootID,
                    preview: !protyle.preview.element.classList.contains("fn__none"),
                });
            }
        });
        menu.addItem({
            id: "backlinks",
            icon: "iconLink",
            label: window.siyuan.languages.backlinks,
            accelerator: window.siyuan.config.keymap.editor.general.backlinks.custom,
            click: () => {
                protyle.host.dispatch({
                    type: "open-backlinks",
                    notebookId: protyle.notebookId,
                    documentId: protyle.block.showAll ? protyle.block.id : protyle.block.rootID,
                });
            }
        });
        menu.addItem({
            id: "graphView",
            icon: "iconGraph",
            label: window.siyuan.languages.graphView,
            accelerator: window.siyuan.config.keymap.editor.general.graphView.custom,
            click: () => {
                protyle.host.dispatch({
                    type: "open-graph",
                    scope: "document",
                    notebookId: protyle.notebookId,
                    documentId: protyle.block.id,
                });
            }
        });
        menu.addItem({id: "separator_2", type: "separator"});
        menu.addItem({
            id: "attr",
            label: window.siyuan.languages.attr,
            icon: "iconAttr",
            accelerator: window.siyuan.config.keymap.editor.general.attr.custom + "/" + updateHotkeyTip("⇧" + window.siyuan.languages.click),
            click() {
                openFileAttr(response.data.ial, "bookmark", protyle);
            }
        });
        if (!window.siyuan.config.readonly) {
            if (window.siyuan.config.cloudRegion === 0) {
                menu.addItem({
                    id: "wechatReminder",
                    label: window.siyuan.languages.wechatReminder,
                    icon: "iconMp",
                    click() {
                        openFileWechatNotify(protyle);
                    }
                });
            }
            const isCardMade = !!response.data.ial[Constants.CUSTOM_RIFF_DECKS];
            if (!isEncryptedBox(protyle.notebookId)) {
                const riffCardMenu: IMenu[] = [{
                    id: "spaceRepetition",
                    iconHTML: "",
                    label: window.siyuan.languages.spaceRepetition,
                    accelerator: window.siyuan.config.keymap.editor.general.spaceRepetition.custom,
                    click: () => {
                        protyle.host.dispatch({
                            type: "open-card-review",
                            notebookId: protyle.notebookId,
                            documentId: protyle.block.rootID,
                        });
                    }
                }, {
                    id: "manage",
                    iconHTML: "",
                    label: window.siyuan.languages.manage,
                    click: () => {
                        protyle.host.dispatch({
                            type: "open-card-browser",
                            notebookId: protyle.notebookId,
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
                            protyle.host.dispatch({
                                type: "open-card-deck-picker",
                                documentId: protyle.block.rootID,
                                notebookId: protyle.notebookId,
                                blockIds: [protyle.block.rootID],
                            });
                        }
                    });
                }
                menu.addItem({
                    id: "riffCard",
                    label: window.siyuan.languages.riffCard,
                    type: "submenu",
                    icon: "iconRiffCard",
                    submenu: riffCardMenu,
                });
            }
        }
        menu.addItem({
            id: "search",
            label: window.siyuan.languages.search,
            icon: "iconSearch",
            accelerator: window.siyuan.config.keymap.general.search.custom,
            click() {
                protyle.host.dispatch({
                    type: "open-document-search",
                    notebookId: protyle.notebookId,
                    documentId: protyle.block.rootID,
                });
            }
        });
        if (!protyle.disabled) {
            transferBlockRef(menu, protyle.block.rootID);
        }
        menu.addItem({id: "separator_3", type: "separator"});
        if (!protyle.model) {
            menu.addItem({
                id: "openBy",
                label: window.siyuan.languages.openBy,
                icon: "iconOpen",
                click() {
                    protyle.host.dispatch({
                        type: "open-document",
                        notebookId: protyle.notebookId,
                        documentId: protyle.block.id,
                        disposition: "current",
                        scope: protyle.block.rootID !== protyle.block.id ? "subtree" : "context",
                        attention: protyle.block.rootID !== protyle.block.id ? "focus" : "none",
                        scroll: "auto",
                        restoreScroll: "never",
                        zoom: false,
                    });
                }
            });
        }
        if (!protyle.disabled) {
            menu.addItem({
                id: "fileHistory",
                label: window.siyuan.languages.fileHistory,
                icon: "iconHistory",
                click() {
                    protyle.host.dispatch({
                        type: "open-document-history",
                        notebookId: protyle.notebookId,
                        documentId: protyle.block.rootID,
                    });
                }
            });
        }
        const exportMenu = exportMd(
            protyle.block.showAll ? protyle.block.id : protyle.block.rootID,
            protyle.notebookId
        );
        if (exportMenu) {
            menu.addItem(exportMenu);
        }

        menu.addItem({id: "separator_4", type: "separator"});
        emitProtylePluginMenu({
            localization: protyle.localization,
            menu,
            plugins: protyle.plugins,
            type: "click-editortitleicon",
            detail: {
                protyle,
                data: response.data,
            },
            separatorPosition: "bottom",
        });
        menu.addItem({
            id: "updateAndCreatedAt",
            iconHTML: "",
            type: "readonly",
            // 不能换行，否则移动端间距过大
            label: `${window.siyuan.languages.modifiedAt} ${dayjs(response.data.ial.updated).format("YYYY-MM-DD HH:mm:ss")}<br>${window.siyuan.languages.createdAt} ${dayjs(response.data.ial.id.substr(0, 14)).format("YYYY-MM-DD HH:mm:ss")}`
        });
        menu.popup(position);
    });
};
