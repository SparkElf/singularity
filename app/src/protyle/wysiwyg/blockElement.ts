import {Constants} from "../../constants";

export const genEmptyBlock = (
    protyle: IProtyle,
    zwsp = true,
    wbr = true,
    string?: string,
) => {
    let html = "";
    if (zwsp) {
        html = Constants.ZWSP;
    }
    if (wbr) {
        html += "<wbr>";
    }
    if (string) {
        html += string;
    }
    return `<div data-node-id="${Lute.NewNodeID()}" data-type="NodeParagraph" class="p"><div contenteditable="true" spellcheck="${protyle.settings.editor.spellcheck}">${html}</div><div contenteditable="false" class="protyle-attr">${Constants.ZWSP}</div></div>`;
};

export const genEmptyElement = (
    protyle: IProtyle,
    zwsp = true,
    wbr = true,
    id?: string,
) => {
    const element = document.createElement("div");
    element.dataset.nodeId = id || Lute.NewNodeID();
    element.dataset.type = "NodeParagraph";
    element.className = "p";
    element.innerHTML = `<div contenteditable="true" spellcheck="${protyle.settings.editor.spellcheck}">${zwsp ? Constants.ZWSP : ""}${wbr ? "<wbr>" : ""}</div><div class="protyle-attr" contenteditable="false">${Constants.ZWSP}</div>`;
    return element;
};

export const genHeadingElement = (
    headElement: Element,
    getHTML = false,
    addWbr = false,
) => {
    const html = `<div data-subtype="${headElement.getAttribute("data-subtype")}" data-node-id="${Lute.NewNodeID()}" data-type="NodeHeading" class="${headElement.className}"><div contenteditable="true" spellcheck="false">${addWbr ? "<wbr>" : ""}</div><div class="protyle-attr" contenteditable="false">${Constants.ZWSP}</div></div>`;
    if (getHTML) {
        return html;
    }
    const template = document.createElement("template");
    template.innerHTML = html;
    return template.content.firstElementChild;
};
