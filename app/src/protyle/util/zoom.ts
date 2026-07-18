import {Constants} from "../../constants";
import {onGet} from "./onGet";
import {beginProtyleContentLoad, requestProtyleContent, type ProtyleContentLoad} from "./contentLoad";
import {focusBlock} from "./selection";
import {getFirstBlock} from "../wysiwyg/getBlock";
import {hasClosestByClassName} from "./hasClosest";

export interface ZoomOutOptions {
    protyle: IProtyle;
    id: string;
    focusId?: string;
    isPushBack?: boolean;
    callback?: () => void;
    reload?: boolean;
}

const reportFailure = (protyle: IProtyle, load: ProtyleContentLoad, error: unknown) => {
    if (load.isCurrent()) {
        console.error("[protyle.transport] zoom request failed", error);
    }
};

const focusVisibleBlock = (protyle: IProtyle, element: Element) => {
    let visibleElement = element;
    while (visibleElement.getBoundingClientRect().height === 0) {
        visibleElement = visibleElement.parentElement!;
    }
    if (visibleElement.classList.contains("protyle-wysiwyg")) {
        visibleElement = element.previousElementSibling || element.nextElementSibling!;
    } else {
        visibleElement = getFirstBlock(visibleElement);
    }
    focusBlock(visibleElement);
};

const pinBlockPopover = (protyle: IProtyle) => {
    const blockPopover = hasClosestByClassName(protyle.element, "block__popover", true);
    if (!blockPopover || blockPopover.getAttribute("data-pin") === "true") {
        return;
    }
    const pinElement = blockPopover.querySelector('[data-type="pin"]');
    if (!pinElement) {
        return;
    }
    pinElement.setAttribute("aria-label", protyle.localization.text("unpin"));
    pinElement.querySelector("use")?.setAttribute("xlink:href", "#iconUnpin");
    blockPopover.setAttribute("data-pin", "true");
};

const activateWorkspaceDocument = (protyle: IProtyle) => {
    if (protyle.surface === "workspace") {
        protyle.host.dispatch({
            type: "activate-document",
            notebookId: protyle.notebookId,
            documentId: protyle.block.rootID,
        });
    }
};

const loadFocusContext = async (
    protyle: IProtyle,
    id: string,
    focusId: string,
    isPushBack: boolean,
    load: ProtyleContentLoad,
) => {
    const response = await requestProtyleContent<IWebSocketData>(protyle, "/api/filetree/getDoc", {
        id: focusId,
        mode: 3,
        size: protyle.settings.editor.dynamicLoadBlocks,
    }, load);
    if (!load.isCurrent()) {
        return;
    }
    onGet({
        data: response,
        protyle,
        action: isPushBack
            ? [Constants.CB_GET_FOCUS]
            : [Constants.CB_GET_FOCUS, Constants.CB_GET_UNUNDO],
        scrollAttr: {rootId: id, focusId},
        load,
    });
};

const focusAfterZoom = async (
    protyle: IProtyle,
    id: string,
    requestedFocusId: string,
    isPushBack: boolean,
    load: ProtyleContentLoad,
) => {
    let focusId = requestedFocusId;
    let focusElement = protyle.wysiwyg.element.querySelector(`[data-node-id="${focusId}"]`);
    if (!focusElement) {
        const response = await requestProtyleContent<IWebSocketData>(
            protyle,
            "/api/block/getUnfoldedParentID",
            {id: focusId},
            load,
        );
        if (!load.isCurrent()) {
            return;
        }
        focusId = response.data.parentID;
        focusElement = protyle.wysiwyg.element.querySelector(`[data-node-id="${focusId}"]`);
    }
    if (focusElement) {
        focusVisibleBlock(protyle, focusElement);
        return;
    }
    if (id === protyle.block.rootID) {
        await loadFocusContext(protyle, id, focusId, isPushBack, load);
    }
};

export const zoomOut = async ({
    protyle,
    id,
    focusId,
    isPushBack = true,
    callback,
    reload = false,
}: ZoomOutOptions) => {
    if (protyle.options.backlinkData) {
        return;
    }
    pinBlockPopover(protyle);
    const activeBreadcrumb = protyle.breadcrumb?.element.querySelector(".protyle-breadcrumb__item--active");
    if (!reload && activeBreadcrumb?.getAttribute("data-node-id") === id) {
        if (id === protyle.block.rootID) {
            return;
        }
        const existingFocus = protyle.wysiwyg.element.querySelector(`[data-node-id="${focusId || id}"]`);
        if (existingFocus) {
            focusBlock(existingFocus);
            existingFocus.scrollIntoView();
            return;
        }
    }

    const load = beginProtyleContentLoad(protyle);
    try {
        const response = await requestProtyleContent<IWebSocketData>(protyle, "/api/filetree/getDoc", {
            id,
            size: id === protyle.block.rootID
                ? protyle.settings.editor.dynamicLoadBlocks
                : Constants.SIZE_GET_MAX,
        }, load);
        if (!load.isCurrent()) {
            return;
        }
        const action: TProtyleAction[] = [Constants.CB_GET_HTML];
        if (!isPushBack) {
            action.push(Constants.CB_GET_UNUNDO);
        }
        if (id !== protyle.block.rootID) {
            action.push(Constants.CB_GET_ALL);
        }
        if (focusId) {
            action.push(Constants.CB_GET_FOCUS);
        }
        onGet({
            data: response,
            protyle,
            action,
            scrollAttr: focusId ? {rootId: id, focusId} : undefined,
            scrollPosition: focusId ? "start" : undefined,
            load,
            afterCB: () => {
                if (!load.isCurrent()) {
                    return;
                }
                if (focusId) {
                    void focusAfterZoom(protyle, id, focusId, isPushBack, load)
                        .then(() => {
                            if (load.isCurrent()) {
                                activateWorkspaceDocument(protyle);
                            }
                        })
                        .catch((error) => reportFailure(protyle, load, error));
                } else if (id !== protyle.block.rootID) {
                    protyle.wysiwyg.element.classList.add("protyle-wysiwyg--animate");
                    window.setTimeout(() => {
                        if (load.isCurrent()) {
                            protyle.wysiwyg.element.classList.remove("protyle-wysiwyg--animate");
                        }
                    }, 365);
                    activateWorkspaceDocument(protyle);
                } else {
                    activateWorkspaceDocument(protyle);
                }
                callback?.();
            },
        });
    } catch (error) {
        reportFailure(protyle, load, error);
    }
};
