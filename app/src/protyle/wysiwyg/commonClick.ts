import {hasClosestBlock, hasClosestByClassName} from "../util/hasClosest";
import {isNarrowViewport} from "../util/browserPlatform";
import {isOnlyMeta} from "../util/keyboard";
import {protyleContentIdentity} from "../util/contentLoad";
import type {ProtyleBlockAttributeFocus} from "../../../../enterprise/packages/protyle-browser/src/contracts";

const openBlockAttributes = (protyle: IProtyle, attributeElement: Element, focus: ProtyleBlockAttributeFocus) => {
    if (!protyle.settings.features.blockAttributes) {
        return;
    }
    const identity = protyleContentIdentity(protyle);
    protyle.host.dispatch({
        type: "open-block-attributes",
        notebookId: identity.notebookId,
        documentId: identity.documentId,
        blockId: (hasClosestBlock(attributeElement) as Element).getAttribute("data-node-id")!,
        focus,
    });
};

export const commonClick = (event: MouseEvent & {
    target: HTMLElement
}, protyle: IProtyle) => {
    const isNarrow = isNarrowViewport();
    const attrBookmarkElement = hasClosestByClassName(event.target, "protyle-attr--bookmark");
    if (attrBookmarkElement) {
        if (!isNarrow && isOnlyMeta(event)) {
            protyle.host.dispatch({
                type: "open-search",
                query: attrBookmarkElement.textContent.trim(),
                queryMode: "replace",
                method: "preferred",
            });
        } else {
            openBlockAttributes(protyle, attrBookmarkElement, "bookmark");
        }
        event.stopPropagation();
        return true;
    }

    const attrNameElement = hasClosestByClassName(event.target, "protyle-attr--name");
    if (attrNameElement) {
        if (!isNarrow && isOnlyMeta(event)) {
            protyle.host.dispatch({
                type: "open-search",
                query: attrNameElement.textContent.trim(),
                queryMode: "replace",
                method: "preferred",
            });
        } else {
            openBlockAttributes(protyle, attrNameElement, "name");
        }
        event.stopPropagation();
        return true;
    }

    const avElement = hasClosestByClassName(event.target, "protyle-attr--av");
    if (avElement) {
        openBlockAttributes(protyle, avElement, "av");
        event.stopPropagation();
        return true;
    }

    const attrAliasElement = hasClosestByClassName(event.target, "protyle-attr--alias");
    if (attrAliasElement) {
        if (!isNarrow && isOnlyMeta(event)) {
            protyle.host.dispatch({
                type: "open-search",
                query: attrAliasElement.textContent.trim(),
                queryMode: "replace",
                method: "preferred",
            });
        } else {
            openBlockAttributes(protyle, attrAliasElement, "alias");
        }
        event.stopPropagation();
        return true;
    }

    const attrMemoElement = hasClosestByClassName(event.target, "protyle-attr--memo");
    if (attrMemoElement) {
        if (!isNarrow && isOnlyMeta(event)) {
            protyle.host.dispatch({
                type: "open-search",
                query: attrMemoElement.getAttribute("aria-label").trim(),
                queryMode: "replace",
                method: "preferred",
            });
        } else {
            openBlockAttributes(protyle, attrMemoElement, "memo");
        }
        event.stopPropagation();
        return true;
    }
};
