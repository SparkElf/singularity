import {setEditMode} from "../util/setEditMode";
import {scrollEvent} from "../scroll/event";
import {Constants} from "../../constants";
import {isMac, isNarrowViewport} from "../util/browserPlatform";
import {lineNumberRender} from "../render/highlightRender";
import {getContenteditableElement, getLastBlock} from "../wysiwyg/getBlock";
import {genEmptyElement, genHeadingElement} from "../wysiwyg/blockElement";
import {transaction} from "../wysiwyg/transaction";
import {focusByRange} from "../util/selection";
import {
    hasClosestBlock,
    hasClosestByAttribute,
    hasClosestByClassName,
    hasClosestByTag,
    isInEmbedBlock
} from "../util/hasClosest";
import {hideElements} from "./hideElements";
import {positionElementInViewport} from "./positionElement";

const toolbarResizeDirections = ["move", "rd", "ld", "lt", "rt", "r", "d", "t", "l"] as const;

const enableToolbarMoveResize = (protyle: IProtyle) => {
    const element = protyle.toolbar.subElement;
    let endGesture: (() => void) | undefined;

    const pinToolbar = () => {
        const pinElement = element.querySelector<HTMLElement>('.block__icons [data-type="pin"]')!;
        pinElement.querySelector("svg use")!.setAttribute("xlink:href", "#iconUnpin");
        pinElement.setAttribute("aria-label", protyle.localization.text("unpin"));
        element.firstElementChild!.setAttribute("data-drag", "true");
    };

    element.addEventListener("pointerdown", (event) => {
        if (event.button !== 0 || isNarrowViewport()) {
            return;
        }
        const target = event.target as HTMLElement;
        const handle = target.closest<HTMLElement>(toolbarResizeDirections
            .map((direction) => `.resize__${direction}`)
            .join(","));
        if (!handle) {
            return;
        }
        const direction = toolbarResizeDirections.find((item) => handle.classList.contains(`resize__${item}`))!;
        const startRect = element.getBoundingClientRect();
        const pointerId = event.pointerId;
        const startX = event.clientX;
        const startY = event.clientY;
        let moved = false;
        const gesture = new AbortController();

        endGesture?.();
        const finish = () => {
            if (endGesture !== finish) {
                return;
            }
            endGesture = undefined;
            gesture.abort();
            element.style.userSelect = "";
            if (moved && !protyle.requestSignal.aborted) {
                pinToolbar();
                hideElements(["gutter"], protyle);
            }
        };
        endGesture = finish;
        element.style.userSelect = "none";
        event.preventDefault();

        document.addEventListener("pointermove", (moveEvent) => {
            if (moveEvent.pointerId !== pointerId) {
                return;
            }
            moved = true;
            const deltaX = moveEvent.clientX - startX;
            const deltaY = moveEvent.clientY - startY;
            const viewportWidth = document.documentElement.clientWidth;
            const viewportHeight = document.documentElement.clientHeight;

            if (direction === "move") {
                positionElementInViewport(element, startRect.left + deltaX, startRect.top + deltaY);
                return;
            }

            const startRight = startRect.right;
            const startBottom = startRect.bottom;
            if (direction.includes("l")) {
                const left = Math.max(0, Math.min(startRect.left + deltaX, startRight - 200));
                element.style.left = `${left}px`;
                element.style.width = `${startRight - left}px`;
                element.style.maxWidth = "none";
            } else if (direction.includes("r")) {
                const width = Math.max(200, Math.min(startRect.width + deltaX, viewportWidth - startRect.left));
                element.style.width = `${width}px`;
                element.style.maxWidth = "none";
            }
            if (direction.includes("t")) {
                const top = Math.max(0, Math.min(startRect.top + deltaY, startBottom - 160));
                element.style.top = `${top}px`;
                element.style.height = `${startBottom - top}px`;
                element.style.maxHeight = "";
            } else if (direction.includes("d")) {
                const height = Math.max(160, Math.min(startRect.height + deltaY, viewportHeight - startRect.top));
                element.style.height = `${height}px`;
                element.style.maxHeight = "";
            }
        }, {signal: gesture.signal});
        const finishPointer = (endEvent: PointerEvent) => {
            if (endEvent.pointerId === pointerId) {
                finish();
            }
        };
        document.addEventListener("pointerup", finishPointer, {signal: gesture.signal});
        document.addEventListener("pointercancel", finishPointer, {signal: gesture.signal});
    }, {signal: protyle.requestSignal});
    protyle.requestSignal.addEventListener("abort", () => endGesture?.(), {once: true});
};

export const initUI = (protyle: IProtyle) => {
    protyle.contentElement = document.createElement("div");
    protyle.contentElement.className = "protyle-content";

    if (protyle.options.render.background || protyle.options.render.title) {
        protyle.contentElement.innerHTML = '<div class="protyle-top"></div>';
        if (protyle.options.render.background) {
            protyle.contentElement.firstElementChild.appendChild(protyle.background.element);
        }
        if (protyle.options.render.title) {
            protyle.contentElement.firstElementChild.appendChild(protyle.title.element);
        }
    }

    protyle.contentElement.appendChild(protyle.wysiwyg.element);
    if (!protyle.options.action.includes(Constants.CB_GET_HISTORY)) {
        scrollEvent(protyle, protyle.contentElement);
    }
    protyle.element.append(protyle.contentElement);
    protyle.element.appendChild(protyle.preview.element);
    if (protyle.upload) {
        protyle.element.appendChild(protyle.upload.element);
    }
    if (protyle.options.render.scroll) {
        protyle.element.appendChild(protyle.scroll.element.parentElement);
    }
    if (protyle.gutter) {
        protyle.element.appendChild(protyle.gutter.element);
    }

    protyle.element.appendChild(protyle.hint.element);

    protyle.selectElement = document.createElement("div");
    protyle.selectElement.className = "protyle-select fn__none";
    protyle.element.appendChild(protyle.selectElement);

    protyle.element.appendChild(protyle.toolbar.element);
    protyle.element.appendChild(protyle.toolbar.subElement);
    enableToolbarMoveResize(protyle);

    protyle.element.append(protyle.highlight.styleElement);

    addLoading(protyle);

    setEditMode(protyle, protyle.options.mode);
    document.execCommand("DefaultParagraphSeparator", false, "p");

    let wheelTimeout: number;
    const isMacOS = isMac();
    const applyFontSize = (fontSize: number) => {
        document.documentElement.style.setProperty("--b3-font-size-editor", `${fontSize}px`);
        protyle.settings.editor.setFontSize(fontSize);
    };
    const persistFontSize = () => {
        const persistence = protyle.settings.editor.persist();
        if (persistence) {
            void persistence.catch((error) => {
                console.error("[protyle.settings] editor font size persistence failed", error);
            });
        }
    };
    protyle.requestSignal.addEventListener("abort", () => {
        clearTimeout(wheelTimeout);
    }, {once: true});
    protyle.contentElement.addEventListener("mousewheel", (event: WheelEvent) => {
        if (!protyle.settings.editor.fontSizeScrollZoom || (isMacOS && !event.metaKey) ||
            (!isMacOS && !event.ctrlKey) || event.deltaX !== 0) {
            return;
        }
        event.stopPropagation();
        let fontSize = protyle.settings.editor.fontSize;
        if (event.deltaY < 0) {
            if (fontSize < 72) {
                fontSize++;
            } else {
                return;
            }
        } else if (event.deltaY > 0) {
            if (fontSize > 9) {
                fontSize--;
            } else {
                return;
            }
        }
        applyFontSize(fontSize);
        clearTimeout(wheelTimeout);
        wheelTimeout = window.setTimeout(() => {
            persistFontSize();
            protyle.wysiwyg.element.querySelectorAll(".code-block .protyle-linenumber__rows").forEach((block: HTMLElement) => {
                lineNumberRender(block.parentElement, protyle);
            });
            protyle.host.dispatch({
                type: "notify",
                level: "info",
                message: `${protyle.localization.text("fontSize")} ${fontSize}px`,
            });
        }, Constants.TIMEOUT_LOAD);
    }, {passive: true, signal: protyle.requestSignal});
    protyle.contentElement.addEventListener("click", (event: MouseEvent & { target: HTMLElement }) => {
        hideElements(["hint", "util"], protyle);
        // wysiwyg 元素下方点击无效果 https://github.com/siyuan-note/siyuan/issues/12009
        if (protyle.disabled ||
            // 选中块时，禁止添加空块 https://github.com/siyuan-note/siyuan/issues/13905
            protyle.contentElement.querySelector(".protyle-wysiwyg--select") ||
            (!event.target.classList.contains("protyle-content") && !event.target.classList.contains("protyle-wysiwyg"))) {
            return;
        }
        // https://github.com/siyuan-note/siyuan/issues/14190 选中最后一个块末尾点击底部时，range 会有值，需使用 setTimeout，最新测试无需 setTimeout 了，且会影响移动端键盘弹起故移除
        // 选中文本禁止添加空块 https://github.com/siyuan-note/siyuan/issues/13905
        if (window.getSelection().rangeCount > 0) {
            const currentRange = window.getSelection().getRangeAt(0);
            if (currentRange.toString() !== "" && protyle.wysiwyg.element.contains(currentRange.startContainer)) {
                return;
            }
        }
        const lastElement = protyle.wysiwyg.element.lastElementChild;
        const lastRect = lastElement.getBoundingClientRect();
        const range = document.createRange();
        if (event.y > lastRect.bottom) {
            const lastEditElement = getContenteditableElement(getLastBlock(lastElement));
            if (!protyle.options.click.preventInsetEmptyBlock && (
                !lastEditElement ||
                (lastElement.getAttribute("data-type") !== "NodeParagraph" && protyle.wysiwyg.element.getAttribute("data-doc-type") !== "NodeListItem") ||
                (lastElement.getAttribute("data-type") === "NodeParagraph" && getContenteditableElement(lastEditElement).innerHTML !== ""))
            ) {
                let emptyElement: Element;
                if (lastElement.getAttribute("data-type") === "NodeHeading" && lastElement.getAttribute("fold") === "1") {
                    emptyElement = genHeadingElement(lastElement) as Element;
                } else {
                    emptyElement = genEmptyElement(protyle, false, false);
                }
                protyle.wysiwyg.element.insertAdjacentElement("beforeend", emptyElement);
                transaction(protyle, [{
                    action: "insert",
                    data: emptyElement.outerHTML,
                    id: emptyElement.getAttribute("data-node-id"),
                    previousID: emptyElement.previousElementSibling.getAttribute("data-node-id"),
                    parentID: protyle.block.parentID
                }], [{
                    action: "delete",
                    id: emptyElement.getAttribute("data-node-id")
                }]);
                const emptyEditElement = getContenteditableElement(emptyElement) as HTMLInputElement;
                range.selectNodeContents(emptyEditElement);
                range.collapse(true);
                focusByRange(range);
                // 需等待 range 更新再次进行渲染
                if (protyle.options.render.breadcrumb) {
                    setTimeout(() => {
                        protyle.breadcrumb.render(protyle);
                    }, Constants.TIMEOUT_TRANSITION);
                }
            } else if (lastEditElement) {
                range.selectNodeContents(lastEditElement);
                range.collapse(false);
                focusByRange(range);
            }
            protyle.toolbar.range = range;
        }
    }, {signal: protyle.requestSignal});
    let overAttr = false;
    protyle.uiEventController = new AbortController();
    protyle.element.addEventListener("mouseover", (event: KeyboardEvent & {
        target: HTMLElement
    }) => {
        // attr
        const attrElement = hasClosestByClassName(event.target, "protyle-attr");
        if (attrElement && !attrElement.parentElement.classList.contains("protyle-title")) {
            const hlElement = protyle.wysiwyg.element.querySelector(".protyle-wysiwyg--hl");
            if (hlElement) {
                hlElement.classList.remove("protyle-wysiwyg--hl");
            }
            overAttr = true;
            attrElement.parentElement.classList.add("protyle-wysiwyg--hl");
            return;
        } else if (overAttr) {
            const hlElement = protyle.wysiwyg.element.querySelector(".protyle-wysiwyg--hl");
            if (hlElement) {
                hlElement.classList.remove("protyle-wysiwyg--hl");
            }
            overAttr = false;
        }

        const nodeElement = hasClosestBlock(event.target);
        if (protyle.options.render.gutter && nodeElement) {
            if (nodeElement && (nodeElement.classList.contains("list") || nodeElement.classList.contains("li"))) {
                // 光标在列表下部应显示右侧的元素，而不是列表本身。放在 windowEvent 中的 mousemove 下处理
                return;
            }
            const embedElement = isInEmbedBlock(nodeElement);
            if (embedElement) {
                protyle.gutter.render(protyle, embedElement);
                return;
            }
            protyle.gutter.render(protyle, nodeElement, event.target);
            return;
        }

        // gutter
        const buttonElement = hasClosestByTag(event.target, "BUTTON");
        if (buttonElement && buttonElement.parentElement.classList.contains("protyle-gutters")) {
            const type = buttonElement.getAttribute("data-type");
            if (type === "fold" || type === "NodeAttributeViewRow") {
                Array.from(protyle.wysiwyg.element.querySelectorAll(".protyle-wysiwyg--hl, .av__row--hl")).forEach(item => {
                    item.classList.remove("protyle-wysiwyg--hl", "av__row--hl");
                });
                return;
            }
            Array.from(protyle.wysiwyg.element.querySelectorAll(`[data-node-id="${buttonElement.getAttribute("data-node-id")}"]`)).find(item => {
                if (!isInEmbedBlock(item) && protyle.gutter.isMatchNode(item)) {
                    const bodyQueryClass = (buttonElement.dataset.groupId && buttonElement.dataset.groupId !== "undefined") ? `.av__body[data-group-id="${buttonElement.dataset.groupId}"] ` : "";
                    const rowItem = item.querySelector(bodyQueryClass + `.av__row[data-id="${buttonElement.dataset.rowId}"]`);
                    Array.from(protyle.wysiwyg.element.querySelectorAll(".protyle-wysiwyg--hl, .av__row--hl")).forEach(hlItem => {
                        if (item !== hlItem) {
                            hlItem.classList.remove("protyle-wysiwyg--hl");
                        }
                        if (rowItem && rowItem !== hlItem) {
                            rowItem.classList.remove("av__row--hl");
                        }
                    });
                    if (type === "NodeAttributeViewRowMenu") {
                        rowItem.classList.add("av__row--hl");
                    } else {
                        item.classList.add("protyle-wysiwyg--hl");
                    }
                    return true;
                }
            });
            event.preventDefault();
            return;
        }

        // 面包屑
        if (protyle.selectElement.classList.contains("fn__none")) {
            const svgElement = hasClosestByAttribute(event.target, "data-node-id", null);
            if (svgElement && svgElement.parentElement.classList.contains("protyle-breadcrumb__bar")) {
                protyle.wysiwyg.element.querySelectorAll(".protyle-wysiwyg--hl").forEach(item => {
                    item.classList.remove("protyle-wysiwyg--hl");
                });
                const nodeElement = protyle.wysiwyg.element.querySelector(`[data-node-id="${svgElement.getAttribute("data-node-id")}"]`);
                if (nodeElement) {
                    nodeElement.classList.add("protyle-wysiwyg--hl");
                }
            }
        }
    }, {signal: protyle.uiEventController.signal});
};

export const addLoading = (protyle: IProtyle, msg?: string) => {
    protyle.element.removeAttribute("data-loading");
    setTimeout(() => {
        if (protyle.element.getAttribute("data-loading") !== "finished") {
            protyle.element.insertAdjacentHTML("beforeend", `<div style="background-color: var(--b3-theme-background);flex-direction: column;" class="fn__loading wysiwygLoading">
    <img width="48px" src="/stage/loading-pure.svg">
    <div style="color: var(--b3-theme-on-surface);margin-top: 8px;">${msg || ""}</div>
</div>`);
        }
    }, Constants.TIMEOUT_LOAD);
};

export const removeLoading = (protyle: IProtyle) => {
    protyle.element.setAttribute("data-loading", "finished");
    protyle.element.querySelectorAll(".wysiwygLoading").forEach(item => {
        item.remove();
    });
};

export const setPadding = (protyle: IProtyle) => {
    if (protyle.options.action.includes(Constants.CB_GET_HISTORY)) {
        return {
            width: 0,
            padding: 0
        };
    }
    const padding = getPadding(protyle);
    const paddingLeft = padding.left;
    const paddingRight = padding.right;

    if (protyle.options.backlinkData) {
        protyle.wysiwyg.element.style.padding = `4px ${paddingRight}px 4px ${paddingLeft}px`;
    } else {
        protyle.wysiwyg.element.style.padding = `${padding.top}px ${paddingRight}px ${padding.bottom}px ${paddingLeft}px`;
    }
    if (protyle.options.render.background) {
        protyle.background.element.querySelector(".protyle-background__ia").setAttribute("style", `margin-left:${paddingLeft}px;margin-right:${paddingRight}px`);
    }
    if (protyle.options.render.title) {
        // pc 端 文档名 attr 过长和添加标签等按钮重合
        protyle.title.element.style.margin = `16px ${paddingRight}px 0 ${paddingLeft}px`;
    }

    // https://github.com/siyuan-note/siyuan/issues/15021
    protyle.element.style.setProperty("--b3-width-protyle", protyle.element.clientWidth + "px");
    protyle.element.style.setProperty("--b3-width-protyle-content", protyle.contentElement.clientWidth + "px");
    const realWidth = protyle.wysiwyg.element.getAttribute("data-realwidth");
    const newWidth = protyle.wysiwyg.element.clientWidth - paddingLeft - paddingRight;
    protyle.wysiwyg.element.setAttribute("data-realwidth", newWidth.toString());
    protyle.element.style.setProperty("--b3-width-protyle-wysiwyg", newWidth.toString() + "px");
    return {
        width: realWidth ? Math.abs(parseFloat(realWidth) - newWidth) : 0,
    };
};

export const getPadding = (protyle: IProtyle) => {
    let right = 16;
    let left = 24;
    let bottom = 16;
    if (protyle.options.typewriterMode) {
        bottom = protyle.element.clientHeight / 2;
    }
    if (!isNarrowViewport()) {
        let isFullWidth = protyle.wysiwyg.element.getAttribute(Constants.CUSTOM_SY_FULLWIDTH);
        if (!isFullWidth) {
            isFullWidth = protyle.settings.editor.fullWidth ? "true" : "false";
        }
        let padding = (protyle.element.clientWidth - Constants.SIZE_EDITOR_WIDTH) / 2;
        if (isFullWidth === "false" && padding > 96) {
            if (padding > Constants.SIZE_EDITOR_WIDTH) {
                // 超宽屏调整 https://ld246.com/article/1668266637363
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
    return {
        left, right, bottom, top: 16
    };
};
