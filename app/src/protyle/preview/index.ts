import {writeText} from "../util/clipboard";
import {focusByRange} from "../util/selection";
import {previewDocImage} from "./image";
import {getDiagramBlock, previewDiagram} from "./diagram";
import {Constants} from "../../constants";
import {processRender} from "../util/processCode";
import {highlightRender} from "../render/highlightRender";
import {speechRender} from "../render/speechRender";
import {avRender} from "../render/av/render";
import {getPadding} from "../ui/initUI";
import {hasTopClosestByAttribute} from "../util/hasClosest";
import {addScriptSync} from "../util/addScript";
import {combineAbortSignals} from "../util/abortSignal";

const assetExtension = (path: string) => {
    const fileName = path.substring(path.lastIndexOf("/") + 1);
    const extensionIndex = fileName.lastIndexOf(".");
    return extensionIndex < 0 ? "" : fileName.substring(extensionIndex).toLowerCase();
};

const isSpaceAssetPath = (path: string) => path.trim().toLowerCase().startsWith("assets/");

const notifySuccess = (protyle: IProtyle, message: string) => {
    protyle.host.dispatch({type: "notify", level: "success", message});
};

export class Preview {
    public element: HTMLElement;
    public previewElement: HTMLElement;
    private renderController?: AbortController;
    private renderGeneration = 0;

    constructor(protyle: IProtyle) {
        this.element = document.createElement("div");
        this.element.className = "protyle-preview fn__none";

        const previewElement = document.createElement("div");
        previewElement.className = "b3-typography";
        if (protyle.options.classes.preview) {
            previewElement.classList.add(protyle.options.classes.preview);
        }
        const actions = protyle.options.preview.actions;
        const actionElement = document.createElement("div");
        actionElement.className = "protyle-preview__action";
        const actionHtml: string[] = [];
        const text = protyle.localization.text;
        for (let i = 0; i < actions.length; i++) {
            const action = actions[i];
            if (typeof action === "object") {
                actionHtml.push(`<button type="button" data-type="${action.key}" class="${action.className}">${action.text}</button>`);
                continue;
            }
            switch (action) {
                case "desktop":
                    actionHtml.push(`<button type="button" class="protyle-preview__action--current" data-type="desktop">${text("desktop")}</button>`);
                    break;
                case "tablet":
                    actionHtml.push(`<button type="button" data-type="tablet">${text("tablet")}</button>`);
                    break;
                case "mobile":
                    actionHtml.push(`<button type="button" data-type="mobile">${text("mobile")}</button>`);
                    break;
                case "mp-wechat":
                    actionHtml.push(`<button type="button" data-type="mp-wechat" class="b3-tooltips b3-tooltips__w" aria-label="${text("copyToWechatMP")}"><svg><use xlink:href="#iconMp"></use></svg></button>`);
                    break;
                case "zhihu":
                    actionHtml.push(`<button type="button" data-type="zhihu" class="b3-tooltips b3-tooltips__w" aria-label="${text("copyToZhihu")}"><svg><use xlink:href="#iconZhihu"></use></svg></button>`);
                    break;
                case "yuque":
                    actionHtml.push(`<button type="button" data-type="yuque" class="b3-tooltips b3-tooltips__w" aria-label="${text("copyToYuque")}"><svg><use xlink:href="#iconYuque"></use></svg></button>`);
                    break;
            }
        }
        actionElement.innerHTML = actionHtml.join("");
        this.element.appendChild(actionElement);
        this.element.appendChild(previewElement);

        this.element.addEventListener("click", (event) => {
            let target = event.target as HTMLElement;
            while (target && !target.isEqualNode(this.element)) {
                if (target.tagName === "A") {
                    const linkAddress = target.getAttribute("href")!;
                    if (linkAddress.startsWith("#")) {
                        // 导出预览模式点击块引转换后的脚注跳转不正确 https://github.com/siyuan-note/siyuan/issues/5700
                        const hash = linkAddress.substring(1);
                        previewElement.querySelector('[data-node-id="' + hash + '"], [id="' + hash + '"]').scrollIntoView();
                        event.stopPropagation();
                        event.preventDefault();
                        break;
                    }

                    event.stopPropagation();
                    event.preventDefault();
                    const assetPath = linkAddress.split("?page")[0];
                    if (isSpaceAssetPath(linkAddress) && Constants.SIYUAN_ASSETS_EXTS.includes(assetExtension(assetPath))) {
                        const page = new URL(linkAddress, window.location.href).searchParams.get("page");
                        protyle.host.dispatch({
                            type: "open-asset",
                            documentId: protyle.block.rootID,
                            notebookId: protyle.notebookId,
                            assetPath,
                            page: page ? parseInt(page) : undefined,
                            disposition: "current",
                        });
                    } else {
                        protyle.host.dispatch({type: "open-external", url: linkAddress});
                    }
                    break;
                } else if (target.tagName === "IMG") {
                    previewDocImage((event.target as HTMLElement).getAttribute("src")!, protyle);
                    event.stopPropagation();
                    event.preventDefault();
                    break;
                } else if (target.tagName === "BUTTON") {
                    const type = target.getAttribute("data-type");
                    const actionCustom = actions.find((w: IPreviewActionCustom) => w?.key === type) as IPreviewActionCustom;
                    if (actionCustom) {
                        actionCustom.click(type);
                    } else if ((type === "mp-wechat" || type === "zhihu" || type === "yuque")) {
                        const tempElement = document.createElement("div");
                        tempElement.appendChild(this.element.lastElementChild.cloneNode(true));
                        this.copyToX(tempElement, protyle, type);
                    } else if (type === "desktop") {
                        previewElement.style.width = "";
                        previewElement.style.padding = protyle.wysiwyg.element.style.padding;
                    } else if (type === "tablet") {
                        previewElement.style.width = "1024px";
                        previewElement.style.padding = "8px 16px";
                    } else {
                        previewElement.style.width = "360px";
                        previewElement.style.padding = "8px";
                    }
                    if (type !== "mp-wechat" && type !== "zhihu" && type !== "yuque") {
                        actionElement.querySelectorAll("button").forEach((item) => {
                            item.classList.remove("protyle-preview__action--current");
                        });
                        target.classList.add("protyle-preview__action--current");
                    }
                }
                target = target.parentElement;
            }
            const nodeElement = hasTopClosestByAttribute(event.target as HTMLElement, "id", undefined);
            if (nodeElement) {
                // 用于点击后大纲定位
                this.element.querySelectorAll(".protyle-wysiwyg--select").forEach(item => {
                    item.classList.remove("selected");
                });
                nodeElement.classList.add("selected");
                const diagramElement = getDiagramBlock(nodeElement);
                if (diagramElement) {
                    previewDiagram(diagramElement);
                    event.stopPropagation();
                    event.preventDefault();
                    return;
                }
            }
        });

        this.previewElement = previewElement;
    }

    public render(protyle: IProtyle) {
        this.renderController?.abort();
        this.renderController = new AbortController();
        const signal = combineAbortSignals([protyle.requestSignal, this.renderController.signal]);
        const generation = ++this.renderGeneration;
        if (this.element.style.display === "none") {
            return;
        }
        if (this.element.querySelector('.protyle-preview__action [data-type="desktop"]')?.classList.contains("protyle-preview__action--current")) {
            const padding = getPadding(protyle);
            this.previewElement.style.padding = `${padding.top}px ${padding.left}px ${padding.bottom}px ${padding.right}px`;
        }

        let loadingElement = this.element.querySelector(".fn__loading");
        if (!loadingElement) {
            this.element.insertAdjacentHTML("beforeend", `<div style="flex-direction: column;" class="fn__loading">
    <img width="48px" src="/stage/loading-pure.svg">
</div>`);
            loadingElement = this.element.querySelector(".fn__loading");
        }
        window.setTimeout(() => {
            if (protyle.destroyed || signal.aborted || generation !== this.renderGeneration) {
                return;
            }
            void protyle.transport!.request<IWebSocketData>("/api/export/preview", {
                id: protyle.block.id || protyle.options.blockId || protyle.block.parentID,
                notebook: protyle.notebookId,
            }, {
                identity: {
                    documentId: protyle.options.blockId!,
                    notebookId: protyle.notebookId,
                },
                intent: "read",
                signal,
            }).then((response) => {
                if (protyle.destroyed || signal.aborted || generation !== this.renderGeneration) {
                    return;
                }
                const oldScrollTop = protyle.preview.previewElement.scrollTop;
                protyle.preview.previewElement.innerHTML = response.data.html;
                processRender(protyle.preview.previewElement, protyle);
                highlightRender(protyle.preview.previewElement, protyle);
                avRender(protyle.preview.previewElement, protyle);
                speechRender(protyle.preview.previewElement, protyle.localization.language);
                protyle.preview.previewElement.scrollTop = oldScrollTop;
                loadingElement.remove();
            }).catch((error) => {
                if (!signal.aborted && generation === this.renderGeneration) {
                    console.error("[protyle.transport] document preview failed", error);
                    loadingElement.remove();
                }
            });
        }, protyle.options.preview.delay);
    }

    private link2online(copyElement: HTMLElement, protyle: IProtyle) {
        const identity = {
            documentId: protyle.options.blockId!,
            notebookId: protyle.notebookId,
        };
        copyElement.querySelectorAll("[href],[src]").forEach(item => {
            const oldLink = item.getAttribute("href") || item.getAttribute("src");
            if (oldLink && oldLink.startsWith("assets/")) {
                const newLink = protyle.runtime!.resources.resolveAsset(identity, oldLink);
                if (item.getAttribute("href")) {
                    item.setAttribute("href", newLink);
                } else {
                    item.setAttribute("src", newLink);
                }
            }
        });
    }

    private async copyToX(copyElement: HTMLElement, protyle: IProtyle, type?: string) {
        // fix math render
        if (type === "mp-wechat") {
            this.link2online(copyElement, protyle);
            copyElement.querySelectorAll(".katex-html .base").forEach((item: HTMLElement) => {
                item.style.display = "initial";
            });
            copyElement.querySelectorAll("mjx-container > svg").forEach((item) => {
                item.setAttribute("width", (parseInt(item.getAttribute("width")) * 8) + "px");
            });
            // 列表嵌套 https://github.com/siyuan-note/siyuan/issues/11276
            copyElement.querySelectorAll("ul, ol").forEach((listItem: HTMLOListElement) => {
                if (typeof listItem.start === "number") {
                    listItem.classList.add("list-paddingleft-" + Math.min(listItem.start.toString().length, 3));
                    listItem.style.listStyleType = "decimal";
                }
                Array.from(listItem.children).forEach(liItem => {
                    const nestedList = liItem.querySelector("ul, ol");
                    if (nestedList) {
                        liItem.parentNode.insertBefore(nestedList, liItem.nextSibling);
                    }
                });
            });
            // 处理任务列表（微信公众号不能显示input[type="checkbox"]）
            copyElement.querySelectorAll("li.protyle-task").forEach((taskItem: HTMLElement) => {
                const checkbox = taskItem.querySelector('input[type="checkbox"]') as HTMLInputElement;
                if (checkbox) {
                    checkbox.style.opacity = "0";
                    if (checkbox.checked) {
                        taskItem.style.setProperty("list-style-type", "'✅'", "important");
                    } else {
                        taskItem.style.setProperty("list-style-type", "'▢'", "important");
                    }
                }
            });
            if (typeof window.MathJax === "undefined") {
                window.MathJax = {
                    svg: {
                        fontCache: "none"
                    },
                };
            }
            await addScriptSync(`${Constants.PROTYLE_CDN}/js/mathjax/tex-svg-full.js`, "protyleMathJaxScript");
            if (protyle.requestSignal.aborted) {
                return;
            }
            await window.MathJax.startup.promise;
            if (protyle.requestSignal.aborted) {
                return;
            }
            copyElement.querySelectorAll('[data-subtype="math"]').forEach(mathElement => {
                const node = window.MathJax.tex2svg(Lute.UnEscapeHTMLStr(mathElement.getAttribute("data-content")).trim(), {display: mathElement.tagName === "DIV"});
                node.querySelector("mjx-assistive-mml").remove();
                mathElement.innerHTML = node.outerHTML;
            });
        } else if (type === "zhihu") {
            this.link2online(copyElement, protyle);
            copyElement.querySelectorAll('[data-subtype="math"]').forEach((item: HTMLElement) => {
                // https://github.com/siyuan-note/siyuan/issues/10015
                item.outerHTML = `<img class="Formula-image" data-eeimg="true" src="//www.zhihu.com/equation?tex=" alt="${item.getAttribute("data-content")}" style="${item.tagName === "DIV" ? "display: block; max-width: 100%;" : ""}margin: 0 auto;">`;
            });
            copyElement.querySelectorAll("blockquote").forEach((item) => {
                const elements: HTMLElement[] = [];
                this.processZHBlockquote(item, elements);
                elements.reverse().forEach(newItem => {
                    item.insertAdjacentElement("afterend", newItem);
                });
                item.remove();
            });
            this.processZHTable(copyElement);
        } else if (type === "yuque") {
            try {
                const response = await protyle.transport!.request<IWebSocketData>("/api/lute/copyStdMarkdown", {
                    id: protyle.block.id || protyle.options.blockId || protyle.block.parentID,
                    notebook: protyle.notebookId,
                    assetsDestSpace2Underscore: true,
                    fillCSSVar: true,
                    adjustHeadingLevel: true,
                }, {
                    identity: {
                        documentId: protyle.options.blockId!,
                        notebookId: protyle.notebookId,
                    },
                    intent: "read",
                    signal: protyle.requestSignal,
                });
                if (protyle.destroyed || protyle.requestSignal.aborted) {
                    return;
                }
                writeText(response.data);
                notifySuccess(protyle, protyle.localization.text("pasteToYuque"));
            } catch (error) {
                if (!protyle.requestSignal.aborted) {
                    console.error("[protyle.transport] standard Markdown copy failed", error);
                }
            }
            return;
        }

        // 防止背景色被粘贴到公众号中
        copyElement.style.backgroundColor = "#fff";
        // 代码背景
        copyElement.querySelectorAll("code").forEach((item) => {
            item.style.backgroundImage = "none";
        });
        const copyEditElement = copyElement.querySelector(".b3-typography") as HTMLElement;
        if (copyEditElement.firstElementChild.tagName === "DIV") {
            // 最后/第一个块是公式块时无法复制下来
            copyElement.insertAdjacentHTML("afterbegin", "<p>&zwj;</p>");
        }
        if (copyEditElement.lastElementChild.tagName === "DIV") {
            copyElement.insertAdjacentHTML("beforeend", "<p>&zwj;</p>");

        }
        this.element.append(copyElement);
        let cloneRange;
        if (getSelection().rangeCount > 0) {
            cloneRange = getSelection().getRangeAt(0).cloneRange();
        }
        const range = copyElement.ownerDocument.createRange();
        if (copyEditElement.firstElementChild.tagName === "DIV") {
            range.setStart(copyElement.firstElementChild, 0);
        } else {
            range.setStartBefore(copyElement.firstElementChild);
        }
        if (copyEditElement.lastElementChild.tagName === "DIV") {
            range.setEndBefore(copyElement.lastElementChild);
        } else {
            range.setEndAfter(copyElement.lastElementChild);
        }
        focusByRange(range);
        document.execCommand("copy");
        this.element.lastElementChild.remove();
        focusByRange(cloneRange);
        if (type) {
            notifySuccess(protyle, protyle.localization.text(type === "zhihu" ? "pasteToZhihu" : "pasteToWechatMP"));
        }
    }

    private processZHBlockquote(element: HTMLElement, elements: HTMLElement[]) {
        Array.from(element.children).forEach((item: HTMLElement) => {
            if (item.tagName === "BLOCKQUOTE") {
                this.processZHBlockquote(item, elements);
            } else if (item.tagName !== "P" || item.querySelector("img")) {
                elements.push(item);
            } else {
                const lastElement = elements[elements.length - 1];
                if (!lastElement || (lastElement && lastElement.tagName !== "BLOCKQUOTE")) {
                    elements.push(document.createElement("blockquote"));
                }
                elements[elements.length - 1].append(item);
            }
        });
    }

    private processZHTable(element: HTMLElement) {
        element.querySelectorAll("table").forEach(item => {
            const headElement = item.querySelector("thead");
            if (!headElement) {
                return;
            }
            const tbodyElement = item.querySelector("tbody");
            if (tbodyElement) {
                tbodyElement.insertAdjacentElement("afterbegin", headElement.firstElementChild);
            } else {
                item.innerHTML = `<tbody>${headElement.innerHTML}</tbody>`;
            }
            headElement.remove();
        });
    }
}
