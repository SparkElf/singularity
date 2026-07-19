import {Constants} from "../../constants";
import {processRender} from "./processCode";
import {highlightRender} from "../render/highlightRender";
import {blockRender} from "../render/blockRender";
import {bgFade, scrollCenter} from "./highlightById";
import {focusBlock, focusByOffset} from "./selection";
import {hasClosestByAttribute} from "./hasClosest";
import {preventScroll} from "../scroll/preventScroll";
import {removeLoading} from "../ui/initUI";
import {foldPassiveType} from "../wysiwyg/renderBacklink";
import {avRender} from "../render/av/render";
import {hideTooltip} from "../ui/tooltip";
import {stickyRow} from "../render/av/row";
import {getContenteditableElement} from "../wysiwyg/getBlock";
import {
    isProtyleReadOnly,
    setApplicationReadOnly,
    setDocumentReadOnlyFromResponse,
} from "../runtime/readOnly";
import {
    beginProtyleContentLoad,
    currentProtyleContentLoad,
    requestProtyleContent,
    type ProtyleContentLoad,
} from "./contentLoad";
import {resolveProtyleContentAssetSources} from "./assetSource";

const notify = (protyle: IProtyle, level: "info" | "warning" | "error", message: string) => {
    protyle.host.dispatch({type: "notify", level, message});
};

const hideCoreElements = (panels: string[], protyle: IProtyle, focusHide = false) => {
    if (panels.includes("hint") && protyle.hint) {
        clearTimeout(protyle.hint.timeId);
        protyle.hint.element.classList.add("fn__none");
    }
    if (protyle.gutter && panels.includes("gutter")) {
        protyle.gutter.element.classList.add("fn__none");
        protyle.gutter.element.innerHTML = "";
        protyle.wysiwyg.element.querySelectorAll(".protyle-wysiwyg--hl").forEach((item) => {
            item.classList.remove("protyle-wysiwyg--hl");
        });
    }
    if (protyle.gutter && panels.includes("gutterOnly")) {
        protyle.gutter.element.classList.add("fn__none");
        protyle.gutter.element.innerHTML = "";
    }
    if (protyle.toolbar && panels.includes("toolbar")) {
        protyle.toolbar.element.classList.add("fn__none");
        protyle.toolbar.element.style.display = "";
    }
    if (protyle.toolbar && panels.includes("util")) {
        const pinElement = protyle.toolbar.subElement.querySelector('[data-type="pin"]');
        const pinned = pinElement?.getAttribute("aria-label") === protyle.localization.text("unpin");
        if (!protyle.toolbar.isMultiSelectMode() && (focusHide || !pinned)) {
            protyle.toolbar.subElement.classList.add("fn__none");
            protyle.toolbar.subElementCloseCB?.();
            protyle.toolbar.subElementCloseCB = undefined;
        }
    }
    if (panels.includes("select")) {
        protyle.wysiwyg.element.querySelectorAll(".protyle-wysiwyg--select").forEach((item) => {
            item.classList.remove("protyle-wysiwyg--select");
            item.removeAttribute("select-start");
            item.removeAttribute("select-end");
        });
    }
};

const isAbort = (error: unknown): boolean =>
    error instanceof DOMException && error.name === "AbortError";

const reportRequestFailure = (protyle: IProtyle, error: unknown) => {
    if (!isAbort(error) && !protyle.requestSignal.aborted && !protyle.destroyed) {
        removeLoading(protyle);
        console.error("[protyle.transport] content load failed", error);
    }
};

export const onGet = (options: {
    data: IWebSocketData,
    protyle: IProtyle,
    action?: TProtyleAction[],
    scrollAttr?: IScrollAttr
    updateReadonly?: boolean,
    scrollPosition?: ScrollLogicalPosition,
    afterCB?: () => void
    load?: ProtyleContentLoad,
}) => {
    const load = options.load ?? currentProtyleContentLoad(options.protyle) ?? beginProtyleContentLoad(options.protyle);
    if (!load.isCurrent()) {
        return;
    }
    const action = options.action ?? [];
    options.protyle.wysiwyg.element.removeAttribute("data-top");
    if (options.data.code === 1) {
        if (!action.includes(Constants.CB_GET_APPEND)) {
            if (options.protyle.surface === "embedded") {
                options.protyle.element.innerHTML = "";
            }
            if (options.data.msg) {
                notify(options.protyle, "error", options.data.msg);
            }
            removeLoading(options.protyle);
        }
        return;
    }
    if (options.data.code === 3) {
        if (options.data.msg) {
            notify(options.protyle, "error", options.data.msg);
        }
        removeLoading(options.protyle);
        return;
    }
    options.protyle.path = options.data.data.path;

    if (options.data.data.eof && !options.scrollAttr) {
        if (action.includes(Constants.CB_GET_BEFORE)) {
            options.protyle.wysiwyg.element.firstElementChild.setAttribute("data-eof", "1");
        } else {
            options.protyle.wysiwyg.element.lastElementChild.setAttribute("data-eof", "2");
        }
        if (options.data.data.mode !== 4) {
            return;
        }
    }
    hideCoreElements(["gutterOnly"], options.protyle);
    options.protyle.block.parentID = options.data.data.parentID;
    options.protyle.block.parent2ID = options.data.data.parent2ID;
    options.protyle.block.parentDocument = options.data.data.parentDocument;
    options.protyle.block.rootID = options.data.data.rootID;
    options.protyle.block.showAll = action.includes(Constants.CB_GET_ALL);
    options.protyle.block.mode = options.data.data.mode;
    options.protyle.block.blockCount = options.data.data.blockCount;
    options.protyle.block.scroll = options.data.data.scroll;
    options.protyle.block.action = action;
    if (!action.includes(Constants.CB_GET_UNCHANGEID)) {
        options.protyle.block.id = options.data.data.id;    // 非缩放情况时不一定是 rootID（搜索打开页签）；缩放时必为缩放 id，否则需查看代码
        options.protyle.scroll.lastScrollTop = 0;
        options.protyle.contentElement.scrollTop = 0;
        options.protyle.wysiwyg.element.setAttribute("data-doc-type", options.data.data.type);
    }

    if (options.protyle.options.render.title && options.protyle.title.element.getAttribute("data-render") !== "true") {
        // 文档A的大纲，关闭文档A后，点击大纲无法渲染头部
    } else if (action.includes(Constants.CB_GET_APPEND) || action.includes(Constants.CB_GET_BEFORE) || action.includes(Constants.CB_GET_HTML)) {
        if (options.protyle.options.render.title && options.protyle.options.render.hideTitleOnZoom) {
            if (options.protyle.block.showAll) {
                options.protyle.title.element.classList.add("fn__none");
            } else {
                options.protyle.title.element.classList.remove("fn__none");
            }
        }
        // 防止动态加载加载过多的内容
        setHTML({
            content: options.data.data.content,
            expand: options.data.data.isBacklinkExpand,
            action,
            scrollAttr: options.scrollAttr,
            updateReadonly: options.updateReadonly,
            isSyncing: options.data.data.isSyncing,
            afterCB: options.afterCB,
            scrollPosition: options.scrollPosition
        }, options.protyle, load);
        removeLoading(options.protyle);
        return;
    }

    const docInfoParam: IObject = {
        id: options.protyle.block.rootID
    };
    void requestProtyleContent<IWebSocketData>(options.protyle, "/api/block/getDocInfo", docInfoParam, load).then((response) => {
        if (!load.isCurrent()) {
            return;
        }
        if (options.protyle.options.render.title) {
            // 页签没有打开
            options.protyle.title.render(options.protyle, response);
        } else {
            if (options.protyle.options.render.background) {
                options.protyle.background.render(response.data.ial, options.protyle.block.rootID);
            }
            options.protyle.wysiwyg.renderCustom(response.data.ial);
        }

        setHTML({
            content: options.data.data.content,
            expand: options.data.data.isBacklinkExpand,
            action,
            scrollAttr: options.scrollAttr,
            updateReadonly: options.updateReadonly,
            isSyncing: options.data.data.isSyncing,
            afterCB: options.afterCB,
            scrollPosition: options.scrollPosition
        }, options.protyle, load);
        removeLoading(options.protyle);
    }).catch((error) => reportRequestFailure(options.protyle, error));
};

const setHTML = (options: {
    content: string,
    action: TProtyleAction[],
    isSyncing: boolean,
    expand: boolean,
    updateReadonly?: boolean,
    scrollAttr?: IScrollAttr,
    scrollPosition?: ScrollLogicalPosition,
    afterCB?: () => void
}, protyle: IProtyle, load: ProtyleContentLoad) => {
    if (!load.isCurrent()) {
        return;
    }
    if (protyle.contentElement.classList.contains("fn__none") && protyle.wysiwyg.element.innerHTML !== "") {
        return;
    }

    // XSS in inline memo elements https://github.com/siyuan-note/siyuan/issues/15280
    const parser = new DOMParser();
    const doc = parser.parseFromString(options.content, "text/html");
    doc.querySelectorAll("[data-inline-memo-content]").forEach(item => {
        const content = item.getAttribute("data-inline-memo-content");
        if (content) {
            item.setAttribute("data-inline-memo-content", window.DOMPurify.sanitize(content));
        }
    });
    resolveProtyleContentAssetSources(protyle, doc);
    options.content = doc.body.innerHTML;
    const REMOVED_OVER_HEIGHT = protyle.contentElement.clientHeight * 8;
    const updateReadonly = typeof options.updateReadonly === "undefined" ? protyle.wysiwyg.element.innerHTML === "" : options.updateReadonly;
    if (options.action.includes(Constants.CB_GET_APPEND)) {
        // 动态加载移除
        if (!protyle.wysiwyg.element.querySelector(".protyle-wysiwyg--select") && !protyle.scroll.keepLazyLoad && protyle.contentElement.scrollHeight > REMOVED_OVER_HEIGHT) {
            let removeElement = protyle.wysiwyg.element.firstElementChild as HTMLElement;
            const removeElements = [];
            while (protyle.wysiwyg.element.childElementCount > 2 && removeElements &&
            protyle.wysiwyg.element.lastElementChild !== removeElement) {
                if (protyle.contentElement.scrollHeight - removeElement.offsetTop > REMOVED_OVER_HEIGHT) {
                    removeElements.push(removeElement);
                } else {
                    break;
                }
                removeElement = removeElement.nextElementSibling as HTMLElement;
            }
            const lastRemoveTop = removeElement.getBoundingClientRect().top;
            removeElements.forEach(item => {
                item.remove();
            });
            protyle.contentElement.scrollTop = protyle.contentElement.scrollTop + (removeElement.getBoundingClientRect().top - lastRemoveTop) - 1;
            protyle.scroll.lastScrollTop = protyle.contentElement.scrollTop;
            hideCoreElements(["toolbar"], protyle);
        }
        protyle.wysiwyg.element.insertAdjacentHTML("beforeend", options.content);
    } else if (options.action.includes(Constants.CB_GET_BEFORE)) {
        const firstElement = protyle.wysiwyg.element.firstElementChild as HTMLElement;
        const lastTop = firstElement.getBoundingClientRect().top;
        protyle.wysiwyg.element.insertAdjacentHTML("afterbegin", options.content);
        protyle.contentElement.scrollTop = protyle.contentElement.scrollTop + (firstElement.getBoundingClientRect().top - lastTop);
        protyle.scroll.lastScrollTop = protyle.contentElement.scrollTop;
        // 动态加载移除
        if (!protyle.wysiwyg.element.querySelector(".protyle-wysiwyg--select") && !protyle.scroll.keepLazyLoad) {
            const removeElements: Element[] = [];
            let childCount = protyle.wysiwyg.element.childElementCount;
            let scrollHeight = protyle.contentElement.scrollHeight;
            let lastElement = protyle.wysiwyg.element.lastElementChild;
            while (childCount > 2 && scrollHeight > REMOVED_OVER_HEIGHT && lastElement.getBoundingClientRect().top > window.innerHeight) {
                removeElements.push(lastElement);
                lastElement = lastElement.previousElementSibling;
                childCount--;
                scrollHeight -= lastElement.clientHeight + 8;   // 大部分元素的 margin
            }
            removeElements.forEach((item) => {
                item.remove();
            });
            hideCoreElements(["toolbar"], protyle);
        }
    } else {
        protyle.wysiwyg.element.innerHTML = options.content;
        // 设置 innerHTML 会导致浏览器将 scrollTop 重置为 0，此处立即恢复以避免页面跳转到开头
        // https://github.com/siyuan-note/siyuan/issues/17886
        if (options.scrollAttr && typeof options.scrollAttr.scrollTop === "number") {
            protyle.contentElement.scrollTop = options.scrollAttr.scrollTop;
            protyle.scroll.lastScrollTop = options.scrollAttr.scrollTop;
        }
    }

    // https://github.com/siyuan-note/siyuan/issues/10528
    if (!protyle.block.showAll && protyle.wysiwyg.element.childElementCount === 1 && protyle.wysiwyg.element.firstElementChild.classList.contains("p")) {
        const editElement = getContenteditableElement(protyle.wysiwyg.element.firstElementChild);
        if (editElement && editElement.textContent === "") {
            editElement.classList.add("protyle-wysiwyg--empty");
            editElement.setAttribute("placeholder", protyle.localization.text("emptyPlaceholder"));
        }
    }

    if (options.action.includes(Constants.CB_GET_BACKLINK)) {
        foldPassiveType(options.expand, protyle.wysiwyg.element);
    }
    processRender(protyle.wysiwyg.element, protyle);
    highlightRender(protyle.wysiwyg.element, protyle);
    avRender(protyle.wysiwyg.element, protyle);
    blockRender(protyle, protyle.wysiwyg.element);
    if (options.action.includes(Constants.CB_GET_HISTORY)) {
        return;
    }
    if (protyle.options.render.scroll) {
        protyle.scroll.update(protyle);
    }
    if (options.action.includes(Constants.CB_GET_FOCUSFIRST)) {
        // settimeout 时间需短一点，否则定位后快速滚动无效
        const headerHeight = protyle.wysiwyg.element.offsetTop - 16;
        preventScroll(protyle, headerHeight, Constants.TIMEOUT_INPUT, load.signal);
        protyle.contentElement.scrollTop = headerHeight;
    }
    if (options.isSyncing) {
        disabledForeverProtyle(protyle);
    } else {
        if (protyle.breadcrumb) {
            protyle.breadcrumb.element.nextElementSibling.textContent = "";
        }
        if (protyle.element.hasAttribute("disabled-forever")) {
            if (protyle.wysiwyg.element.getAttribute("custom-sy-readonly") !== "true") {
                protyle.disabled = false;
            }
            protyle.element.removeAttribute("disabled-forever");
        }
        setReadonlyByConfig(protyle, updateReadonly);
    }

    focusElementById(protyle, options.action, load, options.scrollAttr, options.scrollPosition);

    if (options.action.includes(Constants.CB_GET_SETID)) {
        // 点击大纲后，如果需要动态加载，在定位后，需要重置 block.id https://github.com/siyuan-note/siyuan/issues/4487
        protyle.block.id = protyle.block.rootID;
        protyle.wysiwyg.element.setAttribute("data-doc-type", "NodeDocument");
    }
    protyle.options.defIds?.forEach(item => {
        protyle.wysiwyg.element.querySelectorAll(`[data-id="${item}"]`).forEach(item => {
            item.classList.add("def--mark");
        });
    });
    protyle.options.defIds = [];
    if (options.action.includes(Constants.CB_GET_APPEND) || options.action.includes(Constants.CB_GET_BEFORE)) {
        protyle.plugins.emit({
            type: "loaded-protyle-dynamic",
            detail: {
                protyle,
                position: options.action.includes(Constants.CB_GET_APPEND) ? "afterend" : "beforebegin"
            },
        });
        return;
    }

    if (protyle.options.render.breadcrumb) {
        protyle.breadcrumb.toggleExit(!options.action.includes(Constants.CB_GET_ALL));
        protyle.breadcrumb.render(protyle);
    }
    if (options.afterCB) {
        options.afterCB();
    }
    // 需等待 afterCB 执行后 resize 计算出高度后再进行计算
    // 屏幕太高的页签 https://github.com/siyuan-note/siyuan/issues/5018
    if (options.scrollAttr && !protyle.scroll.element.classList.contains("fn__none") &&
        !protyle.element.classList.contains("block__edit") &&   // 不能为浮窗，否则悬浮为根文档无法打开整个文档 https://github.com/siyuan-note/siyuan/issues/9082
        protyle.wysiwyg.element.lastElementChild.getAttribute("data-eof") !== "2" &&
        protyle.contentElement.scrollHeight > 0 && // 没有激活的页签 https://github.com/siyuan-note/siyuan/issues/5255
        !options.action.includes(Constants.CB_GET_FOCUSFIRST) && // 防止 eof 为true https://github.com/siyuan-note/siyuan/issues/5291
        protyle.contentElement.scrollHeight <= protyle.contentElement.clientHeight) {
        const getDocParam: IObject = {
            id: protyle.wysiwyg.element.lastElementChild.getAttribute("data-node-id"),
            mode: 2,
            size: protyle.settings.editor.dynamicLoadBlocks,
        };
        void requestProtyleContent<IWebSocketData>(protyle, "/api/filetree/getDoc", getDocParam, load)
            .then((getResponse) => {
                if (!load.isCurrent()) {
                    return;
                }
                onGet({
                    data: getResponse,
                    protyle,
                    action: [Constants.CB_GET_APPEND, Constants.CB_GET_UNCHANGEID],
                    load,
                });
            })
            .catch((error) => reportRequestFailure(protyle, error));
    }
    // 动态滚动条拖拽到最后几个块时需多加载一点块 https://github.com/siyuan-note/siyuan/issues/16906
    if (options.action.includes(Constants.CB_GET_FOCUSFIRST) &&
        protyle.wysiwyg.element.getBoundingClientRect().top > protyle.breadcrumb.element.getBoundingClientRect().bottom) {
        const getDocParam: IObject = {
            id: protyle.wysiwyg.element.firstElementChild.getAttribute("data-node-id"),
            mode: 1,
            size: protyle.settings.editor.dynamicLoadBlocks,
        };
        void requestProtyleContent<IWebSocketData>(protyle, "/api/filetree/getDoc", getDocParam, load)
            .then((getResponse) => {
                if (!load.isCurrent()) {
                    return;
                }
                onGet({
                    data: getResponse,
                    protyle,
                    action: [Constants.CB_GET_BEFORE, Constants.CB_GET_UNCHANGEID],
                    load,
                });
            })
            .catch((error) => reportRequestFailure(protyle, error));
    }
    if (options.scrollAttr && !protyle.scroll.element.classList.contains("fn__none") && !protyle.element.classList.contains("fn__none")) {
        // 使用动态滚动条定位到最后一个块，重启后无法触发滚动事件，需要再次更新 index
        const startId = options.scrollAttr.startId || protyle.wysiwyg.element.firstElementChild?.getAttribute("data-node-id");
        if (startId) {
            protyle.scroll.updateIndex(protyle, startId, (index) => {
                // https://github.com/siyuan-note/siyuan/issues/8224
                // https://github.com/siyuan-note/siyuan/issues/10716
                if (index > 1 && protyle.block.blockCount > 1 && protyle.contentElement.scrollHeight <= protyle.contentElement.clientHeight) {
                    notify(protyle, "info", protyle.localization.text("scrollGetMore"));
                }
            }, load);
        }

    }
    protyle.plugins.emit({type: "loaded-protyle-static", detail: {protyle}});
};

export const disabledForeverProtyle = (protyle: IProtyle) => {
    disabledProtyle(protyle);
    if (protyle.breadcrumb) {
        protyle.breadcrumb.element.nextElementSibling.textContent = protyle.localization.kernelText(81);
    } else {
        notify(protyle, "info", protyle.localization.kernelText(81));
    }
    protyle.element.setAttribute("disabled-forever", "true");
};

/** 禁用编辑器 */
export const disabledProtyle = (protyle: IProtyle) => {
    hideCoreElements(["gutter", "toolbar", "select", "hint", "util"], protyle);
    protyle.disabled = true;
    if (protyle.title && protyle.title.editElement) {
        protyle.title.editElement.setAttribute("contenteditable", "false");
        protyle.title.editElement.style.userSelect = "text";
    }
    if (protyle.background) {
        protyle.background.element.classList.remove("protyle-background--enable");
        protyle.background.element.classList.remove("protyle-background--mobileshow");
    }
    protyle.wysiwyg.element.querySelectorAll(".protyle-icons--show").forEach(item => {
        item.classList.remove("protyle-icons--show");
    });
    protyle.wysiwyg.element.querySelectorAll(".av__gallery-fields--edit").forEach(item => {
        item.classList.remove("av__gallery-fields--edit");
    });
    protyle.wysiwyg.element.querySelectorAll(".render-node .protyle-action__edit").forEach(item => {
        item.classList.add("fn__none");
        if (item.classList.contains("protyle-icon--first")) {
            item.nextElementSibling?.classList.add("protyle-icon--first");
        }
    });
    protyle.wysiwyg.element.style.userSelect = "text";
    protyle.wysiwyg.element.setAttribute("contenteditable", "false");
    // 用于区分移动端样式
    protyle.wysiwyg.element.setAttribute("data-readonly", "true");
    protyle.wysiwyg.element.querySelectorAll('[contenteditable="true"][spellcheck]').forEach(item => {
        item.setAttribute("contenteditable", "false");
    });
    protyle.wysiwyg.element.querySelectorAll('.protyle-action[draggable="true"]').forEach(item => {
        item.setAttribute("draggable", "false");
    });
    if (protyle.breadcrumb) {
        const readonlyButton = protyle.breadcrumb.element.parentElement.querySelector('[data-type="readonly"]');
        readonlyButton.querySelector("use").setAttribute("xlink:href", "#iconLock");
        readonlyButton.setAttribute("aria-label", protyle.localization.text(
            protyle.settings.editor.readOnly ? "tempUnlock" : "unlockEdit",
        ));
        readonlyButton.setAttribute("data-subtype", "lock");
        const undoElement = protyle.breadcrumb.element.parentElement.querySelector('[data-type="undo"]');
        if (undoElement && !undoElement.classList.contains("fn__none")) {
            undoElement.classList.add("fn__none");
            protyle.breadcrumb.element.parentElement.querySelector('[data-type="redo"]').classList.add("fn__none");
            protyle.breadcrumb.element.parentElement.querySelector('[data-type="indent"]').classList.add("fn__none");
            protyle.breadcrumb.element.parentElement.querySelector('[data-type="outdent"]').classList.add("fn__none");
        }
    }
    hideTooltip(protyle);
};

/** 解除编辑器禁用 */
export const enableProtyle = (protyle: IProtyle) => {
    if (protyle.element.getAttribute("disabled-forever") === "true" ||
        isProtyleReadOnly(protyle.readonlyState)) {
        return;
    }
    protyle.disabled = false;
    const toolbarName = document.getElementById("toolbarName");
    if (toolbarName) {
        // Android 端空块输入法弹出会收起 https://ld246.com/article/1689713888289
        // iPhone，iPad 端 protyle.wysiwyg.element contenteditable 为 true 时，输入会在块中间插入 span 导致保存失败 https://ld246.com/article/1643473862873/comment/1643813765839#comments
        toolbarName.removeAttribute("readonly");
    } else {
        protyle.wysiwyg.element.setAttribute("contenteditable", "true");
        protyle.wysiwyg.element.style.userSelect = "";
    }
    // 用于区分移动端样式
    protyle.wysiwyg.element.setAttribute("data-readonly", "false");
    if (protyle.title && protyle.title.editElement) {
        protyle.title.editElement.setAttribute("contenteditable", "true");
        protyle.title.editElement.style.userSelect = "";
    }
    if (protyle.background) {
        protyle.background.element.classList.add("protyle-background--enable");
    }

    protyle.wysiwyg.element.querySelectorAll(".render-node .protyle-action__edit").forEach(item => {
        item.classList.remove("fn__none");
        if (item.classList.contains("protyle-icon--first")) {
            item.nextElementSibling?.classList.remove("protyle-icon--first");
        }
    });
    protyle.wysiwyg.element.querySelectorAll('[contenteditable="false"][spellcheck]').forEach(item => {
        item.setAttribute("contenteditable", "true");
    });
    protyle.wysiwyg.element.querySelectorAll('.protyle-action[draggable="false"]').forEach(item => {
        item.setAttribute("draggable", "true");
    });
    protyle.wysiwyg.element.querySelectorAll(".av").forEach((item: HTMLElement) => {
        if (item.querySelector(".av__scroll")) {
            stickyRow(item, protyle.contentElement, "all");
        }
    });
    if (protyle.breadcrumb) {
        const readonlyButton = protyle.breadcrumb.element.parentElement.querySelector('[data-type="readonly"]');
        readonlyButton.querySelector("use").setAttribute("xlink:href", "#iconUnlock");
        readonlyButton.setAttribute("aria-label", protyle.localization.text(
            protyle.settings.editor.readOnly ? "cancelTempUnlock" : "lockEdit",
        ));
        readonlyButton.setAttribute("data-subtype", "unlock");
        const undoElement = protyle.breadcrumb.element.parentElement.querySelector('[data-type="undo"]');
        if (undoElement && undoElement.classList.contains("fn__none")) {
            undoElement.classList.remove("fn__none");
            protyle.breadcrumb.element.parentElement.querySelector('[data-type="redo"]').classList.remove("fn__none");
            protyle.breadcrumb.element.parentElement.querySelector('[data-type="indent"]').classList.remove("fn__none");
            protyle.breadcrumb.element.parentElement.querySelector('[data-type="outdent"]').classList.remove("fn__none");
        }
    }
    hideTooltip(protyle);
};

const focusElementById = (protyle: IProtyle, action: string[], load: ProtyleContentLoad,
                          scrollAttr?: IScrollAttr, scrollPosition?: ScrollLogicalPosition) => {
    if (!load.isCurrent()) {
        return;
    }
    let focusElement: Element;
    if (scrollAttr && scrollAttr.focusId) {
        focusElement = protyle.wysiwyg.element.querySelector(`[data-node-id="${scrollAttr.focusId}"]`);
    } else {
        Array.from(protyle.wysiwyg.element.querySelectorAll(`[data-node-id="${protyle.block.id}"]`)).find((item: HTMLElement) => {
            if (!hasClosestByAttribute(item, "data-type", "block-render", true)) {
                focusElement = item;
                return true;
            }
        });
    }
    if (!focusElement && protyle.block.id === protyle.block.rootID && protyle.title?.editElement) {
        focusElement = protyle.title.editElement;
    }
    if (protyle.block.mode === 4) {
        preventScroll(protyle, 0, 1000, load.signal);
        focusElement = protyle.wysiwyg.element.lastElementChild;
    } else if (!focusElement || action.includes(Constants.CB_GET_FOCUSFIRST)) {
        focusElement = protyle.wysiwyg.element.firstElementChild;
    }
    if (action.includes(Constants.CB_GET_HL)) {
        preventScroll(protyle, 0, 1000, load.signal); // 搜索页签滚动会导致再次请求
        bgFade(focusElement);
    }
    if (action.includes(Constants.CB_GET_FOCUS) || action.includes(Constants.CB_GET_FOCUSFIRST)) {
        setTimeout(() => {
            if (!load.isCurrent()) {
                return;
            }
            if (scrollAttr && scrollAttr.focusId) {
                focusByOffset(focusElement, scrollAttr.focusStart, scrollAttr.focusEnd);
            } else {
                focusBlock(focusElement, undefined, !action.includes(Constants.CB_GET_OUTLINE));
            }
        }, focusElement.getAttribute("data-type") === "NodeCodeBlock" ? Constants.TIMEOUT_TRANSITION : 0);
    }
    const hasScrollTop = scrollAttr && typeof scrollAttr.scrollTop === "number";
    if (hasScrollTop) {
        protyle.contentElement.scrollTop = scrollAttr.scrollTop;
    }
    // 下一个请求过来前需断开，否则 observerLoad 重新赋值后无法 disconnect https://ld246.com/article/1704612002446
    protyle.observerLoad?.disconnect();
    if (action.includes(Constants.CB_GET_FOCUS) || action.includes(Constants.CB_GET_SCROLL) || action.includes(Constants.CB_GET_HL) || action.includes(Constants.CB_GET_FOCUSFIRST)) {
        if (!hasScrollTop) {
            scrollCenter(protyle, focusElement, scrollPosition);
        }
    } else {
        return;
    }
    // 加强定位
    // 使用 AbortController 监听用户手势（滚轮/触摸/方向键），一旦用户主动滚动即停止强制定位，否则顶部为数据库等异步渲染块撑高内容时会反复重置滚动位置
    const userScrollAbort = new AbortController();
    const onUserScroll = () => userScrollAbort.abort();
    protyle.contentElement.addEventListener("wheel", onUserScroll, {capture: true, passive: true, signal: userScrollAbort.signal});
    protyle.contentElement.addEventListener("touchstart", onUserScroll, {capture: true, passive: true, signal: userScrollAbort.signal});
    protyle.contentElement.addEventListener("touchmove", onUserScroll, {capture: true, passive: true, signal: userScrollAbort.signal});
    protyle.contentElement.addEventListener("keydown", (event: KeyboardEvent) => {
        // 仅拦截会触发滚动的按键，避免影响正常编辑输入
        if (["PageUp", "PageDown", "Home", "End", "ArrowUp", "ArrowDown", " "].includes(event.key)) {
            userScrollAbort.abort();
        }
    }, {capture: true, signal: userScrollAbort.signal});
    const observerLoad = new ResizeObserver(() => {
        if (!load.isCurrent() || userScrollAbort.signal.aborted) {
            // 用户已主动滚动，停止强制定位并将滚动权交还给用户
            observerLoad.disconnect();
            if (load.isCurrent()) {
                protyle.observer.observe(protyle.wysiwyg.element);
            }
            return;
        }
        if (hasScrollTop) {
            protyle.contentElement.scrollTop = scrollAttr.scrollTop;
        }
        if (action.includes(Constants.CB_GET_FOCUS) || action.includes(Constants.CB_GET_HL) || action.includes(Constants.CB_GET_FOCUSFIRST)) {
            if (!hasScrollTop) {
                scrollCenter(protyle, focusElement, scrollPosition);
            }
        }
    });
    protyle.observerLoad = observerLoad;
    observerLoad.observe(protyle.wysiwyg.element);
    protyle.observer.unobserve(protyle.wysiwyg.element);
    setTimeout(() => {
        observerLoad.disconnect();
        userScrollAbort.abort();
        if (load.isCurrent()) {
            protyle.observer.observe(protyle.wysiwyg.element);
        }
    }, 1000 * 3);

    if (focusElement === protyle.wysiwyg.element.firstElementChild && !hasScrollTop) {
        observerLoad.disconnect();
        userScrollAbort.abort();
    }
};

export const setReadonlyByConfig = (protyle: IProtyle, updateReadonly: boolean) => {
    if (updateReadonly) {
        setApplicationReadOnly(protyle.readonlyState, protyle.settings.editor.readOnly);
        setDocumentReadOnlyFromResponse(
            protyle.readonlyState,
            protyle.wysiwyg.element.getAttribute(Constants.CUSTOM_SY_READONLY) === "true",
        );
    }
    if (isProtyleReadOnly(protyle.readonlyState)) {
        disabledProtyle(protyle);
    } else {
        enableProtyle(protyle);
    }
};
