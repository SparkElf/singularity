import type {ProtyleMenuHandle, ProtyleMenuSurface} from "../../../../enterprise/packages/protyle-browser/src/contracts";
import dayjs from "dayjs";
import {copyPlainText, readClipboard, writeText} from "../util/clipboard";
import {hasClosestByTag} from "../util/hasClosest";
import {emitProtylePluginMenu} from "../util/plugin";
import {focusByRange, focusByWbr, getEditorRange, selectAll} from "../util/selection";
import {
    deleteColumn,
    deleteRow,
    getColIndex,
    insertColumn,
    insertRow,
    insertRowAbove,
    moveColumnToLeft,
    moveColumnToRight,
    moveRowToDown,
    moveRowToUp,
    setTableAlign,
    updateTableTitle,
} from "../util/table";
import {paste, pasteAsPlainText, pasteEscaped} from "../util/paste";
import {updateTransaction} from "../wysiwyg/transaction";

type TableMenuOwner = Pick<ProtyleMenuHandle<ProtyleMenuSurface>, "close">;

const createQuantityMenu = (
    id: string,
    icon: string,
    label: string,
    accelerator: string,
    owner: TableMenuOwner | undefined,
    action: (count: number) => void,
): IMenu => {
    let committedFromInput = false;
    return {
        id,
        icon,
        label: `<div class="fn__flex" style="align-items: center;">${label}</div>`,
        accelerator,
        click: (element, event) => {
            if (event.target instanceof HTMLInputElement) {
                return true;
            }
            if (committedFromInput) {
                committedFromInput = false;
                return;
            }
            action(parseInt(element.querySelector<HTMLInputElement>("input")!.value));
        },
        bind: (element) => {
            const inputElement = element.querySelector<HTMLInputElement>("input")!;
            inputElement.addEventListener("keydown", (event) => {
                if (!event.isComposing && event.key === "Enter") {
                    event.preventDefault();
                    event.stopPropagation();
                    action(parseInt(inputElement.value));
                    if (owner) {
                        owner.close();
                    } else {
                        committedFromInput = true;
                        element.click();
                    }
                }
            });
        },
    };
};

export const contentMenu = (protyle: IProtyle, nodeElement: Element): ProtyleMenuHandle<ProtyleMenuSurface> => {
    const range = getEditorRange(nodeElement);
    const handle = protyle.runtime.menu.open();
    const menu = handle.menu;
    const oldHTML = nodeElement.outerHTML;
    const captionElement = hasClosestByTag(range.startContainer, "CAPTION");
    const labels = protyle.localization;
    const hotkeys = protyle.settings.hotkeys.editor;

    if (range.toString() !== "" || (range.cloneContents().childNodes[0] as HTMLElement)?.classList?.contains("emoji")) {
        menu.addItem({
            id: "copy",
            icon: "iconCopy",
            accelerator: "⌘C",
            label: labels.text("copy"),
            click() {
                // The editor range can be invalidated before the menu action runs.
                focusByRange(getEditorRange(nodeElement));
                document.execCommand("copy");
            },
        });
        menu.addItem({
            id: "copyPlainText",
            label: labels.text("copyPlainText"),
            accelerator: hotkeys.general.copyPlainText,
            click() {
                focusByRange(getEditorRange(nodeElement));
                copyPlainText(getSelection().getRangeAt(0).toString());
            },
        });
        if (protyle.disabled || captionElement) {
            return handle;
        }
        menu.addItem({
            id: "cut",
            icon: "iconCut",
            accelerator: "⌘X",
            label: labels.text("cut"),
            click() {
                focusByRange(getEditorRange(nodeElement));
                document.execCommand("cut");
            },
        });
        menu.addItem({
            id: "delete",
            icon: "iconTrashcan",
            label: labels.text("delete"),
            click() {
                const currentRange = getEditorRange(nodeElement);
                currentRange.insertNode(document.createElement("wbr"));
                currentRange.extractContents();
                focusByWbr(nodeElement, currentRange);
                focusByRange(currentRange);
                updateTransaction(protyle, nodeElement, oldHTML);
            },
        });
    } else {
        // https://github.com/siyuan-note/siyuan/issues/9630
        const inlineElement = hasClosestByTag(range.startContainer, "SPAN");
        if (inlineElement) {
            const inlineTypes = protyle.toolbar.getCurrentType(range);
            if (inlineTypes.includes("code") || inlineTypes.includes("kbd")) {
                menu.addItem({
                    id: "copy",
                    label: labels.text("copy"),
                    icon: "iconCopy",
                    click() {
                        writeText(protyle.lute.BlockDOM2StdMd(inlineElement.outerHTML));
                    },
                });
                menu.addItem({
                    id: "copyPlainText",
                    label: labels.text("copyPlainText"),
                    click() {
                        copyPlainText(inlineElement.textContent);
                    },
                });
                if (!protyle.disabled) {
                    menu.addItem({
                        id: "cut",
                        icon: "iconCut",
                        label: labels.text("cut"),
                        click() {
                            writeText(protyle.lute.BlockDOM2StdMd(inlineElement.outerHTML));
                            inlineElement.insertAdjacentHTML("afterend", "<wbr>");
                            inlineElement.remove();
                            nodeElement.setAttribute("updated", dayjs().format("YYYYMMDDHHmmss"));
                            updateTransaction(protyle, nodeElement, oldHTML);
                            focusByWbr(nodeElement, protyle.toolbar.range);
                        },
                    });
                    menu.addItem({
                        id: "remove",
                        icon: "iconTrashcan",
                        label: labels.text("remove"),
                        click() {
                            inlineElement.insertAdjacentHTML("afterend", "<wbr>");
                            inlineElement.remove();
                            nodeElement.setAttribute("updated", dayjs().format("YYYYMMDDHHmmss"));
                            updateTransaction(protyle, nodeElement, oldHTML);
                            focusByWbr(nodeElement, protyle.toolbar.range);
                        },
                    });
                }
                menu.addItem({type: "separator"});
            }
        }
    }

    if (!protyle.disabled && !captionElement) {
        menu.addItem({
            id: "paste",
            label: labels.text("paste"),
            icon: "iconPaste",
            accelerator: "⌘V",
            async click() {
                focusByRange(getEditorRange(nodeElement));
                if (document.queryCommandSupported("paste")) {
                    document.execCommand("paste");
                    return;
                }
                try {
                    const text = await readClipboard();
                    paste(protyle, Object.assign(text, {target: nodeElement as HTMLElement}));
                } catch (error) {
                    console.log(error);
                }
            },
        });
        menu.addItem({
            id: "pasteAsPlainText",
            label: labels.text("pasteAsPlainText"),
            accelerator: "⇧⌘V",
            click() {
                focusByRange(getEditorRange(nodeElement));
                pasteAsPlainText(protyle);
            },
        });
        menu.addItem({
            id: "pasteEscaped",
            label: labels.text("pasteEscaped"),
            click() {
                focusByRange(getEditorRange(nodeElement));
                pasteEscaped(protyle, nodeElement);
            },
        });
    }
    if (!captionElement) {
        menu.addItem({
            id: "selectAll",
            label: labels.text("selectAll"),
            icon: "iconSelectAll",
            accelerator: "⌘A",
            click() {
                selectAll(protyle, nodeElement, range);
            },
        });
    }
    if (nodeElement.classList.contains("table") && !protyle.disabled) {
        const cellElement = hasClosestByTag(range.startContainer, "TD") || hasClosestByTag(range.startContainer, "TH");
        if (cellElement) {
            const tableMenus = tableMenu(protyle, nodeElement, cellElement as HTMLTableCellElement, range, handle);
            if (tableMenus.insertMenus.length > 0) {
                menu.addItem({id: "separator_1", type: "separator"});
                tableMenus.insertMenus.forEach((item) => menu.addItem(item));
            }
            if (tableMenus.removeMenus.length > 0) {
                menu.addItem({id: "separator_2", type: "separator"});
                tableMenus.removeMenus.forEach((item) => menu.addItem(item));
            }
            menu.addItem({id: "separator_3", type: "separator"});
            menu.addItem({
                id: "more",
                type: "submenu",
                icon: "iconMore",
                label: labels.text("more"),
                submenu: tableMenus.otherMenus.concat(tableMenus.other2Menus),
            });
        }
    }

    emitProtylePluginMenu({
        localization: protyle.localization,
        menu,
        plugins: protyle.plugins,
        type: "open-menu-content",
        detail: {protyle, range, element: nodeElement},
        separatorPosition: "top",
    });
    return handle;
};

export const tableMenu = (
    protyle: IProtyle,
    nodeElement: Element,
    cellElement: HTMLTableCellElement,
    range: Range,
    owner?: TableMenuOwner,
) => {
    const labels = protyle.localization;
    const hotkeys = protyle.settings.hotkeys.editor;
    const otherMenus: IMenu[] = [];
    const colIndex = getColIndex(cellElement);
    if (cellElement.rowSpan > 1 || cellElement.colSpan > 1) {
        otherMenus.push({
            id: "cancelMerged",
            label: labels.text("cancelMerged"),
            click: () => {
                const oldHTML = nodeElement.outerHTML;
                let rowSpan = cellElement.rowSpan;
                let currentRowElement: Element = cellElement.parentElement;
                const originalColSpan = cellElement.colSpan;
                while (rowSpan > 0 && currentRowElement) {
                    let currentCellElement = currentRowElement.children[colIndex] as HTMLTableCellElement;
                    let colSpan = originalColSpan;
                    while (colSpan > 0 && currentCellElement) {
                        currentCellElement.classList.remove("fn__none");
                        currentCellElement.removeAttribute("colspan");
                        currentCellElement.removeAttribute("rowspan");
                        currentCellElement = currentCellElement.nextElementSibling as HTMLTableCellElement;
                        colSpan--;
                    }
                    currentRowElement = currentRowElement.nextElementSibling;
                    rowSpan--;
                }
                cellElement.removeAttribute("colspan");
                cellElement.removeAttribute("rowspan");
                if (cellElement.tagName === "TH") {
                    let pureTableRow: HTMLElement;
                    Array.from(nodeElement.querySelectorAll("thead tr")).find((item: HTMLElement) => {
                        pureTableRow = item;
                        Array.from(item.children).forEach((currentCell: HTMLTableCellElement) => {
                            if (currentCell.rowSpan !== 1 || currentCell.classList.contains("fn__none")) {
                                pureTableRow = undefined;
                            }
                        });
                        return Boolean(pureTableRow);
                    });
                    if (pureTableRow) {
                        const tbodyElement = nodeElement.querySelector("tbody")!;
                        const theadElement = nodeElement.querySelector("thead")!;
                        while (pureTableRow !== theadElement.lastElementChild) {
                            theadElement.lastElementChild!.querySelectorAll("th").forEach((item) => {
                                const td = document.createElement("td");
                                Array.from(item.attributes).forEach((attribute) => td.setAttribute(attribute.name, attribute.value));
                                while (item.firstChild) {
                                    td.appendChild(item.firstChild);
                                }
                                item.replaceWith(td);
                            });
                            tbodyElement.insertAdjacentElement("afterbegin", theadElement.lastElementChild!);
                        }
                    }
                }
                focusByRange(range);
                updateTransaction(protyle, nodeElement, oldHTML);
            },
        });
    }
    const matchedColumn = nodeElement.querySelectorAll("col")[colIndex] as HTMLElement;
    if (matchedColumn.style.width || matchedColumn.style.minWidth !== "60px") {
        otherMenus.push({
            id: "useDefaultWidth",
            label: labels.text("useDefaultWidth"),
            click: () => {
                const html = nodeElement.outerHTML;
                matchedColumn.style.width = "";
                matchedColumn.style.minWidth = "60px";
                updateTransaction(protyle, nodeElement, html);
            },
        });
    }
    const isPinHead = nodeElement.getAttribute("custom-pinthead");
    otherMenus.push({
        id: isPinHead ? "unpinTableHead" : "pinTableHead",
        icon: isPinHead ? "iconUnpin" : "iconPin",
        label: labels.text(isPinHead ? "unpinTableHead" : "pinTableHead"),
        click: () => {
            const html = nodeElement.outerHTML;
            if (isPinHead) {
                nodeElement.removeAttribute("custom-pinthead");
            } else {
                nodeElement.setAttribute("custom-pinthead", "true");
            }
            updateTransaction(protyle, nodeElement, html);
        },
    });
    otherMenus.push({
        icon: "iconHeadings",
        label: labels.text("title"),
        click: () => updateTableTitle(protyle, nodeElement),
    });
    otherMenus.push({id: "separator_1", type: "separator"});
    otherMenus.push({
        id: "alignLeft",
        icon: "iconAlignLeft",
        accelerator: hotkeys.general.alignLeft,
        label: labels.text("alignLeft"),
        click: () => setTableAlign(protyle, [cellElement], nodeElement, "left", range),
    }, {
        id: "alignCenter",
        icon: "iconAlignCenter",
        accelerator: hotkeys.general.alignCenter,
        label: labels.text("alignCenter"),
        click: () => setTableAlign(protyle, [cellElement], nodeElement, "center", range),
    }, {
        id: "alignRight",
        icon: "iconAlignRight",
        accelerator: hotkeys.general.alignRight,
        label: labels.text("alignRight"),
        click: () => setTableAlign(protyle, [cellElement], nodeElement, "right", range),
    }, {
        id: "useDefaultAlign",
        icon: "",
        label: labels.text("useDefaultAlign"),
        click: () => setTableAlign(protyle, [cellElement], nodeElement, "", range),
    });

    const menus: IMenu[] = [...otherMenus, {type: "separator"}];
    const tableElement = nodeElement.querySelector("table")!;
    const hasNone = cellElement.parentElement!.querySelector(".fn__none");
    let hasColSpan = false;
    let hasRowSpan = false;
    Array.from(cellElement.parentElement!.children).forEach((item: HTMLTableCellElement) => {
        hasColSpan ||= item.colSpan > 1;
        hasRowSpan ||= item.rowSpan > 1;
    });
    let previousHasNone: false | Element = false;
    let previousHasColSpan = false;
    let previousHasRowSpan = false;
    let previousRowElement = cellElement.parentElement!.previousElementSibling;
    if (!previousRowElement && cellElement.parentElement!.parentElement!.tagName === "TBODY") {
        previousRowElement = tableElement.querySelector("thead")!.lastElementChild;
    }
    if (previousRowElement) {
        previousHasNone = previousRowElement.querySelector(".fn__none");
        Array.from(previousRowElement.children).forEach((item: HTMLTableCellElement) => {
            previousHasColSpan ||= item.colSpan > 1;
            previousHasRowSpan ||= item.rowSpan > 1;
        });
    }
    let nextHasNone: false | Element = false;
    let nextHasColSpan = false;
    let nextHasRowSpan = false;
    let nextRowElement = cellElement.parentElement!.nextElementSibling;
    if (!nextRowElement && cellElement.parentElement!.parentElement!.tagName === "THEAD") {
        nextRowElement = tableElement.querySelector("tbody")?.firstElementChild ?? null;
    }
    if (nextRowElement) {
        nextHasNone = nextRowElement.querySelector(".fn__none");
        Array.from(nextRowElement.children).forEach((item: HTMLTableCellElement) => {
            nextHasColSpan ||= item.colSpan > 1;
            nextHasRowSpan ||= item.rowSpan > 1;
        });
    }
    const columnIsPure = Array.from(tableElement.rows).every((row) => {
        const cell = row.cells[colIndex];
        return !cell.classList.contains("fn__none") && cell.colSpan === 1 && cell.rowSpan === 1;
    });
    const nextColumnIsPure = Array.from(tableElement.rows).every((row) => {
        const cell = row.cells[colIndex + 1];
        return !cell || (!cell.classList.contains("fn__none") && cell.colSpan === 1 && cell.rowSpan === 1);
    });
    const previousColumnIsPure = Array.from(tableElement.rows).every((row) => {
        const cell = row.cells[colIndex - 1];
        return !cell || (!cell.classList.contains("fn__none") && cell.colSpan === 1 && cell.rowSpan === 1);
    });

    const quantityLabel = (key: string) => labels.text(key).replace("${x}", `<span class="fn__space"></span><input type="number" step="1" min="1" value="1" placeholder="${labels.text("enterKey")}" class="b3-text-field b3-text-field--size"><span class="fn__space"></span>`);
    const insertMenus: IMenu[] = [createQuantityMenu(
        "insertRowAbove", "iconBefore", quantityLabel("insertRowBefore"), hotkeys.table.insertRowAbove, owner,
        (count) => insertRowAbove(protyle, range, cellElement, nodeElement, count),
    )];
    if (!nextHasNone || (nextHasNone && !nextHasRowSpan && nextHasColSpan)) {
        insertMenus.push(createQuantityMenu(
            "insertRowBelow", "iconAfter", quantityLabel("insertRowAfter"), hotkeys.table.insertRowBelow, owner,
            (count) => insertRow(protyle, range, cellElement, nodeElement, count),
        ));
    }
    if (columnIsPure || previousColumnIsPure) {
        insertMenus.push(createQuantityMenu(
            "insertColumnLeft", "iconInsertLeft", quantityLabel("insertColumnLeft1"), hotkeys.table.insertColumnLeft, owner,
            (count) => insertColumn(protyle, nodeElement, cellElement, "beforebegin", range, count),
        ));
    }
    if (columnIsPure || nextColumnIsPure) {
        insertMenus.push(createQuantityMenu(
            "insertColumnRight", "iconInsertRight", quantityLabel("insertColumnRight1"), hotkeys.table.insertColumnRight, owner,
            (count) => insertColumn(protyle, nodeElement, cellElement, "afterend", range, count),
        ));
    }
    menus.push(...insertMenus);

    const rowCanMoveUp = (!hasNone || (hasNone && !hasRowSpan && hasColSpan)) &&
        (!previousHasNone || (previousHasNone && !previousHasRowSpan && previousHasColSpan));
    const rowCanMoveDown = (!hasNone || (hasNone && !hasRowSpan && hasColSpan)) &&
        (!nextHasNone || (nextHasNone && !nextHasRowSpan && nextHasColSpan));
    const other2Menus: IMenu[] = [];
    if (rowCanMoveUp || rowCanMoveDown || (columnIsPure && previousColumnIsPure) || (columnIsPure && nextColumnIsPure)) {
        other2Menus.push({id: "separator_2", type: "separator"});
    }
    if (rowCanMoveUp) {
        other2Menus.push({
            id: "moveToUp", icon: "iconUp", label: labels.text("moveToUp"), accelerator: hotkeys.table.moveToUp,
            click: () => moveRowToUp(protyle, range, cellElement, nodeElement),
        });
    }
    if (rowCanMoveDown) {
        other2Menus.push({
            id: "moveToDown", icon: "iconDown", label: labels.text("moveToDown"), accelerator: hotkeys.table.moveToDown,
            click: () => moveRowToDown(protyle, range, cellElement, nodeElement),
        });
    }
    if (columnIsPure && previousColumnIsPure) {
        other2Menus.push({
            id: "moveToLeft", icon: "iconLeft", label: labels.text("moveToLeft"), accelerator: hotkeys.table.moveToLeft,
            click: () => moveColumnToLeft(protyle, range, cellElement, nodeElement),
        });
    }
    if (columnIsPure && nextColumnIsPure) {
        other2Menus.push({
            id: "moveToRight", icon: "iconRight", label: labels.text("moveToRight"), accelerator: hotkeys.table.moveToRight,
            click: () => moveColumnToRight(protyle, range, cellElement, nodeElement),
        });
    }
    menus.push(...other2Menus);

    const rowCanRemove = cellElement.parentElement!.parentElement!.tagName !== "THEAD" &&
        ((!hasNone && !hasRowSpan) || (hasNone && !hasRowSpan && hasColSpan));
    if (rowCanRemove || columnIsPure) {
        menus.push({type: "separator"});
    }
    const removeMenus: IMenu[] = [];
    if (rowCanRemove) {
        removeMenus.push({
            id: "deleteRow", icon: "iconDeleteRow", label: labels.text("delete-row"), accelerator: hotkeys.table["delete-row"],
            click: () => deleteRow(protyle, range, cellElement, nodeElement),
        });
    }
    if (columnIsPure) {
        removeMenus.push({
            id: "deleteColumn", icon: "iconDeleteColumn", label: labels.text("delete-column"), accelerator: hotkeys.table["delete-column"],
            click: () => deleteColumn(protyle, range, nodeElement, cellElement),
        });
    }
    menus.push(...removeMenus);
    return {menus, removeMenus, insertMenus, otherMenus, other2Menus};
};
