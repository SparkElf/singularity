import {hasClosestBlock, hasClosestByClassName} from "../../util/hasClosest";
import {transaction} from "../../wysiwyg/transaction";
import {
    addDragFill,
    cellValueIsEmpty,
    genCellValueByElement,
    getCellText,
    getTypeByCellElement,
    popTextCell,
    renderCell,
    renderCellAttr,
    updateCellsValue,
    updateHeaderCell
} from "./cell";
import {addCol, getColIconByType, showColMenu} from "./col";
import {deleteRow, duplicateRows, insertRows, selectRow, setPageSize, updateHeader} from "./row";
import {resetAVRowSelect, updateAVRowSelect} from "./virtualScroll";
import {emitProtylePluginMenu} from "../../util/plugin";
import {openMenuPanel} from "./openMenuPanel";
import {hintRef} from "../../hint/extend";
import {focusBlock, focusByRange} from "../../util/selection";
import {previewAttrViewImages} from "../../preview/image";
import {unicodeToEmoji} from "../../hint/emoji";
import {openProtyleEmojiMenu} from "../../ui/emojiMenu";
import * as dayjs from "dayjs";
import {openCalcMenu} from "./calc";
import {avRender} from "./render";
import {addView, openViewMenu} from "./view";
import {writeText} from "../../util/clipboard";
import {isOnlyMeta, updateHotkeyTip} from "../../util/keyboard";
import {openSearchAV} from "./relation";
import {Constants} from "../../../constants";
import {hideElements} from "../../ui/hideElements";
import {buildSiYuanBlockUri} from "../../util/blockUri";
import {scrollCenter} from "../../util/highlightById";
import {escapeHtml} from "../../../util/escape";
import {editGalleryItem, openGalleryItemMenu} from "./gallery/util";
import {clearSelect} from "../../util/clear";
import {requestBlockFold} from "../../util/blockFoldRequest";
import {protyleContentIdentity} from "../../util/contentLoad";
import {closeAVMenu, openAVMenu} from "./menu";
import {resolveAVBlockTarget, setAVBlockIcon} from "./blockTarget";

const foldTimeouts = new WeakMap<IProtyle, number>();
export const avClick = (protyle: IProtyle, event: MouseEvent & { target: HTMLElement }) => {
    const {localization} = protyle;
    if (isOnlyMeta(event)) {
        return false;
    }
    const blockElement = hasClosestBlock(event.target);
    if (!blockElement) {
        return false;
    }

    const viewType = blockElement.getAttribute("data-av-type") as TAVView;
    let target = event.target;
    while (target && !target.isEqualNode(blockElement)) {
        const type = target.getAttribute("data-type");
        if (type === "av-header-add" && !protyle.disabled) {
            const addMenu = addCol(protyle, blockElement);
            const addRect = target.getBoundingClientRect();
            addMenu?.menu.popup({
                x: addRect.left,
                y: addRect.bottom,
                h: addRect.height
            });
            event.preventDefault();
            event.stopPropagation();
            return true;
        } else if (type === "av-header-more" && !protyle.disabled) {
            openMenuPanel({protyle, blockElement, type: "properties"});
            event.preventDefault();
            event.stopPropagation();
            return true;
        } else if (type === "av-add-more" && !protyle.disabled) {
            insertRows({
                blockElement,
                protyle,
                count: 1,
                previousID: "",
                groupID: blockElement.querySelector(".av__body")?.getAttribute("data-group-id") || ""
            });
            event.preventDefault();
            event.stopPropagation();
            return true;
        } else if (type === "av-more" && !protyle.disabled) {
            openMenuPanel({protyle, blockElement, type: "config"});
            event.preventDefault();
            event.stopPropagation();
            return true;
        } else if (type === "av-switcher" && !protyle.disabled) {
            openMenuPanel({protyle, blockElement, type: "switcher"});
            event.preventDefault();
            event.stopPropagation();
            return true;
        } else if (type === "av-sort" && !protyle.disabled) {
            openMenuPanel({protyle, blockElement, type: "sorts"});
            event.preventDefault();
            event.stopPropagation();
            return true;
        } else if (type === "av-filter" && !protyle.disabled) {
            openMenuPanel({protyle, blockElement, type: "filters"});
            event.preventDefault();
            event.stopPropagation();
            return true;
        } else if (type === "av-add" && !protyle.disabled) {
            addView(protyle, blockElement);
            event.preventDefault();
            event.stopPropagation();
            return true;
        } else if (type === "block-more" && !protyle.disabled) {
            closeAVMenu(protyle);
            protyle.toolbar.range = document.createRange();
            protyle.toolbar.range.selectNodeContents(target);
            focusByRange(protyle.toolbar.range);
            if (viewType === "table") {
                target.parentElement.classList.add("av__cell--select");
                addDragFill(target.parentElement, localization);
            }
            hintRef(target.previousElementSibling.textContent.trim(), protyle, "av");
            event.preventDefault();
            event.stopPropagation();
            return true;
        } else if (type === "set-page-size" && !protyle.disabled) {
            setPageSize({
                target,
                protyle,
                avID: blockElement.getAttribute("data-av-id"),
                nodeElement: blockElement
            });
            event.preventDefault();
            event.stopPropagation();
            return true;
        } else if (type === "av-add-bottom" && !protyle.disabled) {
            const bodyElement = hasClosestByClassName(target, "av__body");
            insertRows({
                blockElement, protyle,
                count: 1,
                previousID: (bodyElement && bodyElement.querySelector(".av__row--util")?.previousElementSibling?.getAttribute("data-id")) ||
                    target.previousElementSibling?.getAttribute("data-id") || undefined,
                groupID: bodyElement ? bodyElement.getAttribute("data-group-id") : ""
            });
            event.preventDefault();
            event.stopPropagation();
            return true;
        } else if (type === "av-add-top" && !protyle.disabled) {
            const titleElement = hasClosestByClassName(target, "av__group-title");
            insertRows({
                blockElement,
                protyle,
                count: 1,
                previousID: "",
                groupID: titleElement ? titleElement.nextElementSibling.getAttribute("data-group-id") : ""
            });
            event.preventDefault();
            event.stopPropagation();
            return true;
        } else if (target.classList.contains("av__cell--header") && !protyle.disabled) {
            showColMenu(protyle, blockElement, target);
            event.preventDefault();
            event.stopPropagation();
            return true;
        } else if (target.classList.contains("av__cell") && !protyle.disabled) {
            if (!hasClosestByClassName(target, "av__row--header")) {
                if (target.querySelector(".av__pulse")) {
                    return;
                }
                const cellType = getTypeByCellElement(target);
                if (viewType === "table") {
                    const scrollElement = hasClosestByClassName(target, "av__scroll");
                    if (!scrollElement) {
                        return;
                    }
                    const rowElement = hasClosestByClassName(target, "av__row");
                    if (!rowElement) {
                        return;
                    }
                    if (cellType === "updated" || cellType === "created" || cellType === "lineNumber") {
                        selectRow(rowElement.querySelector(".av__firstcol"), "toggle");
                    } else {
                        scrollElement.querySelectorAll(".av__row--select").forEach(item => {
                            item.querySelector(".av__firstcol use").setAttribute("xlink:href", "#iconUncheck");
                            item.classList.remove("av__row--select");
                        });
                        // 同步清空虚拟滚动选中快照，避免被 trim 掉的行回填后仍带选中态
                        blockElement.querySelectorAll(".av__body").forEach((bodyEl: HTMLElement) => {
                            resetAVRowSelect(bodyEl, []);
                        });
                        updateHeader(rowElement);
                        popTextCell(protyle, [target]);
                    }
                } else {
                    const itemElement = hasClosestByClassName(target, "av__gallery-item");
                    if (itemElement && cellType !== "updated" && cellType !== "created" && cellType !== "lineNumber") {
                        popTextCell(protyle, [target]);
                    }
                }
            }
            event.preventDefault();
            event.stopPropagation();
            return true;
        } else if (target.classList.contains("av__calc") && !protyle.disabled) {
            openCalcMenu(protyle, target, undefined, event.clientX - 64);
            event.preventDefault();
            event.stopPropagation();
            return true;
        } else if (type === "block-icon" && !protyle.disabled) {
            const blockTarget = resolveAVBlockTarget(protyle, target.dataset.avBlockTarget!);
            const rect = target.getBoundingClientRect();
            openProtyleEmojiMenu({
                protyle,
                position: {
                    x: rect.left,
                    y: rect.bottom,
                    h: rect.height,
                    w: rect.width,
                },
                onSelect: async (unicode, signal) => {
                    await setAVBlockIcon(protyle, blockTarget, unicode, signal);
                    if (signal.aborted || !target.isConnected) {
                        return;
                    }
                    target.dataset.unicode = unicode;
                    target.innerHTML = unicodeToEmoji(protyle, unicode || protyle.settings.icons.file);
                },
            });
            event.preventDefault();
            event.stopPropagation();
            return true;
        } else if (type === "av-gallery-edit" && !protyle.disabled) {
            editGalleryItem(protyle, target);
            event.preventDefault();
            event.stopPropagation();
            return true;
        } else if (type === "av-gallery-more" && !protyle.disabled) {
            const rect = target.getBoundingClientRect();
            openGalleryItemMenu({
                target,
                protyle,
                position: {
                    x: rect.left,
                    y: rect.bottom
                }
            });
            event.preventDefault();
            event.stopPropagation();
            return true;
        } else if (type === "av-group-fold") {
            target.setAttribute("data-processed", "true");
            const isOpen = target.firstElementChild.classList.contains("av__group-arrow--open");
            if (isOpen) {
                target.firstElementChild.classList.remove("av__group-arrow--open");
                target.parentElement.nextElementSibling.classList.add("fn__none");
            } else {
                target.firstElementChild.classList.add("av__group-arrow--open");
                target.parentElement.nextElementSibling.classList.remove("fn__none");
            }
            clearTimeout(foldTimeouts.get(protyle));
            foldTimeouts.set(protyle, window.setTimeout(() => {
                foldTimeouts.delete(protyle);
                transaction(protyle, [{
                    action: "foldAttrViewGroup",
                    avID: blockElement.dataset.avId,
                    blockID: blockElement.dataset.nodeId,
                    id: target.dataset.id,
                    data: isOpen
                }], [{
                    action: "foldAttrViewGroup",
                    avID: blockElement.dataset.avId,
                    blockID: blockElement.dataset.nodeId,
                    id: target.dataset.id,
                    data: !isOpen
                }]);
            }, Constants.TIMEOUT_COUNT));
            event.preventDefault();
            event.stopPropagation();
            return true;
        } else if (type === "av-load-more") {
            blockElement.querySelectorAll(".av__row--footer").forEach((item: HTMLElement) => {
                item.style.transform = "";
            });
            blockElement.removeAttribute("data-render");
            const bodyElement = hasClosestByClassName(target, "av__body") as HTMLElement;
            bodyElement.dataset.pageSize = (parseInt(bodyElement.dataset.pageSize) + parseInt(bodyElement.querySelector('[data-type="set-page-size"]').getAttribute("data-size"))).toString();
            avRender(blockElement, protyle);
            event.preventDefault();
            event.stopPropagation();
            return true;
        } else if (target.classList.contains("av__firstcol")) {
            closeAVMenu(protyle);
            selectRow(target, "toggle");
            event.preventDefault();
            event.stopPropagation();
            return true;
        } else if (target.classList.contains("item") && target.parentElement.classList.contains("layout-tab-bar")) {
            if (target.classList.contains("item--focus")) {
                openViewMenu({protyle, blockElement, element: target});
            } else if (protyle.options.action.includes(Constants.CB_GET_HISTORY)) {
                blockElement.setAttribute(Constants.CUSTOM_SY_AV_VIEW, target.dataset.id);
                blockElement.removeAttribute("data-render");
                if (target.dataset.page) {
                    blockElement.querySelectorAll(".av__body").forEach((bodyItem: HTMLElement) => {
                        bodyItem.dataset.pageSize = target.dataset.page;
                    });
                }
                avRender(blockElement, protyle);
            } else {
                transaction(protyle, [{
                    action: "setAttrViewBlockView",
                    blockID: blockElement.getAttribute("data-node-id"),
                    id: target.dataset.id,
                    avID: blockElement.getAttribute("data-av-id"),
                }], [{
                    action: "setAttrViewBlockView",
                    blockID: blockElement.getAttribute("data-node-id"),
                    id: target.parentElement.querySelector(".item--focus").getAttribute("data-id"),
                    avID: blockElement.getAttribute("data-av-id"),
                }]);
            }
            event.preventDefault();
            event.stopPropagation();
            return true;
        } else if (target.classList.contains("av__cellassetimg")) {
            previewAttrViewImages(
                protyle,
                (target as HTMLImageElement).getAttribute("data-src"),
                blockElement.getAttribute("data-av-id"),
                blockElement.getAttribute(Constants.CUSTOM_SY_AV_VIEW),
                blockElement.querySelector('[data-type="av-search"]')?.textContent.trim() || ""
            );
            event.preventDefault();
            event.stopPropagation();
            return true;
        } else if (target.classList.contains("av__row") && event.shiftKey && !target.classList.contains("av__row--header")) {
            selectRow(target.querySelector(".av__firstcol"), "toggle");
            event.preventDefault();
            event.stopPropagation();
            return true;
        } else if (type === "copy") {
            writeText(getCellText(hasClosestByClassName(target, "av__cell")));
            protyle.host.dispatch({
                type: "notify",
                level: "success",
                message: localization.text("copied"),
            });
            event.preventDefault();
            event.stopPropagation();
            return true;
        } else if (type === "av-search-icon") {
            const searchElement = blockElement.querySelector('div[data-type="av-search"]') as HTMLInputElement;
            searchElement.style.width = "128px";
            searchElement.style.paddingLeft = "";
            searchElement.style.marginRight = "1em";
            const viewsElement = hasClosestByClassName(searchElement, "av__views");
            if (viewsElement) {
                viewsElement.classList.add("av__views--show");
            }
            searchElement.focus();
            event.preventDefault();
            event.stopPropagation();
            return true;
        }
        target = target.parentElement;
    }
    return false;
};

export const avContextmenu = (protyle: IProtyle, rowElement: HTMLElement, position: IPosition) => {
    const {localization} = protyle;
    hideElements(["hint"], protyle);
    if (rowElement.classList.contains("av__row--header")) {
        return false;
    }
    const blockElement = hasClosestBlock(rowElement);
    if (!blockElement) {
        return false;
    }
    const avType = blockElement.getAttribute("data-av-type") as TAVView;
    if (avType === "table") {
        if (!rowElement.classList.contains("av__row--select")) {
            clearSelect(["row"], blockElement);
        }
        clearSelect(["cell"], blockElement);
        rowElement.classList.add("av__row--select");
        rowElement.querySelector(".av__firstcol use").setAttribute("xlink:href", "#iconCheck");
        const bodyElement = hasClosestByClassName(rowElement, "av__body") as HTMLElement;
        const rowId = rowElement.getAttribute("data-id");
        if (bodyElement && rowId) {
            updateAVRowSelect(bodyElement, rowId, true);
        }
        updateHeader(rowElement);
    } else {
        if (!rowElement.classList.contains("av__gallery-item--select")) {
            clearSelect(["galleryItem"], blockElement);
        }
        rowElement.classList.add("av__gallery-item--select");
        const bodyElement = hasClosestByClassName(rowElement, "av__body") as HTMLElement;
        const rowId = rowElement.getAttribute("data-id");
        if (bodyElement && rowId) {
            updateAVRowSelect(bodyElement, rowId, true);
        }
        updateHeader(rowElement);
    }
    const menuHandle = openAVMenu(protyle)!;
    const {menu} = menuHandle;
    const rowElements = blockElement.querySelectorAll(".av__row--select:not(.av__row--header), .av__gallery-item--select");
    const keyCellElements = Array.from(rowElements, item =>
        item.querySelector('.av__cell[data-dtype="block"]') as HTMLElement);
    const blockTargets = keyCellElements.map((cellElement) => {
        if (cellElement.dataset.detached === "true") {
            return undefined;
        }
        const reference = cellElement.querySelector<HTMLElement>("[data-av-block-target]")!.dataset.avBlockTarget!;
        return resolveAVBlockTarget(protyle, reference);
    });
    if (blockTargets.length === 1 && blockTargets[0]) {
        const blockTarget = blockTargets[0]!;
        const {blockId, documentId, notebookId} = blockTarget;
        const openDocument = (disposition: "new-tab" | "split-right" | "split-bottom") => {
            void requestBlockFold(protyle, {
                blockId,
                notebookId,
                documentId,
            }).then(({zoomIn}) => {
                protyle.host.dispatch({
                    type: "open-document",
                    notebookId,
                    documentId,
                    blockId,
                    disposition,
                    scope: zoomIn ? "subtree" : "context",
                    attention: "focus",
                    scroll: "auto",
                    restoreScroll: zoomIn ? "never" : "if-document",
                    zoom: zoomIn,
                });
            }).catch((error) => {
                if (!protyle.requestSignal.aborted) {
                    console.error("[protyle.transport] block fold request failed", error);
                }
            });
        };
        const openSubmenus: IMenu[] = [{
            id: "insertRight",
            icon: "iconLayoutRight",
            label: localization.text("insertRight"),
            accelerator: `${updateHotkeyTip(protyle.settings.hotkeys.editor.general.insertRight)}/${updateHotkeyTip("⌥" + localization.text("click"))}`,
            click: () => openDocument("split-right"),
        }, {
            id: "insertBottom",
            icon: "iconLayoutBottom",
            label: localization.text("insertBottom"),
            accelerator: "⇧⌘" + localization.text("click"),
            click: () => openDocument("split-bottom"),
        }];
        if (protyle.settings.navigation.openFilesUseCurrentTab) {
            openSubmenus.push({
                id: "openInNewTab",
                label: localization.text("openInNewTab"),
                accelerator: "⌥⌘" + localization.text("click"),
                click: () => openDocument("new-tab"),
            });
        }
        if (protyle.settings.features.blockAttributes) {
            openSubmenus.push({id: "separator_3", type: "separator"});
            openSubmenus.push({
                id: "attr",
                icon: "iconAttr",
                label: localization.text("attr"),
                click: () => protyle.host.dispatch({
                    type: "open-block-attributes",
                    notebookId,
                    documentId: blockTarget.documentId,
                    blockId,
                    focus: "av",
                }),
            });
        }
        menu.addItem({
            id: "openBy",
            label: localization.text("openBy"),
            icon: "iconOpen",
            submenu: openSubmenus,
        });
    }
    const hasBlock = blockTargets.some((target) => target !== undefined);
    const copyMenu: IMenu[] = [{
        id: "copyKeyContent",
        iconHTML: "",
        label: localization.text("copyKeyContent"),
        click() {
            let text = "";
            rowElements.forEach((item, i) => {
                if (rowElements.length > 1) {
                    text += "- ";
                }
                text += item.querySelector('.av__cell[data-dtype="block"] .av__celltext').textContent.trim();
                if (blockTargets.length > 1 && i !== blockTargets.length - 1) {
                    text += "\n";
                }
            });
            writeText(text);
        }
    }];
    if (hasBlock) {
        copyMenu.splice(1, 0, {
            id: "copyBlockRef",
            iconHTML: "",
            label: localization.text("copyBlockRef"),
            click: () => {
                let text = "";
                blockTargets.forEach((blockTarget, index) => {
                    let content = "";
                    const cellElement = keyCellElements[index];
                    if (!blockTarget) {
                        content = cellElement.querySelector(".av__celltext").textContent;
                    } else {
                        content = `((${blockTarget.blockId} '${cellElement.querySelector(".av__celltext").textContent.replace(/[\n]+/g, " ")}'))`;
                    }
                    if (blockTargets.length > 1) {
                        text += "- ";
                    }
                    text += content;
                    if (blockTargets.length > 1 && index !== blockTargets.length - 1) {
                        text += "\n";
                    }
                });
                writeText(text);
            }
        }, {
            id: "copyBlockEmbed",
            iconHTML: "",
            label: localization.text("copyBlockEmbed"),
            click: () => {
                let text = "";
                blockTargets.forEach((blockTarget, index) => {
                    if (blockTargets.length > 1) {
                        text += "- ";
                    }
                    const cellElement = keyCellElements[index];
                    if (!blockTarget) {
                        text += cellElement.querySelector(".av__celltext").textContent;
                    } else {
                        text += `{{select * from blocks where id='${blockTarget.blockId}'}}`;
                    }
                    if (blockTargets.length > 1 && index !== blockTargets.length - 1) {
                        text += "\n";
                    }
                });
                writeText(text);
            }
        }, {
            id: "copyProtocol",
            iconHTML: "",
            label: localization.text("copyProtocol"),
            click: () => {
                let text = "";
                blockTargets.forEach((blockTarget, index) => {
                    if (blockTargets.length > 1) {
                        text += "- ";
                    }
                    const cellElement = keyCellElements[index];
                    if (!blockTarget) {
                        text += cellElement.querySelector(".av__celltext").textContent;
                    } else {
                        text += buildSiYuanBlockUri(
                            blockTarget.blockId,
                            blockTarget.notebookId,
                            blockTarget.documentId,
                        );
                    }
                    if (blockTargets.length > 1 && index !== blockTargets.length - 1) {
                        text += "\n";
                    }
                });
                writeText(text);
            }
        }, {
            id: "copyProtocolInMd",
            iconHTML: "",
            label: localization.text("copyProtocolInMd"),
            click: () => {
                let text = "";
                blockTargets.forEach((blockTarget, index) => {
                    let content = "";
                    const cellElement = keyCellElements[index];
                    if (!blockTarget) {
                        content = cellElement.querySelector(".av__celltext").textContent;
                    } else {
                        content = `[${cellElement.querySelector(".av__celltext").textContent.replace(/[\n]+/g, " ")}](${buildSiYuanBlockUri(
                            blockTarget.blockId,
                            blockTarget.notebookId,
                            blockTarget.documentId,
                        )})`;
                    }
                    if (blockTargets.length > 1) {
                        text += "- ";
                    }
                    text += content;
                    if (blockTargets.length > 1 && index !== blockTargets.length - 1) {
                        text += "\n";
                    }
                });
                writeText(text);
            }
        }, {
            id: "copyHPath",
            iconHTML: "",
            label: localization.text("copyHPath"),
            click: async () => {
                let text = "";
                for (let index = 0; index < blockTargets.length; index++) {
                    let content = "";
                    const cellElement = keyCellElements[index];
                    const blockTarget = blockTargets[index];
                    if (!blockTarget) {
                        content = cellElement.querySelector(".av__celltext").textContent;
                    } else {
                        const response = await protyle.transport!.request<IWebSocketData>("/api/filetree/getHPathByID", {
                            id: blockTarget.blockId,
                            notebook: blockTarget.notebookId,
                        }, {
                            identity: {
                                documentId: blockTarget.documentId,
                                notebookId: blockTarget.notebookId,
                            },
                            intent: "read",
                            signal: protyle.requestSignal,
                        });
                        content = response.data;
                    }

                    if (blockTargets.length > 1) {
                        text += "- ";
                    }
                    text += content;
                    if (blockTargets.length > 1 && index !== blockTargets.length - 1) {
                        text += "\n";
                    }
                }
                writeText(text);
            }
        }, {
            id: "copyID",
            iconHTML: "",
            label: localization.text("copyID"),
            click: () => {
                let text = "";
                blockTargets.forEach((blockTarget, index) => {
                    if (blockTargets.length > 1) {
                        text += "- ";
                    }
                    const cellElement = keyCellElements[index];
                    if (!blockTarget) {
                        text += cellElement.querySelector(".av__celltext").textContent;
                    } else {
                        text += blockTarget.blockId;
                    }
                    if (blockTargets.length > 1 && index !== blockTargets.length - 1) {
                        text += "\n";
                    }
                });
                writeText(text);
            }
        });
    }

    copyMenu.push({
        id: "duplicate",
        iconHTML: "",
        label: localization.text("duplicate"),
        click: () => {
            duplicateRows(blockElement, protyle, rowElements);
        }
    });

    menu.addItem({
        id: "copy",
        label: localization.text("copy"),
        icon: "iconCopy",
        type: "submenu",
        submenu: copyMenu
    });
    if (!protyle.disabled) {
        menu.addItem({
            id: "addToDatabase",
            label: localization.text("addToDatabase"),
            icon: "iconDatabase",
            click() {
                openSearchAV(protyle, blockElement.getAttribute("data-av-id"), rowElements[0] as HTMLElement, (listItemElement) => {
                    const srcs: IOperationSrcs[] = [];
                    const sourceIds: string[] = [];
                    rowElements.forEach(item => {
                        const rowId = item.getAttribute("data-id");
                        const blockValue = genCellValueByElement(protyle, "block", item.querySelector('.av__cell[data-dtype="block"]'));
                        srcs.push({
                            itemID: Lute.NewNodeID(),
                            content: blockValue.block.content,
                            id: blockValue.block.id || "",
                            isDetached: blockValue.isDetached,
                        });
                        sourceIds.push(rowId);
                    });
                    const avID = listItemElement.dataset.avId;
                    const viewID = listItemElement.dataset.viewId;
                    transaction(protyle, [{
                        action: "insertAttrViewBlock",
                        ignoreDefaultFill: viewID ? false : true,
                        viewID,
                        avID,
                        srcs,
                        context: {ignoreTip: "true"},
                        blockID: listItemElement.dataset.blockId,
                        groupID: rowElement.parentElement.getAttribute("data-group-id")
                    }, {
                        action: "doUpdateUpdated",
                        id: listItemElement.dataset.blockId,
                        data: dayjs().format("YYYYMMDDHHmmss"),
                    }], [{
                        action: "removeAttrViewBlock",
                        srcIDs: sourceIds,
                        avID,
                    }]);
                });
            }
        });
        if (rowElements.length === 1) {
            if (blockTargets[0]) {
                menu.addItem({id: "separator_1", type: "separator"});
            }
            menu.addItem({
                id: avType === "table" ? "insertRowBefore" : "insertItemBefore",
                icon: "iconBefore",
                label: `<div class="fn__flex" style="align-items: center;">
${localization.text(avType === "table" ? "insertRowBefore" : "insertItemBefore").replace("${x}", `<span class="fn__space"></span><input type="number" step="1" min="1" value="1" placeholder="${localization.text("enterKey")}" class="b3-text-field b3-text-field--size"><span class="fn__space"></span>`)}
</div>`,
                bind(element) {
                    const inputElement = element.querySelector("input");
                    element.addEventListener("click", () => {
                        if (document.activeElement === inputElement) {
                            return;
                        }
                        insertRows({
                            blockElement,
                            protyle,
                            count: parseInt(inputElement.value),
                            previousID: rowElements[0].previousElementSibling?.getAttribute("data-id"),
                            groupID: rowElements[0].parentElement.getAttribute("data-group-id")
                        });
                        menuHandle.close();
                    });
                    inputElement.addEventListener("keydown", (event: KeyboardEvent) => {
                        if (!event.isComposing && event.key === "Enter") {
                            insertRows({
                                blockElement,
                                protyle,
                                count: parseInt(inputElement.value),
                                previousID: rowElements[0].previousElementSibling?.getAttribute("data-id"),
                                groupID: rowElements[0].parentElement.getAttribute("data-group-id")
                            });
                            menuHandle.close();
                        }
                    });
                }
            });
            menu.addItem({
                id: avType === "table" ? "insertRowAfter" : "insertItemAfter",
                icon: "iconAfter",
                label: `<div class="fn__flex" style="align-items: center;">
${localization.text(avType === "table" ? "insertRowAfter" : "insertItemAfter").replace("${x}", `<span class="fn__space"></span><input type="number" step="1" min="1" placeholder="${localization.text("enterKey")}" class="b3-text-field b3-text-field--size" value="1"><span class="fn__space"></span>`)}
</div>`,
                bind(element) {
                    const inputElement = element.querySelector("input");
                    element.addEventListener("click", () => {
                        if (document.activeElement === inputElement) {
                            return;
                        }
                        insertRows({
                            blockElement,
                            protyle,
                            count: parseInt(inputElement.value),
                            previousID: rowElements[0].getAttribute("data-id"),
                            groupID: rowElements[0].parentElement.getAttribute("data-group-id")
                        });
                        menuHandle.close();
                    });
                    inputElement.addEventListener("keydown", (event: KeyboardEvent) => {
                        if (!event.isComposing && event.key === "Enter") {
                            insertRows({
                                blockElement,
                                protyle,
                                count: parseInt(inputElement.value),
                                previousID: rowElements[0].getAttribute("data-id"),
                                groupID: rowElements[0].parentElement.getAttribute("data-group-id")
                            });
                            menuHandle.close();
                        }
                    });
                }
            });
            menu.addItem({id: "separator_2", type: "separator"});
            if (blockTargets[0]) {
                menu.addItem({
                    id: "unbindBlock",
                    label: localization.text("unbindBlock"),
                    icon: "iconLinkOff",
                    click() {
                        updateCellsValue(protyle, blockElement, {
                            content: keyCellElements[0].querySelector(".av__celltext").textContent,
                        }, [keyCellElements[0]]);
                    }
                });
            }
        }
        menu.addItem({
            id: "delete",
            icon: "iconTrashcan",
            label: localization.text("delete"),
            click() {
                deleteRow(blockElement, protyle);
            }
        });
        const editAttrSubmenu: IMenu[] = [];
        if (avType === "table") {
            rowElement.parentElement.querySelectorAll(".av__row--header .av__cell").forEach((cellElement: HTMLElement) => {
                const selectElements: HTMLElement[] = Array.from(blockElement.querySelectorAll(`.av__row--select:not(.av__row--header) .av__cell[data-col-id="${cellElement.dataset.colId}"]`));
                const type = cellElement.getAttribute("data-dtype") as TAVCol;
                if (!["updated", "created"].includes(type)) {
                    const icon = cellElement.dataset.icon;
                    editAttrSubmenu.push({
                        iconHTML: icon ? unicodeToEmoji(protyle, icon, "b3-menu__icon", true) : `<svg class="b3-menu__icon"><use xlink:href="#${getColIconByType(type)}"></use></svg>`,
                        label: escapeHtml(cellElement.querySelector(".av__celltext").textContent.trim()),
                        click() {
                            popTextCell(protyle, selectElements);
                        }
                    });
                }
            });
        } else {
            rowElement.querySelectorAll(".av__cell").forEach((cellElement: HTMLElement) => {
                const selectElements: HTMLElement[] = Array.from(blockElement.querySelectorAll(`.av__gallery-item--select .av__cell[data-field-id="${cellElement.dataset.fieldId}"]`));
                const type = cellElement.getAttribute("data-dtype") as TAVCol;
                if (!["updated", "created"].includes(type)) {
                    const iconElement = cellElement.parentElement.querySelector(".av__gallery-tip, .av__gallery-name").firstElementChild.cloneNode(true) as HTMLElement;
                    iconElement.classList.add("b3-menu__icon");
                    editAttrSubmenu.push({
                        iconHTML: iconElement.outerHTML,
                        label: escapeHtml(cellElement.getAttribute("aria-label").split('<div class="ft__on-surface">')[0]),
                        click() {
                            rowElement.querySelector(".av__gallery-fields").classList.add("av__gallery-fields--edit");
                            rowElement.querySelector('[data-type="av-gallery-edit"]').setAttribute("aria-label", localization.text("hideEmptyFields"));
                            popTextCell(protyle, selectElements);
                        }
                    });
                }
            });
        }
        menu.addItem({
            id: "fields",
            icon: "iconAttr",
            label: localization.text("fields"),
            type: "submenu",
            submenu: editAttrSubmenu
        });
    }
    emitProtylePluginMenu({
        plugins: protyle.plugins,
        menu,
        localization,
        type: "open-menu-av",
        detail: {
            protyle,
            element: blockElement,
            selectRowElements: rowElements,
        },
        separatorPosition: "top",
    });
    menu.popup(position);
    return true;
};

export const updateAVName = (protyle: IProtyle, blockElement: Element) => {
    const avId = blockElement.getAttribute("data-av-id");
    const id = blockElement.getAttribute("data-node-id");
    const nameElement = blockElement.querySelector(".av__title") as HTMLElement;
    // https://github.com/siyuan-note/siyuan/issues/14770
    if (nameElement.textContent === "") {
        nameElement.querySelectorAll("br").forEach(item => {
            item.remove();
        });
    }
    const newData = nameElement.textContent.trim();
    if (newData === nameElement.dataset.title.trim()) {
        return;
    }
    if (newData.length > Constants.SIZE_TITLE) {
        protyle.host.dispatch({
            type: "notify",
            level: "info",
            message: protyle.localization.kernelText(106),
        });
        return false;
    }
    const newUpdated = dayjs().format("YYYYMMDDHHmmss");
    transaction(protyle, [{
        action: "setAttrViewName",
        id: avId,
        data: newData,
    }, {
        action: "doUpdateUpdated",
        id,
        data: newUpdated,
    }], [{
        action: "setAttrViewName",
        id: avId,
        data: nameElement.dataset.title,
    }, {
        action: "doUpdateUpdated",
        id,
        data: blockElement.getAttribute("updated")
    }]);
    blockElement.setAttribute("updated", newUpdated);
    nameElement.dataset.title = newData;

    // 当前页面不能进行推送，否则光标会乱跳
    Array.from(protyle.wysiwyg.element.querySelectorAll(`.av[data-av-id="${avId}"]`)).forEach((item: HTMLElement) => {
        if (blockElement === item) {
            return;
        }
        const titleElement = item.querySelector(".av__title") as HTMLElement;
        if (!titleElement) {
            return;
        }
        titleElement.textContent = newData;
        titleElement.dataset.title = newData;
    });
};

export const updateAttrViewCellAnimation = (protyle: IProtyle, cellElement: HTMLElement, value: IAVCellValue, headerValue?: {
    icon?: string,
    name?: string,
    pin?: boolean,
    type?: TAVCol
}) => {
    // 属性面板更新列名
    if (!cellElement) {
        return;
    }
    if (headerValue) {
        updateHeaderCell(cellElement, headerValue, protyle);
    } else {
        const hasDragFill = cellElement.querySelector(".av__drag-fill");
        const blockElement = hasClosestBlock(cellElement);
        if (!blockElement) {
            return;
        }
        const viewType = blockElement.getAttribute("data-av-type") as TAVView;
        const iconElement = cellElement.querySelector(".b3-menu__avemoji");
        if (["gallery", "kanban"].includes(viewType)) {
            if (value.type === "checkbox") {
                value.checkbox = {
                    checked: value.checkbox?.checked || false,
                    content: cellElement.getAttribute("aria-label").split('<div class="ft__on-surface">')[0],
                };
            }
            cellElement.innerHTML = renderCell(value, 0, iconElement ? !iconElement.classList.contains("fn__none") : false,
                viewType, protyle.settings.icons.file, protyle);
            cellElement.parentElement.setAttribute("data-empty", cellValueIsEmpty(value).toString());
        } else {
            cellElement.innerHTML = renderCell(value, 0, iconElement ? !iconElement.classList.contains("fn__none") : false,
                "table", protyle.settings.icons.file, protyle);
        }
        if (hasDragFill) {
            addDragFill(cellElement, protyle.localization);
        }
        renderCellAttr(cellElement, value);
    }
};

export const removeAttrViewColAnimation = (blockElement: Element, id: string) => {
    blockElement.querySelectorAll(`.av__cell[data-col-id="${id}"]`).forEach(item => {
        item.remove();
    });
};

export const duplicateCompletely = (protyle: IProtyle, nodeElement: HTMLElement) => {
    const identity = protyleContentIdentity(protyle);
    void protyle.transport!.request<IWebSocketData>("/api/av/duplicateAttributeViewBlock", {
        avID: nodeElement.getAttribute("data-av-id"),
    }, {
        identity,
        intent: "write",
        signal: protyle.requestSignal,
    }).then((response) => {
        if (protyle.requestSignal.aborted || protyle.destroyed || !nodeElement.isConnected) {
            return;
        }
        nodeElement.classList.remove("protyle-wysiwyg--select");
        const tempElement = document.createElement("template");
        tempElement.innerHTML = protyle.lute.SpinBlockDOM(`<div class="av" data-node-id="${response.data.blockID}" data-av-id="${response.data.avID}" data-type="NodeAttributeView" data-av-type="table"></div>`);
        const cloneElement = tempElement.content.firstElementChild;
        nodeElement.after(cloneElement);
        avRender(cloneElement, protyle, () => {
            focusBlock(cloneElement);
            scrollCenter(protyle);
        });
        transaction(protyle, [{
            action: "insert",
            data: cloneElement.outerHTML,
            id: response.data.blockID,
            previousID: nodeElement.dataset.nodeId,
        }], [{
            action: "delete",
            id: response.data.blockID,
        }]);
    }).catch((error) => {
        if (!protyle.requestSignal.aborted) {
            console.error("[protyle.transport] duplicate attribute view failed", {
                documentId: identity.documentId,
                notebookId: identity.notebookId,
                error,
            });
        }
    });
};
