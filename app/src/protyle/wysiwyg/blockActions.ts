import {scrollCenter} from "../util/highlightById";
import {focusByWbr, getEditorRange} from "../util/selection";
import {zoomOut} from "../util/zoom";
import {hideElements} from "../ui/hideElements";
import {hasClosestBlock, hasClosestByClassName} from "../util/hasClosest";
import {genEmptyElement, genHeadingElement} from "./blockElement";
import {type BlockSibling, requestBlockSibling} from "./blockSibling";
import {getTopAloneElement} from "./getBlock";
import {genListItemElement, updateListOrder} from "./list";
import {transaction, turnsIntoOneTransaction, updateTransaction} from "./transaction";
import {protyleContentIdentity} from "../util/contentLoad";

export const insertEmptyBlock = async (
    protyle: IProtyle,
    position: InsertPosition,
    id?: string,
) => {
    const range = getEditorRange(protyle.wysiwyg.element);
    let blockElement: Element | null;
    if (id) {
        blockElement = protyle.wysiwyg.element.querySelector(`[data-node-id="${id}"]`);
    } else {
        const selectedElements = protyle.wysiwyg.element.querySelectorAll(".protyle-wysiwyg--select");
        if (selectedElements.length > 0) {
            blockElement = position === "beforebegin"
                ? selectedElements[0]
                : selectedElements[selectedElements.length - 1];
            hideElements(["select"], protyle);
        } else {
            blockElement = getTopAloneElement(hasClosestBlock(range.startContainer) as HTMLElement);
            if (blockElement.classList.contains("list")) {
                blockElement = hasClosestByClassName(range.startContainer, "li") as HTMLElement;
            } else if (blockElement.classList.contains("bq") || blockElement.classList.contains("callout")) {
                blockElement = hasClosestBlock(range.startContainer) as HTMLElement;
            }
        }
    }
    if (!blockElement) {
        return;
    }
    protyle.observerLoad?.disconnect();
    let newElement = genEmptyElement(protyle, false, true);
    let orderIndex = 1;
    if (blockElement.getAttribute("data-type") === "NodeListItem") {
        newElement = genListItemElement(protyle, blockElement, 0, true) as HTMLDivElement;
        orderIndex = parseInt(blockElement.parentElement!.firstElementChild!.getAttribute("data-marker")!);
    } else if (position === "beforebegin" &&
        blockElement.previousElementSibling?.getAttribute("data-type") === "NodeHeading" &&
        blockElement.previousElementSibling.getAttribute("fold") === "1") {
        newElement = genHeadingElement(blockElement.previousElementSibling, false, true) as HTMLDivElement;
    } else if (position === "afterend" && blockElement.getAttribute("data-type") === "NodeHeading" &&
        blockElement.getAttribute("fold") === "1") {
        newElement = genHeadingElement(blockElement, false, true) as HTMLDivElement;
    }

    const parentOldHTML = blockElement.parentElement!.outerHTML;
    const newId = newElement.dataset.nodeId!;
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

export const jumpToParent = async (
    protyle: IProtyle,
    nodeElement: Element,
    target: BlockSibling,
) => {
    const response = await requestBlockSibling(protyle, nodeElement.getAttribute("data-node-id")!);
    const targetId = response.data[target];
    if (!targetId) {
        return;
    }
    const identity = protyleContentIdentity(protyle);
    protyle.host.dispatch({
        type: "open-document",
        notebookId: identity.notebookId,
        documentId: identity.documentId,
        blockId: targetId,
        disposition: "current",
        scope: targetId !== protyle.block.rootID && protyle.block.showAll ? "subtree" : "target",
        attention: "focus",
        scroll: "auto",
        restoreScroll: "always",
        zoom: false,
    });
};

export const navigateBack = async (protyle: IProtyle, focusId: string) => {
    if (!protyle.block.showAll) {
        const parentDocument = protyle.block.parentDocument;
        if (!parentDocument) {
            return;
        }
        protyle.host.dispatch({
            type: "open-document",
            notebookId: parentDocument.notebookId,
            documentId: parentDocument.documentId,
            blockId: parentDocument.blockId,
            disposition: "current",
            scope: "target",
            attention: "focus",
            scroll: "auto",
            restoreScroll: "always",
            zoom: false,
        });
        return;
    }
    const response = await requestBlockSibling(protyle, protyle.block.rootID!);
    const parentId = response.data.parent;
    if (!parentId) {
        return;
    }
    await zoomOut({protyle, id: parentId, focusId});
};
