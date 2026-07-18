import {addLoading, removeLoading} from "../ui/initUI";
import {getDocByScroll, saveScroll} from "../scroll/saveScroll";
import {renderBacklink} from "../wysiwyg/renderBacklink";
import {hasClosestByClassName} from "./hasClosest";
import {preventScroll} from "../scroll/preventScroll";
import {isSupportCSSHL, searchMarkRender} from "../render/searchMarkRender";
import {beginProtyleContentLoad, requestProtyleContent} from "./contentLoad";

export const reloadProtyle = (protyle: IProtyle, focus: boolean, updateReadonly?: boolean) => {
    const load = beginProtyleContentLoad(protyle);
    if (!protyle.preview.element.classList.contains("fn__none")) {
        protyle.preview.render(protyle);
        removeLoading(protyle);
        return;
    }
    if (protyle.settings.editor.displayBookmarkIcon) {
        protyle.wysiwyg.element.classList.add("protyle-wysiwyg--attr");
    } else {
        protyle.wysiwyg.element.classList.remove("protyle-wysiwyg--attr");
    }
    // RTL 切换时同步 .protyle 元素的 .rtl 类名
    if (protyle.settings.editor.rtl) {
        protyle.element.classList.add("rtl");
    } else {
        protyle.element.classList.remove("rtl");
    }
    if (protyle.title) {
        protyle.title.element.removeAttribute("data-render");
        protyle.title.element.setAttribute("spellcheck", protyle.settings.editor.spellcheck.toString());
        if (protyle.settings.editor.displayBookmarkIcon) {
            protyle.title.element.classList.add("protyle-wysiwyg--attr");
        } else {
            protyle.title.element.classList.remove("protyle-wysiwyg--attr");
        }
    }
    protyle.lute.SetProtyleMarkNetImg(protyle.settings.editor.displayNetImgMark);
    protyle.lute.SetSpellcheck(protyle.settings.editor.spellcheck);
    const markdown = protyle.settings.editor.markdown;
    protyle.lute.SetInlineAsterisk(markdown.inlineAsterisk);
    protyle.lute.SetGFMStrikethrough(markdown.inlineStrikethrough);
    protyle.lute.SetInlineMath(markdown.inlineMath);
    protyle.lute.SetSub(markdown.inlineSub);
    protyle.lute.SetSup(markdown.inlineSup);
    protyle.lute.SetTag(markdown.inlineTag);
    protyle.lute.SetInlineUnderscore(markdown.inlineUnderscore);
    protyle.lute.SetMark(markdown.inlineMark);
    protyle.lute.SetGFMStrikethrough1(false);
    addLoading(protyle);
    if (protyle.options.backlinkData) {
        const isMention = protyle.element.getAttribute("data-ismention") === "true";
        const tabElement = hasClosestByClassName(protyle.element, "sy__backlink");
        if (tabElement) {
            const inputsElement = tabElement.querySelectorAll(".b3-text-field") as NodeListOf<HTMLInputElement>;
            const keyword = isMention ? inputsElement[1].value : inputsElement[0].value;
            const params: IObject = {
                defID: protyle.element.getAttribute("data-defid"),
                refTreeID: protyle.block.rootID,
                highlight: !isSupportCSSHL(),
                keyword,
            };
            void requestProtyleContent<IWebSocketData>(
                protyle,
                isMention ? "/api/ref/getBackmentionDoc" : "/api/ref/getBacklinkDoc",
                params,
                load,
            ).then((response) => {
                if (!load.isCurrent()) {
                    return;
                }
                protyle.options.backlinkData = isMention ? response.data.backmentions : response.data.backlinks;
                renderBacklink(protyle, protyle.options.backlinkData);
                searchMarkRender(protyle, response.data.keywords);
            }).catch((error) => {
                if (load.isCurrent()) {
                    removeLoading(protyle);
                    console.error("[protyle.transport] backlink reload failed", error);
                }
            });
        }
    } else {
        preventScroll(protyle, 0, 1000, load.signal);
        getDocByScroll({
            protyle,
            focus,
            scrollAttr: saveScroll(protyle, true) as IScrollAttr,
            updateReadonly,
            load,
            signal: load.signal,
            isCurrent: load.isCurrent,
            cb(keys) {
                if (protyle.query?.key) {
                    searchMarkRender(protyle, keys, protyle.highlight.rangeIndex);
                }
            }
        });
    }
};
