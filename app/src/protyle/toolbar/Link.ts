import {ToolbarItem} from "./ToolbarItem";
import {hasClosestBlock, hasClosestByAttribute} from "../util/hasClosest";
import {Constants} from "../../constants";
import {genLinkText, resolveLinkDest} from "./config";
import {readClipboard, writeText} from "../util/clipboard";
import {setToolbarPosition} from "./position";
import {focusByRange, getSelectionPosition} from "../util/selection";
import * as dayjs from "dayjs";

type ToolbarTextKey = Parameters<IProtyle["localization"]["text"]>[0];

const text = (protyle: IProtyle, key: ToolbarTextKey) => protyle.localization.text(key);

const closeToolbarOverlay = (protyle: IProtyle) => {
    protyle.toolbar.subElementCloseCB?.();
    protyle.toolbar.subElementCloseCB = undefined;
    protyle.toolbar.subElement.classList.add("fn__none");
};

/**
 * Link editing is an editor-owned overlay. It deliberately does not use the
 * legacy global Menu singleton: the bound Runtime owns the overlay lifecycle,
 * while the editor owns the link transaction and selection restoration.
 */
export const openLinkEditor = (protyle: IProtyle, linkElement: HTMLElement, focusText = false) => {
    const nodeElement = hasClosestBlock(linkElement);
    if (!nodeElement) {
        return;
    }
    closeToolbarOverlay(protyle);
    protyle.toolbar.element.classList.add("fn__none");
    protyle.hint?.element.classList.add("fn__none");
    const oldHTML = nodeElement.outerHTML;
    const linkAddress = linkElement.getAttribute("data-href") || "";
    const anchor = linkElement.textContent?.replace(Constants.ZWSP, "") || "";
    const title = Lute.UnEscapeHTMLStr(linkElement.getAttribute("data-title") || "");
    const panel = protyle.toolbar.subElement;
    panel.removeAttribute("style");
    panel.style.width = "min(420px, calc(100vw - 16px))";
    panel.innerHTML = `<div class="fn__flex-column" style="padding:8px;gap:6px">
<label class="fn__flex-column"><span>${text(protyle, "link")}</span><textarea data-field="href" rows="1" spellcheck="false" class="b3-text-field"></textarea></label>
<label class="fn__flex-column"><span>${text(protyle, "text")}</span><textarea data-field="text" rows="1" spellcheck="false" class="b3-text-field"></textarea></label>
<label class="fn__flex-column"><span>${text(protyle, "title")}</span><textarea data-field="title" rows="1" spellcheck="false" class="b3-text-field"></textarea></label>
<div class="fn__flex"><button class="b3-button" data-action="copy">${text(protyle, "copy")}</button><span class="fn__flex-1"></span><button class="b3-button b3-button--remove" data-action="remove">${text(protyle, "remove")}</button></div>
</div>`;
    const hrefInput = panel.querySelector('[data-field="href"]') as HTMLTextAreaElement;
    const textInput = panel.querySelector('[data-field="text"]') as HTMLTextAreaElement;
    const titleInput = panel.querySelector('[data-field="title"]') as HTMLTextAreaElement;
    hrefInput.value = Lute.UnEscapeHTMLStr(linkAddress);
    textInput.value = anchor || (linkAddress ? genLinkText(linkAddress, true, true) : "");
    titleInput.value = title;

    const commit = () => {
        panel.onclick = null;
        const lineBreaks = /\r\n|\n|\r|\u2028|\u2029/g;
        const href = hrefInput.value.replace(lineBreaks, "");
        const nextText = textInput.value.replace(lineBreaks, "").trim();
        const nextTitle = titleInput.value.replace(lineBreaks, "");
        if (href) {
            linkElement.setAttribute("data-href", Lute.EscapeHTMLStr(href));
        } else {
            linkElement.removeAttribute("data-href");
        }
        if (nextTitle) {
            linkElement.setAttribute("data-title", Lute.EscapeHTMLStr(nextTitle));
        } else {
            linkElement.removeAttribute("data-title");
        }
        if (nextText) {
            linkElement.innerHTML = Lute.EscapeHTMLStr(nextText);
        } else if (href || nextTitle) {
            linkElement.textContent = "*";
        } else {
            linkElement.remove();
        }
        if (oldHTML !== nodeElement.outerHTML) {
            nodeElement.setAttribute("updated", dayjs().format("YYYYMMDDHHmmss"));
            protyle.getInstance().updateTransactionElement(nodeElement, oldHTML);
        }
        if (linkElement.parentElement) {
            protyle.toolbar.range.selectNodeContents(linkElement);
            protyle.toolbar.range.collapse(false);
            focusByRange(protyle.toolbar.range);
        }
    };
    panel.querySelectorAll("textarea").forEach((input) => {
        input.addEventListener("input", (event) => {
            event.stopPropagation();
            if (input === textInput) {
                linkElement.innerHTML = Lute.EscapeHTMLStr(textInput.value.trim() || "*");
            }
        });
        input.addEventListener("keydown", (event: KeyboardEvent) => {
            if (event.key === "Escape" || (event.key === "Enter" && !event.shiftKey)) {
                event.preventDefault();
                closeToolbarOverlay(protyle);
            }
            event.stopPropagation();
        });
    });
    panel.onclick = (event) => {
        const target = event.target as HTMLElement;
        const action = target.closest<HTMLElement>("[data-action]")?.dataset.action;
        if (action === "copy") {
            void writeText(hrefInput.value).then(() => {
                protyle.host.dispatch({type: "notify", level: "info", message: text(protyle, "copied")});
            }).catch((error) => console.error("[protyle.clipboard] link copy failed", error));
        } else if (action === "remove") {
            linkElement.remove();
            closeToolbarOverlay(protyle);
        }
        event.stopPropagation();
    };
    protyle.toolbar.subElementCloseCB = commit;
    protyle.toolbar.activateOverlay();
    panel.classList.remove("fn__none");
    const position = getSelectionPosition(nodeElement, protyle.toolbar.range);
    setToolbarPosition(panel, position.left, position.top + 26, 26);
    (focusText ? textInput : hrefInput).select();
};

export class Link extends ToolbarItem {
    public element: HTMLElement;

    constructor(protyle: IProtyle, menuItem: IMenuItem) {
        super(protyle, menuItem);
        // 不能用 getEventName，否则会导致光标位置变动到点击的文档中
        this.element.addEventListener("click", async (event: MouseEvent & { changedTouches: MouseEvent[] }) => {
            protyle.toolbar.element.classList.add("fn__none");
            event.stopPropagation();

            const range = protyle.toolbar.range;
            const nodeElement = hasClosestBlock(range.startContainer);
            if (!nodeElement) {
                return;
            }
            const aElement = hasClosestByAttribute(range.startContainer, "data-type", "a");
            if (aElement) {
                openLinkEditor(protyle, aElement);
                return;
            }

            let dataHref = "";
            let dataText = range.toString().trim().replace(Constants.ZWSP, "");
            let showMenu = false;
            try {
                // 选中链接时需忽略剪切板内容 https://ld246.com/article/1643035329737
                dataHref = protyle.lute.GetLinkDest(dataText);
                if (!dataHref) {
                    const clipObject = await readClipboard();
                    const html = clipObject.textHTML || protyle.lute.Md2BlockDOM(clipObject.textPlain);
                    if (html) {
                        const tempElement = document.createElement("template");
                        tempElement.innerHTML = html;
                        const linkElement = tempElement.content.querySelector('span[data-type~="a"], a');
                        if (linkElement) {
                            dataText = dataText || linkElement.textContent;
                            dataHref = linkElement.getAttribute("data-href") || linkElement.getAttribute("href");
                        }
                    }
                    if (!dataHref) {
                        dataHref = resolveLinkDest(clipObject.textPlain, protyle.lute);
                    }
                    if (!dataHref) {
                        // 360
                        const lastSpace = clipObject.textPlain.lastIndexOf(" ");
                        if (lastSpace > -1) {
                            dataHref = protyle.lute.GetLinkDest(clipObject.textPlain.substring(lastSpace));
                            if (dataHref && !dataText) {
                                dataText = clipObject.textPlain.substring(0, lastSpace);
                            }
                        }
                    }
                    // https://github.com/siyuan-note/siyuan/issues/14704#issuecomment-2867555769 第一点 & https://github.com/siyuan-note/siyuan/issues/6798
                    if (dataHref && !dataText) {
                        dataText = genLinkText(dataHref, true, true);
                        showMenu = true;
                    }
                }
            } catch (e) {
                console.log(e);
            }
            const linkElements = protyle.toolbar.setInlineMark(protyle, "a", "range", {
                type: "a",
                color: dataHref + (dataText ? Constants.ZWSP + dataText : "")
            });
            if (showMenu) {
                openLinkEditor(protyle, linkElements[0] as HTMLElement, true);
            }
        });
    }
}
