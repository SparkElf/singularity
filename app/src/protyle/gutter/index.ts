import {
    hasClosestBlock,
    hasClosestByClassName,
    hasClosestByTag,
    hasTopClosestByClassName,
    isInAVBlock,
    isInEmbedBlock
} from "../util/hasClosest";
import {getIconByType} from "../util/getIconByType";
import {foldBlocksRecursively, setFold} from "../util/blockFold";
import {isMac, isNarrowViewport} from "../util/browserPlatform";
import {copyPlainText, writeText} from "../util/clipboard";
import {downloadExportFile} from "../util/download";
import {isOnlyMeta, updateHotkeyAfterTip, updateHotkeyTip} from "../util/keyboard";
import {
    transaction,
    turnsIntoOneTransaction,
    turnsIntoTransaction,
    turnsOneInto,
    updateBatchTransaction,
    updateTransaction
} from "../wysiwyg/transaction";
import {removeBlock} from "../wysiwyg/remove";
import {focusBlock, focusByRange, getEditorRange} from "../util/selection";
import {hideElements} from "../ui/hideElements";
import {highlightRender} from "../render/highlightRender";
import {blockRender} from "../render/blockRender";
import {getContenteditableElement, getParentBlock, getTopAloneElement, isNotEditBlock} from "../wysiwyg/getBlock";
import * as dayjs from "dayjs";
import {transparentImgSrc} from "../util/dragTip";
import {countBlockStatistics} from "../util/statistics";
import {Constants} from "../../constants";
import {mathRender} from "../render/mathRender";
import {duplicateBlock} from "../wysiwyg/commonHotkey";
import {hideTooltip} from "../ui/tooltip";
import {appearanceMenu} from "../toolbar/Font";
import {emitProtylePluginMenu} from "../util/plugin";
import {insertAttrViewBlockAnimation, updateHeader} from "../render/av/row";
import {avContextmenu, duplicateCompletely} from "../render/av/action";
import {getPlainText} from "../util/paste";
import {addEditorToDatabase} from "../render/av/addToDatabase";
import {processClonePHElement} from "../render/util";
import {clearSelect} from "../util/clear";
import {chartRender} from "../render/chartRender";
import {zoomOut} from "../util/zoom";
import {requestBlockFold} from "../util/blockFoldRequest";
import {protyleContentIdentity} from "../util/contentLoad";
import {beginProtyleDrag, endProtyleDrag} from "../ui/dragState";
import {touchDragOwner} from "../ui/touchDragState";
import {createBlockCopyMenu} from "../ui/blockCopyMenu";
import {positionElementInViewport} from "../ui/positionElement";
import {insertEmptyBlock, jumpToParent, navigateBack} from "../wysiwyg/blockActions";
import {genEmptyElement} from "../wysiwyg/blockElement";
import {cancelSB} from "../wysiwyg/superBlock";
import {createIframeMenu, createMediaMenu} from "./mediaMenu";
import type {
    ProtyleMenuHandle,
    ProtyleMenuSurface,
} from "../../../../enterprise/packages/protyle-browser/src/contracts";

type GutterTextKey = Parameters<IProtyle["localization"]["text"]>[0];

const gutterText = (protyle: IProtyle, key: GutterTextKey) => protyle.localization.text(key);

const requestGutter = (
    protyle: IProtyle,
    path: string,
    body: unknown,
    intent: "read" | "write",
) => protyle.session!.runtime.transport.request<IWebSocketData>(path, body, {
    identity: protyleContentIdentity(protyle),
    intent,
    signal: protyle.requestSignal,
});

const reportGutterRequestFailure = (protyle: IProtyle, path: string, error: unknown) => {
    if (!protyle.requestSignal.aborted) {
        console.error(`[protyle.transport] gutter request failed: ${path}`, error);
    }
};

const reportGutterActionFailure = (protyle: IProtyle, action: string, error: unknown) => {
    if (!protyle.requestSignal.aborted) {
        console.error(`[protyle.gutter] ${action} failed`, error);
    }
};

const submitGutterRequest = (
    protyle: IProtyle,
    path: string,
    body: unknown,
) => {
    void requestGutter(protyle, path, body, "write").catch((error) => {
        reportGutterRequestFailure(protyle, path, error);
    });
};

const toggleQuickFlashcards = (protyle: IProtyle, elements: Element[]) => {
    const candidates = elements.filter((item) => item.getAttribute("data-type") !== "NodeThematicBreak");
    const remove = candidates.every((item) =>
        (item.getAttribute(Constants.CUSTOM_RIFF_DECKS) || "").includes(Constants.QUICK_DECK_ID));
    const blockIDs = candidates
        .filter((item) => (item.getAttribute(Constants.CUSTOM_RIFF_DECKS) || "").includes(Constants.QUICK_DECK_ID) === remove)
        .map((item) => item.getAttribute("data-node-id")!);
    candidates.forEach((item) => item.classList.remove("protyle-wysiwyg--select"));
    transaction(protyle, [{
        action: remove ? "removeFlashcards" : "addFlashcards",
        deckID: Constants.QUICK_DECK_ID,
        blockIDs,
    }], [{
        action: remove ? "addFlashcards" : "removeFlashcards",
        deckID: Constants.QUICK_DECK_ID,
        blockIDs,
    }]);
};

// 块类型 data-type 到本地化名称键的映射，用于块标提示中的 ${x}
const BLOCK_TYPE_LANG_KEYS: { [key: string]: string } = {
    NodeParagraph: "paragraph",
    NodeHeading: "headings",
    NodeList: "list1",
    NodeListItem: "listItem",
    NodeBlockquote: "quote",
    NodeCallout: "callout",
    NodeSuperBlock: "superBlock",
    NodeTable: "table",
    NodeCodeBlock: "code",
    NodeMathBlock: "math",
    NodeBlockQueryEmbed: "blockEmbed",
    NodeThematicBreak: "line",
    NodeVideo: "video",
    NodeAudio: "audio",
    NodeWidget: "widget",
    NodeAttributeView: "database",
};

// 根据块 data-type 返回本地化的类型名，用于块标拖拽提示「拖拽 ${x} 移动位置」
const getBlockTypeName = (protyle: IProtyle, type: string) => {
    const langKey = BLOCK_TYPE_LANG_KEYS[type];
    if (langKey) {
        return gutterText(protyle, langKey);
    }
    return type === "NodeIFrame" ? "IFrame" : type;
};

export class Gutter {
    public element: HTMLElement;
    // 普通块标提示模板（含 ${x} 块类型占位符），反链面板使用 gutterTipBacklink
    private gutterTip: string;
    private gutterTipBacklink: string;
    private menuHandle?: ProtyleMenuHandle<ProtyleMenuSurface>;

    private get menu() {
        return this.menuHandle!.menu;
    }

    private closeMenu() {
        const handle = this.menuHandle;
        this.menuHandle = undefined;
        handle?.close();
    }

    private openMenu(protyle: IProtyle) {
        this.closeMenu();
        const handle = protyle.session!.runtime.menu.open() as ProtyleMenuHandle<ProtyleMenuSurface>;
        this.menuHandle = handle;
        handle.menu.removeCB = () => {
            if (this.menuHandle === handle) {
                this.menuHandle = undefined;
            }
        };
        return handle.menu;
    }

    constructor(protyle: IProtyle) {
        if (isMac()) {
            this.gutterTip = gutterText(protyle, "gutterTip").replace("⌥→", updateHotkeyAfterTip(protyle.settings.hotkeys.general.enter, "/"));
            this.gutterTipBacklink = gutterText(protyle, "gutterTipBacklink").replace("⌥→", updateHotkeyAfterTip(protyle.settings.hotkeys.general.enter, "/"));
        } else {
            this.gutterTip = gutterText(protyle, "gutterTip").replace("⌥→", updateHotkeyAfterTip(protyle.settings.hotkeys.general.enter, "/"))
                .replace(/⌘/g, "Ctrl+").replace(/⌥/g, "Alt+").replace(/⇧/g, "Shift+").replace(/⌃/g, "Ctrl+");
            this.gutterTipBacklink = gutterText(protyle, "gutterTipBacklink").replace("⌥→", updateHotkeyAfterTip(protyle.settings.hotkeys.general.enter, "/"))
                .replace(/⌘/g, "Ctrl+").replace(/⌥/g, "Alt+").replace(/⇧/g, "Shift+").replace(/⌃/g, "Ctrl+");
        }
        protyle.requestSignal.addEventListener("abort", () => this.closeMenu(), {once: true});
        this.element = document.createElement("div");
        this.element.className = "protyle-gutters";
        this.element.addEventListener("dragstart", (event: DragEvent & { target: HTMLElement }) => {
            hideTooltip(protyle);
            this.closeMenu();
            const buttonElement = event.target.parentElement;
            let selectIds: string[] = [];
            let selectElements: Element[] = [];
            let avElement: Element;
            if (buttonElement.dataset.rowId) {
                avElement = Array.from(protyle.wysiwyg.element.querySelectorAll(`.av[data-node-id="${buttonElement.dataset.nodeId}"]`)).find((item: HTMLElement) => {
                    if (!isInEmbedBlock(item) && !isInAVBlock(item)) {
                        return true;
                    }
                });
                if (avElement.querySelector('.block__icon[data-type="av-sort"]')?.classList.contains("block__icon--active")) {
                    const bodyElements = avElement.querySelectorAll(".av__body");
                    if (bodyElements.length === 1) {
                        event.preventDefault();
                        event.stopPropagation();
                        return;
                    } else if (["template", "created", "updated"].includes(bodyElements[0].getAttribute("data-dtype"))) {
                        event.preventDefault();
                        event.stopPropagation();
                        return;
                    }
                }
                const rowElement = avElement.querySelector(`.av__body${buttonElement.dataset.groupId ? `[data-group-id="${buttonElement.dataset.groupId}"]` : ""} .av__row[data-id="${buttonElement.dataset.rowId}"]`);
                if (!rowElement.classList.contains("av__row--select")) {
                    avElement.querySelectorAll(".av__row--select:not(.av__row--header)").forEach(item => {
                        item.classList.remove("av__row--select");
                        item.querySelector("use").setAttribute("xlink:href", "#iconUncheck");
                    });
                }
                rowElement.classList.add("av__row--select");
                rowElement.querySelector(".av__firstcol use").setAttribute("xlink:href", "#iconCheck");
                updateHeader(rowElement as HTMLElement);
                avElement.querySelectorAll(".av__row--select:not(.av__row--header)").forEach(item => {
                    const avBodyElement = hasClosestByClassName(item, "av__body") as HTMLElement;
                    const groupId = (avBodyElement ? avBodyElement.dataset.groupId : "") || "";
                    selectIds.push(item.getAttribute("data-id") + (groupId ? "@" + groupId : ""));
                    selectElements.push(item);
                });
            } else {
                const gutterId = buttonElement.getAttribute("data-node-id");
                selectElements = Array.from(protyle.wysiwyg.element.querySelectorAll(".protyle-wysiwyg--select"));
                let selectedIncludeGutter = false;
                selectElements.forEach((item => {
                    const itemId = item.getAttribute("data-node-id");
                    if (itemId === gutterId) {
                        selectedIncludeGutter = true;
                    }
                    selectIds.push(itemId);
                }));
                if (!selectedIncludeGutter) {
                    let gutterNodeElement: HTMLElement;
                    Array.from(protyle.wysiwyg.element.querySelectorAll(`[data-node-id="${gutterId}"]`)).find((item: HTMLElement) => {
                        if (!isInEmbedBlock(item) && this.isMatchNode(item)) {
                            gutterNodeElement = item;
                            return true;
                        }
                    });
                    if (gutterNodeElement) {
                        selectElements.forEach((item => {
                            item.classList.remove("protyle-wysiwyg--select");
                        }));
                        gutterNodeElement.classList.add("protyle-wysiwyg--select");
                        selectElements = [gutterNodeElement];
                        selectIds = [gutterId];
                    }
                }
            }

            const ghostElement = document.createElement("div");
            ghostElement.className = protyle.wysiwyg.element.className;
            selectElements.forEach(item => {
                if (item.querySelector("iframe")) {
                    const type = item.getAttribute("data-type");
                    const embedElement = genEmptyElement(protyle);
                    embedElement.classList.add("protyle-wysiwyg--select");
                    getContenteditableElement(embedElement).innerHTML = `<svg class="svg"><use xlink:href="${buttonElement.querySelector("use").getAttribute("xlink:href")}"></use></svg> ${getBlockTypeName(protyle, type)}`;
                    ghostElement.append(embedElement);
                } else {
                    ghostElement.append(processClonePHElement(item.cloneNode(true) as Element));
                }
            });
            ghostElement.setAttribute("style", `position:fixed;opacity:.1;width:${selectElements[0].clientWidth}px;padding:0;`);
            document.body.append(ghostElement);
            // 普通块（段落/标题/列表块/引用块等）拖拽时隐藏原生 ghost 并改用自定义双区跟随框；AV 行保留原生 ghost
            const isBlockDrag = !buttonElement.dataset.rowId;
            if (isBlockDrag && !touchDragOwner.active) {
                const transparentImg = new Image();
                transparentImg.src = transparentImgSrc;
                event.dataTransfer.setDragImage(transparentImg, 0, 0);
                setTimeout(() => {
                    ghostElement.remove();
                });
            } else {
                event.dataTransfer.setDragImage(ghostElement, 0, 0);
                if (touchDragOwner.active) {
                    const ghostHandle = protyle.runtime!.overlays.add(ghostElement);
                    protyle.runtime!.overlays.bringToFront(ghostElement);
                    touchDragOwner.registerGhost(ghostElement, ghostHandle, protyle.requestSignal);
                } else {
                    setTimeout(() => {
                        ghostElement.remove();
                    });
                }
            }
            let dragTitle = "";
            if (isBlockDrag) {
                const text = getContenteditableElement(selectElements[0] as HTMLElement)?.textContent?.trim() || "";
                // 数据库块若无标题，优先用当前视图名，最后兜底为"数据库"
                dragTitle = text;
                if (!dragTitle && buttonElement.getAttribute("data-type") === "NodeAttributeView") {
                    dragTitle = (selectElements[0] as HTMLElement)?.querySelector(".av__views .item--focus")?.textContent?.trim() ||
                        gutterText(protyle, "database");
                }
            }
            buttonElement.style.opacity = "0.38";
            beginProtyleDrag({
                data: selectIds.join(","),
                dataTransfer: event.dataTransfer,
                element: avElement as HTMLElement || protyle.wysiwyg.element,
                html: protyle.wysiwyg.element.innerHTML,
                protyle,
                subtype: buttonElement.getAttribute("data-subtype") || "",
                title: dragTitle,
                type: buttonElement.getAttribute("data-type"),
            });
        });
        this.element.addEventListener("dragend", () => {
            this.element.querySelectorAll("button").forEach((item) => {
                item.style.opacity = "";
            });
            endProtyleDrag(protyle);
        });
        this.element.addEventListener("click", (event: MouseEvent & { target: HTMLInputElement }) => {
            const buttonElement = hasClosestByTag(event.target, "BUTTON");
            if (!buttonElement) {
                return;
            }
            event.preventDefault();
            event.stopPropagation();
            hideTooltip(protyle);
            clearSelect(["cell", "img"], protyle.wysiwyg.element);
            // 框线点击：若鼠标在块标范围内（框线::before 截获了块标点击），转发为块标菜单；否则无操作
            if (buttonElement.classList.contains("protyle-gutters__line")) {
                if (activeBlockButton && !protyle.disabled) {
                    const br = activeBlockButton.getBoundingClientRect();
                    if (event.clientX >= br.left && event.clientX <= br.right &&
                        event.clientY >= br.top && event.clientY <= br.bottom) {
                        const menu = this.renderMenu(protyle, activeBlockButton as HTMLElement);
                        if (!protyle.toolbar.range) {
                            protyle.toolbar.range = getEditorRange(protyle.wysiwyg.element.querySelector(`[data-node-id="${activeBlockButton.getAttribute("data-node-id")}"]`) || protyle.wysiwyg.element.firstElementChild);
                        }
                        menu?.popup({x: br.left, y: br.bottom, isLeft: true});
                        focusByRange(protyle.toolbar.range);
                    }
                }
                return;
            }
            const id = buttonElement.getAttribute("data-node-id");
            if (!id) {
                if (buttonElement.getAttribute("disabled")) {
                    return;
                }
                buttonElement.setAttribute("disabled", "disabled");
                let foldElement: Element;
                Array.from(protyle.wysiwyg.element.querySelectorAll(`[data-node-id="${(buttonElement.previousElementSibling || buttonElement.nextElementSibling).getAttribute("data-node-id")}"]`)).find(item => {
                    if (!isInEmbedBlock(item) && this.isMatchNode(item)) {
                        foldElement = item;
                        return true;
                    }
                });
                if (!foldElement) {
                    return;
                }
                if (event.altKey) {
                    // 折叠所有子集
                    let hasFold = true;
                    Array.from(foldElement.children).find((ulElement) => {
                        if (ulElement.classList.contains("list")) {
                            const foldElement = Array.from(ulElement.children).find((listItemElement) => {
                                if (listItemElement.classList.contains("li")) {
                                    if (listItemElement.getAttribute("fold") !== "1" && listItemElement.childElementCount > 3) {
                                        hasFold = false;
                                        return true;
                                    }
                                }
                            });
                            if (foldElement) {
                                return true;
                            }
                        }
                    });
                    const doOperations: IOperation[] = [];
                    const undoOperations: IOperation[] = [];
                    Array.from(foldElement.children).forEach((ulElement) => {
                        if (ulElement.classList.contains("list")) {
                            Array.from(ulElement.children).forEach((listItemElement) => {
                                if (listItemElement.classList.contains("li")) {
                                    if (hasFold) {
                                        listItemElement.removeAttribute("fold");
                                    } else if (listItemElement.childElementCount > 3) {
                                        listItemElement.setAttribute("fold", "1");
                                    }
                                    const listId = listItemElement.getAttribute("data-node-id");
                                    doOperations.push({
                                        action: "setAttrs",
                                        id: listId,
                                        data: JSON.stringify({fold: hasFold ? "" : "1"})
                                    });
                                    undoOperations.push({
                                        action: "setAttrs",
                                        id: listId,
                                        data: JSON.stringify({fold: hasFold ? "1" : ""})
                                    });
                                }
                            });
                        }
                    });
                    transaction(protyle, doOperations, undoOperations);
                    buttonElement.removeAttribute("disabled");
                } else {
                    const foldStatus = setFold(protyle, foldElement).fold;
                    if (foldStatus === 1) {
                        (buttonElement.firstElementChild as HTMLElement).style.transform = "";
                    } else if (foldStatus === 0) {
                        (buttonElement.firstElementChild as HTMLElement).style.transform = "rotate(90deg)";
                    }
                }
                hideElements(["select"], protyle);
                this.closeMenu();
                return;
            }
            const gutterRect = buttonElement.getBoundingClientRect();
            if (buttonElement.dataset.type === "gutterPlusBefore" || buttonElement.dataset.type === "gutterPlusAfter") {
                // 块标边缘+号：在对应块上方/下方插入新块，复用 insertEmptyBlock（列表项自动生成新列表项）
                if (protyle.disabled || !id) {
                    return;
                }
                hideElements(["gutter"], protyle);
                countBlockStatistics(protyle, []);
                void insertEmptyBlock(
                    protyle,
                    buttonElement.dataset.type === "gutterPlusBefore" ? "beforebegin" : "afterend",
                    id,
                ).catch((error) => reportGutterActionFailure(protyle, "insert empty block", error));
                return;
            }
            if (buttonElement.dataset.type === "NodeAttributeViewRowMenu" || buttonElement.dataset.type === "NodeAttributeViewRow") {
                const rowElement = Array.from(protyle.wysiwyg.element.querySelectorAll(`.av[data-node-id="${buttonElement.dataset.nodeId}"] .av__row[data-id="${buttonElement.dataset.rowId}"]`)).find((item: HTMLElement) => {
                    if (!isInEmbedBlock(item)) {
                        return true;
                    }
                });
                if (!rowElement) {
                    return;
                }
                const blockElement = hasClosestBlock(rowElement);
                if (!blockElement) {
                    return;
                }
                if (buttonElement.dataset.type === "NodeAttributeViewRow") {
                    const avID = blockElement.getAttribute("data-av-id");
                    const srcIDs = [Lute.NewNodeID()];
                    const previousID = event.altKey ? (rowElement.previousElementSibling.getAttribute("data-id") || "") : buttonElement.dataset.rowId;
                    const newUpdated = dayjs().format("YYYYMMDDHHmmss");
                    const groupID = rowElement.parentElement.getAttribute("data-group-id");
                    transaction(protyle, [{
                        action: "insertAttrViewBlock",
                        avID,
                        previousID,
                        srcs: [{
                            itemID: Lute.NewNodeID(),
                            id: srcIDs[0],
                            isDetached: true,
                            content: ""
                        }],
                        blockID: id,
                        groupID,
                    }, {
                        action: "doUpdateUpdated",
                        id,
                        data: newUpdated,
                    }], [{
                        action: "removeAttrViewBlock",
                        srcIDs,
                        avID,
                    }, {
                        action: "doUpdateUpdated",
                        id,
                        data: blockElement.getAttribute("updated")
                    }]);
                    insertAttrViewBlockAnimation({protyle, blockElement, srcIDs, previousId: previousID, groupID});
                    if (event.altKey) {
                        this.element.querySelectorAll("button").forEach(item => {
                            item.dataset.rowId = srcIDs[0];
                        });
                    }
                    blockElement.setAttribute("updated", newUpdated);
                } else {
                    avContextmenu(protyle, rowElement as HTMLElement, {
                        x: gutterRect.left,
                        y: gutterRect.bottom,
                        w: gutterRect.width,
                        h: gutterRect.height,
                        isLeft: true
                    });
                }
                return;
            }
            if (isOnlyMeta(event)) {
                if (protyle.options.backlinkData) {
                    void requestBlockFold(protyle, {
                        notebookId: protyle.notebookId,
                        documentId: id,
                    }).then(({zoomIn}) => {
                        protyle.host.dispatch({
                            type: "open-document",
                            notebookId: protyle.notebookId,
                            documentId: id,
                            disposition: "current",
                            scope: zoomIn ? "subtree" : "context",
                            attention: "focus",
                            scroll: "auto",
                            restoreScroll: zoomIn ? "never" : "if-document",
                            zoom: zoomIn,
                        });
                    }).catch((error) => reportGutterActionFailure(protyle, "open folded block", error));
                } else {
                    void zoomOut({protyle, id})
                        .catch((error) => reportGutterActionFailure(protyle, "zoom out", error));
                }
            } else if (event.altKey) {
                let foldElement: Element;
                Array.from(protyle.wysiwyg.element.querySelectorAll(`[data-node-id="${id}"]`)).find(item => {
                    if (!isInEmbedBlock(item) && this.isMatchNode(item)) {
                        foldElement = item;
                        return true;
                    }
                });
                if (!foldElement) {
                    return;
                }
                if (buttonElement.getAttribute("data-type") === "NodeListItem" && foldElement.parentElement.getAttribute("data-node-id")) {
                    // 折叠同级
                    let hasFold = true;
                    Array.from(foldElement.parentElement.children).find((listItemElement) => {
                        if (listItemElement.classList.contains("li")) {
                            if (listItemElement.getAttribute("fold") !== "1" && listItemElement.childElementCount > 3) {
                                hasFold = false;
                                return true;
                            }
                        }
                    });
                    const arrowElement = buttonElement.parentElement.querySelector("[data-type='fold'] > svg") as HTMLElement;
                    if (arrowElement) {
                        arrowElement.style.transform = hasFold ? "rotate(90deg)" : "";
                    }
                    const doOperations: IOperation[] = [];
                    const undoOperations: IOperation[] = [];
                    Array.from(foldElement.parentElement.children).find((listItemElement) => {
                        if (listItemElement.classList.contains("li")) {
                            if (hasFold) {
                                listItemElement.removeAttribute("fold");
                            } else if (listItemElement.childElementCount > 3) {
                                listItemElement.setAttribute("fold", "1");
                            }
                            const listId = listItemElement.getAttribute("data-node-id");
                            doOperations.push({
                                action: "setAttrs",
                                id: listId,
                                data: JSON.stringify({fold: hasFold ? "" : "1"})
                            });
                            undoOperations.push({
                                action: "setAttrs",
                                id: listId,
                                data: JSON.stringify({fold: hasFold ? "1" : ""})
                            });
                        }
                    });
                    transaction(protyle, doOperations, undoOperations);
                } else {
                    const hasFold = setFold(protyle, foldElement).fold;
                    const foldArrowElement = buttonElement.parentElement.querySelector("[data-type='fold'] > svg") as HTMLElement;
                    if (hasFold !== -1 && foldArrowElement) {
                        foldArrowElement.style.transform = hasFold === 0 ? "rotate(90deg)" : "";
                    }
                }
                foldElement.classList.remove("protyle-wysiwyg--hl");
            } else if (event.shiftKey && !protyle.disabled && protyle.settings.features.blockAttributes) {
                // 直接使用当前事件，确保窗口未激活时按 Shift 点击块标仍可打开属性面板。
                protyle.host.dispatch({
                    type: "open-block-attributes",
                    notebookId: protyle.notebookId,
                    documentId: protyleContentIdentity(protyle).documentId,
                    blockId: id,
                    focus: "bookmark",
                });
            } else if (!event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey) {
                const menu = this.renderMenu(protyle, buttonElement);
                // https://ld246.com/article/1648433751993
                if (!protyle.toolbar.range) {
                    protyle.toolbar.range = getEditorRange(protyle.wysiwyg.element.querySelector(`[data-node-id="${id}"]`) || protyle.wysiwyg.element.firstElementChild);
                }
                menu?.popup({x: gutterRect.left, y: gutterRect.bottom, isLeft: true});
                const popoverElement = hasTopClosestByClassName(protyle.element, "block__popover", true);
                menu?.element.setAttribute("data-from", popoverElement ? popoverElement.dataset.level + "popover" : "app");
                focusByRange(protyle.toolbar.range);
            }
        });
        this.element.addEventListener("contextmenu", (event: MouseEvent & { target: HTMLInputElement }) => {
            const buttonElement = hasClosestByTag(event.target, "BUTTON");
            if (!buttonElement || buttonElement.getAttribute("data-type") === "fold") {
                return;
            }
            if (!event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey) {
                hideTooltip(protyle);
                clearSelect(["cell", "img"], protyle.wysiwyg.element);
                const gutterRect = buttonElement.getBoundingClientRect();
                if (buttonElement.dataset.type === "NodeAttributeViewRowMenu") {
                    const rowElement = Array.from(protyle.wysiwyg.element.querySelectorAll(`.av[data-node-id="${buttonElement.dataset.nodeId}"] .av__row[data-id="${buttonElement.dataset.rowId}"]`)).find((item: HTMLElement) => {
                        if (!isInEmbedBlock(item)) {
                            return true;
                        }
                    });
                    if (rowElement) {
                        avContextmenu(protyle, rowElement as HTMLElement, {
                            x: gutterRect.left,
                            y: gutterRect.bottom,
                            w: gutterRect.width,
                            h: gutterRect.height,
                            isLeft: true
                        });
                    }
                } else if (buttonElement.dataset.type !== "NodeAttributeViewRow") {
                    const menu = this.renderMenu(protyle, buttonElement);
                    if (!protyle.toolbar.range) {
                        protyle.toolbar.range = getEditorRange(
                            protyle.wysiwyg.element.querySelector(`[data-node-id="${buttonElement.getAttribute("data-node-id")}"]`) ||
                            protyle.wysiwyg.element.firstElementChild);
                    }
                    menu?.popup({x: gutterRect.left, y: gutterRect.bottom, isLeft: true});
                    const popoverElement = hasTopClosestByClassName(protyle.element, "block__popover", true);
                    menu?.element.setAttribute("data-from", popoverElement ? popoverElement.dataset.level + "popover" : "app");
                    focusByRange(protyle.toolbar.range);
                }
            }
            event.preventDefault();
            event.stopPropagation();
        });
        // 延迟隐藏计时器，鼠标在块标/框线/+号之间移动时提供缓冲，避免中途 mouseleave 误隐藏
        let hidePlusTimeout: number;
        // 当前悬浮的块标 button，供情况A 坐标判断（鼠标在块标内不误触发+号）
        let activeBlockButton: Element;
        const hideInsert = () => {
            activeBlockButton = undefined;
            this.element.querySelectorAll(".protyle-gutters__line, .protyle-gutters__plus").forEach(item => {
                (item as HTMLElement).style.display = "none";
            });
        };
        this.element.addEventListener("mouseleave", (event: MouseEvent & { target: HTMLInputElement }) => {
            // 鼠标移向框线或+号时不隐藏（它们定位在容器外侧，移出容器几何范围会触发 mouseleave）
            const related = event.relatedTarget as HTMLElement;
            if (related && (related.classList.contains("protyle-gutters__line") || related.classList.contains("protyle-gutters__plus"))) {
                return;
            }
            // 块高亮立即移除，保持原有反馈；框线/+号延迟隐藏，避免移向它们途中误隐藏
            Array.from(protyle.wysiwyg.element.querySelectorAll(".protyle-wysiwyg--hl, .av__row--hl")).forEach(item => {
                item.classList.remove("protyle-wysiwyg--hl", "av__row--hl");
            });
            window.clearTimeout(hidePlusTimeout);
            hidePlusTimeout = window.setTimeout(hideInsert, 200);
            event.preventDefault();
            event.stopPropagation();
        });
        // 双元素交互：悬浮块标显示框线（贴边不动），悬浮框线显示+号（独立元素外偏定位）
        this.element.addEventListener("mousemove", (event: MouseEvent & { target: HTMLElement }) => {
            const lineBefore = this.element.querySelector('.protyle-gutters__line[data-type="gutterLineBefore"]') as HTMLElement;
            const lineAfter = this.element.querySelector('.protyle-gutters__line[data-type="gutterLineAfter"]') as HTMLElement;
            const plusBefore = this.element.querySelector('.protyle-gutters__plus[data-type="gutterPlusBefore"]') as HTMLElement;
            const plusAfter = this.element.querySelector('.protyle-gutters__plus[data-type="gutterPlusAfter"]') as HTMLElement;
            if (protyle.disabled || !lineBefore || !lineAfter || !plusBefore || !plusAfter) {
                return;
            }
            // 情况A：鼠标在框线或+号上 → 显示对应+号，框线设透明（视觉隐藏但保留命中区，避免 display:none 导致脱离触发重置闪烁）
            const lineEl = hasClosestByClassName(event.target, "protyle-gutters__line");
            const plusEl = hasClosestByClassName(event.target, "protyle-gutters__plus");
            const hoverEl = lineEl || plusEl;
            if (hoverEl) {
                window.clearTimeout(hidePlusTimeout);
                // 鼠标若仍在块标 button 几何范围内，视为块标 hover，不触发+号
                // 避免框线::before 扩展区侵入块标导致误把点击块标弹菜单变成插入块
                if (activeBlockButton) {
                    const br = activeBlockButton.getBoundingClientRect();
                    if (event.clientX >= br.left && event.clientX <= br.right &&
                        event.clientY >= br.top && event.clientY <= br.bottom) {
                        return;
                    }
                }
                const isBefore = hoverEl.getAttribute("data-type").includes("Before");
                plusBefore.style.display = isBefore ? "" : "none";
                plusAfter.style.display = isBefore ? "none" : "";
                // 框线视觉隐藏（opacity:0），但 display 保持以维持命中区
                lineBefore.style.opacity = "0";
                lineAfter.style.opacity = "0";
                return;
            }
            const buttonElement = hasClosestByTag(event.target, "BUTTON");
            if (!buttonElement || buttonElement.classList.contains("protyle-gutters__line") || buttonElement.classList.contains("protyle-gutters__plus")) {
                return;
            }
            const type = buttonElement.getAttribute("data-type");
            const id = buttonElement.getAttribute("data-node-id");
            // 情况C：非有效块标（折叠箭头、数据库行等）→ 隐藏框线与+号
            if (type === "fold" || type === "NodeAttributeViewRow" || type === "NodeAttributeViewRowMenu" || !id) {
                hideInsert();
                return;
            }
            // 情况B：悬浮有效块标 → 显示框线（贴边），并预设+号位置（隐藏）
            plusBefore.dataset.nodeId = id;
            plusAfter.dataset.nodeId = id;
            activeBlockButton = buttonElement;
            const rect = buttonElement.getBoundingClientRect();
            const compressed = this.element.style.width === "24px";
            // 竖排时不显示+号提示（清空 aria-label 避免触发 tooltip），横排时恢复
            plusBefore.setAttribute("aria-label", compressed ? "" : gutterText(protyle, "insertBefore"));
            plusAfter.setAttribute("aria-label", compressed ? "" : gutterText(protyle, "insertAfter"));
            plusBefore.style.display = "none";
            plusAfter.style.display = "none";
            if (compressed) {
                // 竖排：压缩模式块标贴编辑区左缘，左侧紧邻 .layout__resize--lr 分栏拖拽条（z-index 4）
                // 若 lineBefore/plusBefore 按横排逻辑外延到块标左侧，鼠标移入该区会被分栏拖拽条抢占悬浮，
                // 导致加号无法触发。故竖排时上方/下方插入指示均置于块标右侧，上下以纵向位置区分：
                // 上方插入指示贴图标右缘上半段，下方插入指示贴图标右缘下半段，完全避开左侧拖拽条命中区。
                const iconRect = buttonElement.querySelector("svg").getBoundingClientRect();
                const centerY = iconRect.top + iconRect.height / 2;
                const lineH = Math.max(8, iconRect.height / 2 - 1);
                const plusSize = 16;
                // 线条/加号需落在 button rect（rect.right）外，否则 case A 会判定鼠标仍在块标内而不触发加号
                const rightX = rect.right + 1;
                // 上方插入：块标右侧上半段
                lineBefore.style.display = "";
                lineBefore.style.opacity = "1";
                lineBefore.style.width = "2px";
                lineBefore.style.height = `${lineH}px`;
                lineBefore.style.left = `${rightX}px`;
                lineBefore.style.top = `${iconRect.top - 1}px`;
                // 下方插入：块标右侧下半段
                lineAfter.style.display = "";
                lineAfter.style.opacity = "1";
                lineAfter.style.width = "2px";
                lineAfter.style.height = `${lineH}px`;
                lineAfter.style.left = `${rightX}px`;
                lineAfter.style.top = `${centerY + 1}px`;
                // +号位于右侧线条外偏，上下分开避免重叠
                plusBefore.style.width = `${plusSize}px`;
                plusBefore.style.height = `${plusSize}px`;
                plusBefore.style.left = `${rightX + 4}px`;
                plusBefore.style.top = `${iconRect.top + lineH / 2 - plusSize / 2}px`;
                plusAfter.style.width = `${plusSize}px`;
                plusAfter.style.height = `${plusSize}px`;
                plusAfter.style.left = `${rightX + 4}px`;
                plusAfter.style.top = `${centerY + 1 + lineH / 2 - plusSize / 2}px`;
                // 竖排时隐藏块标提示，避免其遮挡右侧框线与+号
                hideTooltip(protyle);
            } else {
                // 横排：框线贴块标上下边缘，+号定位在外偏位置
                const lineW = 10;
                const left = rect.left + (rect.width - lineW) / 2;
                const plusSize = 16;
                const plusLeft = rect.left + (rect.width - plusSize) / 2;
                lineBefore.style.display = "";
                lineBefore.style.opacity = "1";
                lineBefore.style.width = `${lineW}px`;
                lineBefore.style.height = "2px";
                lineBefore.style.left = `${left}px`;
                lineBefore.style.top = `${rect.top - 4}px`;
                lineAfter.style.display = "";
                lineAfter.style.opacity = "1";
                lineAfter.style.width = `${lineW}px`;
                lineAfter.style.height = "2px";
                lineAfter.style.left = `${left}px`;
                lineAfter.style.top = `${rect.bottom + 2}px`;
                plusBefore.style.width = `${plusSize}px`;
                plusBefore.style.height = `${plusSize}px`;
                plusBefore.style.left = `${plusLeft}px`;
                plusBefore.style.top = `${rect.top - 5 - plusSize / 2 + 1}px`;
                plusAfter.style.width = `${plusSize}px`;
                plusAfter.style.height = `${plusSize}px`;
                plusAfter.style.left = `${plusLeft}px`;
                plusAfter.style.top = `${rect.bottom + 3 - plusSize / 2 + 1}px`;
            }
            window.clearTimeout(hidePlusTimeout);
        });
        // https://github.com/siyuan-note/siyuan/issues/12751
        this.element.addEventListener("mousewheel", (event) => {
            hideElements(["gutter"], protyle);
            event.stopPropagation();
        }, {passive: true});
    }

    public isMatchNode(item: Element) {
        const itemRect = item.getBoundingClientRect();
        // 原本为4，由于 https://github.com/siyuan-note/siyuan/issues/12166 改为 6
        let gutterTop = this.element.getBoundingClientRect().top + 6;
        if (itemRect.height < Math.floor(protyle.settings.editor.fontSize * 1.625) + 8) {
            gutterTop = gutterTop - (itemRect.height - this.element.clientHeight) / 2;
        }
        return itemRect.top <= gutterTop && itemRect.bottom >= gutterTop;
    }

    private turnsOneInto(options: {
        menuId?: string,
        id: string,
        icon: string,
        label: string,
        protyle: IProtyle,
        nodeElement: Element,
        accelerator?: string
        type: string,
        level?: number
    }) {
        return {
            id: options.menuId,
            icon: options.icon,
            label: options.label,
            accelerator: options.accelerator,
            click() {
                turnsOneInto(options);
            }
        };
    }

    private turnsIntoOne(options: {
        menuId?: string,
        accelerator?: string,
        icon?: string,
        label: string,
        protyle: IProtyle,
        selectsElement: Element[],
        type: TTurnIntoOne,
        level?: TTurnIntoOneSub,
    }) {
        return {
            id: options.menuId,
            icon: options.icon,
            label: options.label,
            accelerator: options.accelerator,
            click() {
                turnsIntoOneTransaction(options);
            }
        };
    }

    private turnsInto(options: {
        menuId?: string,
        icon?: string,
        label: string,
        protyle: IProtyle,
        selectsElement: Element[],
        type: TTurnInto,
        level?: number,
        isContinue?: boolean,
        accelerator?: string,
    }) {
        return {
            id: options.menuId,
            icon: options.icon,
            label: options.label,
            accelerator: options.accelerator,
            click() {
                turnsIntoTransaction(options);
            }
        };
    }

    public renderMultipleMenu(protyle: IProtyle, selectsElement: Element[]) {
        const menu = this.openMenu(protyle);
        const identity = protyleContentIdentity(protyle);
        menu.element.setAttribute("data-name", Constants.MENU_BLOCK_MULTI);
        let isList = false;
        let isContinue = false;
        selectsElement.find((item, index) => {
            if (item.classList.contains("li")) {
                isList = true;
                return true;
            }
            if (item.nextElementSibling && selectsElement[index + 1] &&
                item.nextElementSibling === selectsElement[index + 1]) {
                isContinue = true;
            } else if (index !== selectsElement.length - 1) {
                isContinue = false;
                return true;
            }
        });
        if (!isList && !protyle.disabled) {
            const turnIntoSubmenu: IMenu[] = [];
            if (isContinue) {
                turnIntoSubmenu.push(this.turnsIntoOne({
                    menuId: "list",
                    icon: "iconList",
                    label: gutterText(protyle, "list"),
                    protyle,
                    accelerator: protyle.settings.hotkeys.editor.insert.list,
                    selectsElement,
                    type: "Blocks2ULs"
                }));
                turnIntoSubmenu.push(this.turnsIntoOne({
                    menuId: "orderedList",
                    icon: "iconOrderedList",
                    label: gutterText(protyle, "ordered-list"),
                    accelerator: protyle.settings.hotkeys.editor.insert.orderedList,
                    protyle,
                    selectsElement,
                    type: "Blocks2OLs"
                }));
                turnIntoSubmenu.push(this.turnsIntoOne({
                    menuId: "check",
                    icon: "iconCheck",
                    label: gutterText(protyle, "check"),
                    accelerator: protyle.settings.hotkeys.editor.insert.check,
                    protyle,
                    selectsElement,
                    type: "Blocks2TLs"
                }));
                turnIntoSubmenu.push(this.turnsIntoOne({
                    menuId: "quote",
                    icon: "iconQuote",
                    label: gutterText(protyle, "quote"),
                    accelerator: protyle.settings.hotkeys.editor.insert.quote,
                    protyle,
                    selectsElement,
                    type: "Blocks2Blockquote"
                }));
                turnIntoSubmenu.push(this.turnsIntoOne({
                    menuId: "callout",
                    icon: "iconCallout",
                    label: gutterText(protyle, "callout"),
                    protyle,
                    selectsElement,
                    type: "Blocks2Callout"
                }));
            }
            turnIntoSubmenu.push(this.turnsInto({
                menuId: "paragraph",
                icon: "iconParagraph",
                label: gutterText(protyle, "paragraph"),
                accelerator: protyle.settings.hotkeys.editor.heading.paragraph,
                protyle,
                selectsElement,
                type: "Blocks2Ps",
                isContinue
            }));
            turnIntoSubmenu.push(this.turnsInto({
                menuId: "heading1",
                icon: "iconH1",
                label: gutterText(protyle, "heading1"),
                accelerator: protyle.settings.hotkeys.editor.heading.heading1,
                protyle,
                selectsElement,
                level: 1,
                type: "Blocks2Hs",
                isContinue
            }));
            turnIntoSubmenu.push(this.turnsInto({
                menuId: "heading2",
                icon: "iconH2",
                label: gutterText(protyle, "heading2"),
                accelerator: protyle.settings.hotkeys.editor.heading.heading2,
                protyle,
                selectsElement,
                level: 2,
                type: "Blocks2Hs",
                isContinue
            }));
            turnIntoSubmenu.push(this.turnsInto({
                menuId: "heading3",
                icon: "iconH3",
                label: gutterText(protyle, "heading3"),
                accelerator: protyle.settings.hotkeys.editor.heading.heading3,
                protyle,
                selectsElement,
                level: 3,
                type: "Blocks2Hs",
                isContinue
            }));
            turnIntoSubmenu.push(this.turnsInto({
                menuId: "heading4",
                icon: "iconH4",
                label: gutterText(protyle, "heading4"),
                accelerator: protyle.settings.hotkeys.editor.heading.heading4,
                protyle,
                selectsElement,
                level: 4,
                type: "Blocks2Hs",
                isContinue
            }));
            turnIntoSubmenu.push(this.turnsInto({
                menuId: "heading5",
                icon: "iconH5",
                label: gutterText(protyle, "heading5"),
                accelerator: protyle.settings.hotkeys.editor.heading.heading5,
                protyle,
                selectsElement,
                level: 5,
                type: "Blocks2Hs",
                isContinue
            }));
            turnIntoSubmenu.push(this.turnsInto({
                menuId: "heading6",
                icon: "iconH6",
                label: gutterText(protyle, "heading6"),
                accelerator: protyle.settings.hotkeys.editor.heading.heading6,
                protyle,
                selectsElement,
                level: 6,
                type: "Blocks2Hs",
                isContinue
            }));
            this.menu.addItem({
                id: "turnInto",
                icon: "iconTurnInto",
                label: gutterText(protyle, "turnInto"),
                type: "submenu",
                submenu: turnIntoSubmenu
            });
            if (isContinue && !(selectsElement[0].parentElement.classList.contains("sb") &&
                selectsElement.length + 1 === selectsElement[0].parentElement.childElementCount)) {
                this.menu.addItem({
                    id: "mergeSuperBlock",
                    icon: "iconSuper",
                    label: gutterText(protyle, "merge") + " " + gutterText(protyle, "superBlock"),
                    type: "submenu",
                    submenu: [this.turnsIntoOne({
                        menuId: "hLayout",
                        label: gutterText(protyle, "hLayout"),
                        accelerator: protyle.settings.hotkeys.editor.general.hLayout,
                        icon: "iconSplitLR",
                        protyle,
                        selectsElement,
                        type: "BlocksMergeSuperBlock",
                        level: "col"
                    }), this.turnsIntoOne({
                        menuId: "vLayout",
                        label: gutterText(protyle, "vLayout"),
                        accelerator: protyle.settings.hotkeys.editor.general.vLayout,
                        icon: "iconSplitTB",
                        protyle,
                        selectsElement,
                        type: "BlocksMergeSuperBlock",
                        level: "row"
                    })]
                });
            }
        }
        if (!protyle.disabled && protyle.settings.features.aiActions) {
            this.menu.addItem({
                id: "ai",
                icon: "iconSparkles",
                label: gutterText(protyle, "aiEdit"),
                accelerator: protyle.settings.hotkeys.editor.general.ai,
                click() {
                    protyle.host.dispatch({
                        type: "open-ai-actions",
                        documentId: identity.documentId,
                        notebookId: identity.notebookId,
                        blockIds: selectsElement.map((item) => item.getAttribute("data-node-id")!),
                    });
                }
            });
        }
        const copyMenu: IMenu[] = createBlockCopyMenu({
            blockIds: selectsElement.map((item) => item.getAttribute("data-node-id")!),
            focusElement: selectsElement[0],
            protyle,
        }).concat([{
            id: "copyPlainText",
            iconHTML: "",
            label: gutterText(protyle, "copyPlainText"),
            accelerator: protyle.settings.hotkeys.editor.general.copyPlainText,
            click() {
                let html = "";
                selectsElement.forEach((item: HTMLElement) => {
                    html += getPlainText(item) + "\n";
                });
                copyPlainText(html.trimEnd());
                focusBlock(selectsElement[0]);
            }
        }, {
            id: "copy",
            iconHTML: "",
            label: gutterText(protyle, "copy"),
            accelerator: "⌘C",
            click() {
                if (isNotEditBlock(selectsElement[0])) {
                    focusBlock(selectsElement[0]);
                } else {
                    focusByRange(getEditorRange(selectsElement[0]));
                }
                document.execCommand("copy");
            }
        }]);
        const copyTextRefMenu = this.genCopyTextRef(selectsElement);
        if (copyTextRefMenu) {
            copyMenu.splice(7, 0, copyTextRefMenu);
        }
        if (!protyle.disabled) {
            copyMenu.push({
                id: "duplicate",
                iconHTML: "",
                label: gutterText(protyle, "duplicate"),
                accelerator: protyle.settings.hotkeys.editor.general.duplicate,
                click() {
                    duplicateBlock(selectsElement, protyle);
                }
            });
        }
        this.menu.addItem({
            id: "copy",
            label: gutterText(protyle, "copy"),
            icon: "iconCopy",
            type: "submenu",
            submenu: copyMenu,
        });
        if (!protyle.disabled) {
            this.menu.addItem({
                id: "cut",
                label: gutterText(protyle, "cut"),
                accelerator: "⌘X",
                icon: "iconCut",
                click: () => {
                    focusBlock(selectsElement[0]);
                    document.execCommand("cut");
                }
            });
            if (protyle.settings.features.blockMove) {
                this.menu.addItem({
                    id: "move",
                    label: gutterText(protyle, "move"),
                    accelerator: protyle.settings.hotkeys.general.move,
                    icon: "iconMove",
                    click: () => protyle.host.dispatch({
                        type: "open-block-move",
                        documentId: identity.documentId,
                        notebookId: identity.notebookId,
                        blockIds: selectsElement.map((item) => item.getAttribute("data-node-id")!),
                    }),
                });
            }
            this.menu.addItem({
                id: "addToDatabase",
                label: gutterText(protyle, "addToDatabase"),
                accelerator: protyle.settings.hotkeys.general.addToDatabase,
                icon: "iconDatabase",
                click: () => {
                    addEditorToDatabase(protyle, getEditorRange(selectsElement[0]));
                }
            });
            this.menu.addItem({
                id: "addToAgent",
                icon: "iconSend",
                label: gutterText(protyle, "addToAgent"),
                click: () => {
                    protyle.host.dispatch({
                        type: "add-blocks-to-agent",
                        documentId: identity.documentId,
                        notebookId: identity.notebookId,
                        blockIds: Array.from(selectsElement).map(item => item.getAttribute("data-node-id")!),
                    });
                }
            });
            this.menu.addItem({
                id: "delete",
                label: gutterText(protyle, "delete"),
                icon: "iconTrashcan",
                accelerator: "⌫",
                click: () => {
                    protyle.breadcrumb?.hide();
                    removeBlock(protyle, selectsElement[0], getEditorRange(selectsElement[0]), "Backspace");
                }
            });

            this.menu.addItem({id: "separator_appearance", type: "separator"});
            const appearanceElement = this.menu.addItem({
                id: "appearance",
                label: gutterText(protyle, "appearance"),
                icon: "iconFont",
                accelerator: protyle.settings.toolbar.hotkeys.appearance,
                click: () => {
                    protyle.toolbar.element.classList.add("fn__none");
                    protyle.toolbar.subElement.innerHTML = "";
                    protyle.toolbar.subElement.style.width = "";
                    protyle.toolbar.subElement.style.padding = "";
                    protyle.toolbar.subElement.append(appearanceMenu(protyle, selectsElement));
                    protyle.toolbar.activateOverlay();
                    protyle.toolbar.subElement.classList.remove("fn__none");
                    protyle.toolbar.subElementCloseCB = undefined;
                    const position = selectsElement[0].getBoundingClientRect();
                    positionElementInViewport(protyle.toolbar.subElement, position.left, position.top);
                }
            })!;
            if (!isNarrowViewport()) {
                appearanceElement.lastElementChild.classList.add("b3-menu__submenu--row");
            }
            this.genAlign(selectsElement, protyle);
            this.genWidths(selectsElement, protyle);
            // this.genHeights(selectsElement, protyle);
        }
        if (!protyle.disabled &&
            (protyle.settings.features.quickFlashcard || protyle.settings.features.flashcardDeck)) {
            this.menu.addItem({
                id: "separator_quickMakeCard",
                type: "separator"
            });
            if (protyle.settings.features.quickFlashcard) {
                const allCardsMade = !selectsElement.some(item =>
                    !item.hasAttribute(Constants.CUSTOM_RIFF_DECKS) &&
                    item.getAttribute("data-type") !== "NodeThematicBreak");
                this.menu.addItem({
                    id: allCardsMade ? "removeCard" : "quickMakeCard",
                    label: allCardsMade ? gutterText(protyle, "removeCard") : gutterText(protyle, "quickMakeCard"),
                    accelerator: protyle.settings.hotkeys.editor.general.quickMakeCard,
                    icon: "iconRiffCard",
                    click: () => toggleQuickFlashcards(protyle, selectsElement),
                });
            }
            if (protyle.settings.features.flashcardDeck) {
                this.menu.addItem({
                    id: "addToDeck",
                    label: gutterText(protyle, "addToDeck"),
                    icon: "iconRiffCard",
                    click() {
                        const ids = selectsElement
                            .filter((item) => item.getAttribute("data-type") !== "NodeThematicBreak")
                            .map((item) => item.getAttribute("data-node-id")!);
                        protyle.host.dispatch({
                            type: "open-card-deck-picker",
                            documentId: identity.documentId,
                            notebookId: identity.notebookId,
                            blockIds: ids,
                        });
                    }
                });
            }
        }

        emitProtylePluginMenu({
            detail: {protyle, blockElements: selectsElement},
            localization: protyle.localization,
            menu,
            plugins: protyle.plugins,
            separatorPosition: "top",
            type: "click-blockicon",
        });

        return menu;
    }

    public renderMenu(protyle: IProtyle, buttonElement: Element) {
        if (!buttonElement) {
            return;
        }
        hideElements(["util", "toolbar", "hint"], protyle);
        this.closeMenu();
        if (isNarrowViewport()) {
            (document.activeElement as HTMLElement).blur();
        }
        const id = buttonElement.getAttribute("data-node-id");
        const selectsElement = protyle.wysiwyg.element.querySelectorAll(".protyle-wysiwyg--select");
        if (selectsElement.length > 1) {
            const match = Array.from(selectsElement).find(item => {
                if (id === item.getAttribute("data-node-id")) {
                    return true;
                }
            });
            if (match) {
                return this.renderMultipleMenu(protyle, Array.from(selectsElement));
            }
        }

        let nodeElement: Element;
        if (buttonElement.tagName === "BUTTON") {
            Array.from(protyle.wysiwyg.element.querySelectorAll(`[data-node-id="${id}"]`)).find(item => {
                if (!isInEmbedBlock(item) && this.isMatchNode(item)) {
                    nodeElement = item;
                    return true;
                }
            });
        } else {
            nodeElement = buttonElement;
        }
        if (!nodeElement) {
            return;
        }
        const menu = this.openMenu(protyle);
        const identity = protyleContentIdentity(protyle);
        const closeMenu = () => this.closeMenu();
        menu.element.setAttribute("data-name", Constants.MENU_BLOCK_SINGLE);
        const type = nodeElement.getAttribute("data-type");
        const subType = nodeElement.getAttribute("data-subtype");
        const turnIntoSubmenu: IMenu[] = [];
        hideElements(["select"], protyle);
        nodeElement.classList.add("protyle-wysiwyg--select");
        countBlockStatistics(protyle, [id]);
        // "heading1-6", "list", "ordered-list", "check", "quote", "code", "table", "line", "math", "paragraph"
        if (type === "NodeParagraph" && !protyle.disabled) {
            turnIntoSubmenu.push(this.turnsIntoOne({
                menuId: "list",
                icon: "iconList",
                label: gutterText(protyle, "list"),
                accelerator: protyle.settings.hotkeys.editor.insert.list,
                protyle,
                selectsElement: [nodeElement],
                type: "Blocks2ULs"
            }));
            turnIntoSubmenu.push(this.turnsIntoOne({
                menuId: "orderedList",
                icon: "iconOrderedList",
                label: gutterText(protyle, "ordered-list"),
                accelerator: protyle.settings.hotkeys.editor.insert.orderedList,
                protyle,
                selectsElement: [nodeElement],
                type: "Blocks2OLs"
            }));
            turnIntoSubmenu.push(this.turnsIntoOne({
                menuId: "check",
                icon: "iconCheck",
                label: gutterText(protyle, "check"),
                accelerator: protyle.settings.hotkeys.editor.insert.check,
                protyle,
                selectsElement: [nodeElement],
                type: "Blocks2TLs"
            }));
            turnIntoSubmenu.push(this.turnsIntoOne({
                menuId: "quote",
                icon: "iconQuote",
                label: gutterText(protyle, "quote"),
                accelerator: protyle.settings.hotkeys.editor.insert.quote,
                protyle,
                selectsElement: [nodeElement],
                type: "Blocks2Blockquote"
            }));
            turnIntoSubmenu.push(this.turnsIntoOne({
                menuId: "callout",
                icon: "iconCallout",
                label: gutterText(protyle, "callout"),
                protyle,
                selectsElement: [nodeElement],
                type: "Blocks2Callout"
            }));
            turnIntoSubmenu.push(this.turnsInto({
                menuId: "heading1",
                icon: "iconH1",
                label: gutterText(protyle, "heading1"),
                accelerator: protyle.settings.hotkeys.editor.heading.heading1,
                protyle,
                selectsElement: [nodeElement],
                level: 1,
                type: "Blocks2Hs",
            }));
            turnIntoSubmenu.push(this.turnsInto({
                menuId: "heading2",
                icon: "iconH2",
                label: gutterText(protyle, "heading2"),
                accelerator: protyle.settings.hotkeys.editor.heading.heading2,
                protyle,
                selectsElement: [nodeElement],
                level: 2,
                type: "Blocks2Hs",
            }));
            turnIntoSubmenu.push(this.turnsInto({
                menuId: "heading3",
                icon: "iconH3",
                label: gutterText(protyle, "heading3"),
                accelerator: protyle.settings.hotkeys.editor.heading.heading3,
                protyle,
                selectsElement: [nodeElement],
                level: 3,
                type: "Blocks2Hs",
            }));
            turnIntoSubmenu.push(this.turnsInto({
                menuId: "heading4",
                icon: "iconH4",
                label: gutterText(protyle, "heading4"),
                accelerator: protyle.settings.hotkeys.editor.heading.heading4,
                protyle,
                selectsElement: [nodeElement],
                level: 4,
                type: "Blocks2Hs",
            }));
            turnIntoSubmenu.push(this.turnsInto({
                menuId: "heading5",
                icon: "iconH5",
                label: gutterText(protyle, "heading5"),
                accelerator: protyle.settings.hotkeys.editor.heading.heading5,
                protyle,
                selectsElement: [nodeElement],
                level: 5,
                type: "Blocks2Hs",
            }));
            turnIntoSubmenu.push(this.turnsInto({
                menuId: "heading6",
                icon: "iconH6",
                label: gutterText(protyle, "heading6"),
                accelerator: protyle.settings.hotkeys.editor.heading.heading6,
                protyle,
                selectsElement: [nodeElement],
                level: 6,
                type: "Blocks2Hs",
            }));
        } else if (type === "NodeHeading" && !protyle.disabled) {
            turnIntoSubmenu.push(this.turnsInto({
                menuId: "paragraph",
                icon: "iconParagraph",
                label: gutterText(protyle, "paragraph"),
                accelerator: protyle.settings.hotkeys.editor.heading.paragraph,
                protyle,
                selectsElement: [nodeElement],
                type: "Blocks2Ps",
            }));
            turnIntoSubmenu.push(this.turnsIntoOne({
                menuId: "quote",
                icon: "iconQuote",
                label: gutterText(protyle, "quote"),
                accelerator: protyle.settings.hotkeys.editor.insert.quote,
                protyle,
                selectsElement: [nodeElement],
                type: "Blocks2Blockquote"
            }));
            turnIntoSubmenu.push(this.turnsIntoOne({
                menuId: "callout",
                icon: "iconCallout",
                label: gutterText(protyle, "callout"),
                protyle,
                selectsElement: [nodeElement],
                type: "Blocks2Callout"
            }));
            if (subType !== "h1") {
                turnIntoSubmenu.push(this.turnsInto({
                    menuId: "heading1",
                    icon: "iconH1",
                    label: gutterText(protyle, "heading1"),
                    accelerator: protyle.settings.hotkeys.editor.heading.heading1,
                    protyle,
                    selectsElement: [nodeElement],
                    level: 1,
                    type: "Blocks2Hs",
                }));
            }
            if (subType !== "h2") {
                turnIntoSubmenu.push(this.turnsInto({
                    menuId: "heading2",
                    icon: "iconH2",
                    label: gutterText(protyle, "heading2"),
                    accelerator: protyle.settings.hotkeys.editor.heading.heading2,
                    protyle,
                    selectsElement: [nodeElement],
                    level: 2,
                    type: "Blocks2Hs",
                }));
            }
            if (subType !== "h3") {
                turnIntoSubmenu.push(this.turnsInto({
                    menuId: "heading3",
                    icon: "iconH3",
                    label: gutterText(protyle, "heading3"),
                    accelerator: protyle.settings.hotkeys.editor.heading.heading3,
                    protyle,
                    selectsElement: [nodeElement],
                    level: 3,
                    type: "Blocks2Hs",
                }));
            }
            if (subType !== "h4") {
                turnIntoSubmenu.push(this.turnsInto({
                    menuId: "heading4",
                    icon: "iconH4",
                    label: gutterText(protyle, "heading4"),
                    accelerator: protyle.settings.hotkeys.editor.heading.heading4,
                    protyle,
                    selectsElement: [nodeElement],
                    level: 4,
                    type: "Blocks2Hs",
                }));
            }
            if (subType !== "h5") {
                turnIntoSubmenu.push(this.turnsInto({
                    menuId: "heading5",
                    icon: "iconH5",
                    label: gutterText(protyle, "heading5"),
                    accelerator: protyle.settings.hotkeys.editor.heading.heading5,
                    protyle,
                    selectsElement: [nodeElement],
                    level: 5,
                    type: "Blocks2Hs",
                }));
            }
            if (subType !== "h6") {
                turnIntoSubmenu.push(this.turnsInto({
                    menuId: "heading6",
                    icon: "iconH6",
                    label: gutterText(protyle, "heading6"),
                    accelerator: protyle.settings.hotkeys.editor.heading.heading6,
                    protyle,
                    selectsElement: [nodeElement],
                    level: 6,
                    type: "Blocks2Hs",
                }));
            }
        } else if (type === "NodeList" && !protyle.disabled) {
            turnIntoSubmenu.push(this.turnsOneInto({
                menuId: "paragraph",
                id,
                icon: "iconParagraph",
                label: gutterText(protyle, "paragraph"),
                accelerator: protyle.settings.hotkeys.editor.heading.paragraph,
                protyle,
                nodeElement,
                type: "CancelList"
            }));
            turnIntoSubmenu.push(this.turnsIntoOne({
                menuId: "quote",
                icon: "iconQuote",
                label: gutterText(protyle, "quote"),
                accelerator: protyle.settings.hotkeys.editor.insert.quote,
                protyle,
                selectsElement: [nodeElement],
                type: "Blocks2Blockquote"
            }));
            turnIntoSubmenu.push(this.turnsIntoOne({
                menuId: "callout",
                icon: "iconCallout",
                label: gutterText(protyle, "callout"),
                protyle,
                selectsElement: [nodeElement],
                type: "Blocks2Callout"
            }));
            if (nodeElement.getAttribute("data-subtype") === "o") {
                turnIntoSubmenu.push(this.turnsOneInto({
                    menuId: "list",
                    id,
                    icon: "iconList",
                    label: gutterText(protyle, "list"),
                    accelerator: protyle.settings.hotkeys.editor.insert.list,
                    protyle,
                    nodeElement,
                    type: "OL2UL"
                }));
                turnIntoSubmenu.push(this.turnsOneInto({
                    menuId: "check",
                    id,
                    icon: "iconCheck",
                    label: gutterText(protyle, "check"),
                    accelerator: protyle.settings.hotkeys.editor.insert.check,
                    protyle,
                    nodeElement,
                    type: "UL2TL"
                }));
            } else if (nodeElement.getAttribute("data-subtype") === "t") {
                turnIntoSubmenu.push(this.turnsOneInto({
                    menuId: "list",
                    id,
                    icon: "iconList",
                    label: gutterText(protyle, "list"),
                    accelerator: protyle.settings.hotkeys.editor.insert.list,
                    protyle,
                    nodeElement,
                    type: "TL2UL"
                }));
                turnIntoSubmenu.push(this.turnsOneInto({
                    menuId: "orderedList",
                    id,
                    icon: "iconOrderedList",
                    label: gutterText(protyle, "ordered-list"),
                    accelerator: protyle.settings.hotkeys.editor.insert.orderedList,
                    protyle,
                    nodeElement,
                    type: "TL2OL"
                }));
            } else {
                turnIntoSubmenu.push(this.turnsOneInto({
                    menuId: "orderedList",
                    id,
                    icon: "iconOrderedList",
                    label: gutterText(protyle, "ordered-list"),
                    accelerator: protyle.settings.hotkeys.editor.insert.orderedList,
                    protyle,
                    nodeElement,
                    type: "UL2OL"
                }));
                turnIntoSubmenu.push(this.turnsOneInto({
                    menuId: "check",
                    id,
                    icon: "iconCheck",
                    label: gutterText(protyle, "check"),
                    accelerator: protyle.settings.hotkeys.editor.insert.check,
                    protyle,
                    nodeElement,
                    type: "OL2TL"
                }));
            }
        } else if (type === "NodeBlockquote" && !protyle.disabled) {
            turnIntoSubmenu.push(this.turnsOneInto({
                menuId: "paragraph",
                id,
                icon: "iconParagraph",
                label: gutterText(protyle, "paragraph"),
                accelerator: protyle.settings.hotkeys.editor.heading.paragraph,
                protyle,
                nodeElement,
                type: "CancelBlockquote"
            }));
            turnIntoSubmenu.push(this.turnsOneInto({
                id,
                icon: "iconCallout",
                label: gutterText(protyle, "callout"),
                protyle,
                nodeElement,
                type: "Blockquote2Callout"
            }));
        } else if (type === "NodeCallout" && !protyle.disabled) {
            turnIntoSubmenu.push(this.turnsOneInto({
                menuId: "paragraph",
                id,
                icon: "iconParagraph",
                label: gutterText(protyle, "paragraph"),
                accelerator: protyle.settings.hotkeys.editor.heading.paragraph,
                protyle,
                nodeElement,
                type: "CancelCallout"
            }));
            turnIntoSubmenu.push(this.turnsOneInto({
                id,
                icon: "iconQuote",
                label: gutterText(protyle, "quote"),
                protyle,
                nodeElement,
                type: "Callout2Blockquote"
            }));
        }
        if (turnIntoSubmenu.length > 0 && !protyle.disabled) {
            this.menu.addItem({
                id: "turnInto",
                icon: "iconTurnInto",
                label: gutterText(protyle, "turnInto"),
                type: "submenu",
                submenu: turnIntoSubmenu
            });
        }
        if (!protyle.disabled && !nodeElement.classList.contains("hr") && protyle.settings.features.aiActions) {
            this.menu.addItem({
                id: "ai",
                icon: "iconSparkles",
                label: gutterText(protyle, "aiEdit"),
                accelerator: protyle.settings.hotkeys.editor.general.ai,
                click() {
                    protyle.host.dispatch({
                        type: "open-ai-actions",
                        documentId: identity.documentId,
                        notebookId: identity.notebookId,
                        blockIds: [id],
                    });
                }
            });
        }

        const copyMenu = createBlockCopyMenu({blockIds: [id], focusElement: nodeElement, protyle}).concat([{
            id: "copyPlainText",
            iconHTML: "",
            label: gutterText(protyle, "copyPlainText"),
            accelerator: protyle.settings.hotkeys.editor.general.copyPlainText,
            click() {
                copyPlainText(getPlainText(nodeElement as HTMLElement).trimEnd());
                focusBlock(nodeElement);
            }
        }, {
            id: type === "NodeAttributeView" ? "copyMirror" : "copy",
            iconHTML: "",
            label: type === "NodeAttributeView" ? gutterText(protyle, "copyMirror") : gutterText(protyle, "copy"),
            accelerator: "⌘C",
            click() {
                if (isNotEditBlock(nodeElement)) {
                    focusBlock(nodeElement);
                } else {
                    focusByRange(getEditorRange(nodeElement));
                }
                document.execCommand("copy");
            }
        }]);
        const copyTextRefMenu = this.genCopyTextRef([nodeElement]);
        if (copyTextRefMenu) {
            copyMenu.splice(7, 0, copyTextRefMenu);
        }
        if (type === "NodeAttributeView") {
            copyMenu.splice(6, 0, {
                iconHTML: "",
                label: gutterText(protyle, "copyAVID"),
                click: () => writeText(nodeElement.getAttribute("data-av-id")),
            });
            if (!protyle.disabled) {
                copyMenu.push({
                    id: "duplicateMirror",
                    iconHTML: "",
                    label: gutterText(protyle, "duplicateMirror"),
                    accelerator: protyle.settings.hotkeys.editor.general.duplicate,
                    click() {
                        duplicateBlock([nodeElement], protyle);
                    }
                });
                copyMenu.push({
                    id: "duplicateCompletely",
                    iconHTML: "",
                    label: gutterText(protyle, "duplicateCompletely"),
                    accelerator: protyle.settings.hotkeys.editor.general.duplicateCompletely,
                    click() {
                        duplicateCompletely(protyle, nodeElement as HTMLElement);
                    }
                });
            }
        } else if (!protyle.disabled) {
            copyMenu.push({
                id: "duplicate",
                iconHTML: "",
                label: gutterText(protyle, "duplicate"),
                accelerator: protyle.settings.hotkeys.editor.general.duplicate,
                click() {
                    duplicateBlock([nodeElement], protyle);
                }
            });
        }
        this.menu.addItem({
            id: "copy",
            icon: "iconCopy",
            label: gutterText(protyle, "copy"),
            type: "submenu",
            submenu: copyMenu
        });
        if (!protyle.disabled) {
            this.menu.addItem({
                id: "cut",
                icon: "iconCut",
                label: gutterText(protyle, "cut"),
                accelerator: "⌘X",
                click: () => {
                    focusBlock(nodeElement);
                    document.execCommand("cut");
                }
            });
            if (protyle.settings.features.blockMove) {
                this.menu.addItem({
                    id: "move",
                    icon: "iconMove",
                    label: gutterText(protyle, "move"),
                    accelerator: protyle.settings.hotkeys.general.move,
                    click: () => protyle.host.dispatch({
                        type: "open-block-move",
                        documentId: identity.documentId,
                        notebookId: identity.notebookId,
                        blockIds: [id],
                    }),
                });
            }
            this.menu.addItem({
                id: "addToDatabase",
                icon: "iconDatabase",
                label: gutterText(protyle, "addToDatabase"),
                accelerator: protyle.settings.hotkeys.general.addToDatabase,
                click: () => {
                    addEditorToDatabase(protyle, getEditorRange(nodeElement));
                }
            });
            this.menu.addItem({
                id: "addToAgent",
                icon: "iconSend",
                label: gutterText(protyle, "addToAgent"),
                click: () => {
                    protyle.host.dispatch({
                        type: "add-blocks-to-agent",
                        documentId: identity.documentId,
                        notebookId: identity.notebookId,
                        blockIds: [nodeElement.getAttribute("data-node-id")!],
                    });
                }
            });
            this.menu.addItem({
                id: "delete",
                icon: "iconTrashcan",
                label: gutterText(protyle, "delete"),
                accelerator: "⌫",
                click: () => {
                    protyle.breadcrumb?.hide();
                    removeBlock(protyle, nodeElement, getEditorRange(nodeElement), "Backspace");
                }
            });
        }
        if (type === "NodeSuperBlock" && !protyle.disabled) {
            this.menu.addItem({
                id: "separator_cancelSuperBlock",
                type: "separator"
            });
            const isCol = nodeElement.getAttribute("data-sb-layout") === "col";
            this.menu.addItem({
                id: "cancelSuperBlock",
                label: gutterText(protyle, "cancel") + " " + gutterText(protyle, "superBlock"),
                accelerator: protyle.settings.hotkeys.editor.general[isCol ? "hLayout" : "vLayout"],
                async click() {
                    const sbData = await cancelSB(protyle, nodeElement);
                    transaction(protyle, sbData.doOperations, sbData.undoOperations);
                    focusBlock(protyle.wysiwyg.element.querySelector(`[data-node-id="${sbData.previousId}"]`));
                    hideElements(["gutter"], protyle);
                }
            });
            this.menu.addItem({
                id: "turnInto" + (isCol ? "VLayout" : "HLayout"),
                accelerator: protyle.settings.hotkeys.editor.general[isCol ? "vLayout" : "hLayout"],
                label: gutterText(protyle, "turnInto") + " " + gutterText(protyle, isCol ? "vLayout" : "hLayout"),
                click() {
                    const oldHTML = nodeElement.outerHTML;
                    if (isCol) {
                        nodeElement.setAttribute("data-sb-layout", "row");
                    } else {
                        nodeElement.setAttribute("data-sb-layout", "col");
                    }
                    nodeElement.setAttribute("updated", dayjs().format("YYYYMMDDHHmmss"));
                    updateTransaction(protyle, nodeElement, oldHTML);
                    focusByRange(protyle.toolbar.range);
                    hideElements(["gutter"], protyle);
                }
            });
        } else if (type === "NodeCodeBlock" && !nodeElement.getAttribute("data-subtype")) {
            this.menu.addItem({id: "separator_code", type: "separator"});
            const linewrap = nodeElement.getAttribute("linewrap");
            const ligatures = nodeElement.getAttribute("ligatures");
            const linenumber = nodeElement.getAttribute("linenumber");

            this.menu.addItem({
                id: "code",
                type: "submenu",
                icon: "iconCode",
                label: gutterText(protyle, "code"),
                submenu: [{
                    id: "md31",
                    iconHTML: "",
                    ignore: protyle.disabled,
                    label: `<div class="fn__flex" style="margin-bottom: 4px"><span>${gutterText(protyle, "md31")}</span><span class="fn__space fn__flex-1"></span>
<input type="checkbox" class="b3-switch fn__flex-center"${linewrap === "true" ? " checked" : ((protyle.settings.editor.codeLineWrap && linewrap !== "false") ? " checked" : "")}></div>`,
                    bind(element) {
                        element.addEventListener("click", (event: MouseEvent & { target: HTMLElement }) => {
                            const inputElement = element.querySelector("input");
                            if (event.target.tagName !== "INPUT") {
                                inputElement.checked = !inputElement.checked;
                            }
                            nodeElement.setAttribute("linewrap", inputElement.checked.toString());
                            nodeElement.querySelector(".hljs").removeAttribute("data-render");
                            highlightRender(nodeElement, protyle);
                            submitGutterRequest(protyle, "/api/attr/setBlockAttrs", {
                                id,
                                attrs: {linewrap: inputElement.checked.toString()}
                            });
                            closeMenu();
                        });
                    }
                }, {
                    id: "md2",
                    iconHTML: "",
                    ignore: protyle.disabled,
                    label: `<div class="fn__flex" style="margin-bottom: 4px"><span>${gutterText(protyle, "md2")}</span><span class="fn__space fn__flex-1"></span>
<input type="checkbox" class="b3-switch fn__flex-center"${ligatures === "true" ? " checked" : ((protyle.settings.editor.codeLigatures && ligatures !== "false") ? " checked" : "")}></div>`,
                    bind(element) {
                        element.addEventListener("click", (event: MouseEvent & { target: HTMLElement }) => {
                            const inputElement = element.querySelector("input");
                            if (event.target.tagName !== "INPUT") {
                                inputElement.checked = !inputElement.checked;
                            }
                            nodeElement.setAttribute("ligatures", inputElement.checked.toString());
                            nodeElement.querySelector(".hljs").removeAttribute("data-render");
                            highlightRender(nodeElement, protyle);
                            submitGutterRequest(protyle, "/api/attr/setBlockAttrs", {
                                id,
                                attrs: {ligatures: inputElement.checked.toString()}
                            });
                            closeMenu();
                        });
                    }
                }, {
                    id: "md27",
                    iconHTML: "",
                    ignore: protyle.disabled,
                    label: `<div class="fn__flex" style="margin-bottom: 4px"><span>${gutterText(protyle, "md27")}</span><span class="fn__space fn__flex-1"></span>
<input type="checkbox" class="b3-switch fn__flex-center"${linenumber === "true" ? " checked" : ((protyle.settings.editor.codeSyntaxHighlightLineNum && linenumber !== "false") ? " checked" : "")}></div>`,
                    bind(element) {
                        element.addEventListener("click", (event: MouseEvent & { target: HTMLElement }) => {
                            const inputElement = element.querySelector("input");
                            if (event.target.tagName !== "INPUT") {
                                inputElement.checked = !inputElement.checked;
                            }
                            nodeElement.setAttribute("linenumber", inputElement.checked.toString());
                            nodeElement.querySelector(".hljs").removeAttribute("data-render");
                            highlightRender(nodeElement, protyle);
                            submitGutterRequest(protyle, "/api/attr/setBlockAttrs", {
                                id,
                                attrs: {linenumber: inputElement.checked.toString()}
                            });
                            closeMenu();
                        });
                    }
                }, {
                    id: "saveCodeBlockAsFile",
                    iconHTML: "",
                    label: gutterText(protyle, "saveCodeBlockAsFile"),
                    click() {
                        protyle.host.dispatch({
                            type: "notify",
                            level: "info",
                            message: gutterText(protyle, "exporting"),
                        });
                        return requestGutter(
                            protyle,
                            "/api/export/exportCodeBlock",
                            {id, notebook: protyle.notebookId},
                            "read",
                        ).then((response) => {
                            downloadExportFile(
                                protyle.session!.runtime.resources.resolveExport(identity, response.data.path),
                            );
                        }).catch((error) => {
                            reportGutterRequestFailure(protyle, "/api/export/exportCodeBlock", error);
                        });
                    }
                }]
            });
        } else if (type === "NodeCodeBlock" && !protyle.disabled && ["echarts", "mindmap"].includes(nodeElement.getAttribute("data-subtype"))) {
            this.menu.addItem({id: "separator_chart", type: "separator"});
            const height = (nodeElement as HTMLElement).style.height;
            let html = nodeElement.outerHTML;
            this.menu.addItem({
                id: "chart",
                label: gutterText(protyle, "chart"),
                icon: "iconCode",
                submenu: [{
                    id: "height",
                    iconHTML: "",
                    type: "readonly",
                    label: `<div class="fn__flex"><input class="b3-text-field fn__flex-1" value="${height ? parseInt(height) : "420"}" step="1" min="148" style="margin: 4px 8px 4px 0" placeholder="${gutterText(protyle, "height")}"><span class="fn__flex-center">px</span></div>`,
                    bind: (element) => {
                        element.querySelector("input").addEventListener("change", (event) => {
                            const newHeight = ((event.target as HTMLInputElement).value || "420") + "px";
                            (nodeElement as HTMLElement).style.height = newHeight;
                            updateTransaction(protyle, nodeElement, html);
                            html = nodeElement.outerHTML;
                            event.stopPropagation();
                            const renderElement = nodeElement.querySelector('[contenteditable="false"]') as HTMLElement;
                            if (renderElement) {
                                renderElement.style.height = newHeight;
                                const chartInstance = window.echarts.getInstanceById(renderElement.getAttribute("_echarts_instance_"));
                                if (chartInstance) {
                                    chartInstance.resize();
                                }
                            }
                        });
                    }
                }, {
                    id: "update",
                    label: gutterText(protyle, "update"),
                    icon: "iconEdit",
                    click() {
                        protyle.toolbar.showRender(protyle, nodeElement);
                    }
                }]
            });
        } else if (type === "NodeTable" && !protyle.disabled && protyle.settings.features.tableMenu) {
            this.menu.addItem({id: "separator_table", type: "separator"});
            this.menu.addItem({
                id: "table",
                icon: "iconTable",
                label: gutterText(protyle, "table"),
                click: () => protyle.host.dispatch({
                    type: "open-table-menu",
                    documentId: identity.documentId,
                    notebookId: identity.notebookId,
                    blockId: id,
                }),
            });
        } else if (type === "NodeAttributeView") {
            this.menu.addItem({id: "separator_exportCSV", type: "separator"});
            this.menu.addItem({
                id: "exportCSV",
                icon: "iconDatabase",
                label: gutterText(protyle, "export") + " CSV",
                click() {
                    return requestGutter(protyle, "/api/export/exportAttributeView", {
                        id: nodeElement.getAttribute("data-av-id"),
                        blockID: id,
                        notebook: protyle.notebookId,
                    }, "read").then((response) => {
                        downloadExportFile(
                            protyle.session!.runtime.resources.resolveExport(identity, response.data.zip),
                        );
                    }).catch((error) => {
                        reportGutterRequestFailure(protyle, "/api/export/exportAttributeView", error);
                    });
                }
            });
        } else if ((type === "NodeVideo" || type === "NodeAudio") && !protyle.disabled) {
            this.menu.addItem({id: "separator_VideoOrAudio", type: "separator"});
            this.menu.addItem({
                id: type === "NodeVideo" ? "assetVideo" : "assetAudio",
                type: "submenu",
                icon: type === "NodeVideo" ? "iconVideo" : "iconRecord",
                label: gutterText(protyle, "assets"),
                submenu: createMediaMenu(protyle, nodeElement, type)
            });
        } else if (type === "NodeIFrame" && !protyle.disabled) {
            this.menu.addItem({id: "separator_IFrame", type: "separator"});
            this.menu.addItem({
                id: "assetIFrame",
                type: "submenu",
                icon: "iconGlobe",
                label: gutterText(protyle, "assets"),
                submenu: createIframeMenu(protyle, nodeElement)
            });
        } else if (type === "NodeHTMLBlock" && !protyle.disabled) {
            this.menu.addItem({id: "separator_html", type: "separator"});
            this.menu.addItem({
                id: "html",
                icon: "iconHTML5",
                label: "HTML",
                click() {
                    protyle.toolbar.showRender(protyle, nodeElement);
                }
            });
        } else if (type === "NodeBlockQueryEmbed" && !protyle.disabled) {
            this.menu.addItem({id: "separator_blockEmbed", type: "separator"});
            const breadcrumb = nodeElement.getAttribute("breadcrumb");
            this.menu.addItem({
                id: "blockEmbed",
                type: "submenu",
                icon: "iconSQL",
                label: gutterText(protyle, "blockEmbed"),
                submenu: [{
                    id: "refresh",
                    icon: "iconRefresh",
                    label: `${gutterText(protyle, "refresh")} SQL`,
                    click() {
                        nodeElement.removeAttribute("data-render");
                        blockRender(protyle, nodeElement);
                    }
                }, {
                    id: "update",
                    icon: "iconEdit",
                    label: `${gutterText(protyle, "update")} SQL`,
                    click() {
                        protyle.toolbar.showRender(protyle, nodeElement);
                    }
                }, {
                    type: "separator"
                }, {
                    id: "embedBlockBreadcrumb",
                    label: `<div class="fn__flex" style="margin-bottom: 4px"><span>${gutterText(protyle, "embedBlockBreadcrumb")}</span><span class="fn__space fn__flex-1"></span>
<input type="checkbox" class="b3-switch fn__flex-center"${breadcrumb === "true" ? " checked" : ((protyle.settings.editor.embedBlockBreadcrumb && breadcrumb !== "false") ? " checked" : "")}></div>`,
                    bind(element) {
                        element.addEventListener("click", (event: MouseEvent & { target: HTMLElement }) => {
                            const inputElement = element.querySelector("input");
                            if (event.target.tagName !== "INPUT") {
                                inputElement.checked = !inputElement.checked;
                            }
                            nodeElement.setAttribute("breadcrumb", inputElement.checked.toString());
                            submitGutterRequest(protyle, "/api/attr/setBlockAttrs", {
                                id,
                                attrs: {breadcrumb: inputElement.checked.toString()}
                            });
                            nodeElement.removeAttribute("data-render");
                            blockRender(protyle, nodeElement);
                            closeMenu();
                        });
                    }
                }, {
                    id: "headingEmbedMode",
                    label: gutterText(protyle, "headingEmbedMode"),
                    type: "submenu",
                    submenu: [{
                        id: "showHeadingWithBlocks",
                        label: gutterText(protyle, "showHeadingWithBlocks"),
                        iconHTML: "",
                        checked: nodeElement.getAttribute("custom-heading-mode") === "0",
                        click() {
                            nodeElement.setAttribute("custom-heading-mode", "0");
                            submitGutterRequest(protyle, "/api/attr/setBlockAttrs", {
                                id,
                                attrs: {"custom-heading-mode": "0"}
                            });
                            nodeElement.removeAttribute("data-render");
                            blockRender(protyle, nodeElement);
                        }
                    }, {
                        id: "showHeadingOnlyTitle",
                        label: gutterText(protyle, "showHeadingOnlyTitle"),
                        iconHTML: "",
                        checked: nodeElement.getAttribute("custom-heading-mode") === "1",
                        click() {
                            nodeElement.setAttribute("custom-heading-mode", "1");
                            submitGutterRequest(protyle, "/api/attr/setBlockAttrs", {
                                id,
                                attrs: {"custom-heading-mode": "1"}
                            });
                            nodeElement.removeAttribute("data-render");
                            blockRender(protyle, nodeElement);
                        }
                    }, {
                        id: "showHeadingOnlyBlocks",
                        label: gutterText(protyle, "showHeadingOnlyBlocks"),
                        iconHTML: "",
                        checked: nodeElement.getAttribute("custom-heading-mode") === "2",
                        click() {
                            nodeElement.setAttribute("custom-heading-mode", "2");
                            submitGutterRequest(protyle, "/api/attr/setBlockAttrs", {
                                id,
                                attrs: {"custom-heading-mode": "2"}
                            });
                            nodeElement.removeAttribute("data-render");
                            blockRender(protyle, nodeElement);
                        }
                    }, {
                        id: "default",
                        label: gutterText(protyle, "default"),
                        iconHTML: "",
                        checked: !nodeElement.getAttribute("custom-heading-mode"),
                        click() {
                            nodeElement.removeAttribute("custom-heading-mode");
                            submitGutterRequest(protyle, "/api/attr/setBlockAttrs", {
                                id,
                                attrs: {"custom-heading-mode": ""}
                            });
                            nodeElement.removeAttribute("data-render");
                            blockRender(protyle, nodeElement);
                        }
                    }]
                }]
            });
        } else if (type === "NodeHeading" && !protyle.disabled) {
            this.menu.addItem({id: "separator_1", type: "separator"});
            const headingSubMenu = [];
            if (subType !== "h1") {
                headingSubMenu.push(this.genHeadingTransform(protyle, id, 1));
            }
            if (subType !== "h2") {
                headingSubMenu.push(this.genHeadingTransform(protyle, id, 2));
            }
            if (subType !== "h3") {
                headingSubMenu.push(this.genHeadingTransform(protyle, id, 3));
            }
            if (subType !== "h4") {
                headingSubMenu.push(this.genHeadingTransform(protyle, id, 4));
            }
            if (subType !== "h5") {
                headingSubMenu.push(this.genHeadingTransform(protyle, id, 5));
            }
            if (subType !== "h6") {
                headingSubMenu.push(this.genHeadingTransform(protyle, id, 6));
            }
            this.menu.addItem({
                id: "tWithSubtitle",
                type: "submenu",
                icon: "iconRefresh",
                label: gutterText(protyle, "tWithSubtitle"),
                submenu: headingSubMenu
            });
            this.menu.addItem({
                id: "copyHeadings1",
                icon: "iconCopy",
                label: `${gutterText(protyle, "copy")} ${gutterText(protyle, "headings1")}`,
                click() {
                    return requestGutter(protyle, "/api/block/getHeadingChildrenDOM", {
                        id,
                        notebook: protyle.notebookId,
                        removeFoldAttr: nodeElement.getAttribute("fold") !== "1"
                    }, "read").then((response) => writeText(response.data + Constants.ZWSP)).catch((error) => {
                        reportGutterRequestFailure(protyle, "/api/block/getHeadingChildrenDOM", error);
                    });
                }
            });
            this.menu.addItem({
                id: "cutHeadings1",
                icon: "iconCut",
                label: `${gutterText(protyle, "cut")} ${gutterText(protyle, "headings1")}`,
                click() {
                    return requestGutter(protyle, "/api/block/getHeadingChildrenDOM", {
                        id,
                        notebook: protyle.notebookId,
                        removeFoldAttr: nodeElement.getAttribute("fold") !== "1"
                    }, "read").then(async (response) => {
                        await writeText(response.data + Constants.ZWSP);
                        return requestGutter(protyle, "/api/block/getHeadingDeleteTransaction", {
                            id,
                            notebook: protyle.notebookId,
                        }, "read");
                    }).then((deleteResponse) => {
                        deleteResponse.data.doOperations.forEach((operation: IOperation) => {
                            protyle.wysiwyg.element.querySelectorAll(`[data-node-id="${operation.id}"]`).forEach((itemElement: HTMLElement) => {
                                itemElement.remove();
                            });
                        });
                        if (protyle.wysiwyg.element.childElementCount === 0) {
                            const newID = Lute.NewNodeID();
                            const emptyElement = genEmptyElement(protyle, false, false, newID);
                            protyle.wysiwyg.element.insertAdjacentElement("afterbegin", emptyElement);
                            deleteResponse.data.doOperations.push({
                                action: "insert",
                                data: emptyElement.outerHTML,
                                id: newID,
                                parentID: protyle.block.parentID
                            });
                            deleteResponse.data.undoOperations.push({
                                action: "delete",
                                id: newID,
                            });
                            focusBlock(emptyElement);
                        }
                        transaction(protyle, deleteResponse.data.doOperations, deleteResponse.data.undoOperations);
                    }).catch((error) => {
                        reportGutterRequestFailure(
                            protyle,
                            "/api/block/getHeadingChildrenDOM -> /api/block/getHeadingDeleteTransaction",
                            error,
                        );
                    });
                }
            });
            this.menu.addItem({
                id: "deleteHeadings1",
                icon: "iconTrashcan",
                label: `${gutterText(protyle, "delete")} ${gutterText(protyle, "headings1")}`,
                click() {
                    return requestGutter(protyle, "/api/block/getHeadingDeleteTransaction", {
                        id,
                        notebook: protyle.notebookId,
                    }, "read").then((response) => {
                        response.data.doOperations.forEach((operation: IOperation) => {
                            protyle.wysiwyg.element.querySelectorAll(`[data-node-id="${operation.id}"]`).forEach((itemElement: HTMLElement) => {
                                itemElement.remove();
                            });
                        });
                        if (protyle.wysiwyg.element.childElementCount === 0) {
                            const newID = Lute.NewNodeID();
                            const emptyElement = genEmptyElement(protyle, false, false, newID);
                            protyle.wysiwyg.element.insertAdjacentElement("afterbegin", emptyElement);
                            response.data.doOperations.push({
                                action: "insert",
                                data: emptyElement.outerHTML,
                                id: newID,
                                parentID: protyle.block.parentID
                            });
                            response.data.undoOperations.push({
                                action: "delete",
                                id: newID,
                            });
                            focusBlock(emptyElement);
                        }
                        transaction(protyle, response.data.doOperations, response.data.undoOperations);
                    }).catch((error) => {
                        reportGutterRequestFailure(protyle, "/api/block/getHeadingDeleteTransaction", error);
                    });
                }
            });
        }
        this.menu.addItem({id: "separator_2", type: "separator"});
        if (!protyle.options.backlinkData) {
            this.menu.addItem({
                id: "enter",
                icon: "iconEnter",
                accelerator: `${protyle.settings.hotkeys.general.enter ? updateHotkeyTip(protyle.settings.hotkeys.general.enter) + "/" : ""}${updateHotkeyAfterTip("⌘" + gutterText(protyle, "click"))}`,
                label: gutterText(protyle, "enter"),
                click: () => zoomOut({protyle, id}),
            });
            this.menu.addItem({
                id: "enterBack",
                icon: "iconEnterBack",
                accelerator: protyle.settings.hotkeys.general.enterBack,
                label: gutterText(protyle, "enterBack"),
                click: () => navigateBack(protyle, id),
            });
        } else {
            this.menu.addItem({
                id: "enter",
                icon: "iconEnter",
                accelerator: `${updateHotkeyTip(protyle.settings.hotkeys.general.enter)}/${updateHotkeyTip("⌘" + gutterText(protyle, "click"))}`,
                label: gutterText(protyle, "openBy"),
                click: () => requestBlockFold(protyle, {
                    notebookId: protyle.notebookId,
                    documentId: id,
                }).then(({zoomIn}) => {
                    protyle.host.dispatch({
                        type: "open-document",
                        notebookId: protyle.notebookId,
                        documentId: id,
                        disposition: "current",
                        scope: zoomIn ? "subtree" : "context",
                        attention: "focus",
                        scroll: "auto",
                        restoreScroll: zoomIn ? "never" : "if-document",
                        zoom: zoomIn,
                    });
                }).catch((error) => reportGutterActionFailure(protyle, "open folded block", error)),
            });
        }
        if (!protyle.disabled) {
            this.menu.addItem({
                id: "insertBefore",
                icon: "iconBefore",
                label: gutterText(protyle, "insertBefore"),
                accelerator: protyle.settings.hotkeys.editor.general.insertBefore,
                click() {
                    hideElements(["select"], protyle);
                    countBlockStatistics(protyle, []);
                    return insertEmptyBlock(protyle, "beforebegin", id);
                }
            });
            this.menu.addItem({
                id: "insertAfter",
                icon: "iconAfter",
                label: gutterText(protyle, "insertAfter"),
                accelerator: protyle.settings.hotkeys.editor.general.insertAfter,
                click() {
                    hideElements(["select"], protyle);
                    countBlockStatistics(protyle, []);
                    return insertEmptyBlock(protyle, "afterend", id);
                }
            });
            const countElement = nodeElement.lastElementChild.querySelector(".protyle-attr--refcount");
            if (countElement?.textContent && protyle.settings.features.blockRefTransfer) {
                this.menu.addItem({
                    id: "transferBlockRef",
                    label: gutterText(protyle, "transferBlockRef"),
                    icon: "iconScrollHoriz",
                    click: () => protyle.host.dispatch({
                        type: "open-block-ref-transfer",
                        notebookId: identity.notebookId,
                        documentId: identity.documentId,
                        blockId: id,
                    }),
                });
            }
        }
        this.menu.addItem({
            id: "jumpTo",
            icon: "iconJumpTo",
            type: "submenu",
            label: gutterText(protyle, "jumpTo"),
            submenu: [{
                id: "jumpToParentPrev",
                iconHTML: "",
                label: gutterText(protyle, "jumpToParentPrev"),
                accelerator: protyle.settings.hotkeys.editor.general.jumpToParentPrev,
                click() {
                    hideElements(["select"], protyle);
                    return jumpToParent(protyle, nodeElement, "previous");
                }
            }, {
                iconHTML: "",
                id: "jumpToParentNext",
                label: gutterText(protyle, "jumpToParentNext"),
                accelerator: protyle.settings.hotkeys.editor.general.jumpToParentNext,
                click() {
                    hideElements(["select"], protyle);
                    return jumpToParent(protyle, nodeElement, "next");
                }
            }, {
                iconHTML: "",
                id: "jumpToParent",
                label: gutterText(protyle, "jumpToParent"),
                accelerator: protyle.settings.hotkeys.editor.general.jumpToParent,
                click() {
                    hideElements(["select"], protyle);
                    return jumpToParent(protyle, nodeElement, "parent");
                }
            }]
        });

        this.menu.addItem({id: "separator_3", type: "separator"});

        if (type !== "NodeThematicBreak") {
            this.menu.addItem({
                id: "fold",
                icon: "iconFoldUnFold",
                label: gutterText(protyle, "fold"),
                accelerator: `${updateHotkeyTip(protyle.settings.hotkeys.editor.general.collapse)}/${updateHotkeyTip("⌥" + gutterText(protyle, "click"))}`,
                click() {
                    setFold(protyle, nodeElement);
                    focusBlock(nodeElement);
                }
            });
            if (["NodeHeading", "NodeListItem", "NodeBlockquote", "NodeCallout", "NodeSuperBlock"].includes(type)) {
                this.menu.addItem({
                    id: "foldRecursive",
                    icon: "iconListTree",
                    label: gutterText(protyle, "foldRecursive"),
                    accelerator: protyle.settings.hotkeys.editor.general.foldRecursive,
                    click() {
                        foldBlocksRecursively(protyle, [nodeElement]);
                        focusBlock(nodeElement);
                    }
                });
            }
            if (!protyle.disabled && protyle.settings.features.blockAttributes) {
                this.menu.addItem({
                    id: "attr",
                    label: gutterText(protyle, "attr"),
                    icon: "iconAttr",
                    accelerator: protyle.settings.hotkeys.editor.general.attr + "/" + updateHotkeyTip("⇧" + gutterText(protyle, "click")),
                    click: () => protyle.host.dispatch({
                        type: "open-block-attributes",
                        notebookId: identity.notebookId,
                        documentId: identity.documentId,
                        blockId: id,
                        focus: "bookmark",
                    }),
                });
            }
        }
        if (!protyle.disabled) {
            const appearanceElement = this.menu.addItem({
                id: "appearance",
                label: gutterText(protyle, "appearance"),
                icon: "iconFont",
                accelerator: protyle.settings.toolbar.hotkeys.appearance,
                click: () => {
                    protyle.toolbar.element.classList.add("fn__none");
                    protyle.toolbar.subElement.innerHTML = "";
                    protyle.toolbar.subElement.style.width = "";
                    protyle.toolbar.subElement.style.padding = "";
                    protyle.toolbar.subElement.append(appearanceMenu(protyle, [nodeElement]));
                    protyle.toolbar.activateOverlay();
                    protyle.toolbar.subElement.classList.remove("fn__none");
                    protyle.toolbar.subElementCloseCB = undefined;
                    const position = nodeElement.getBoundingClientRect();
                    positionElementInViewport(protyle.toolbar.subElement, position.left, position.top);
                }
            })!;
            if (!isNarrowViewport()) {
                appearanceElement.lastElementChild.classList.add("b3-menu__submenu--row");
            }
            this.genAlign([nodeElement], protyle);
            this.genWidths([nodeElement], protyle);
            // this.genHeights([nodeElement], protyle);
        }
        this.menu.addItem({id: "separator_4", type: "separator"});
        if (!protyle.disabled && protyle.settings.features.wechatReminder &&
            !["NodeThematicBreak", "NodeBlockQueryEmbed", "NodeIFrame", "NodeHTMLBlock", "NodeWidget", "NodeVideo", "NodeAudio"].includes(type) &&
            getContenteditableElement(nodeElement)?.textContent.trim() !== "" &&
            (type !== "NodeCodeBlock" || (type === "NodeCodeBlock" && !nodeElement.getAttribute("data-subtype")))) {
            this.menu.addItem({
                id: "wechatReminder",
                icon: "iconMp",
                label: gutterText(protyle, "wechatReminder"),
                click: () => protyle.host.dispatch({
                    type: "open-block-reminder",
                    notebookId: identity.notebookId,
                    documentId: identity.documentId,
                    blockId: id,
                }),
            });
        }
        if (type !== "NodeThematicBreak" && !protyle.disabled &&
            (protyle.settings.features.quickFlashcard || protyle.settings.features.flashcardDeck)) {
            const isCardMade = nodeElement.hasAttribute(Constants.CUSTOM_RIFF_DECKS);
            if (protyle.settings.features.quickFlashcard) {
                this.menu.addItem({
                    id: isCardMade ? "removeCard" : "quickMakeCard",
                    icon: "iconRiffCard",
                    label: isCardMade ? gutterText(protyle, "removeCard") : gutterText(protyle, "quickMakeCard"),
                    accelerator: protyle.settings.hotkeys.editor.general.quickMakeCard,
                    click: () => toggleQuickFlashcards(protyle, [nodeElement]),
                });
            }
            if (protyle.settings.features.flashcardDeck) {
                this.menu.addItem({
                    id: "addToDeck",
                    label: gutterText(protyle, "addToDeck"),
                    icon: "iconRiffCard",
                    click: () => protyle.host.dispatch({
                        type: "open-card-deck-picker",
                        documentId: identity.documentId,
                        notebookId: identity.notebookId,
                        blockIds: [id],
                    }),
                });
            }
            this.menu.addItem({id: "separator_5", type: "separator"});
        }

        emitProtylePluginMenu({
            detail: {protyle, blockElements: [nodeElement]},
            localization: protyle.localization,
            menu,
            plugins: protyle.plugins,
            separatorPosition: "bottom",
            type: "click-blockicon",
        });

        let updateHTML = nodeElement.getAttribute("updated") || "";
        if (updateHTML) {
            updateHTML = `${gutterText(protyle, "modifiedAt")} ${dayjs(updateHTML).format("YYYY-MM-DD HH:mm:ss")}<br>`;
        }
        this.menu.addItem({
            id: "updateAndCreatedAt",
            iconHTML: "",
            type: "readonly",
            label: `${updateHTML}${gutterText(protyle, "createdAt")} ${dayjs(id.substr(0, 14)).format("YYYY-MM-DD HH:mm:ss")}`,
        });
        return menu;
    }

    private genHeadingTransform(protyle: IProtyle, id: string, level: number) {
        return {
            id: "heading" + level,
            iconHTML: "",
            icon: "iconHeading" + level,
            label: gutterText(protyle, "heading" + level),
            click() {
                return requestGutter(protyle, "/api/block/getHeadingLevelTransaction", {
                    id,
                    notebook: protyle.notebookId,
                    level
                }, "read").then((response) => {
                    response.data.doOperations.forEach((operation: IOperation, index: number) => {
                        protyle.wysiwyg.element.querySelectorAll(`[data-node-id="${operation.id}"]`).forEach((itemElement: HTMLElement) => {
                            itemElement.outerHTML = operation.data;
                        });
                        // 使用 outer 后元素需要重新查询
                        protyle.wysiwyg.element.querySelectorAll(`[data-node-id="${operation.id}"]`).forEach((itemElement: HTMLElement) => {
                            mathRender(itemElement, protyle);
                        });
                        if (index === 0) {
                            focusBlock(protyle.wysiwyg.element.querySelector(`[data-node-id="${operation.id}"]`), protyle.wysiwyg.element, true);
                        }
                    });
                    transaction(protyle, response.data.doOperations, response.data.undoOperations);
                }).catch((error) => {
                    reportGutterRequestFailure(protyle, "/api/block/getHeadingLevelTransaction", error);
                });
            }
        };
    }

    private genClick(nodeElements: Element[], protyle: IProtyle, cb: (e: HTMLElement) => void) {
        updateBatchTransaction(nodeElements, protyle, cb);
        focusBlock(nodeElements[0]);
    }

    private genAlign(nodeElements: Element[], protyle: IProtyle) {
        const disabledRTL = nodeElements.some(e => ["NodeAttributeView", "NodeCodeBlock", "NodeMathBlock"].includes(e.getAttribute("data-type")));
        this.menu.addItem({
            id: "layout",
            icon: "iconAlignSettings",
            label: gutterText(protyle, "layout"),
            type: "submenu",
            submenu: [{
                id: "alignLeft",
                icon: "iconAlignLeft",
                label: gutterText(protyle, "alignLeft"),
                accelerator: protyle.settings.hotkeys.editor.general.alignLeft,
                click: () => {
                    this.genClick(nodeElements, protyle, (e: HTMLElement) => {
                        if (e.classList.contains("av")) {
                            e.style.justifyContent = "";
                        } else if (["NodeIFrame", "NodeWidget"].includes(e.getAttribute("data-type"))) {
                            e.style.margin = "";
                        } else {
                            e.style.textAlign = "left";
                        }
                    });
                }
            }, {
                id: "alignCenter",
                icon: "iconAlignCenter",
                label: gutterText(protyle, "alignCenter"),
                accelerator: protyle.settings.hotkeys.editor.general.alignCenter,
                click: () => {
                    this.genClick(nodeElements, protyle, (e: HTMLElement) => {
                        if (e.classList.contains("av")) {
                            e.style.justifyContent = "center";
                        } else if (["NodeIFrame", "NodeWidget"].includes(e.getAttribute("data-type"))) {
                            e.style.margin = "0 auto";
                        } else {
                            e.style.textAlign = "center";
                        }
                    });
                }
            }, {
                id: "alignRight",
                icon: "iconAlignRight",
                label: gutterText(protyle, "alignRight"),
                accelerator: protyle.settings.hotkeys.editor.general.alignRight,
                click: () => {
                    this.genClick(nodeElements, protyle, (e: HTMLElement) => {
                        if (e.classList.contains("av")) {
                            e.style.justifyContent = "flex-end";
                        } else if (["NodeIFrame", "NodeWidget"].includes(e.getAttribute("data-type"))) {
                            e.style.margin = "0 0 0 auto";
                        } else {
                            e.style.textAlign = "right";
                        }
                    });
                }
            }, {
                id: "justify",
                icon: "iconAlignJustify",
                label: gutterText(protyle, "justify"),
                click: () => {
                    this.genClick(nodeElements, protyle, (e: HTMLElement) => {
                        e.style.textAlign = "justify";
                    });
                }
            }, {
                id: "separator_1",
                type: "separator"
            }, {
                id: "ltr",
                icon: "iconLtr",
                ignore: disabledRTL,
                label: gutterText(protyle, "ltr"),
                accelerator: protyle.settings.hotkeys.editor.general.ltr,
                click: () => {
                    this.genClick(nodeElements, protyle, (e: HTMLElement) => {
                        if (e.classList.contains("table")) {
                            e.querySelector("table").style.direction = "ltr";
                        } else if (e.getAttribute("data-type") === "NodeHTMLBlock") {
                            (e.querySelector("protyle-html") as HTMLElement).style.direction = "ltr";
                        } else {
                            e.style.direction = "ltr";
                        }
                    });
                }
            }, {
                id: "rtl",
                icon: "iconRtl",
                ignore: disabledRTL,
                label: gutterText(protyle, "rtl"),
                accelerator: protyle.settings.hotkeys.editor.general.rtl,
                click: () => {
                    this.genClick(nodeElements, protyle, (e: HTMLElement) => {
                        if (e.classList.contains("table")) {
                            e.querySelector("table").style.direction = "rtl";
                        } else if (e.getAttribute("data-type") === "NodeHTMLBlock") {
                            (e.querySelector("protyle-html") as HTMLElement).style.direction = "rtl";
                        } else {
                            e.style.direction = "rtl";
                        }
                    });
                }
            }, {
                id: "separator_2",
                ignore: disabledRTL,
                type: "separator"
            }, {
                id: "clearFontStyle",
                icon: "iconTrashcan",
                label: gutterText(protyle, "clearFontStyle"),
                click: () => {
                    this.genClick(nodeElements, protyle, (e: HTMLElement) => {
                        if (e.classList.contains("av")) {
                            e.style.justifyContent = "";
                        } else if (["NodeIFrame", "NodeWidget"].includes(e.getAttribute("data-type"))) {
                            e.style.margin = "";
                        } else {
                            e.style.textAlign = "";
                            e.style.direction = "";
                        }
                    });
                }
            }]
        });
    }

    private updateNodeElements(nodeElements: Element[], protyle: IProtyle, inputElement: HTMLInputElement) {
        const undoOperations: IOperation[] = [];
        const operations: IOperation[] = [];
        nodeElements.forEach((e) => {
            e.setAttribute(Constants.ATTRIBUTE_EDITING, "true");
            undoOperations.push({
                action: "update",
                id: e.getAttribute("data-node-id"),
                data: e.outerHTML
            });
        });
        inputElement.addEventListener(inputElement.type === "number" ? "blur" : "change", () => {
            nodeElements.forEach((e: HTMLElement) => {
                e.setAttribute(Constants.ATTRIBUTE_EDITING, "true");
                operations.push({
                    action: "update",
                    id: e.getAttribute("data-node-id"),
                    data: e.outerHTML
                });
                if (e.getAttribute("data-subtype") === "echarts") {
                    const chartInstance = window.echarts.getInstanceById(e.querySelector("[_echarts_instance_]").getAttribute("_echarts_instance_"));
                    if (chartInstance) {
                        chartInstance.resize();
                    }
                    chartRender(e, protyle);
                }
            });
            transaction(protyle, operations, undoOperations);
            this.closeMenu();
            focusBlock(nodeElements[0]);
        });
    }

    private genWidths(nodeElements: Element[], protyle: IProtyle) {
        let isInSb = false;
        nodeElements.find((e: HTMLElement) => {
            if (e.parentElement.classList.contains("sb")) {
                isInSb = true;
                return true;
            }
        });
        if (isInSb) {
            return;
        }
        let rangeElement: HTMLInputElement;
        const firstElement = nodeElements[0] as HTMLElement;
        const styles: IMenu[] = [{
            id: "widthInput",
            iconHTML: "",
            type: "readonly",
            label: `<div class="fn__flex"><input class="b3-text-field fn__flex-1" value="${firstElement.style.width.endsWith("px") ? parseInt(firstElement.style.width) : ""}" type="number" style="margin: 4px 8px 4px 0" placeholder="${gutterText(protyle, "width")}"><span class="fn__flex-center">px</span></div>`,
            bind: (element) => {
                const inputElement = element.querySelector("input");
                inputElement.addEventListener("input", () => {
                    nodeElements.forEach((item: HTMLElement) => {
                        item.style.width = inputElement.value + "px";
                        item.style.flex = "none";
                    });
                    rangeElement.value = "0";
                    rangeElement.parentElement.setAttribute("aria-label", inputElement.value + "px");
                });
                this.updateNodeElements(nodeElements, protyle, inputElement);
            }
        }];
        ["25%", "33%", "50%", "67%", "75%", "100%"].forEach((item) => {
            styles.push({
                id: "width_" + item,
                iconHTML: "",
                label: item,
                click: () => {
                    this.genClick(nodeElements, protyle, (e: HTMLElement) => {
                        e.style.width = item;
                        e.style.flex = "none";
                        if (e.getAttribute("data-subtype") === "echarts") {
                            const chartInstance = window.echarts.getInstanceById(e.querySelector("[_echarts_instance_]").getAttribute("_echarts_instance_"));
                            if (chartInstance) {
                                chartInstance.resize();
                            }
                        }
                    });
                }
            });
        });
        styles.push({
            id: "separator_1",
            type: "separator"
        });
        const width = firstElement.style.width.endsWith("%") ? parseInt(firstElement.style.width) : 0;
        this.menu.addItem({
            id: "width",
            icon: "iconWidth",
            label: gutterText(protyle, "width"),
            submenu: styles.concat([{
                id: "widthDrag",
                iconHTML: "",
                type: "readonly",
                label: `<div style="margin: 4px 0;" aria-label="${firstElement.style.width.endsWith("px") ? firstElement.style.width : (firstElement.style.width || gutterText(protyle, "default"))}" class="b3-tooltips b3-tooltips__n"><input style="box-sizing: border-box" value="${width}" class="b3-slider fn__block" max="100" min="1" step="1" type="range"></div>`,
                bind: (element) => {
                    rangeElement = element.querySelector("input");
                    rangeElement.addEventListener("input", () => {
                        nodeElements.forEach((e: HTMLElement) => {
                            e.style.width = rangeElement.value + "%";
                            e.style.flex = "none";
                        });
                        rangeElement.parentElement.setAttribute("aria-label", `${rangeElement.value}%`);
                    });
                    this.updateNodeElements(nodeElements, protyle, rangeElement);
                }
            }, {
                id: "separator_2",
                type: "separator"
            }, {
                id: "default",
                iconHTML: "",
                label: gutterText(protyle, "default"),
                click: () => {
                    this.genClick(nodeElements, protyle, (e: HTMLElement) => {
                        if (e.style.width) {
                            e.style.width = "";
                            e.style.flex = "";
                            if (e.getAttribute("data-subtype") === "echarts") {
                                const chartInstance = window.echarts.getInstanceById(e.querySelector("[_echarts_instance_]").getAttribute("_echarts_instance_"));
                                if (chartInstance) {
                                    chartInstance.resize();
                                }
                            }
                        }
                    });
                }
            }]),
        });
    }

    // TODO https://github.com/siyuan-note/siyuan/issues/11055
    private genHeights(nodeElements: Element[], protyle: IProtyle) {
        const matchHeight = nodeElements.find(item => {
            if (!item.classList.contains("p") && !item.classList.contains("code-block") && !item.classList.contains("render-node")) {
                return true;
            }
        });
        if (matchHeight) {
            return;
        }
        let rangeElement: HTMLInputElement;
        const firstElement = nodeElements[0] as HTMLElement;
        const styles: IMenu[] = [{
            id: "heightInput",
            iconHTML: "",
            type: "readonly",
            label: `<div class="fn__flex"><input class="b3-text-field fn__flex-1" value="${firstElement.style.height.endsWith("px") ? parseInt(firstElement.style.height) : ""}" type="number" style="margin: 4px 8px 4px 0" placeholder="${gutterText(protyle, "height")}"><span class="fn__flex-center">px</span></div>`,
            bind: (element) => {
                const inputElement = element.querySelector("input");
                inputElement.addEventListener("input", () => {
                    nodeElements.forEach((item: HTMLElement) => {
                        item.style.height = inputElement.value + "px";
                        item.style.flex = "none";
                    });
                    rangeElement.value = "0";
                    rangeElement.parentElement.setAttribute("aria-label", inputElement.value + "px");
                });
                this.updateNodeElements(nodeElements, protyle, inputElement);
            }
        }];
        ["25%", "33%", "50%", "67%", "75%", "100%"].forEach((item) => {
            styles.push({
                id: "height_" + item,
                iconHTML: "",
                label: item,
                click: () => {
                    this.genClick(nodeElements, protyle, (e: HTMLElement) => {
                        e.style.height = item;
                        e.style.flex = "none";
                    });
                }
            });
        });
        styles.push({
            type: "separator"
        });
        const height = firstElement.style.height.endsWith("%") ? parseInt(firstElement.style.height) : 0;
        this.menu.addItem({
            id: "heightDrag",
            label: gutterText(protyle, "height"),
            submenu: styles.concat([{
                iconHTML: "",
                type: "readonly",
                label: `<div style="margin: 4px 0;" aria-label="${firstElement.style.height.endsWith("px") ? firstElement.style.height : (firstElement.style.height || gutterText(protyle, "default"))}" class="b3-tooltips b3-tooltips__n"><input style="box-sizing: border-box" value="${height}" class="b3-slider fn__block" max="100" min="1" step="1" type="range"></div>`,
                bind: (element) => {
                    rangeElement = element.querySelector("input");
                    rangeElement.addEventListener("input", () => {
                        nodeElements.forEach((e: HTMLElement) => {
                            e.style.height = rangeElement.value + "%";
                            e.style.flex = "none";
                        });
                        rangeElement.parentElement.setAttribute("aria-label", `${rangeElement.value}%`);
                    });
                    this.updateNodeElements(nodeElements, protyle, rangeElement);
                }
            }, {
                type: "separator"
            }, {
                id: "default",
                iconHTML: "",
                label: gutterText(protyle, "default"),
                click: () => {
                    this.genClick(nodeElements, protyle, (e: HTMLElement) => {
                        if (e.style.height) {
                            e.style.height = "";
                            e.style.overflow = "";
                        }
                    });
                }
            }]),
        });
    }

    private genCopyTextRef(selectsElement: Element[]): false | IMenu {
        if (isNotEditBlock(selectsElement[0])) {
            return false;
        }
        return {
            id: "copyText",
            iconHTML: "",
            accelerator: protyle.settings.hotkeys.editor.general.copyText,
            label: gutterText(protyle, "copyText"),
            click() {
                // 用于标识复制文本 *
                selectsElement[0].setAttribute("data-reftext", "true");
                focusByRange(getEditorRange(selectsElement[0]));
                document.execCommand("copy");
            }
        };
    }

    public render(protyle: IProtyle, element: Element, target?: Element) {
        // https://github.com/siyuan-note/siyuan/issues/4659
        if (protyle.title && protyle.title.element.getAttribute("data-render") !== "true") {
            return;
        }
        // 防止划选时触碰图标导致 hl 无法移除
        const selectElement = protyle.element.querySelector(".protyle-select");
        if (selectElement && !selectElement.classList.contains("fn__none")) {
            return;
        }
        let html = "";
        let nodeElement = element;
        let space = 0;
        let index = 0;
        let listItem;
        let hideParent = false;
        while (nodeElement) {
            let parentElement = hasClosestBlock(nodeElement.parentElement);
            if (!isInEmbedBlock(nodeElement)) {
                let type: string;
                if (!hideParent) {
                    type = nodeElement.getAttribute("data-type");
                }
                let dataNodeId = nodeElement.getAttribute("data-node-id");
                if (type === "NodeAttributeView" && target) {
                    const rowElement = hasClosestByClassName(target, "av__row");
                    if (rowElement && !rowElement.classList.contains("av__row--header") && rowElement.dataset.id) {
                        element = rowElement;
                        const bodyElement = hasClosestByClassName(rowElement, "av__body") as HTMLElement;
                        let iconAriaLabel = isMac() ? gutterText(protyle, "rowTip") : gutterText(protyle, "rowTip").replace("⇧", "Shift+");
                        if (protyle.disabled) {
                            iconAriaLabel = gutterText(protyle, "rowTip").substring(0, gutterText(protyle, "rowTip").indexOf("<br"));
                        } else if (rowElement.querySelector('[data-dtype="block"]')?.getAttribute("data-detached") === "true") {
                            iconAriaLabel = gutterText(protyle, "rowTip").substring(0, gutterText(protyle, "rowTip").lastIndexOf("<br"));
                        }
                        html = `<button data-type="NodeAttributeViewRowMenu" data-node-id="${dataNodeId}" data-row-id="${rowElement.dataset.id}" data-group-id="${bodyElement.dataset.groupId || ""}" class="ariaLabel" data-position="parentW" aria-label="${iconAriaLabel}"><svg><use xlink:href="#iconDrag"></use></svg><span ${protyle.disabled ? "" : 'draggable="true" class="fn__grab"'}></span></button>`;
                        if (!protyle.disabled) {
                            html = `<button data-type="NodeAttributeViewRow" data-node-id="${dataNodeId}" data-row-id="${rowElement.dataset.id}" data-group-id="${bodyElement.dataset.groupId || ""}" class="ariaLabel" data-position="parentW" aria-label="${isMac() ? gutterText(protyle, "addBelowAbove") : gutterText(protyle, "addBelowAbove").replace("⌥", "Alt+")}"><svg><use xlink:href="#iconAdd"></use></svg></button>${html}`;
                        }
                        break;
                    }
                }
                if (index === 0) {
                    // 不单独显示，要不然在块的间隔中，gutter 会跳来跳去的
                    if (["NodeBlockquote", "NodeList", "NodeCallout", "NodeSuperBlock"].includes(type)) {
                        if (target && type === "NodeCallout") {
                            // Callout 标题需显示
                            const calloutInfoElement = hasTopClosestByClassName(target, "callout-info");
                            if (calloutInfoElement) {
                                element = calloutInfoElement;
                            } else {
                                return;
                            }
                        } else {
                            return;
                        }
                    }

                    let topElement = getTopAloneElement(nodeElement);
                    // https://github.com/siyuan-note/siyuan/issues/17751 第二点
                    if (topElement === nodeElement.parentElement && nodeElement.childElementCount > 3 &&
                        nodeElement.classList.contains("li")) {
                        topElement = nodeElement;
                    }
                    // 提示下方仅有单个列表
                    if (topElement.classList.contains("callout") && !nodeElement.classList.contains("callout") &&
                        getParentBlock(nodeElement) !== topElement) {
                        topElement = topElement.querySelector("[data-node-id]");
                    }
                    listItem = topElement.querySelector(".li") || topElement.querySelector(".list");
                    // 嵌入块中有列表时块标显示位置错误 https://github.com/siyuan-note/siyuan/issues/6254
                    if (isInEmbedBlock(listItem) || isInAVBlock(listItem) || hasClosestByClassName(nodeElement, "callout")) {
                        listItem = undefined;
                    }
                    // 标题（除列表下的）、提示下的块必须显示
                    if (topElement !== nodeElement && type !== "NodeHeading" && !hasClosestByClassName(nodeElement, "callout")) {
                        while (nodeElement !== topElement) {
                            nodeElement = nodeElement.parentElement;
                            // > > > > 1 left 位置
                            if (nodeElement.parentElement.classList.contains("bq")) {
                                space += 10;
                            }
                        }
                        parentElement = hasClosestBlock(nodeElement.parentElement);
                        type = nodeElement.getAttribute("data-type");
                        dataNodeId = nodeElement.getAttribute("data-node-id");
                    }
                }
                // - > # 1 \n  > 2
                if (type === "NodeListItem" && index > 0) {
                    // 列表项内的块不显示块标
                    html = "";
                }
                index += 1;
                // 按块类型与是否反链面板生成提示，${x} 替换为该块的本地化类型名（如「段落/表格/超级块」）
                // 使用回调返回值，避免类型名中可能的 $ 字符被当作替换模式
                let gutterTip = (protyle.options.backlinkData ? this.gutterTipBacklink : this.gutterTip)
                    .replace("${x}", () => getBlockTypeName(protyle, type));
                if (protyle.disabled) {
                    gutterTip = gutterTip.split("<br>").splice(0, 2).join("<br>");
                }

                let popoverHTML = "";
                if (protyle.options.backlinkData) {
                    popoverHTML = `class="popover__block" data-id="${dataNodeId}"`;
                }
                const buttonHTML = type ? `<button class="ariaLabel" data-delay="500" data-position="parentW" aria-label="${gutterTip}"
data-type="${type}" data-subtype="${nodeElement.getAttribute("data-subtype")}" data-node-id="${dataNodeId}">
    <svg><use xlink:href="#${getIconByType(type, nodeElement.getAttribute("data-subtype"))}"></use></svg>
    <span ${popoverHTML} ${protyle.disabled ? "" : 'draggable="true"'}></span>
</button>` : "";
                if (!hideParent) {
                    html = buttonHTML + html;
                }
                let foldHTML = "";
                if (type === "NodeListItem" && nodeElement.childElementCount > 3 || type === "NodeHeading") {
                    const fold = nodeElement.getAttribute("fold");
                    foldHTML = `<button class="ariaLabel" data-delay="500" data-position="parentW" aria-label="${gutterText(protyle, "fold")}"
data-type="fold" style="cursor:inherit;"><svg style="width: 10px;${fold && fold === "1" ? "" : "transform:rotate(90deg)"}"><use xlink:href="#iconPlay"></use></svg></button>`;
                }
                if (type === "NodeListItem" || type === "NodeList") {
                    listItem = nodeElement;
                    if (type === "NodeListItem" && nodeElement.childElementCount > 3) {
                        html = buttonHTML + foldHTML;
                    }
                }
                if (type === "NodeHeading") {
                    html = html + foldHTML;
                }
                if (["NodeBlockquote", "NodeCallout"].includes(type)) {
                    space += 10;
                }
                // 前一个块兄弟（跳过 sb__resize 拖拽手柄，手柄无 data-node-id）
                let previousBlock = nodeElement.previousElementSibling;
                while (previousBlock && !previousBlock.getAttribute("data-node-id")) {
                    previousBlock = previousBlock.previousElementSibling;
                }
                if ((previousBlock && previousBlock.getAttribute("data-node-id")) ||
                    nodeElement.parentElement.classList.contains("callout-content")) {
                    // 前一个块存在时，只显示到当前层级
                    hideParent = true;
                    // 由于折叠块的第二个子块在界面上不显示，因此移除块标 https://github.com/siyuan-note/siyuan/issues/14304
                    if (parentElement && parentElement.getAttribute("fold") === "1") {
                        return;
                    }
                    // 列表项中的引述块中的第二个段落块块标和引述块左侧样式重叠
                    if (parentElement && ["NodeBlockquote", "NodeCallout"].includes(parentElement.getAttribute("data-type"))) {
                        space += 10;
                    }
                }
            }

            if (parentElement) {
                nodeElement = parentElement;
            } else {
                break;
            }
        }
        let match = true;
        // 统计时排除块标边缘框线与+号元素，它们由 render 末尾单独追加，不参与防抖比较
        const buttonsElement = this.element.querySelectorAll("button:not(.protyle-gutters__line):not(.protyle-gutters__plus)");
        if (buttonsElement.length !== html.split("</button>").length - 1) {
            match = false;
        } else {
            Array.from(buttonsElement).find(item => {
                const id = item.getAttribute("data-node-id");
                if (id && html.indexOf(id) === -1) {
                    match = false;
                    return true;
                }
                const rowId = item.getAttribute("data-row-id");
                if ((rowId && html.indexOf(rowId) === -1) || (!rowId && html.indexOf("NodeAttributeViewRowMenu") > -1)) {
                    match = false;
                    return true;
                }
            });
        }
        // 防止抖动 https://github.com/siyuan-note/siyuan/issues/4166
        if (match && this.element.childElementCount > 0) {
            this.element.classList.remove("fn__none");
            return;
        }
        this.element.innerHTML = html;
        this.element.classList.remove("fn__none");
        this.element.style.width = "";
        const contentTop = protyle.contentElement.getBoundingClientRect().top;
        let rect = element.getBoundingClientRect();
        let marginHeight = 0;
        if (listItem && !protyle.settings.editor.rtl && getComputedStyle(element).direction !== "rtl") {
            rect = listItem.firstElementChild.getBoundingClientRect();
            space = 0;
        } else if (nodeElement.getAttribute("data-type") === "NodeBlockQueryEmbed") {
            rect = nodeElement.getBoundingClientRect();
            space = 0;
        } else if (!element.classList.contains("av__row")) {
            if (rect.height < Math.floor(protyle.settings.editor.fontSize * 1.625) + 8 ||
                (rect.height > Math.floor(protyle.settings.editor.fontSize * 1.625) + 8 && rect.height < Math.floor(protyle.settings.editor.fontSize * 1.625) * 2 + 8)) {
                marginHeight = (rect.height - this.element.clientHeight) / 2;
            } else if ((nodeElement.getAttribute("data-type") === "NodeAttributeView" || element.getAttribute("data-type") === "NodeAttributeView") &&
                contentTop < rect.top) {
                marginHeight = 8;
            }
        }
        this.element.style.top = `${Math.max(rect.top, contentTop) + marginHeight}px`;
        let left = rect.left - this.element.clientWidth - space;
        if ((nodeElement.getAttribute("data-type") === "NodeBlockQueryEmbed" && this.element.childElementCount === 1)) {
            // 嵌入块为列表时
            left = nodeElement.getBoundingClientRect().left - this.element.clientWidth - space;
        } else if (element.classList.contains("av__row")) {
            // 为数据库行
            left = nodeElement.getBoundingClientRect().left - this.element.clientWidth - space + parseInt(getComputedStyle(nodeElement).paddingLeft);
        }
        this.element.style.left = `${left}px`;
        if (left < this.element.parentElement.getBoundingClientRect().left) {
            this.element.style.width = "24px";
            // 需加 2，否则和折叠标题无法对齐
            this.element.style.left = `${rect.left - this.element.clientWidth - space / 2 + 3}px`;
            html = "";
            Array.from(this.element.children).reverse().forEach((item, index) => {
                // 跳过块标边缘框线与+号元素，避免被压缩重排
                if (item.classList.contains("protyle-gutters__line") || item.classList.contains("protyle-gutters__plus")) {
                    return;
                }
                if (index !== 0) {
                    (item.firstElementChild as HTMLElement).style.height = "14px";
                }
                html += item.outerHTML;
            });
            this.element.innerHTML = html;
        } else {
            this.element.querySelectorAll("svg").forEach(item => {
                item.style.height = "";
            });
        }
        // 追加块标边缘悬浮触发的插入元素（默认隐藏，悬浮块标显示线条，悬浮线条变+号），由 mousemove 定位
        // 追加块标边缘的框线（悬浮块标显示）与+号（悬浮框线显示），默认隐藏，由 mousemove 定位
        // 双元素：框线贴块标边缘不移动（避免闪烁），+号独立定位在外偏位置，tooltip 基于+号元素对齐
        this.element.insertAdjacentHTML("beforeend", `<button class="protyle-gutters__line" data-type="gutterLineBefore" style="display:none"></button><button class="protyle-gutters__line" data-type="gutterLineAfter" style="display:none"></button><button class="protyle-gutters__plus ariaLabel" data-type="gutterPlusBefore" data-position="4west" aria-label="${gutterText(protyle, "insertBefore")}" style="display:none"><svg><use xlink:href="#iconAdd"></use></svg></button><button class="protyle-gutters__plus ariaLabel" data-type="gutterPlusAfter" data-position="4west" aria-label="${gutterText(protyle, "insertAfter")}" style="display:none"><svg><use xlink:href="#iconAdd"></use></svg></button>`);
    }
}
