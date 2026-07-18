import {Constants} from "../../constants";
import {focusByRange, focusByWbr} from "./selection";

export const removeInlineType = (inlineElement: HTMLElement, type: string, range?: Range) => {
    const types = (inlineElement.getAttribute("data-type") || "")
        .split(" ")
        .filter((item) => item !== "" && item !== type);
    if (types.length === 0) {
        const linkParentElement = inlineElement.parentElement;
        inlineElement.outerHTML = inlineElement.innerHTML.replace(Constants.ZWSP, "") + "<wbr>";
        if (range) {
            focusByWbr(linkParentElement, range);
        }
        return;
    }

    inlineElement.setAttribute("data-type", types.join(" "));
    if (type === "a") {
        inlineElement.removeAttribute("data-href");
    } else if (type === "file-annotation-ref") {
        inlineElement.removeAttribute("data-id");
    } else if (type === "block-ref") {
        inlineElement.removeAttribute("data-id");
        inlineElement.removeAttribute("data-subtype");
    }
    if (range) {
        range.selectNodeContents(inlineElement);
        range.collapse(false);
        focusByRange(range);
    }
};
