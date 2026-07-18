import {Constants} from "../../constants";
import {blockRender} from "../render/blockRender";
import {mathRender} from "../render/mathRender";
import {scrollCenter} from "../util/highlightById";
import {focusByWbr, getEditorRange} from "../util/selection";
import {zoomOut} from "../util/zoom";
import {getParentBlock} from "../wysiwyg/getBlock";
import {genListItemElement, updateListOrder} from "../wysiwyg/list";
import {
    transaction,
    turnsIntoOneTransaction,
    updateTransaction,
} from "../wysiwyg/transaction";
import {protyleContentIdentity} from "../util/contentLoad";

interface SiblingResponse {
    readonly data: {
        readonly next?: string;
        readonly parent?: string;
        readonly previous?: string;
    };
}

const requestSibling = (protyle: IProtyle, id: string) =>
    protyle.session!.runtime.transport.request<SiblingResponse>("/api/block/getBlockSiblingID", {
        id,
        notebook: protyle.notebookId,
    }, {
        identity: protyleContentIdentity(protyle),
        intent: "read",
        signal: protyle.requestSignal,
    });

export const createEmptyBlockElement = (
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

const createEmptyHeadingElement = (heading: Element, addWbr: boolean) => {
    const template = document.createElement("template");
    template.innerHTML = `<div data-subtype="${heading.getAttribute("data-subtype")}" data-node-id="${Lute.NewNodeID()}" data-type="NodeHeading" class="${heading.className}"><div contenteditable="true" spellcheck="false">${addWbr ? "<wbr>" : ""}</div><div class="protyle-attr" contenteditable="false">${Constants.ZWSP}</div></div>`;
    return template.content.firstElementChild as HTMLElement;
};

export const cancelSuperBlock = async (protyle: IProtyle, nodeElement: Element) => {
    const doOperations: IOperation[] = [];
    const undoOperations: IOperation[] = [];
    let previousId = nodeElement.previousElementSibling?.getAttribute("data-node-id") || undefined;
    nodeElement.classList.remove("protyle-wysiwyg--select");
    nodeElement.removeAttribute("select-start");
    nodeElement.removeAttribute("select-end");
    const id = nodeElement.getAttribute("data-node-id")!;
    nodeElement.querySelectorAll(".sb__resize").forEach((handle) => handle.remove());
    const superBlock = nodeElement.cloneNode() as HTMLElement;
    superBlock.innerHTML = nodeElement.lastElementChild!.outerHTML;
    let parentId = getParentBlock(nodeElement)?.getAttribute("data-node-id") || undefined;
    if (!previousId && !parentId) {
        if (protyle.block.showAll || protyle.options.backlinkData) {
            const response = await requestSibling(protyle, id);
            previousId = response.data.previous;
            parentId = response.data.parent;
        } else {
            parentId = protyle.block.rootID;
        }
    }
    undoOperations.push({
        action: "insert",
        id,
        data: superBlock.outerHTML,
        previousID: previousId,
        parentID: parentId,
    });
    Array.from(nodeElement.children).forEach((item, index) => {
        if (index === nodeElement.childElementCount - 1) {
            doOperations.push({action: "delete", id});
            nodeElement.lastElementChild!.remove();
            nodeElement.replaceWith(...nodeElement.children);
            return;
        }
        doOperations.push({
            action: "move",
            id: item.getAttribute("data-node-id")!,
            previousID: previousId,
            parentID: parentId,
        });
        undoOperations.push({
            action: "move",
            id: item.getAttribute("data-node-id")!,
            previousID: item.previousElementSibling?.getAttribute("data-node-id") || undefined,
            parentID: id,
        });
        previousId = item.getAttribute("data-node-id")!;
    });
    mathRender(protyle.wysiwyg.element, protyle);
    doOperations.forEach((operation) => {
        const element = protyle.wysiwyg.element.querySelector(`[data-node-id="${operation.id}"]`);
        if (element?.getAttribute("data-type") === "NodeBlockQueryEmbed") {
            element.removeAttribute("data-render");
            blockRender(protyle, element);
        }
    });
    return {doOperations, undoOperations, previousId};
};

export const insertEmptyBlockAt = async (protyle: IProtyle, position: InsertPosition, id: string) => {
    const range = getEditorRange(protyle.wysiwyg.element);
    const blockElement = protyle.wysiwyg.element.querySelector(`[data-node-id="${id}"]`);
    if (!blockElement) {
        throw new Error(`[protyle.gutter] insert target unavailable: ${id}`);
    }
    protyle.observerLoad?.disconnect();
    let newElement = createEmptyBlockElement(protyle, false, true);
    let orderIndex = 1;
    if (blockElement.getAttribute("data-type") === "NodeListItem") {
        newElement = genListItemElement(blockElement, 0, true) as HTMLDivElement;
        orderIndex = parseInt(blockElement.parentElement!.firstElementChild!.getAttribute("data-marker")!);
    } else if (position === "beforebegin" &&
        blockElement.previousElementSibling?.getAttribute("data-type") === "NodeHeading" &&
        blockElement.previousElementSibling.getAttribute("fold") === "1") {
        newElement = createEmptyHeadingElement(blockElement.previousElementSibling, true);
    } else if (position === "afterend" && blockElement.getAttribute("data-type") === "NodeHeading" &&
        blockElement.getAttribute("fold") === "1") {
        newElement = createEmptyHeadingElement(blockElement, true);
    }

    const parentOldHTML = blockElement.parentElement!.outerHTML;
    const newId = newElement.getAttribute("data-node-id")!;
    blockElement.insertAdjacentElement(position, newElement);
    if (blockElement.getAttribute("data-type") === "NodeListItem" &&
        blockElement.getAttribute("data-subtype") === "o" &&
        !newElement.parentElement!.classList.contains("protyle-wysiwyg")) {
        updateListOrder(newElement.parentElement!, orderIndex);
        updateTransaction(protyle, newElement.parentElement!, parentOldHTML);
    } else {
        const doOperations: IOperation[] = position === "beforebegin" ? [{
            action: "insert",
            data: newElement.outerHTML,
            id: newId,
            nextID: blockElement.getAttribute("data-node-id")!,
        }] : [{
            action: "insert",
            data: newElement.outerHTML,
            id: newId,
            previousID: blockElement.getAttribute("data-node-id")!,
        }];
        const undoOperations: IOperation[] = [{action: "delete", id: newId}];
        if (blockElement.parentElement!.classList.contains("sb") &&
            blockElement.parentElement!.getAttribute("data-sb-layout") === "col") {
            const mergeOperations = await turnsIntoOneTransaction({
                protyle,
                selectsElement: position === "afterend"
                    ? [blockElement, blockElement.nextElementSibling!]
                    : [blockElement.previousElementSibling!, blockElement],
                type: "BlocksMergeSuperBlock",
                level: "row",
                unfocus: true,
                getOperations: true,
            });
            doOperations.push(...mergeOperations.doOperations);
            undoOperations.unshift(...mergeOperations.undoOperations);
        }
        transaction(protyle, doOperations, undoOperations);
    }
    focusByWbr(protyle.wysiwyg.element, range);
    scrollCenter(protyle);
};

export const navigateRelativeBlock = async (
    protyle: IProtyle,
    id: string,
    target: "next" | "parent" | "previous",
) => {
    const response = await requestSibling(protyle, id);
    const targetId = response.data[target];
    if (!targetId) {
        return;
    }
    protyle.host.dispatch({
        type: "open-document",
        notebookId: protyle.notebookId,
        documentId: targetId,
        disposition: "current",
        scope: targetId !== protyle.block.rootID && protyle.block.showAll ? "subtree" : "target",
        attention: "focus",
        scroll: "auto",
        restoreScroll: "always",
        zoom: false,
    });
};

export const navigateBack = async (protyle: IProtyle, focusId: string) => {
    const currentId = protyle.block.rootID!;
    const response = await requestSibling(protyle, currentId);
    const parentId = response.data.parent;
    if (!parentId) {
        return;
    }
    if (protyle.block.showAll) {
        await zoomOut({protyle, id: parentId, focusId});
        return;
    }
    protyle.host.dispatch({
        type: "open-document",
        notebookId: protyle.notebookId,
        documentId: parentId,
        disposition: "current",
        scope: "target",
        attention: "focus",
        scroll: "auto",
        restoreScroll: "always",
        zoom: false,
    });
};
