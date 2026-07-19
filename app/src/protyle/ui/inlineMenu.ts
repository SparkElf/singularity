import type {ProtyleContentIdentity} from "../../../../enterprise/packages/protyle-browser/src/contracts";
import * as dayjs from "dayjs";
import {Constants} from "../../constants";
import {escapeHtml} from "../../util/escape";
import {blockRender} from "../render/blockRender";
import {combineAbortSignals} from "../util/abortSignal";
import {buildSiYuanBlockUri, parseSiYuanBlockUri} from "../util/blockUri";
import {requestBlockFold} from "../util/blockFoldRequest";
import {getBlockRefContentTarget} from "../util/blockRefIdentity";
import {writeText} from "../util/clipboard";
import {protyleContentIdentity} from "../util/contentLoad";
import {hasClosestBlock, hasClosestByClassName, hasTopClosestByClassName} from "../util/hasClosest";
import {removeInlineType} from "../util/inlineType";
import {emitProtylePluginMenu} from "../util/plugin";
import {focusByRange, focusByWbr} from "../util/selection";
import {upDownHint} from "../util/upDownHint";
import {updateTransaction} from "../wysiwyg/transaction";
import {downloadExportFile} from "../util/download";
import {hideElements} from "./hideElements";
import {hideTooltip} from "./tooltip";

type InlineMenuHandle = ReturnType<TProtyleRuntime["menu"]["open"]>;
type InlineMenuSurface = InlineMenuHandle["menu"];

interface ActiveInlineMenu {
    readonly handle: InlineMenuHandle;
    onClose?: () => void;
}

interface OwnedInlineMenu {
    readonly menu: InlineMenuSurface;
    readonly signal: AbortSignal;
    close: () => void;
    isCurrent: () => boolean;
    setOnClose: (callback: (() => void) | undefined) => void;
}

interface KernelDataResponse<T> {
    readonly data: T;
}

interface TagSearchData {
    readonly k: string;
    readonly tags: readonly string[];
}

const activeInlineMenus = new WeakMap<IProtyle, ActiveInlineMenu>();
const inlineInputWidth = "min(360px, calc(100vw - 32px))";

const openInlineMenu = (protyle: IProtyle, name: string): OwnedInlineMenu => {
    activeInlineMenus.get(protyle)?.handle.close();

    const handle = protyle.session!.runtime.menu.open();
    const controller = new AbortController();
    const signal = combineAbortSignals([protyle.requestSignal, controller.signal]);
    const state: ActiveInlineMenu = {handle};
    const closeOnOwnerAbort = () => handle.close();
    activeInlineMenus.set(protyle, state);
    protyle.requestSignal.addEventListener("abort", closeOnOwnerAbort, {once: true});
    handle.menu.element.setAttribute("data-name", name);
    handle.menu.removeCB = () => {
        protyle.requestSignal.removeEventListener("abort", closeOnOwnerAbort);
        controller.abort();
        if (activeInlineMenus.get(protyle) === state) {
            activeInlineMenus.delete(protyle);
        }
        state.onClose?.();
    };
    return {
        menu: handle.menu,
        signal,
        close: () => handle.close(),
        isCurrent: () => activeInlineMenus.get(protyle) === state && !signal.aborted,
        setOnClose: (callback) => {
            state.onClose = callback;
        },
    };
};

const setMenuSource = (protyle: IProtyle, menu: InlineMenuSurface) => {
    const popoverElement = hasTopClosestByClassName(protyle.element, "block__popover", true);
    menu.element.setAttribute("data-from", popoverElement ? `${popoverElement.dataset.level}popover` : "app");
};

const popupInlineMenu = (protyle: IProtyle, menu: InlineMenuSurface, target: Element) => {
    const rect = target.getBoundingClientRect();
    menu.popup({x: rect.left, y: rect.top + 26, h: 26});
    setMenuSource(protyle, menu);
};

const requestKernel = <T>(
    protyle: IProtyle,
    signal: AbortSignal,
    path: string,
    body: unknown,
    intent: "read" | "write",
    identity: ProtyleContentIdentity = protyleContentIdentity(protyle),
) => protyle.session!.runtime.transport.request<KernelDataResponse<T>>(path, body, {
    identity,
    intent,
    signal,
});

const positionTagList = (listElement: HTMLElement, inputElement: HTMLInputElement) => {
    const inputRect = inputElement.getBoundingClientRect();
    const listRect = listElement.getBoundingClientRect();
    const preferredLeft = inputRect.right + 8;
    const left = preferredLeft + listRect.width <= document.documentElement.clientWidth
        ? preferredLeft
        : Math.max(0, inputRect.left - listRect.width - 8);
    const top = Math.max(0, Math.min(inputRect.top, document.documentElement.clientHeight - listRect.height));
    listElement.style.left = `${left}px`;
    listElement.style.top = `${top}px`;
};

const createTagSuggestions = (
    protyle: IProtyle,
    owner: OwnedInlineMenu,
    inputElement: HTMLInputElement,
    listElement: HTMLElement,
) => {
    let generation = 0;
    const hide = () => listElement.classList.add("fn__none");
    const isOpen = () => !listElement.classList.contains("fn__none");
    const selectCurrent = () => {
        const currentElement = listElement.querySelector<HTMLElement>(".b3-list-item--focus")!;
        inputElement.value = currentElement.dataset.type === "new"
            ? currentElement.querySelector("mark")!.textContent!.trim()
            : currentElement.textContent!.trim();
        hide();
    };
    const search = (keyword: string) => {
        const requestGeneration = ++generation;
        listElement.classList.remove("fn__none");
        positionTagList(listElement, inputElement);
        void requestKernel<TagSearchData>(
            protyle,
            owner.signal,
            "/api/search/searchTag",
            {k: keyword},
            "read",
        ).then((response) => {
            if (!owner.isCurrent() || requestGeneration !== generation) {
                return;
            }
            let searchHTML = "";
            let hasKey = false;
            response.data.tags.forEach((item, index) => {
                const value = item.replace(/<mark>/g, "").replace(/<\/mark>/g, "");
                searchHTML += `<div class="b3-list-item${index === 0 ? " b3-list-item--focus" : ""}">
    <div class="fn__flex-1">${item}</div>
</div>`;
                if (Lute.UnEscapeHTMLStr(value) === response.data.k) {
                    hasKey = true;
                }
            });
            if (!hasKey && response.data.k) {
                searchHTML = `<div data-type="new" class="b3-list-item${searchHTML ? "" : " b3-list-item--focus"}"><div class="fn__flex-1">${protyle.localization.text("new")} <mark>${escapeHtml(response.data.k)}</mark></div></div>${searchHTML}`;
            }
            listElement.innerHTML = searchHTML;
            positionTagList(listElement, inputElement);
        }).catch((error) => {
            if (!owner.isCurrent() || requestGeneration !== generation) {
                return;
            }
            const message = document.createElement("div");
            message.className = "b3-list--empty";
            message.textContent = protyle.localization.kernelText(258);
            listElement.replaceChildren(message);
            positionTagList(listElement, inputElement);
            console.error("[protyle.inline-menu] tag search failed", error);
        });
    };
    listElement.addEventListener("click", (event) => {
        const listItemElement = hasClosestByClassName(event.target as HTMLElement, "b3-list-item");
        if (!listItemElement) {
            return;
        }
        inputElement.value = listItemElement.dataset.type === "new"
            ? listItemElement.querySelector("mark")!.textContent!.trim()
            : listItemElement.textContent!.trim();
        hide();
    }, {signal: owner.signal});
    return {hide, isOpen, search, selectCurrent};
};

const openTagRenameMenu = (protyle: IProtyle, oldLabel: string, targetRect: DOMRect) => {
    const owner = openInlineMenu(protyle, Constants.MENU_INLINE_TAG);
    const {menu} = owner;
    let inputElement!: HTMLInputElement;
    let suggestions!: ReturnType<typeof createTagSuggestions>;
    menu.addItem({
        id: "renameTag",
        iconHTML: "",
        type: "empty",
        label: `<div class="fn__flex-column" style="width: ${inlineInputWidth}">
    <input class="b3-text-field fn__block" style="margin: 4px 0" placeholder="${protyle.localization.text("tag")}">
    <div class="fn__none b3-list fn__flex-1 b3-list--background protyle-hint" style="position: fixed"></div>
    <div class="fn__hr"></div>
    <div class="fn__flex" style="justify-content:flex-end">
        <button data-action="cancel" class="b3-button b3-button--cancel">${protyle.localization.text("cancel")}</button>
        <span class="fn__space"></span>
        <button data-action="confirm" class="b3-button b3-button--text">${protyle.localization.text("confirm")}</button>
    </div>
</div>`,
        bind(element) {
            element.style.maxWidth = "none";
            inputElement = element.querySelector("input")!;
            inputElement.value = oldLabel;
            const listElement = element.querySelector<HTMLElement>(".b3-list")!;
            suggestions = createTagSuggestions(protyle, owner, inputElement, listElement);
            const confirm = () => {
                void requestKernel<void>(protyle, owner.signal, "/api/tag/renameTag", {
                    oldLabel,
                    newLabel: inputElement.value,
                }, "write").then(() => owner.close()).catch((error) => {
                    if (owner.isCurrent()) {
                        console.error("[protyle.inline-menu] tag rename failed", error);
                    }
                });
            };
            inputElement.addEventListener("compositionend", () => {
                suggestions.search(inputElement.value.trim());
            }, {signal: owner.signal});
            inputElement.addEventListener("input", (event: InputEvent) => {
                if (!event.isComposing) {
                    suggestions.search(inputElement.value.trim());
                }
            }, {signal: owner.signal});
            inputElement.addEventListener("keydown", (event) => {
                event.stopPropagation();
                if (event.isComposing) {
                    return;
                }
                if (event.key === "Enter") {
                    if (suggestions.isOpen()) {
                        suggestions.selectCurrent();
                    } else {
                        confirm();
                    }
                    event.preventDefault();
                } else {
                    upDownHint(listElement, event);
                }
            }, {signal: owner.signal});
            element.addEventListener("click", (event) => {
                const action = (event.target as Element).closest<HTMLElement>("[data-action]")?.dataset.action;
                if (action === "cancel") {
                    owner.close();
                } else if (action === "confirm") {
                    confirm();
                }
            }, {signal: owner.signal});
            window.addEventListener("keydown", (event) => {
                if (event.target !== inputElement || event.key !== "Escape") {
                    return;
                }
                if (suggestions.isOpen()) {
                    suggestions.hide();
                    event.preventDefault();
                    event.stopImmediatePropagation();
                }
            }, {capture: true, signal: owner.signal});
        },
    });
    menu.popup({x: targetRect.left, y: targetRect.top + 26, h: 26});
    setMenuSource(protyle, menu);
    inputElement.select();
};

export const fileAnnotationRefMenu = (protyle: IProtyle, refElement: HTMLElement) => {
    const nodeElement = hasClosestBlock(refElement);
    if (!nodeElement) {
        return;
    }
    hideElements(["util", "toolbar", "hint"], protyle);
    let oldHTML = nodeElement.outerHTML;
    const owner = openInlineMenu(protyle, Constants.MENU_INLINE_FILE_ANNOTATION_REF);
    const {menu} = owner;
    let anchorElement!: HTMLTextAreaElement;
    menu.addItem({
        id: "idAndAnchor",
        iconHTML: "",
        type: "readonly",
        label: `<div>ID</div><textarea spellcheck="false" rows="1" style="margin:4px 0;width:${inlineInputWidth}" class="b3-text-field" readonly>${refElement.getAttribute("data-id") || ""}</textarea><div class="fn__hr"></div><div>${protyle.localization.text("anchor")}</div><textarea rows="1" style="margin:4px 0;width:${inlineInputWidth}" class="b3-text-field"></textarea>`,
        bind(menuItemElement) {
            menuItemElement.style.maxWidth = "none";
            anchorElement = menuItemElement.querySelectorAll<HTMLTextAreaElement>(".b3-text-field")[1];
            anchorElement.value = refElement.textContent || "";
            const updateAnchor = () => {
                refElement.innerHTML = anchorElement.value ? Lute.EscapeHTMLStr(anchorElement.value) : "*";
            };
            anchorElement.addEventListener("input", (event: InputEvent) => {
                if (!event.isComposing) {
                    updateAnchor();
                }
                event.stopPropagation();
            }, {signal: owner.signal});
            anchorElement.addEventListener("compositionend", (event) => {
                updateAnchor();
                event.stopPropagation();
            }, {signal: owner.signal});
            anchorElement.addEventListener("keydown", (event) => {
                if (event.key === "Enter" && !event.isComposing) {
                    owner.close();
                }
            }, {signal: owner.signal});
        },
    });
    menu.addItem({type: "separator"});
    menu.addItem({
        id: "turnInto",
        label: protyle.localization.text("turnInto"),
        icon: "iconTurnInto",
        submenu: [{
            id: "text",
            iconHTML: "",
            label: protyle.localization.text("text"),
            click() {
                nodeElement.setAttribute("updated", dayjs().format("YYYYMMDDHHmmss"));
                removeInlineType(refElement, "file-annotation-ref", protyle.toolbar.range);
                updateTransaction(protyle, nodeElement, oldHTML);
                oldHTML = nodeElement.outerHTML;
            },
        }, {
            id: "text*",
            iconHTML: "",
            label: `${protyle.localization.text("text")} *`,
            click() {
                refElement.insertAdjacentHTML("beforebegin", `${refElement.innerHTML} `);
                refElement.textContent = "*";
                nodeElement.setAttribute("updated", dayjs().format("YYYYMMDDHHmmss"));
                updateTransaction(protyle, nodeElement, oldHTML);
                oldHTML = nodeElement.outerHTML;
            },
        }],
    });
    menu.addItem({
        id: "remove",
        icon: "iconTrashcan",
        label: protyle.localization.text("remove"),
        click() {
            refElement.insertAdjacentHTML("afterend", "<wbr>");
            refElement.remove();
            nodeElement.setAttribute("updated", dayjs().format("YYYYMMDDHHmmss"));
            updateTransaction(protyle, nodeElement, oldHTML);
            focusByWbr(nodeElement, protyle.toolbar.range);
            oldHTML = nodeElement.outerHTML;
        },
    });
    owner.setOnClose(() => {
        if (nodeElement.outerHTML !== oldHTML) {
            nodeElement.setAttribute("updated", dayjs().format("YYYYMMDDHHmmss"));
            updateTransaction(protyle, nodeElement, oldHTML);
        }
        const selection = getSelection();
        const currentRange = selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : undefined;
        if (currentRange && !protyle.element.contains(currentRange.startContainer)) {
            protyle.toolbar.range.selectNodeContents(refElement);
            protyle.toolbar.range.collapse(false);
            focusByRange(protyle.toolbar.range);
        }
    });
    emitProtylePluginMenu({
        plugins: protyle.plugins,
        type: "open-menu-fileannotationref",
        detail: {protyle, element: refElement},
        separatorPosition: "top",
        localization: protyle.localization,
        menu,
    });
    popupInlineMenu(protyle, menu, refElement);
    anchorElement.select();
};

export const refMenu = (protyle: IProtyle, element: HTMLElement) => {
    let nodeElement = hasClosestBlock(element) as HTMLElement;
    if (!nodeElement) {
        return;
    }
    const target = getBlockRefContentTarget(element);
    if (!target) {
        console.error("[Singularity/ProtyleIdentity] block reference target has no content identity");
        return;
    }
    const {
        blockId: refBlockId,
        documentId: targetDocumentId,
        notebookId: targetNotebookId,
    } = target;
    const targetIdentity: ProtyleContentIdentity = {
        notebookId: targetNotebookId,
        documentId: targetDocumentId,
    };
    hideElements(["util", "toolbar", "hint"], protyle);
    const id = nodeElement.getAttribute("data-node-id")!;
    let oldHTML = nodeElement.outerHTML;
    const owner = openInlineMenu(protyle, Constants.MENU_INLINE_REF);
    const {menu} = owner;
    let refTextGeneration = 0;
    if (!protyle.disabled) {
        menu.addItem({
            id: "anchor",
            iconHTML: "",
            type: "readonly",
            label: `<input style="margin:4px 0;width:${inlineInputWidth}" class="b3-text-field fn__block" placeholder="${protyle.localization.text("anchor")}">`,
            bind(menuItemElement) {
                const inputElement = menuItemElement.querySelector<HTMLInputElement>("input")!;
                inputElement.value = element.getAttribute("data-subtype") === "d" ? "" : element.textContent || "";
                inputElement.addEventListener("input", () => {
                    const generation = ++refTextGeneration;
                    if (inputElement.value) {
                        element.innerHTML = Lute.EscapeHTMLStr(inputElement.value).trim() || refBlockId;
                    } else {
                        void requestKernel<string>(protyle, owner.signal, "/api/block/getRefText", {
                            id: refBlockId,
                            notebook: targetNotebookId,
                        }, "read", targetIdentity).then((response) => {
                            if (owner.isCurrent() && generation === refTextGeneration) {
                                element.innerHTML = response.data;
                            }
                        }).catch((error) => {
                            if (owner.isCurrent() && generation === refTextGeneration) {
                                console.error("[protyle.inline-menu] reference text request failed", error);
                            }
                        });
                    }
                    element.setAttribute("data-subtype", inputElement.value ? "s" : "d");
                }, {signal: owner.signal});
                inputElement.addEventListener("keydown", (event) => {
                    if (event.key === "Enter" && !event.isComposing) {
                        owner.close();
                    }
                }, {signal: owner.signal});
            },
        });
        menu.addItem({id: "separator_1", type: "separator"});
    }

    const openReference = async (
        disposition: "current" | "background-tab" | "split-right" | "split-bottom",
        rootAttention: "focus" | "highlight",
    ) => {
        const {isRoot, zoomIn} = await requestBlockFold(protyle, {
            ...targetIdentity,
            blockId: refBlockId,
        });
        protyle.host.dispatch({
            type: "open-document",
            notebookId: targetNotebookId,
            documentId: targetDocumentId,
            blockId: refBlockId,
            disposition,
            scope: zoomIn ? "subtree" : "context",
            attention: rootAttention === "highlight" ? "highlight" : isRoot ? "focus" : "focus-and-highlight",
            scroll: "start",
            restoreScroll: zoomIn ? "never" : "if-document",
            zoom: zoomIn,
        });
    };
    const hotkeys = protyle.settings.hotkeys.editor.general;
    const clickLabel = protyle.localization.text("click");
    menu.addItem({
        id: "openBy",
        label: protyle.localization.text("openBy"),
        icon: "iconOpen",
        accelerator: `${hotkeys.openBy}/${clickLabel}`,
        click: () => openReference("current", "focus"),
    });
    menu.addItem({
        id: "refTab",
        label: protyle.localization.text("refTab"),
        icon: "iconEyeoff",
        accelerator: `${hotkeys.refTab}/⌘${clickLabel}`,
        click: () => openReference("background-tab", "highlight"),
    });
    menu.addItem({
        id: "insertRight",
        label: protyle.localization.text("insertRight"),
        icon: "iconLayoutRight",
        accelerator: `${hotkeys.insertRight}/⌥${clickLabel}`,
        click: () => openReference("split-right", "focus"),
    });
    menu.addItem({
        id: "insertBottom",
        label: protyle.localization.text("insertBottom"),
        icon: "iconLayoutBottom",
        accelerator: `${hotkeys.insertBottom}${hotkeys.insertBottom ? "/" : ""}⇧${clickLabel}`,
        click: () => openReference("split-bottom", "focus"),
    });
    menu.addItem({id: "separator_2", type: "separator"});
    menu.addItem({
        id: "backlinks",
        icon: "iconLink",
        label: protyle.localization.text("backlinks"),
        accelerator: hotkeys.backlinks,
        click: () => protyle.host.dispatch({
            type: "open-backlinks",
            notebookId: targetNotebookId,
            documentId: targetDocumentId,
        }),
    });
    menu.addItem({
        id: "graphView",
        icon: "iconGraph",
        label: protyle.localization.text("graphView"),
        accelerator: hotkeys.graphView,
        click: () => protyle.host.dispatch({
            type: "open-graph",
            scope: "document",
            notebookId: targetNotebookId,
            documentId: targetDocumentId,
        }),
    });
    menu.addItem({id: "separator_3", type: "separator"});
    if (!protyle.disabled) {
        let submenu: IMenu[] = [];
        if (element.getAttribute("data-subtype") === "s") {
            submenu.push({
                id: "turnToDynamic",
                iconHTML: "",
                label: protyle.localization.text("turnToDynamic"),
                click() {
                    element.setAttribute("data-subtype", "d");
                    const request = requestKernel<string>(protyle, owner.signal, "/api/block/getRefText", {
                        id: refBlockId,
                        notebook: targetNotebookId,
                    }, "read", targetIdentity).then((response) => {
                        element.innerHTML = response.data;
                        nodeElement.setAttribute("updated", dayjs().format("YYYYMMDDHHmmss"));
                        updateTransaction(protyle, nodeElement, oldHTML);
                        oldHTML = nodeElement.outerHTML;
                    });
                    focusByRange(protyle.toolbar.range);
                    return request;
                },
            });
        } else {
            submenu.push({
                id: "turnToStatic",
                iconHTML: "",
                label: protyle.localization.text("turnToStatic"),
                click() {
                    element.setAttribute("data-subtype", "s");
                    nodeElement.setAttribute("updated", dayjs().format("YYYYMMDDHHmmss"));
                    updateTransaction(protyle, nodeElement, oldHTML);
                    focusByRange(protyle.toolbar.range);
                    oldHTML = nodeElement.outerHTML;
                },
            });
        }
        submenu = submenu.concat([{
            id: "text",
            iconHTML: "",
            label: protyle.localization.text("text"),
            click() {
                nodeElement.setAttribute("updated", dayjs().format("YYYYMMDDHHmmss"));
                removeInlineType(element, "block-ref", protyle.toolbar.range);
                updateTransaction(protyle, nodeElement, oldHTML);
                oldHTML = nodeElement.outerHTML;
            },
        }, {
            id: "*",
            iconHTML: "",
            label: "*",
            click() {
                element.setAttribute("data-subtype", "s");
                element.textContent = "*";
                nodeElement.setAttribute("updated", dayjs().format("YYYYMMDDHHmmss"));
                updateTransaction(protyle, nodeElement, oldHTML);
                focusByRange(protyle.toolbar.range);
                oldHTML = nodeElement.outerHTML;
            },
        }, {
            id: "text*",
            iconHTML: "",
            label: `${protyle.localization.text("text")} *`,
            click() {
                element.insertAdjacentHTML("beforebegin", `${element.innerHTML} `);
                element.setAttribute("data-subtype", "s");
                element.textContent = "*";
                nodeElement.setAttribute("updated", dayjs().format("YYYYMMDDHHmmss"));
                updateTransaction(protyle, nodeElement, oldHTML);
                focusByRange(protyle.toolbar.range);
                oldHTML = nodeElement.outerHTML;
            },
        }, {
            id: "link",
            label: protyle.localization.text("hyperlink"),
            iconHTML: "",
            click() {
                element.outerHTML = `<span data-type="a" data-href="${buildSiYuanBlockUri(refBlockId, targetNotebookId, targetDocumentId)}">${element.innerHTML}</span><wbr>`;
                nodeElement.setAttribute("updated", dayjs().format("YYYYMMDDHHmmss"));
                updateTransaction(protyle, nodeElement, oldHTML);
                focusByWbr(nodeElement, protyle.toolbar.range);
                oldHTML = nodeElement.outerHTML;
            },
        }]);
        if (targetNotebookId === protyle.notebookId &&
            element.parentElement!.textContent!.trim() === element.textContent!.trim() &&
            element.parentElement!.tagName === "DIV") {
            submenu.push({
                id: "blockEmbed",
                iconHTML: "",
                label: protyle.localization.text("blockEmbed"),
                click() {
                    nodeElement.insertAdjacentHTML("afterend", `<div data-content="select * from blocks where id='${refBlockId}'" data-node-id="${id}" data-type="NodeBlockQueryEmbed" class="render-node" updated="${dayjs().format("YYYYMMDDHHmmss")}">${nodeElement.querySelector(".protyle-attr")!.outerHTML}</div>`);
                    nodeElement = nodeElement.nextElementSibling as HTMLElement;
                    nodeElement.previousElementSibling!.remove();
                    updateTransaction(protyle, nodeElement, oldHTML);
                    blockRender(protyle, protyle.wysiwyg.element);
                    oldHTML = nodeElement.outerHTML;
                },
            });
        }
        if (targetNotebookId === protyle.notebookId) {
            submenu.push({
                id: "defBlock",
                iconHTML: "",
                label: protyle.localization.text("defBlock"),
                click: async () => {
                    await requestKernel<void>(protyle, owner.signal, "/api/block/swapBlockRef", {
                        refID: id,
                        defID: refBlockId,
                        includeChildren: false,
                        notebook: protyle.notebookId,
                    }, "write");
                },
            }, {
                id: "defBlockChildren",
                iconHTML: "",
                label: protyle.localization.text("defBlockChildren"),
                click: async () => {
                    await requestKernel<void>(protyle, owner.signal, "/api/block/swapBlockRef", {
                        refID: id,
                        defID: refBlockId,
                        includeChildren: true,
                        notebook: protyle.notebookId,
                    }, "write");
                },
            });
        }
        menu.addItem({
            id: "turnInto",
            label: protyle.localization.text("turnInto"),
            icon: "iconTurnInto",
            submenu,
        });
    }
    menu.addItem({
        id: "copy",
        label: protyle.localization.text("copy"),
        icon: "iconCopy",
        click: () => writeText(protyle.lute.BlockDOM2StdMd(element.outerHTML).trim()),
    });
    if (!protyle.disabled) {
        menu.addItem({
            id: "cut",
            label: protyle.localization.text("cut"),
            icon: "iconCut",
            click() {
                void writeText(protyle.lute.BlockDOM2StdMd(element.outerHTML));
                element.insertAdjacentHTML("afterend", "<wbr>");
                element.remove();
                nodeElement.setAttribute("updated", dayjs().format("YYYYMMDDHHmmss"));
                updateTransaction(protyle, nodeElement, oldHTML);
                focusByWbr(nodeElement, protyle.toolbar.range);
                oldHTML = nodeElement.outerHTML;
            },
        });
        menu.addItem({
            id: "remove",
            label: protyle.localization.text("remove"),
            icon: "iconTrashcan",
            click() {
                element.insertAdjacentHTML("afterend", "<wbr>");
                element.remove();
                nodeElement.setAttribute("updated", dayjs().format("YYYYMMDDHHmmss"));
                updateTransaction(protyle, nodeElement, oldHTML);
                focusByWbr(nodeElement, protyle.toolbar.range);
                oldHTML = nodeElement.outerHTML;
            },
        });
    }
    owner.setOnClose(protyle.disabled ? undefined : () => {
        if (nodeElement.outerHTML !== oldHTML) {
            nodeElement.setAttribute("updated", dayjs().format("YYYYMMDDHHmmss"));
            updateTransaction(protyle, nodeElement, oldHTML);
        }
        const selection = getSelection();
        const currentRange = selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : undefined;
        if (currentRange && !protyle.element.contains(currentRange.startContainer)) {
            protyle.toolbar.range.selectNodeContents(element);
            protyle.toolbar.range.collapse(false);
            focusByRange(protyle.toolbar.range);
        }
    });
    emitProtylePluginMenu({
        plugins: protyle.plugins,
        type: "open-menu-blockref",
        detail: {protyle, element},
        separatorPosition: "top",
        localization: protyle.localization,
        menu,
    });
    menu.data = element;
    popupInlineMenu(protyle, menu, element);
    if (!protyle.disabled) {
        menu.element.querySelector<HTMLInputElement>("input")!.select();
    }
};

export const linkMenu = (protyle: IProtyle, linkElement: HTMLElement, focusText = false) => {
    const nodeElement = hasClosestBlock(linkElement);
    if (!nodeElement) {
        return;
    }
    hideTooltip(protyle);
    hideElements(["util", "toolbar", "hint"], protyle);
    let html = nodeElement.outerHTML;
    const linkAddress = linkElement.getAttribute("data-href");
    const owner = openInlineMenu(protyle, Constants.MENU_INLINE_A);
    const {menu} = owner;
    let inputElements!: NodeListOf<HTMLTextAreaElement>;
    if (!protyle.disabled) {
        menu.addItem({
            id: "linkAndAnchorAndTitle",
            iconHTML: "",
            type: "readonly",
            label: `<div class="fn__flex">
    <span class="fn__flex-center">${protyle.localization.text("link")}</span>
    <span class="fn__space"></span>
    <span data-action="copy" class="block__icon block__icon--show b3-tooltips b3-tooltips__e fn__flex-center" aria-label="${protyle.localization.text("copy")}">
        <svg><use xlink:href="#iconCopy"></use></svg>
    </span>
</div><textarea spellcheck="false" rows="1" style="margin:4px 0;width:${inlineInputWidth}" class="b3-text-field"></textarea><div class="fn__hr"></div><div class="fn__flex">
    <span class="fn__flex-center">${protyle.localization.text("anchor")}</span>
    <span class="fn__space"></span>
    <span data-action="copy" class="block__icon block__icon--show b3-tooltips b3-tooltips__e fn__flex-center" aria-label="${protyle.localization.text("copy")}">
        <svg><use xlink:href="#iconCopy"></use></svg>
    </span>
</div><textarea rows="1" style="margin:4px 0;width:${inlineInputWidth}" class="b3-text-field"></textarea><div class="fn__hr"></div><div class="fn__flex">
    <span class="fn__flex-center">${protyle.localization.text("title")}</span>
    <span class="fn__space"></span>
    <span data-action="copy" class="block__icon block__icon--show b3-tooltips b3-tooltips__e fn__flex-center" aria-label="${protyle.localization.text("copy")}">
        <svg><use xlink:href="#iconCopy"></use></svg>
    </span>
</div><textarea rows="1" style="margin:4px 0;width:${inlineInputWidth}" class="b3-text-field"></textarea>`,
            bind(element) {
                element.style.maxWidth = "none";
                inputElements = element.querySelectorAll("textarea");
                inputElements[0].value = Lute.UnEscapeHTMLStr(linkAddress || "");
                inputElements[0].addEventListener("keydown", (event) => {
                    if ((event.key === "Enter" || event.key === "Escape") && !event.isComposing) {
                        event.preventDefault();
                        event.stopPropagation();
                        owner.close();
                    } else if (event.key === "Tab" && !event.isComposing) {
                        event.preventDefault();
                        event.stopPropagation();
                        inputElements[1].focus();
                    }
                }, {signal: owner.signal});
                let anchor = linkElement.textContent!.replace(Constants.ZWSP, "");
                if (!anchor && linkAddress) {
                    anchor = decodeURIComponent(linkAddress.replace("https://", "").replace("http://", ""));
                    if (anchor.length > Constants.SIZE_LINK_TEXT_MAX) {
                        anchor = `${anchor.substring(0, Constants.SIZE_LINK_TEXT_MAX)}...`;
                    }
                    linkElement.innerHTML = Lute.EscapeHTMLStr(anchor);
                }
                inputElements[1].value = anchor;
                inputElements[1].addEventListener("compositionend", () => {
                    linkElement.innerHTML = Lute.EscapeHTMLStr(inputElements[1].value.replace(/\n|\r\n|\r|\u2028|\u2029/g, "").trim() || "*");
                }, {signal: owner.signal});
                inputElements[1].addEventListener("input", (event: InputEvent) => {
                    if (!event.isComposing) {
                        linkElement.innerHTML = Lute.EscapeHTMLStr(inputElements[1].value.replace(/\n|\r\n|\r|\u2028|\u2029/g, "").trim()) || "*";
                    }
                }, {signal: owner.signal});
                inputElements[1].addEventListener("keydown", (event) => {
                    if ((event.key === "Enter" || event.key === "Escape") && !event.isComposing) {
                        event.preventDefault();
                        event.stopPropagation();
                        owner.close();
                    } else if (event.key === "Tab" && !event.isComposing) {
                        event.preventDefault();
                        event.stopPropagation();
                        if (event.shiftKey) {
                            inputElements[0].focus();
                        } else {
                            inputElements[2].focus();
                        }
                    }
                }, {signal: owner.signal});
                inputElements[2].value = Lute.UnEscapeHTMLStr(linkElement.getAttribute("data-title") || "");
                inputElements[2].addEventListener("keydown", (event) => {
                    if ((event.key === "Enter" || event.key === "Escape") && !event.isComposing) {
                        event.preventDefault();
                        event.stopPropagation();
                        owner.close();
                    } else if (event.key === "Tab" && event.shiftKey && !event.isComposing) {
                        event.preventDefault();
                        event.stopPropagation();
                        inputElements[1].focus();
                    }
                }, {signal: owner.signal});
                element.addEventListener("click", (event) => {
                    const target = (event.target as Element).closest<HTMLElement>('[data-action="copy"]');
                    if (!target || !element.contains(target)) {
                        return;
                    }
                    const value = (target.parentElement!.nextElementSibling as HTMLTextAreaElement).value;
                    void writeText(value).then(() => protyle.host.dispatch({
                        type: "notify",
                        level: "success",
                        message: protyle.localization.text("copied"),
                    })).catch((error) => console.error("[protyle.inline-menu] copy link field failed", error));
                }, {signal: owner.signal});
            },
        });
        menu.addItem({id: "separator_1", type: "separator"});
    }
    menu.addItem({
        id: "copy",
        label: protyle.localization.text("copy"),
        icon: "iconCopy",
        click() {
            const range = document.createRange();
            range.selectNode(linkElement);
            focusByRange(range);
            document.execCommand("copy");
        },
    });
    if (protyle.disabled) {
        menu.addItem({
            id: "copyAHref",
            label: protyle.localization.text("copyAHref"),
            icon: "iconLink",
            click: () => writeText(linkAddress || ""),
        });
    } else {
        menu.addItem({
            id: "cut",
            icon: "iconCut",
            label: protyle.localization.text("cut"),
            click() {
                const range = document.createRange();
                range.selectNode(linkElement);
                focusByRange(range);
                document.execCommand("cut");
            },
        });
        menu.addItem({
            id: "remove",
            icon: "iconTrashcan",
            label: protyle.localization.text("remove"),
            click() {
                linkElement.insertAdjacentHTML("afterend", "<wbr>");
                linkElement.remove();
                nodeElement.setAttribute("updated", dayjs().format("YYYYMMDDHHmmss"));
                updateTransaction(protyle, nodeElement, html);
                focusByWbr(nodeElement, protyle.toolbar.range);
                html = nodeElement.outerHTML;
            },
        });
        if (protyle.settings.features.assetRename && linkAddress?.startsWith("assets/")) {
            menu.addItem({
                id: "rename",
                label: protyle.localization.text("rename"),
                icon: "iconEdit",
                click() {
                    const identity = protyleContentIdentity(protyle);
                    protyle.host.dispatch({
                        type: "rename-asset",
                        notebookId: identity.notebookId,
                        documentId: identity.documentId,
                        blockId: nodeElement.getAttribute("data-node-id")!,
                        assetPath: linkAddress,
                    });
                },
            });
        }
        if (linkAddress?.startsWith("siyuan://blocks/")) {
            menu.addItem({
                id: "turnIntoRef",
                label: `${protyle.localization.text("turnInto")} <b>${protyle.localization.text("ref")}</b>`,
                icon: "iconTurnInto",
                click() {
                    const blockLink = parseSiYuanBlockUri(inputElements[0].value);
                    if (!blockLink) {
                        console.error("[Singularity/ProtyleIdentity] SiYuan URI has no complete content identity");
                        return;
                    }
                    linkElement.setAttribute("data-subtype", "s");
                    const types = linkElement.getAttribute("data-type")!.split(" ");
                    types.push("block-ref");
                    types.splice(types.indexOf("a"), 1);
                    linkElement.setAttribute("data-type", types.join(" "));
                    linkElement.setAttribute("data-id", blockLink.blockId);
                    linkElement.setAttribute("data-notebook-id", blockLink.notebookId);
                    linkElement.setAttribute("data-document-id", blockLink.documentId);
                    inputElements[0].value = "";
                    inputElements[2].value = "";
                    linkElement.removeAttribute("data-href");
                    linkElement.removeAttribute("data-title");
                    nodeElement.setAttribute("updated", dayjs().format("YYYYMMDDHHmmss"));
                    updateTransaction(protyle, nodeElement, html);
                    protyle.toolbar.range.selectNode(linkElement);
                    protyle.toolbar.range.collapse(false);
                    focusByRange(protyle.toolbar.range);
                    html = nodeElement.outerHTML;
                },
            });
        }
        menu.addItem({
            id: "turnIntoText",
            label: `${protyle.localization.text("turnInto")} <b>${protyle.localization.text("text")}</b>`,
            icon: "iconTurnInto",
            click() {
                inputElements[0].value = "";
                inputElements[2].value = "";
                nodeElement.setAttribute("updated", dayjs().format("YYYYMMDDHHmmss"));
                removeInlineType(linkElement, "a", protyle.toolbar.range);
                updateTransaction(protyle, nodeElement, html);
                html = nodeElement.outerHTML;
            },
        });
    }

    if (linkAddress) {
        menu.addItem({id: "separator_2", type: "separator"});
        const source = Lute.UnEscapeHTMLStr(linkAddress).trim();
        const submenu: IMenu[] = [];
        if (source.startsWith("assets/")) {
            const identity = protyleContentIdentity(protyle);
            const page = new URLSearchParams(source.split("?", 2)[1] || "").get("page") || undefined;
            submenu.push({
                id: "insertRight",
                icon: "iconLayoutRight",
                label: protyle.localization.text("insertRight"),
                accelerator: protyle.localization.text("click"),
                click: () => protyle.host.dispatch({
                    type: "open-asset",
                    documentId: identity.documentId,
                    notebookId: identity.notebookId,
                    assetPath: source,
                    page,
                    disposition: "split-right",
                }),
            }, {
                id: "openBy",
                icon: "iconOpen",
                label: protyle.localization.text("openBy"),
                accelerator: `⌥${protyle.localization.text("click")}`,
                click: () => protyle.host.dispatch({
                    type: "open-asset",
                    documentId: identity.documentId,
                    notebookId: identity.notebookId,
                    assetPath: source,
                    page,
                    disposition: "current",
                }),
            });
        } else {
            const url = source.includes(":") ? source : `https://${source}`;
            submenu.push({
                id: "useBrowserView",
                label: protyle.localization.text("useBrowserView"),
                accelerator: protyle.localization.text("click"),
                click: () => protyle.host.dispatch({type: "open-external", url}),
            });
        }
        menu.addItem({
            id: "openBy",
            label: protyle.localization.text("openBy"),
            icon: "iconOpen",
            submenu,
        });
        if (source.startsWith("assets/")) {
            const identity = protyleContentIdentity(protyle);
            menu.addItem({
                id: "export",
                label: protyle.localization.text("export"),
                icon: "iconUpload",
                click: () => downloadExportFile(protyle.session!.runtime.resources.resolveAsset(identity, source)),
            });
        }
    }

    owner.setOnClose(protyle.disabled ? undefined : () => {
        if (inputElements[2].value) {
            linkElement.setAttribute("data-title", Lute.EscapeHTMLStr(inputElements[2].value.replace(/\n|\r\n|\r|\u2028|\u2029/g, "")));
        } else {
            linkElement.removeAttribute("data-title");
        }
        if (linkElement.getAttribute("data-type")!.includes("a")) {
            linkElement.setAttribute("data-href", Lute.EscapeHTMLStr(inputElements[0].value.replace(/\n|\r\n|\r|\u2028|\u2029/g, "")));
        } else {
            linkElement.removeAttribute("data-href");
        }
        if (!inputElements[1].value && (inputElements[0].value || inputElements[2].value)) {
            linkElement.textContent = "*";
        }
        const selection = getSelection();
        const currentRange = selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : undefined;
        if (currentRange && !protyle.element.contains(currentRange.startContainer)) {
            protyle.toolbar.range.selectNodeContents(linkElement);
            protyle.toolbar.range.collapse(false);
            focusByRange(protyle.toolbar.range);
        }
        if (!inputElements[1].value && !inputElements[0].value && !inputElements[2].value) {
            linkElement.remove();
        }
        if (html !== nodeElement.outerHTML) {
            nodeElement.setAttribute("updated", dayjs().format("YYYYMMDDHHmmss"));
            updateTransaction(protyle, nodeElement, html);
        }
    });
    if (!protyle.disabled) {
        emitProtylePluginMenu({
            plugins: protyle.plugins,
            type: "open-menu-link",
            detail: {protyle, element: linkElement},
            separatorPosition: "top",
            localization: protyle.localization,
            menu,
        });
    }
    popupInlineMenu(protyle, menu, linkElement);
    if (protyle.disabled) {
        return;
    }
    if (focusText || protyle.lute.GetLinkDest(linkAddress) || linkAddress?.startsWith("assets/")) {
        inputElements[1].select();
    } else {
        inputElements[0].select();
    }
};

export const tagMenu = (protyle: IProtyle, tagElement: HTMLElement) => {
    const nodeElement = hasClosestBlock(tagElement);
    if (!nodeElement) {
        return;
    }
    hideElements(["util", "toolbar", "hint"], protyle);
    const oldHTML = nodeElement.outerHTML;
    const owner = openInlineMenu(protyle, Constants.MENU_INLINE_TAG);
    const {menu} = owner;
    let inputElement!: HTMLInputElement;
    let suggestions!: ReturnType<typeof createTagSuggestions>;
    let commitOnClose = true;
    menu.addItem({
        id: "tag",
        iconHTML: "",
        type: "readonly",
        label: `<input class="b3-text-field fn__block" style="margin:4px 0;width:${inlineInputWidth}" placeholder="${protyle.localization.text("tag")}">
<div class="fn__none b3-list fn__flex-1 b3-list--background protyle-hint" style="position:fixed"></div>`,
        bind(element) {
            const listElement = element.querySelector<HTMLElement>(".b3-list")!;
            inputElement = element.querySelector("input")!;
            inputElement.value = tagElement.textContent!.replace(Constants.ZWSP, "");
            suggestions = createTagSuggestions(protyle, owner, inputElement, listElement);
            inputElement.addEventListener("compositionend", () => {
                suggestions.search(inputElement.value.trim());
            }, {signal: owner.signal});
            inputElement.addEventListener("input", (event: InputEvent) => {
                if (!event.isComposing) {
                    suggestions.search(inputElement.value.trim());
                }
            }, {signal: owner.signal});
            inputElement.addEventListener("keydown", (event) => {
                event.stopPropagation();
                if (event.isComposing) {
                    return;
                }
                if (event.key === "Enter") {
                    if (suggestions.isOpen()) {
                        suggestions.selectCurrent();
                    } else {
                        owner.close();
                    }
                    event.preventDefault();
                } else {
                    upDownHint(listElement, event);
                }
            }, {signal: owner.signal});
            window.addEventListener("keydown", (event) => {
                if (event.target !== inputElement || event.key !== "Escape") {
                    return;
                }
                if (suggestions.isOpen()) {
                    suggestions.hide();
                    event.preventDefault();
                    event.stopImmediatePropagation();
                } else {
                    commitOnClose = false;
                }
            }, {capture: true, signal: owner.signal});
        },
    });
    menu.addItem({id: "separator_1", type: "separator"});
    menu.addItem({
        id: "search",
        label: protyle.localization.text("search"),
        accelerator: protyle.localization.text("click"),
        icon: "iconSearch",
        click: () => protyle.host.dispatch({
            type: "open-search",
            query: `#${tagElement.textContent}#`,
            queryMode: "replace",
            method: "keyword",
        }),
    });
    menu.addItem({
        id: "rename",
        label: protyle.localization.text("rename"),
        icon: "iconEdit",
        click() {
            const label = tagElement.textContent!.replace(Constants.ZWSP, "");
            const targetRect = tagElement.getBoundingClientRect();
            openTagRenameMenu(protyle, label, targetRect);
        },
    });
    menu.addItem({id: "separator_2", type: "separator"});
    menu.addItem({
        id: "turnIntoText",
        label: `${protyle.localization.text("turnInto")} <b>${protyle.localization.text("text")}</b>`,
        icon: "iconTurnInto",
        click() {
            protyle.toolbar.range.setStart(tagElement.firstChild!, 0);
            protyle.toolbar.range.setEnd(tagElement.lastChild!, tagElement.lastChild!.textContent!.length);
            protyle.toolbar.setInlineMark(protyle, "tag", "range");
        },
    });
    menu.addItem({
        id: "copy",
        label: protyle.localization.text("copy"),
        icon: "iconCopy",
        click() {
            const range = document.createRange();
            range.selectNode(tagElement);
            focusByRange(range);
            document.execCommand("copy");
        },
    });
    menu.addItem({
        id: "cut",
        label: protyle.localization.text("cut"),
        icon: "iconCut",
        click() {
            const range = document.createRange();
            range.selectNode(tagElement);
            focusByRange(range);
            document.execCommand("cut");
        },
    });
    menu.addItem({
        id: "remove",
        icon: "iconTrashcan",
        label: protyle.localization.text("remove"),
        click() {
            tagElement.insertAdjacentHTML("afterend", "<wbr>");
            tagElement.remove();
            nodeElement.setAttribute("updated", dayjs().format("YYYYMMDDHHmmss"));
            updateTransaction(protyle, nodeElement, oldHTML);
            focusByWbr(nodeElement, protyle.toolbar.range);
        },
    });
    owner.setOnClose(() => {
        if (!commitOnClose) {
            return;
        }
        tagElement.innerHTML = Constants.ZWSP + Lute.EscapeHTMLStr(inputElement.value || "");
        if (!inputElement.value) {
            tagElement.insertAdjacentHTML("afterend", "<wbr>");
            tagElement.remove();
            focusByWbr(nodeElement, protyle.toolbar.range);
        } else {
            protyle.toolbar.range.selectNodeContents(tagElement);
            protyle.toolbar.range.collapse(false);
            focusByRange(protyle.toolbar.range);
        }
        if (nodeElement.outerHTML !== oldHTML) {
            nodeElement.setAttribute("updated", dayjs().format("YYYYMMDDHHmmss"));
            updateTransaction(protyle, nodeElement, oldHTML);
        }
    });
    emitProtylePluginMenu({
        plugins: protyle.plugins,
        type: "open-menu-tag",
        detail: {protyle, element: tagElement},
        separatorPosition: "top",
        localization: protyle.localization,
        menu,
    });
    popupInlineMenu(protyle, menu, tagElement);
    inputElement.select();
};

export const inlineMathMenu = (protyle: IProtyle, element: Element) => {
    const nodeElement = hasClosestBlock(element);
    if (!nodeElement) {
        return;
    }
    const html = nodeElement.outerHTML;
    const {menu} = openInlineMenu(protyle, Constants.MENU_INLINE_MATH);
    menu.addItem({
        id: "copy",
        label: protyle.localization.text("copy"),
        icon: "iconCopy",
        click() {
            const range = document.createRange();
            range.selectNode(element);
            focusByRange(range);
            document.execCommand("copy");
        },
    });
    if (!protyle.disabled) {
        menu.addItem({
            id: "cut",
            icon: "iconCut",
            label: protyle.localization.text("cut"),
            click() {
                const range = document.createRange();
                range.selectNode(element);
                focusByRange(range);
                document.execCommand("cut");
            },
        });
        menu.addItem({
            id: "remove",
            icon: "iconTrashcan",
            label: protyle.localization.text("remove"),
            click() {
                element.insertAdjacentHTML("afterend", "<wbr>");
                element.remove();
                nodeElement.setAttribute("updated", dayjs().format("YYYYMMDDHHmmss"));
                updateTransaction(protyle, nodeElement, html);
                focusByWbr(nodeElement, protyle.toolbar.range);
            },
        });
    }
    popupInlineMenu(protyle, menu, element);
};
