import {hideElements} from "../ui/hideElements";
import {isSupportCSSHL} from "../render/searchMarkRender";

export const destroy = (protyle: IProtyle) => {
    if (!protyle) {
        return;
    }
    if (protyle.destroyed) {
        return;
    }
    protyle.destroyed = true;
    protyle.editors.unregister(protyle);
    hideElements(["util"], protyle);
    if (isSupportCSSHL()) {
        protyle.highlight.markHL.clear();
        protyle.highlight.mark.clear();
        protyle.highlight.ranges = [];
        protyle.highlight.rangeIndex = 0;
    }
    protyle.observer?.disconnect();
    protyle.observerLoad?.disconnect();
    protyle.element.classList.remove("protyle");
    protyle.element.removeAttribute("style");
    if (protyle.wysiwyg) {
        protyle.wysiwyg.lastHTMLs = {};
    }
    if (protyle.undo) {
        protyle.undo.clear();
    }
    protyle.ws?.disconnect();
    protyle.plugins.emit({
        type: "destroy-protyle",
        detail: {
            protyle,
        },
    });
};
