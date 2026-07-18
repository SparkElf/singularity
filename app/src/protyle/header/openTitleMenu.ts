import {encodeBase64} from "../util/clipboard";
import {updateHotkeyTip} from "../util/keyboard";
import {Constants} from "../../constants";
import {emitProtylePluginMenu} from "../util/plugin";
import * as dayjs from "dayjs";
import {hideTooltip} from "../ui/tooltip";
import {addEditorToDatabase} from "../render/av/addToDatabase";
import {hasTopClosestByClassName} from "../util/hasClosest";
import {removeZWJ} from "../util/normalizeText";
import {createBlockCopyMenu} from "../ui/blockCopyMenu";
import {protyleContentIdentity} from "../util/contentLoad";
import {transaction} from "../wysiwyg/transaction";

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

const requestTitleMenu = <TResponse>(
    protyle: IProtyle,
    path: string,
    body: unknown,
    intent: "read" | "write" = "read",
) => protyle.session!.runtime.transport.request<TResponse>(path, body, {
    identity: protyleContentIdentity(protyle),
    intent,
    signal: protyle.requestSignal,
});

const reportTitleMenuFailure = (protyle: IProtyle, action: string, error: unknown) => {
    if (!protyle.requestSignal.aborted) {
        console.error(`[protyle.title-menu] ${action} failed`, error);
    }
};

export const openTitleMenu = (protyle: IProtyle, position: IPosition, from: string) => {
    hideTooltip(protyle);
    if (activeTitleMenus.has(protyle)) {
        closeTitleMenu(protyle);
        return;
    }
    const menuHandle = createTitleMenu(protyle);
    const {menu} = menuHandle;
    const identity = protyleContentIdentity(protyle);
    void requestTitleMenu<IWebSocketData>(protyle, "/api/block/getDocInfo", {
        id: protyle.block.rootID,
        notebook: identity.notebookId,
    }).then((response) => {
        if (activeTitleMenus.get(protyle) !== menuHandle) {
            return;
        }
        menu.element.setAttribute("data-name", Constants.MENU_TITLE);
        const popoverElement = hasTopClosestByClassName(protyle.element, "block__popover", true);
        menu.element.setAttribute("data-from", popoverElement ? popoverElement.dataset.level + "popover-" + from : "app-" + from);
        const submenu = createBlockCopyMenu({
            blockIds: [protyle.block.rootID],
            protyle,
            standardMarkdownDocumentId: protyle.block.showAll ? protyle.block.id : protyle.block.rootID,
        });
        submenu.push({
            iconHTML: "",
            label: protyle.localization.text("copyDoc"),
            accelerator: undefined,
            click: async () => {
                try {
                    const [responseHTML, responseText] = await Promise.all([
                        requestTitleMenu<IWebSocketData>(protyle, "/api/block/getBlockDOM", {
                            id: protyle.block.rootID,
                            notebook: identity.notebookId,
                        }),
                        requestTitleMenu<IWebSocketData>(protyle, "/api/export/exportMdContent", {
                            id: protyle.block.rootID,
                            notebook: identity.notebookId,
                            refMode: 3,
                            embedMode: 1,
                            yfm: false,
                            fillCSSVar: false,
                            adjustHeadingLevel: false
                        }),
                    ]);

                    const textHTML = `<!--data-siyuan='${encodeBase64(responseHTML.data.dom)}'-->${removeZWJ(responseHTML.data.dom)}`;
                    await navigator.clipboard.write([
                        new ClipboardItem({
                            "text/plain": new Blob([responseText.data.content], {type: "text/plain"}),
                            "text/html": new Blob([textHTML], {type: "text/html"}),
                        })
                    ]);

                    protyle.host.dispatch({
                        type: "notify",
                        level: "success",
                        message: protyle.localization.text("copied"),
                    });
                } catch (error) {
                    reportTitleMenuFailure(protyle, "copy document", error);
                }
            }
        });
        menu.addItem({
            id: "copy",
            label: protyle.localization.text("copy"),
            icon: "iconCopy",
            type: "submenu",
            submenu,
        });
        if (!protyle.disabled) {
            if (protyle.settings.features.documentMove) {
                menu.addItem({
                    id: "move",
                    label: protyle.localization.text("move"),
                    icon: "iconMove",
                    accelerator: protyle.settings.hotkeys.general.move,
                    click: () => protyle.host.dispatch({
                        type: "open-document-move",
                        notebookId: identity.notebookId,
                        documentId: identity.documentId,
                    }),
                });
            }
            const range = getSelection().rangeCount > 0 ? getSelection().getRangeAt(0) : undefined;
            menu.addItem({
                id: "addToDatabase",
                label: protyle.localization.text("addToDatabase"),
                accelerator: protyle.settings.hotkeys.general.addToDatabase,
                icon: "iconDatabase",
                click: () => {
                    addEditorToDatabase(protyle, range, "title");
                }
            });
            if (protyle.settings.features.documentDelete) {
                menu.addItem({
                    id: "delete",
                    icon: "iconTrashcan",
                    label: protyle.localization.text("delete"),
                    click: () => protyle.host.dispatch({
                        type: "delete-document",
                        notebookId: identity.notebookId,
                        documentId: identity.documentId,
                    }),
                });
            }
        }
        menu.addItem({id: "separator_1", type: "separator"});
        menu.addItem({
            id: "outline",
            icon: "iconOutline",
            label: protyle.localization.text("outline"),
            accelerator: protyle.settings.hotkeys.editor.general.outline,
            click: () => {
                protyle.host.dispatch({
                    type: "open-outline",
                    notebookId: identity.notebookId,
                    documentId: identity.documentId,
                    preview: !protyle.preview.element.classList.contains("fn__none"),
                });
            }
        });
        menu.addItem({
            id: "backlinks",
            icon: "iconLink",
            label: protyle.localization.text("backlinks"),
            accelerator: protyle.settings.hotkeys.editor.general.backlinks,
            click: () => {
                protyle.host.dispatch({
                    type: "open-backlinks",
                    notebookId: identity.notebookId,
                    documentId: identity.documentId,
                });
            }
        });
        menu.addItem({
            id: "graphView",
            icon: "iconGraph",
            label: protyle.localization.text("graphView"),
            accelerator: protyle.settings.hotkeys.editor.general.graphView,
            click: () => {
                protyle.host.dispatch({
                    type: "open-graph",
                    scope: "document",
                    notebookId: identity.notebookId,
                    documentId: identity.documentId,
                });
            }
        });
        menu.addItem({id: "separator_2", type: "separator"});
        if (protyle.settings.features.blockAttributes) {
            menu.addItem({
                id: "attr",
                label: protyle.localization.text("attr"),
                icon: "iconAttr",
                accelerator: protyle.settings.hotkeys.editor.general.attr + "/" + updateHotkeyTip("⇧" + protyle.localization.text("click")),
                click() {
                    protyle.host.dispatch({
                        type: "open-block-attributes",
                        notebookId: identity.notebookId,
                        documentId: identity.documentId,
                        blockId: protyle.block.rootID!,
                        focus: "bookmark",
                    });
                }
            });
        }
        if (!protyle.readonlyState.host) {
            if (protyle.settings.features.wechatReminder) {
                menu.addItem({
                    id: "wechatReminder",
                    label: protyle.localization.text("wechatReminder"),
                    icon: "iconMp",
                    click() {
                        protyle.host.dispatch({
                            type: "open-block-reminder",
                            notebookId: identity.notebookId,
                            documentId: identity.documentId,
                            blockId: protyle.block.rootID!,
                        });
                    }
                });
            }
            if (protyle.settings.features.quickFlashcard || protyle.settings.features.flashcardDeck) {
                const isCardMade = (response.data.ial[Constants.CUSTOM_RIFF_DECKS] || "")
                    .includes(Constants.QUICK_DECK_ID);
                const riffCardMenu: IMenu[] = [{
                    id: "spaceRepetition",
                    iconHTML: "",
                    label: protyle.localization.text("spaceRepetition"),
                    accelerator: protyle.settings.hotkeys.editor.general.spaceRepetition,
                    click: () => {
                        protyle.host.dispatch({
                            type: "open-card-review",
                            notebookId: identity.notebookId,
                            documentId: identity.documentId,
                        });
                    }
                }, {
                    id: "manage",
                    iconHTML: "",
                    label: protyle.localization.text("manage"),
                    click: () => {
                        protyle.host.dispatch({
                            type: "open-card-browser",
                            notebookId: identity.notebookId,
                            documentId: identity.documentId,
                        });
                    }
                }];
                if (protyle.settings.features.quickFlashcard) {
                    riffCardMenu.push({
                        id: isCardMade ? "removeCard" : "quickMakeCard",
                        iconHTML: "",
                        label: isCardMade ? protyle.localization.text("removeCard") : protyle.localization.text("quickMakeCard"),
                        accelerator: protyle.settings.hotkeys.editor.general.quickMakeCard,
                        click: () => transaction(protyle, [{
                            action: isCardMade ? "removeFlashcards" : "addFlashcards",
                            deckID: Constants.QUICK_DECK_ID,
                            blockIDs: [protyle.block.rootID],
                        }], [{
                            action: isCardMade ? "addFlashcards" : "removeFlashcards",
                            deckID: Constants.QUICK_DECK_ID,
                            blockIDs: [protyle.block.rootID],
                        }]),
                    });
                }
                if (protyle.settings.features.flashcardDeck) {
                    riffCardMenu.push({
                        id: "addToDeck",
                        iconHTML: "",
                        label: protyle.localization.text("addToDeck"),
                        click: () => {
                            protyle.host.dispatch({
                                type: "open-card-deck-picker",
                                documentId: identity.documentId,
                                notebookId: identity.notebookId,
                                blockIds: [protyle.block.rootID!],
                            });
                        }
                    });
                }
                menu.addItem({
                    id: "riffCard",
                    label: protyle.localization.text("riffCard"),
                    type: "submenu",
                    icon: "iconRiffCard",
                    submenu: riffCardMenu,
                });
            }
        }
        menu.addItem({
            id: "search",
            label: protyle.localization.text("search"),
            icon: "iconSearch",
            accelerator: protyle.settings.hotkeys.general.search,
            click() {
                protyle.host.dispatch({
                    type: "open-document-search",
                    notebookId: identity.notebookId,
                    documentId: identity.documentId,
                });
            }
        });
        if (!protyle.disabled && protyle.settings.features.blockRefTransfer) {
            menu.addItem({
                id: "transferBlockRef",
                label: protyle.localization.text("transferBlockRef"),
                icon: "iconScrollHoriz",
                click: () => protyle.host.dispatch({
                    type: "open-block-ref-transfer",
                    notebookId: identity.notebookId,
                    documentId: identity.documentId,
                    blockId: protyle.block.rootID!,
                }),
            });
        }
        menu.addItem({id: "separator_3", type: "separator"});
        if (protyle.surface === "embedded") {
            menu.addItem({
                id: "openBy",
                label: protyle.localization.text("openBy"),
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
                label: protyle.localization.text("fileHistory"),
                icon: "iconHistory",
                click() {
                    protyle.host.dispatch({
                        type: "open-document-history",
                        notebookId: identity.notebookId,
                        documentId: identity.documentId,
                    });
                }
            });
        }
        if (protyle.settings.features.documentExport) {
            menu.addItem({
                id: "export",
                label: protyle.localization.text("export"),
                icon: "iconUpload",
                click: (element) => {
                    const rect = element.getBoundingClientRect();
                    queueMicrotask(() => protyle.host.dispatch({
                        type: "open-document-export",
                        notebookId: identity.notebookId,
                        documentId: identity.documentId,
                        blockId: (protyle.block.showAll ? protyle.block.id : protyle.block.rootID)!,
                        position: {x: rect.left, y: rect.bottom},
                    }));
                },
            });
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
            label: `${protyle.localization.text("modifiedAt")} ${dayjs(response.data.ial.updated).format("YYYY-MM-DD HH:mm:ss")}<br>${protyle.localization.text("createdAt")} ${dayjs(response.data.ial.id.substr(0, 14)).format("YYYY-MM-DD HH:mm:ss")}`
        });
        menu.popup(position);
    }).catch((error) => {
        if (activeTitleMenus.get(protyle) === menuHandle) {
            menuHandle.close();
        }
        reportTitleMenuFailure(protyle, "load", error);
    });
};
