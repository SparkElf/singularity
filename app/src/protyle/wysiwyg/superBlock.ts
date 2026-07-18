import {Constants} from "../../constants";
import {blockRender} from "../render/blockRender";
import {mathRender} from "../render/mathRender";
import {focusByWbr} from "../util/selection";
import {getContenteditableElement, getParentBlock} from "./getBlock";
import {requestBlockSibling} from "./blockSibling";

export const cancelSB = async (protyle: IProtyle, nodeElement: Element, range?: Range) => {
    const doOperations: IOperation[] = [];
    const undoOperations: IOperation[] = [];
    let previousId = nodeElement.previousElementSibling?.getAttribute("data-node-id") || undefined;
    nodeElement.classList.remove("protyle-wysiwyg--select");
    nodeElement.removeAttribute("select-start");
    nodeElement.removeAttribute("select-end");
    const id = nodeElement.getAttribute("data-node-id")!;
    // 先清理拖拽手柄，避免手柄被克隆进撤销用的超级块副本，导致恢复后残留多余手柄。
    nodeElement.querySelectorAll(".sb__resize").forEach((handle) => handle.remove());
    const sbElement = nodeElement.cloneNode() as HTMLElement;
    sbElement.innerHTML = nodeElement.lastElementChild!.outerHTML;
    let parentId = getParentBlock(nodeElement)?.getAttribute("data-node-id") || undefined;
    if (!previousId && !parentId) {
        if (protyle.block.showAll || protyle.options.backlinkData) {
            const response = await requestBlockSibling(protyle, id);
            previousId = response.data.previous;
            parentId = response.data.parent;
        } else {
            parentId = protyle.block.rootID;
        }
    }
    undoOperations.push({
        action: "insert",
        id,
        data: sbElement.outerHTML,
        previousID: previousId,
        parentID: parentId,
    });
    Array.from(nodeElement.children).forEach((item, index) => {
        if (index === nodeElement.childElementCount - 1) {
            doOperations.push({action: "delete", id});
            if (range) {
                getContenteditableElement(nodeElement)?.insertAdjacentHTML("afterbegin", "<wbr>");
            }
            nodeElement.lastElementChild!.remove();
            nodeElement.replaceWith(...nodeElement.children);
            if (range) {
                focusByWbr(protyle.wysiwyg.element, range);
            }
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
    // 超级块内嵌入块无面包屑，需重新渲染 https://github.com/siyuan-note/siyuan/issues/7574
    doOperations.forEach((operation) => {
        const element = protyle.wysiwyg.element.querySelector(`[data-node-id="${operation.id}"]`);
        if (element?.getAttribute("data-type") === "NodeBlockQueryEmbed") {
            element.removeAttribute("data-render");
            blockRender(protyle, element);
        }
    });
    return {doOperations, undoOperations, previousId};
};

export const genSBElement = (layout: string, id?: string, attrHTML?: string) => {
    const sbElement = document.createElement("div");
    sbElement.dataset.nodeId = id || Lute.NewNodeID();
    sbElement.dataset.type = "NodeSuperBlock";
    sbElement.className = "sb";
    sbElement.dataset.sbLayout = layout;
    sbElement.innerHTML = attrHTML || `<div class="protyle-attr" contenteditable="false">${Constants.ZWSP}</div>`;
    return sbElement;
};

export const refreshSbResize = (sbElement: Element) => {
    sbElement.querySelectorAll(":scope > .sb__resize").forEach((item) => item.remove());
    if (sbElement.getAttribute("data-sb-layout") !== "col") {
        return;
    }
    const children = Array.from(sbElement.querySelectorAll(":scope > [data-node-id]"));
    for (let index = 0; index < children.length - 1; index++) {
        const handle = document.createElement("span");
        handle.className = "sb__resize";
        handle.setAttribute("contenteditable", "false");
        children[index].after(handle);
    }
};

export const rebalanceSbWidth = (sbElement: Element): Array<{id: string, oldHTML: string}> => {
    if (sbElement.getAttribute("data-sb-layout") !== "col") {
        return [];
    }
    const children = Array.from(sbElement.querySelectorAll<HTMLElement>(":scope > [data-node-id]"));
    if (children.length < 2 || !children.some((child) => child.style.width)) {
        return [];
    }
    const handle = sbElement.querySelector<HTMLElement>(":scope > .sb__resize");
    let gapPx = 20;
    if (handle) {
        const style = getComputedStyle(handle);
        gapPx = handle.offsetWidth + parseFloat(style.marginLeft) + parseFloat(style.marginRight);
    }
    const childCount = children.length;
    const gapShare = ((childCount - 1) * gapPx) / childCount + 0.5;
    const averageRatio = 1 / childCount;
    const ratios = children.map((child) => {
        const match = child.style.width.match(/calc\(([\d.]+)%/);
        return match ? parseFloat(match[1]) / 100 : averageRatio;
    });
    const totalRatio = ratios.reduce((sum, ratio) => sum + ratio, 0) || 1;
    return children.map((child, index) => {
        const oldHTML = child.outerHTML;
        const percentage = Math.round((ratios[index] / totalRatio) * 100 * 10) / 10;
        child.style.width = `calc(${percentage}% - ${gapShare}px)`;
        child.style.flex = "none";
        return {id: child.dataset.nodeId!, oldHTML};
    });
};

export const refreshSbAndPersistWidth = (
    sbElement: Element,
    doOperations: IOperation[],
    undoOperations: IOperation[],
) => {
    if (!sbElement.parentElement) {
        return;
    }
    refreshSbResize(sbElement);
    rebalanceSbWidth(sbElement).forEach((change) => {
        const targetElement = sbElement.querySelector(`[data-node-id="${change.id}"]`)!;
        doOperations.push({action: "update", id: change.id, data: targetElement.outerHTML});
        undoOperations.unshift({action: "update", id: change.id, data: change.oldHTML});
    });
};
