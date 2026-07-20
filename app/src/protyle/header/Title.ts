import {
    focusBlock,
    focusByOffset,
    focusByRange,
    focusByWbr,
    getEditorRange,
    getSelectionOffset,
} from "../util/selection";
import {Constants} from "../../constants";
import {matchHotKey} from "../util/hotKey";
import {isMac, isNarrowViewport} from "../util/browserPlatform";
import {readText} from "../util/clipboard";
import dayjs from "dayjs";
import {getProtyleDocumentDisplayName} from "../runtime/displayName";
import {getContenteditableElement, getNoContainerElement} from "../wysiwyg/getBlock";
import {commonHotkey} from "../wysiwyg/commonHotkey";
import {nbsp2space} from "../util/normalizeText";
import {transaction} from "../wysiwyg/transaction";
import {hideTooltip, showTooltip} from "../ui/tooltip";
import {openTitleMenu} from "./openTitleMenu";
import {enableLuteMarkdownSyntax, restoreLuteMarkdownSyntax} from "../util/paste";
import {genEmptyElement} from "../wysiwyg/blockElement";
import {hasClosestByClassName} from "../util/hasClosest";
import {isOnlyMeta} from "../util/keyboard";
import {protyleContentIdentity} from "../util/contentLoad";
import type {ProtyleBlockAttributeFocus} from "../../../../enterprise/packages/protyle-browser/src/contracts";
import {
    type FileNameViolation,
    getFileNameViolation,
    normalizeFileName,
    truncateFileName,
} from "../util/fileNameRules";

type TitleMenuHandle = ReturnType<NonNullable<IProtyle["runtime"]>["menu"]["open"]>;

interface RenameDocumentResponse {
    readonly data: {
        readonly empty: boolean;
        readonly title: string;
    };
}

const validateDocumentTitle = (
    protyle: IProtyle,
    name: string,
    target: HTMLElement,
): FileNameViolation | undefined => {
    const violation = getFileNameViolation(name);
    if (violation === "invalid-character") {
        showTooltip(protyle, protyle.localization.text("fileNameRule"), target, "error");
        return violation;
    }
    if (violation === "too-long") {
        showTooltip(protyle, protyle.localization.kernelText(106), target, "error");
        return violation;
    }
};

const normalizeDocumentTitle = (protyle: IProtyle, name: string, target: HTMLElement) => {
    const normalized = normalizeFileName(name);
    if (normalized.replacedPathSeparator) {
        showTooltip(protyle, protyle.localization.text("fileNameRule"), target, "error");
    }
    return normalized.name;
};

const titleSelectionOffset = (element: HTMLElement) => {
    const selection = getSelection();
    if (selection.rangeCount === 0) {
        return undefined;
    }
    const range = selection.getRangeAt(0);
    if (!element.contains(range.startContainer)) {
        return undefined;
    }
    return getSelectionOffset(element, undefined, range);
};

const attributeFocus = (target: HTMLElement): ProtyleBlockAttributeFocus | undefined => {
    if (hasClosestByClassName(target, "protyle-attr--bookmark")) {
        return "bookmark";
    }
    if (hasClosestByClassName(target, "protyle-attr--name")) {
        return "name";
    }
    if (hasClosestByClassName(target, "protyle-attr--alias")) {
        return "alias";
    }
    if (hasClosestByClassName(target, "protyle-attr--memo")) {
        return "memo";
    }
    if (hasClosestByClassName(target, "protyle-attr--av")) {
        return "av";
    }
};

const openDocumentAttributes = (
    protyle: IProtyle,
    focus: ProtyleBlockAttributeFocus,
) => {
    const identity = protyleContentIdentity(protyle);
    protyle.host.dispatch({
        type: "open-block-attributes",
        notebookId: identity.notebookId,
        documentId: identity.documentId,
        blockId: protyle.block.rootID!,
        focus,
    });
};

export class Title {
    public element: HTMLElement;
    public editElement: HTMLElement;
    private timeout: number;
    private menuHandle?: TitleMenuHandle;
    private renameGeneration = 0;

    public focusInput() {
        if (!this.editElement) {
            return;
        }
        focusByOffset(this.editElement, 0, this.editElement.textContent.length);
    }

    public replaceTitle(protyle: IProtyle, title: string) {
        if (!this.editElement) {
            return;
        }
        this.writeTitle(normalizeDocumentTitle(protyle, title, this.editElement));
        this.rename(protyle);
    }

    private closeMenu() {
        const handle = this.menuHandle;
        this.menuHandle = undefined;
        handle?.close();
    }

    private openMenu(protyle: IProtyle) {
        this.closeMenu();
        const handle = protyle.runtime.menu.open();
        this.menuHandle = handle;
        handle.menu.removeCB = () => {
            if (this.menuHandle === handle) {
                this.menuHandle = undefined;
            }
        };
        return handle;
    }

    constructor(protyle: IProtyle) {
        protyle.requestSignal.addEventListener("abort", () => this.closeMenu(), {once: true});
        this.element = document.createElement("div");
        this.element.className = "protyle-title";
        if (protyle.settings.editor.displayBookmarkIcon) {
            this.element.classList.add("protyle-wysiwyg--attr");
        }
        if (protyle.options.render?.titleShowTop) {
            this.element.innerHTML = '<div class="protyle-attr"></div>';
        } else {
            // 标题内需要一个空格，避免首次加载出现`请输入文档名`干扰
            const gutterTip = protyle.localization.text("gutterTip2");
            this.element.innerHTML = `<span aria-label="${isMac() ? gutterTip : gutterTip.replace("⇧", "Shift+")}" data-position="west" class="protyle-title__icon ariaLabel"><svg><use xlink:href="#iconFile"></use></svg></span>
<div contenteditable="true" spellcheck="${protyle.settings.editor.spellcheck}" class="protyle-title__input" data-tip="${protyle.localization.kernelText(16)}"> </div><div class="protyle-attr"></div>`;
            this.editElement = this.element.querySelector(".protyle-title__input");
            this.editElement.addEventListener("paste", (event: ClipboardEvent) => {
                event.stopPropagation();
                event.preventDefault();
                // 不能使用 range.insertNode，否则无法撤销
                let text = event.clipboardData.getData("text/siyuan");
                if (text) {
                    try {
                        JSON.parse(text);
                        text = event.clipboardData.getData("text/plain");
                    } catch (e) {
                        // 不为数据库，保持 text 不变
                    }
                    text = protyle.lute.BlockDOM2Content(text);
                } else {
                    text = event.clipboardData.getData("text/plain");
                }
                // 阻止右键复制菜单报错
                setTimeout(() => {
                    document.execCommand("insertText", false, normalizeDocumentTitle(protyle, text, this.editElement));
                }, 0);
                this.rename(protyle);
            });
            this.editElement.addEventListener("click", () => {
                protyle.toolbar?.element.classList.add("fn__none");
            });
            this.editElement.addEventListener("input", (event: InputEvent) => {
                if (event.isComposing) {
                    return;
                }
                if (this.editElement.textContent === "") {
                    this.editElement.querySelectorAll("br").forEach(item => {
                        item.remove();
                    });
                }
                this.rename(protyle);
            });
            this.editElement.addEventListener("compositionend", () => {
                this.rename(protyle);
            });
            this.editElement.addEventListener("drop", (event: DragEvent) => {
                // https://ld246.com/article/1661911210429
                event.stopPropagation();
                event.preventDefault();
            });
            this.editElement.addEventListener("keydown", async (event: KeyboardEvent) => {
                if (event.isComposing) {
                    return;
                }

                if (commonHotkey(protyle, event)) {
                    return true;
                }
                if (matchHotKey("⇧⌘V", event)) {
                    event.preventDefault();
                    event.stopPropagation();
                    let textPlain = await readText() || "";
                    if (textPlain) {
                        // 对 <<assets/...>> 进行内部转义 https://github.com/siyuan-note/siyuan/issues/11992
                        textPlain = textPlain.replace(/<<assets\//g, "__@lt2assets/@__").replace(/>>/g, "__@gt2@__");
                        // 对 HTML 标签进行内部转义，避免被 Lute 解析以后变为小写 https://github.com/siyuan-note/siyuan/issues/10620
                        textPlain = textPlain.replace(/</g, ";;;lt;;;").replace(/>/g, ";;;gt;;;");
                        // 反转义 <<assets/...>>
                        textPlain = textPlain.replace(/__@lt2assets\/@__/g, "<<assets/").replace(/__@gt2@__/g, ">>");
                        enableLuteMarkdownSyntax(protyle);
                        let content = protyle.lute.BlockDOM2EscapeMarkerContent(protyle.lute.Md2BlockDOM(textPlain));
                        restoreLuteMarkdownSyntax(protyle);
                        // 移除 ;;;lt;;; 和 ;;;gt;;; 转义及其包裹的内容
                        content = content.replace(/;;;lt;;;[^;]+;;;gt;;;/g, "");
                        document.execCommand("insertText", false, normalizeDocumentTitle(protyle, content, this.editElement));
                        this.rename(protyle);
                    }
                    return;
                }
                if (matchHotKey(protyle.settings.hotkeys.general.enterBack, event)) {
                    const parentDocument = protyle.block.parentDocument;
                    if (parentDocument) {
                        protyle.host.dispatch({
                            type: "open-document",
                            notebookId: parentDocument.notebookId,
                            documentId: parentDocument.documentId,
                            blockId: parentDocument.blockId,
                            disposition: "current",
                            scope: "target",
                            attention: "focus",
                            scroll: "auto",
                            restoreScroll: "always",
                            zoom: false,
                        });
                    }
                    event.preventDefault();
                    event.stopPropagation();
                    return;
                }
                if (event.key === "ArrowDown") {
                    const rects = getSelection().getRangeAt(0).getClientRects();
                    // https://github.com/siyuan-note/siyuan/issues/11729
                    if (rects.length === 0 // 标题为空时时
                        || this.editElement.getBoundingClientRect().bottom - rects[rects.length - 1].bottom < 25) {
                        const noContainerElement = getNoContainerElement(protyle.wysiwyg.element.firstElementChild);
                        // https://github.com/siyuan-note/siyuan/issues/4923
                        if (noContainerElement) {
                            focusBlock(noContainerElement, protyle.wysiwyg.element);
                        }
                        event.preventDefault();
                        event.stopPropagation();
                    }
                } else if (event.key === "Enter") {
                    const firstElement = protyle.wysiwyg.element.firstElementChild;
                    const editElement = getContenteditableElement(firstElement);
                    if (editElement && editElement.textContent === "" && editElement.getAttribute("placeholder") ||
                        firstElement.classList.contains("li")) {
                        // 配合提示文本使用，避免提示文本挤压到第二个块中
                        focusBlock(firstElement, protyle.wysiwyg.element);
                    } else {
                        const newId = Lute.NewNodeID();
                        const newElement = genEmptyElement(protyle, false, true, newId);
                        protyle.wysiwyg.element.insertAdjacentElement("afterbegin", newElement);
                        focusByWbr(newElement, protyle.toolbar.range || getEditorRange(newElement));
                        transaction(protyle, [{
                            action: "insert",
                            data: newElement.outerHTML,
                            id: newId,
                            parentID: protyle.block.parentID
                        }], [{
                            action: "delete",
                            id: newId,
                        }]);
                    }
                    event.preventDefault();
                    event.stopPropagation();
                } else if (protyle.settings.features.blockAttributes &&
                    matchHotKey(protyle.settings.hotkeys.editor.general.attr, event)) {
                    openDocumentAttributes(protyle, "bookmark");
                    event.preventDefault();
                    event.stopPropagation();
                } else if (matchHotKey("⌘A", event)) {
                    getEditorRange(this.editElement).selectNodeContents(this.editElement);
                    event.preventDefault();
                    event.stopPropagation();
                }
            });
            const iconElement = this.element.querySelector(".protyle-title__icon") as HTMLElement;
            iconElement.addEventListener("click", (event) => {
                // 读取当前点击事件，避免窗口失焦后遗留的全局 Shift 状态。
                if (event.shiftKey) {
                    if (protyle.settings.features.blockAttributes) {
                        openDocumentAttributes(protyle, "bookmark");
                    }
                } else {
                    const iconRect = iconElement.getBoundingClientRect();
                    openTitleMenu(protyle, {x: iconRect.left, y: iconRect.bottom}, Constants.MENU_FROM_TITLE_PROTYLE);
                }
            });
            this.element.addEventListener("contextmenu", (event) => {
                if (event.shiftKey) {
                    return;
                }
                if (getSelection().rangeCount === 0 || iconElement.contains((event.target as HTMLElement))) {
                    openTitleMenu(protyle, {x: event.clientX, y: event.clientY}, Constants.MENU_FROM_TITLE_PROTYLE);
                    return;
                }
                protyle.toolbar?.element.classList.add("fn__none");
                const {menu} = this.openMenu(protyle);
                const range = getEditorRange(this.editElement);
                if (range.toString() !== "") {
                    menu.addItem({
                        id: "copy",
                        icon: "iconCopy",
                        accelerator: "⌘C",
                        label: protyle.localization.text("copy"),
                        click: () => {
                            focusByRange(getEditorRange(this.editElement));
                            document.execCommand("copy");
                        }
                    });
                    menu.addItem({
                        id: "cut",
                        icon: "iconCut",
                        accelerator: "⌘X",
                        label: protyle.localization.text("cut"),
                        click: () => {
                            focusByRange(getEditorRange(this.editElement));
                            document.execCommand("cut");
                            setTimeout(() => {
                                this.rename(protyle);
                            }, Constants.TIMEOUT_INPUT);
                        }
                    });
                    menu.addItem({
                        id: "delete",
                        icon: "iconTrashcan",
                        accelerator: "⌫",
                        label: protyle.localization.text("delete"),
                        click: () => {
                            const range = getEditorRange(this.editElement);
                            range.extractContents();
                            focusByRange(range);
                            setTimeout(() => {
                                this.rename(protyle);
                            }, Constants.TIMEOUT_INPUT);
                        }
                    });
                }
                menu.addItem({
                    id: "paste",
                    label: protyle.localization.text("paste"),
                    icon: "iconPaste",
                    accelerator: "⌘V",
                    click: async () => {
                        focusByRange(getEditorRange(this.editElement));
                        if (document.queryCommandSupported("paste")) {
                            document.execCommand("paste");
                        } else {
                            try {
                                const text = await readText() || "";
                                document.execCommand("insertText", false, normalizeDocumentTitle(protyle, text, this.editElement));
                                this.rename(protyle);
                            } catch (e) {
                                console.error("[protyle.title] clipboard paste failed", e);
                            }
                        }
                    }
                });
                menu.addItem({
                    id: "pasteAsPlainText",
                    label: protyle.localization.text("pasteAsPlainText"),
                    accelerator: "⇧⌘V",
                    click: async () => {
                        let textPlain = await readText() || "";
                        textPlain = textPlain.replace(/<<assets\//g, "__@lt2assets/@__").replace(/>>/g, "__@gt2@__");
                        textPlain = textPlain.replace(/</g, ";;;lt;;;").replace(/>/g, ";;;gt;;;");
                        textPlain = textPlain.replace(/__@lt2assets\/@__/g, "<<assets/").replace(/__@gt2@__/g, ">>");
                        enableLuteMarkdownSyntax(protyle);
                        let content = protyle.lute.BlockDOM2EscapeMarkerContent(protyle.lute.Md2BlockDOM(textPlain));
                        restoreLuteMarkdownSyntax(protyle);
                        // 移除 ;;;lt;;; 和 ;;;gt;;; 转义及其包裹的内容
                        content = content.replace(/;;;lt;;;[^;]+;;;gt;;;/g, "");
                        document.execCommand("insertText", false, normalizeDocumentTitle(protyle, content, this.editElement));
                        this.rename(protyle);
                    }
                });
                menu.addItem({
                    id: "selectAll",
                    label: protyle.localization.text("selectAll"),
                    icon: "iconSelectAll",
                    accelerator: "⌘A",
                    click: () => {
                        range.selectNodeContents(this.editElement);
                        focusByRange(range);
                    }
                });
                menu.popup({x: event.clientX, y: event.clientY});
            });
        }
        this.element.querySelector(".protyle-attr").addEventListener("click", (event: MouseEvent & {
            target: HTMLElement
        }) => {
            if (!protyle.settings.features.blockAttributes) {
                return;
            }
            const focus = attributeFocus(event.target);
            if (!focus) {
                return;
            }
            const attributeElement = hasClosestByClassName(event.target, `protyle-attr--${focus}`);
            if (focus !== "av" && !isNarrowViewport() && isOnlyMeta(event) && attributeElement) {
                protyle.host.dispatch({
                    type: "open-search",
                    query: (focus === "memo" ? attributeElement.getAttribute("aria-label") : attributeElement.textContent)?.trim() || "",
                    queryMode: "replace",
                    method: "preferred",
                });
            } else {
                openDocumentAttributes(protyle, focus);
            }
            event.stopPropagation();
        });
    }

    private rename(protyle: IProtyle) {
        clearTimeout(this.timeout);
        const generation = ++this.renameGeneration;
        const violation = validateDocumentTitle(protyle, this.editElement.textContent, this.editElement);
        if (violation) {
            if (violation === "too-long") {
                // 字数过长会导致滚动
                const offset = titleSelectionOffset(this.editElement);
                this.writeTitle(truncateFileName(this.editElement.textContent));
                if (offset) {
                    focusByOffset(this.editElement, offset.start, offset.end);
                }
            }
            return false;
        }
        hideTooltip(protyle);
        this.timeout = window.setTimeout(() => {
            const fileName = normalizeDocumentTitle(protyle, this.editElement.textContent, this.editElement);
            const identity = protyleContentIdentity(protyle);
            void protyle.runtime.transport.request<RenameDocumentResponse>("/api/filetree/renameDoc", {
                notebook: protyle.notebookId,
                path: protyle.path,
                title: fileName,
            }, {
                identity,
                intent: "write",
                signal: protyle.requestSignal,
            }).then((response) => {
                if (protyle.requestSignal.aborted || generation !== this.renameGeneration) {
                    return;
                }
                const canonicalTitle = response.data.empty ? "" : response.data.title;
                if (canonicalTitle !== this.editElement.textContent) {
                    const offset = titleSelectionOffset(this.editElement);
                    this.writeTitle(canonicalTitle);
                    if (offset) {
                        focusByOffset(this.editElement, offset.start, offset.end);
                    }
                }
            }).catch((error) => {
                if (!protyle.requestSignal.aborted) {
                    console.error("[protyle.title] document rename failed", error);
                }
            });
            if (fileName !== this.editElement.textContent) {
                const offset = titleSelectionOffset(this.editElement);
                this.writeTitle(fileName);
                if (offset) {
                    focusByOffset(this.editElement, offset.start, offset.end);
                }
            }
        }, Constants.TIMEOUT_INPUT);
    }

    private writeTitle(title: string, empty = false) {
        if (nbsp2space(title) !== nbsp2space(this.editElement.textContent)) {
            this.editElement.textContent = empty ? "" : title;
        }
    }

    public setTitle(title: string, empty = false) {
        this.renameGeneration++;
        this.writeTitle(title, empty);
    }

    public render(protyle: IProtyle, response: IWebSocketData) {
        if (protyle.options.render.hideTitleOnZoom) {
            if (protyle.block.showAll) {
                this.element.classList.add("fn__none");
            } else {
                this.element.classList.remove("fn__none");
            }
        }
        if (this.element.getAttribute("data-render") === "true" && this.element.dataset.nodeId === protyle.block.rootID) {
            return false;
        }
        this.element.setAttribute("data-node-id", protyle.block.rootID);
        if (response.data.ial[Constants.CUSTOM_RIFF_DECKS]) {
            this.element.setAttribute(Constants.CUSTOM_RIFF_DECKS, response.data.ial[Constants.CUSTOM_RIFF_DECKS]);
        }
        protyle.background?.render(response.data.ial, protyle.block.rootID);
        protyle.wysiwyg.renderCustom(response.data.ial);
        this.element.setAttribute("data-render", "true");
        this.setTitle(response.data.ial.title, response.data.ial[Constants.CUSTOM_SY_TITLE_EMPTY] === "true");
        if (protyle.surface === "workspace") {
            const identity = protyleContentIdentity(protyle);
            protyle.host.dispatch({
                type: "set-document-title",
                notebookId: identity.notebookId,
                documentId: identity.documentId,
                title: getProtyleDocumentDisplayName(
                    response.data.name,
                    response.data.ial[Constants.CUSTOM_SY_TITLE_EMPTY] === "true",
                    protyle.localization.kernelText(16),
                ),
            });
        }
        let nodeAttrHTML = "";
        if (response.data.ial.bookmark) {
            nodeAttrHTML += `<div class="protyle-attr--bookmark">${Lute.EscapeHTMLStr(response.data.ial.bookmark)}</div>`;
        }
        if (response.data.ial.name) {
            nodeAttrHTML += `<div class="protyle-attr--name"><svg><use xlink:href="#iconN"></use></svg>${Lute.EscapeHTMLStr(response.data.ial.name)}</div>`;
        }
        if (response.data.ial.alias) {
            nodeAttrHTML += `<div class="protyle-attr--alias"><svg><use xlink:href="#iconA"></use></svg>${Lute.EscapeHTMLStr(response.data.ial.alias)}</div>`;
        }
        if (response.data.ial.memo) {
            nodeAttrHTML += `<div class="protyle-attr--memo ariaLabel" aria-label="${Lute.EscapeHTMLStr(response.data.ial.memo)}" data-position="north"><svg><use xlink:href="#iconM"></use></svg></div>`;
        }
        if (response.data.ial["custom-avs"]) {
            let avTitle = "";
            response.data.attrViews.forEach((item: { id: string, name: string }) => {
                avTitle += `<span data-av-id="${item.id}" data-popover-url="/api/av/getMirrorDatabaseBlocks" class="popover__block">${Lute.EscapeHTMLStr(item.name)}</span>&nbsp;`;
            });
            if (avTitle) {
                avTitle = avTitle.substring(0, avTitle.length - 6);
            }
            nodeAttrHTML += `<div class="protyle-attr--av"><svg><use xlink:href="#iconDatabase"></use></svg>${avTitle}</div>`;
        }
        this.element.querySelector(".protyle-attr").innerHTML = nodeAttrHTML;
        if (response.data.refCount !== 0) {
            this.element.querySelector(".protyle-attr").insertAdjacentHTML("beforeend", `<div class="protyle-attr--refcount popover__block">${response.data.refCount}</div>`);
        }
        // 存在设置新建文档名模板，不能使用 Untitled 进行判断，https://ld246.com/article/1649301009888
        if (this.editElement && Date.now() - dayjs(response.data.id.split("-")[0]).toDate().getTime() < 2000) {
            const range = this.editElement.ownerDocument.createRange();
            range.selectNodeContents(this.editElement);
            focusByRange(range);
        }
    }
}
