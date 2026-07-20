import {Constants} from "../../constants";

export type ProtyleReferenceIdentity = {
    notebookId: string;
    documentId: string;
};

export type ProtyleRefDynamicTextData = ProtyleReferenceIdentity & {
    blockID: string;
    defBlockID: string;
    refText: string;
};

export type ProtyleDefRefCountData = ProtyleReferenceIdentity & {
    blockID: string;
    refCount: number;
    rootRefCount: number;
};

/** 判断编辑器是否拥有推送事件声明的 notebook/document 身份。 */
const ownsDocument = (protyle: IProtyle, identity: ProtyleReferenceIdentity) =>
    protyle.content.mode === "bound" &&
    protyle.content.notebookId === identity.notebookId &&
    protyle.block.rootID === identity.documentId;

/** 判断普通块或嵌入块元素是否属于推送来源文档，避免跨空间更新 DOM。 */
const ownsRenderedDocument = (protyle: IProtyle, element: Element, identity: ProtyleReferenceIdentity) => {
    const embedElement = element.closest(".protyle-wysiwyg__embed");
    if (embedElement) {
        return embedElement.getAttribute("data-notebook-id") === identity.notebookId &&
            embedElement.getAttribute("data-document-id") === identity.documentId;
    }
    return ownsDocument(protyle, identity);
};

/** 将引用动态文本推送到来源文档的匹配实例，拒绝不属于该文档的迟到事件。 */
export const setProtyleRefDynamicText = (protyle: IProtyle, data: ProtyleRefDynamicTextData) => {
    protyle.wysiwyg.element
        .querySelectorAll(`[data-node-id="${data.blockID}"] span[data-type~="block-ref"][data-subtype="d"][data-id="${data.defBlockID}"]`)
        .forEach((item) => {
            if (ownsRenderedDocument(protyle, item, data)) {
                item.innerHTML = data.refText;
            }
        });
};

/** 更新文档及块引用计数，只修改通过身份校验的当前编辑器或嵌入块。 */
export const setProtyleDefRefCount = (protyle: IProtyle, data: ProtyleDefRefCountData) => {
    if (ownsDocument(protyle, data) && protyle.title) {
        const attrElement = protyle.title.element.querySelector(".protyle-attr");
        const countElement = attrElement.querySelector(".protyle-attr--refcount");
        if (countElement) {
            if (data.rootRefCount === 0) {
                countElement.remove();
            } else {
                countElement.textContent = data.rootRefCount.toString();
            }
        } else if (data.rootRefCount > 0) {
            attrElement.insertAdjacentHTML("beforeend", `<div class="protyle-attr--refcount popover__block">${data.rootRefCount}</div>`);
        }
    }

    if (data.documentId === data.blockID) {
        return;
    }
    protyle.wysiwyg.element.querySelectorAll(`[data-node-id="${data.blockID}"]`).forEach((item) => {
        if (!ownsRenderedDocument(protyle, item, data)) {
            return;
        }
        // 不能直接查询，否则列表中会获取到第一个列表项的 attr https://github.com/siyuan-note/siyuan/issues/12738
        const countElement = item.lastElementChild?.querySelector(".protyle-attr--refcount");
        if (countElement) {
            if (data.refCount === 0) {
                countElement.remove();
            } else {
                countElement.textContent = data.refCount.toString();
            }
        } else if (data.refCount > 0) {
            const attrElement = item.lastElementChild;
            if (attrElement.childElementCount > 0) {
                attrElement.lastElementChild.insertAdjacentHTML("afterend", `<div class="protyle-attr--refcount popover__block">${data.refCount}</div>`);
            } else {
                attrElement.innerHTML = `<div class="protyle-attr--refcount popover__block">${data.refCount}</div>${Constants.ZWSP}`;
            }
        }
        if (data.refCount === 0) {
            item.removeAttribute("refcount");
        } else {
            item.setAttribute("refcount", data.refCount.toString());
        }
    });
};
