import {isSupportCSSHL} from "../render/searchMarkRender";
import {disposeTooltip} from "../ui/tooltip";

const hideProtyleUtility = (protyle: IProtyle) => {
    const toolbar = protyle.toolbar;
    if (!toolbar || toolbar.isMultiSelectMode()) {
        return;
    }
    const pinElement = toolbar.subElement.querySelector('[data-type="pin"]');
    const pinIcon = pinElement?.querySelector("use")?.getAttribute("xlink:href") ??
        pinElement?.querySelector("use")?.getAttribute("href");
    if (pinIcon === "#iconUnpin") {
        return;
    }
    toolbar.subElement.classList.add("fn__none");
    toolbar.subElementCloseCB?.();
    toolbar.subElementCloseCB = undefined;
};

export const destroy = (protyle: IProtyle) => {
    if (!protyle) {
        return;
    }
    if (protyle.destroyed) {
        return;
    }
    protyle.destroyed = true;
    protyle.uiEventController?.abort();
    protyle.editors.unregister(protyle);
    disposeTooltip(protyle);
    hideProtyleUtility(protyle);
    protyle.toolbar?.destroy();
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
    protyle.plugins.emit({
        type: "destroy-protyle",
        detail: {
            protyle,
        },
    });
};
