import {Constants} from "../../constants";
import {onGet} from "../util/onGet";
import {hasClosestBlock, hasClosestByClassName} from "../util/hasClosest";
import {stickyRow} from "../render/av/row";
import {trimAVRowsSync} from "../render/av/virtualScroll";
import {isIPhone, isNarrowViewport} from "../util/browserPlatform";
import {beginProtyleContentLoad, requestProtyleContent} from "../util/contentLoad";

export const scrollEvent = (protyle: IProtyle, element: HTMLElement) => {
    let getIndexTimeout: number;
    let dragActive = false;
    const avScrollPending = new WeakSet<HTMLElement>();
    const signal = protyle.requestSignal;
    const endDrag = () => {
        dragActive = false;
    };
    protyle.element.addEventListener("dragstart", () => {
        dragActive = true;
    }, {capture: true, signal});
    protyle.element.addEventListener("dragend", endDrag, {capture: true, signal});
    protyle.element.addEventListener("drop", endDrag, {capture: true, signal});
    signal.addEventListener("abort", () => {
        clearTimeout(getIndexTimeout);
    }, {once: true});

    const hideGutter = () => {
        if (protyle.gutter && !isIPhone()) {
            protyle.gutter.element.classList.add("fn__none");
            protyle.gutter.element.innerHTML = "";
        }
    };

    const loadDynamicPage = (
        id: string,
        mode: 1 | 2,
        action: TProtyleAction,
        freezeWidth: boolean,
    ) => {
        const load = beginProtyleContentLoad(protyle);
        const restoreLayout = () => {
            protyle.wysiwyg.element.removeAttribute("data-top");
            if (freezeWidth) {
                protyle.contentElement.style.overflow = "";
                protyle.contentElement.style.width = "";
            }
        };
        load.signal.addEventListener("abort", restoreLayout, {once: true});
        if (freezeWidth) {
            // 禁用滚动时会产生抖动 https://ld246.com/article/1666717094418
            protyle.contentElement.style.width = protyle.contentElement.offsetWidth + "px";
            protyle.contentElement.style.overflow = "hidden";
        }
        protyle.wysiwyg.element.setAttribute("data-top", element.scrollTop.toString());
        void requestProtyleContent<IWebSocketData>(protyle, "/api/filetree/getDoc", {
            id,
            mode,
            size: protyle.settings.editor.dynamicLoadBlocks,
        }, load).then((response) => {
            if (!load.isCurrent()) {
                return;
            }
            load.signal.removeEventListener("abort", restoreLayout);
            restoreLayout();
            onGet({
                data: response,
                protyle,
                action: [action, Constants.CB_GET_UNCHANGEID],
                load,
            });
        }).catch((error) => {
            load.signal.removeEventListener("abort", restoreLayout);
            if (!load.isCurrent()) {
                return;
            }
            restoreLayout();
            console.error("[protyle.transport] dynamic page load failed", error);
        });
    };

    element.addEventListener("scroll", () => {
        if (signal.aborted) {
            return;
        }
        const elementRect = element.getBoundingClientRect();
        if (!protyle.toolbar.element.classList.contains("fn__none")) {
            const initY = protyle.toolbar.element.getAttribute("data-inity").split(Constants.ZWSP);
            const top = parseInt(initY[0]) + (parseInt(initY[1]) - element.scrollTop);
            if (top < elementRect.top - protyle.toolbar.toolbarHeight || top > elementRect.bottom - protyle.toolbar.toolbarHeight) {
                protyle.toolbar.element.style.display = "none";
            } else {
                protyle.toolbar.element.style.top = top + "px";
                protyle.toolbar.element.style.display = "";
            }
        }

        protyle.wysiwyg.element.querySelectorAll(".av").forEach((item: HTMLElement) => {
            if (item.dataset.render !== "true") {
                return;
            }
            // stickyRow 与 trimAVRows 合并到每块每帧一个 rAF：先 stickyRow（读布局为主），
            // 再 trimAVRowsSync（增删行）。合并避免两个独立 rAF 跨回调读写交错触发重排；
            // 先读后写避免 trim 的 DOM 写入让 sticky 的几何读取成为强制重排。
            if (avScrollPending.has(item)) {
                return;
            }
            avScrollPending.add(item);
            requestAnimationFrame(() => {
                avScrollPending.delete(item);
                if (signal.aborted || !item.isConnected) {
                    return;
                }
                stickyRow(item, element, "all");
                trimAVRowsSync(item, elementRect);
            });
        });

        if (!protyle.element.classList.contains("block__edit") && !isNarrowViewport()) {
            protyle.contentElement.setAttribute("data-scrolltop", element.scrollTop.toString());
        }

        if (!dragActive) { // https://ld246.com/article/1649638389841
            hideGutter();
        }

        if (protyle.scroll && !protyle.scroll.element.classList.contains("fn__none")) {
            clearTimeout(getIndexTimeout);
            getIndexTimeout = window.setTimeout(() => {
                if (signal.aborted) {
                    return;
                }
                let targetElement = document.elementFromPoint(elementRect.left + elementRect.width / 2, elementRect.top + 10);
                if (targetElement.classList.contains("protyle-wysiwyg")) {
                    // 恰好定位到块的中间时
                    targetElement = document.elementFromPoint(elementRect.left + elementRect.width / 2, elementRect.top + 20);
                }
                const blockElement = hasClosestBlock(targetElement);
                if (!blockElement) {
                    if ((protyle.wysiwyg.element.firstElementChild.getAttribute("data-eof") === "1" ||
                            // goHome 时 data-eof 不为 1
                            protyle.wysiwyg.element.firstElementChild.getAttribute("data-node-index") === "0") &&
                        (hasClosestByClassName(targetElement, "protyle-background") || hasClosestByClassName(targetElement, "protyle-title"))) {
                        const inputElement = protyle.scroll.element.querySelector(".b3-slider") as HTMLInputElement;
                        inputElement.value = "1";
                        protyle.scroll.element.setAttribute("aria-label", `Blocks 1/${protyle.block.blockCount}`);
                    }
                    return;
                }
                protyle.scroll.updateIndex(protyle, blockElement.getAttribute("data-node-id"));
            }, Constants.TIMEOUT_LOAD);
        }

        if (protyle.wysiwyg.element.getAttribute("data-top") || protyle.block.showAll ||
            (protyle.scroll && protyle.scroll.element.classList.contains("fn__none")) || !protyle.scroll ||
            protyle.scroll.lastScrollTop === element.scrollTop || protyle.scroll.lastScrollTop === -1 ||
            // 移动端跳转的时候会设置 wysiwyg.element.innerHTML = "";
            !protyle.wysiwyg.element.firstElementChild) {
            return;
        }
        if (protyle.scroll.lastScrollTop > element.scrollTop) {
            if (element.scrollTop === 0) {
                // 使用鼠标拖拽滚动条中无法准确获取 scrollTop，在此忽略
                return;
            }
            if (element.scrollTop < element.clientHeight &&
                protyle.wysiwyg.element.firstElementChild.getAttribute("data-eof") !== "1") {
                loadDynamicPage(
                    protyle.wysiwyg.element.firstElementChild.getAttribute("data-node-id"),
                    1,
                    Constants.CB_GET_BEFORE,
                    true,
                );
            }
        } else if ((element.scrollTop > element.scrollHeight - element.clientHeight * 1.8) &&
            protyle.wysiwyg.element.lastElementChild &&
            protyle.wysiwyg.element.lastElementChild.getAttribute("data-eof") !== "2") {
            if (protyle.scroll.lastScrollTop > 768 && element.scrollTop > protyle.scroll.lastScrollTop * 2) {
                // 使用鼠标拖拽滚动条时导致加载需进行矫正
                element.scrollTop = protyle.scroll.lastScrollTop;
                return;
            }
            loadDynamicPage(
                protyle.wysiwyg.element.lastElementChild.getAttribute("data-node-id"),
                2,
                Constants.CB_GET_APPEND,
                false,
            );
        }
        protyle.scroll.lastScrollTop = Math.max(element.scrollTop, 0);
    }, {
        capture: false,
        passive: true,
        once: false,
        signal,
    });
};
