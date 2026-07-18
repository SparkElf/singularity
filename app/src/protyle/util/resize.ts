import {hasClosestBlock, hasClosestByClassName} from "./hasClosest";
import {Constants} from "../../constants";
import {lineNumberRender} from "../render/highlightRender";
import {stickyRow} from "../render/av/row";

const hideGutterOnly = (protyle: IProtyle) => {
    if (!protyle.gutter || navigator.userAgent.includes("iPhone")) {
        return;
    }
    protyle.gutter.element.classList.add("fn__none");
    protyle.gutter.element.innerHTML = "";
};

const getPadding = (protyle: IProtyle) => {
    let right = 16;
    let left = 24;
    let bottom = 16;
    if (protyle.options.typewriterMode) {
        bottom = protyle.element.clientHeight / 2;
    }
    const isMobile = document.getElementById("sidebar") !== null;
    if (!isMobile) {
        const fullWidthAttribute = protyle.wysiwyg.element.getAttribute(Constants.CUSTOM_SY_FULLWIDTH);
        const isFullWidth = fullWidthAttribute !== null
            ? fullWidthAttribute === "true"
            : protyle.element.dataset.fullWidth === "true";
        let padding = (protyle.element.clientWidth - Constants.SIZE_EDITOR_WIDTH) / 2;
        if (!isFullWidth && padding > 96) {
            if (padding > Constants.SIZE_EDITOR_WIDTH) {
                padding = protyle.element.clientWidth * .382 / 1.382;
            }
            padding = Math.ceil(padding);
            left = padding;
            right = padding;
        } else if (protyle.element.clientWidth > Constants.SIZE_EDITOR_WIDTH) {
            left = 96;
            right = 96;
        }
    }
    return {left, right, bottom, top: 16};
};

const setPadding = (protyle: IProtyle) => {
    if (protyle.options.action.includes(Constants.CB_GET_HISTORY)) {
        return {width: 0, padding: 0};
    }
    const padding = getPadding(protyle);
    if (protyle.options.backlinkData) {
        protyle.wysiwyg.element.style.padding = `4px ${padding.right}px 4px ${padding.left}px`;
    } else {
        protyle.wysiwyg.element.style.padding =
            `${padding.top}px ${padding.right}px ${padding.bottom}px ${padding.left}px`;
    }
    if (protyle.options.render.background) {
        protyle.background?.element.querySelector(".protyle-background__ia")?.setAttribute(
            "style",
            `margin-left:${padding.left}px;margin-right:${padding.right}px`,
        );
    }
    if (protyle.options.render.title) {
        protyle.title?.element.style.setProperty(
            "margin",
            `16px ${padding.right}px 0 ${padding.left}px`,
        );
    }
    protyle.element.style.setProperty("--b3-width-protyle", `${protyle.element.clientWidth}px`);
    protyle.element.style.setProperty("--b3-width-protyle-content", `${protyle.contentElement.clientWidth}px`);
    const realWidth = protyle.wysiwyg.element.getAttribute("data-realwidth");
    const newWidth = protyle.wysiwyg.element.clientWidth - padding.left - padding.right;
    protyle.wysiwyg.element.setAttribute("data-realwidth", newWidth.toString());
    protyle.element.style.setProperty("--b3-width-protyle-wysiwyg", `${newWidth}px`);
    return {width: realWidth ? Math.abs(parseFloat(realWidth) - newWidth) : 0};
};

export const clearBeforeResizeTop = (editors: TProtyleEditorRegistry) => {
    editors.forEach((editor) => {
        if (editor.element.isConnected && editor.element.getClientRects().length > 0) {
            editor.wysiwyg.element.querySelector("[data-resize-top]")?.removeAttribute("data-resize-top");
        }
    });
};

export const recordBeforeResizeTop = (editors: TProtyleEditorRegistry) => {
    editors.forEach((editor) => {
        if (editor.element.isConnected && editor.element.getClientRects().length > 0) {
            editor.wysiwyg.element.querySelector("[data-resize-top]")?.removeAttribute("data-resize-top");
            const contentRect = editor.contentElement.getBoundingClientRect();
            let topElement = document.elementFromPoint(contentRect.left + (contentRect.width / 2), contentRect.top);
            if (hasClosestByClassName(topElement, "b3-menu")) {
                return;
            }
            if (!topElement) {
                topElement = document.elementFromPoint(contentRect.left + (contentRect.width / 2), contentRect.top + 17);
            }
            if (!topElement) {
                return;
            }
            topElement = hasClosestBlock(topElement) as HTMLElement;
            if (!topElement) {
                return;
            }
            topElement.setAttribute("data-resize-top", (contentRect.top - topElement.getBoundingClientRect().top).toString());
        }
    });
};

export const resize = (protyle: IProtyle) => {
    hideGutterOnly(protyle);
    const abs = setPadding(protyle);
    const MIN_ABS = 4;
    // 不能 clearTimeout，否则 split 时左侧无法 resize
    setTimeout(() => {
        if (protyle.destroyed || protyle.ownerSignal?.aborted) {
            return;
        }
        const scrollParent = protyle.scroll?.element.parentElement;
        if (scrollParent?.getAttribute("style")) {
            scrollParent.setAttribute("style", `--b3-dynamicscroll-width:${Math.min(protyle.contentElement.clientHeight - 49, 200)}px`);
        }
        if (!protyle.disabled) {
            protyle.wysiwyg.element.querySelectorAll(".av").forEach((item: HTMLElement) => {
                if (item.querySelector(".av__scroll")) {
                    stickyRow(item, protyle.contentElement, "all");
                }
            });
        }
        if (abs.width > MIN_ABS || isNaN(abs.width)) {
            if (typeof window.echarts !== "undefined") {
                protyle.wysiwyg.element.querySelectorAll('[data-subtype="echarts"], [data-subtype="mindmap"]').forEach((chartItem: HTMLElement) => {
                    const chartInstance = window.echarts.getInstanceById(chartItem.querySelector("[_echarts_instance_]").getAttribute("_echarts_instance_"));
                    if (chartInstance) {
                        chartInstance.resize();
                    }
                });
            }
        }
        // 小于 MIN_ABS 也会导致换行 https://github.com/siyuan-note/siyuan/issues/13677
        protyle.wysiwyg.element.querySelectorAll(".code-block .protyle-linenumber__rows").forEach((item: HTMLElement) => {
            if ((item.nextElementSibling as HTMLElement).style.wordBreak === "break-word") {
                lineNumberRender(item.parentElement, protyle);
            }
        });
        const topElement = protyle.wysiwyg.element.querySelector("[data-resize-top]");
        if (topElement) {
            topElement.scrollIntoView();
            protyle.contentElement.scrollTop += parseInt(topElement.getAttribute("data-resize-top"));
            topElement.removeAttribute("data-resize-top");
        }
    }, Constants.TIMEOUT_TRANSITION + 100);   // 等待 setPadding 动画结束
};
