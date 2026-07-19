import {hasClosestByAttribute} from "../util/hasClosest";
import {combineAbortSignals} from "../util/abortSignal";
import {processRender} from "../util/processCode";
import {protyleContentIdentity} from "../util/contentLoad";
import {resolveProtyleContentAssetSources} from "../util/assetSource";
import {genBreadcrumb, improveBreadcrumbAppearance} from "../wysiwyg/renderBacklink";
import {avRender} from "./av/render";
import {genEmbedRenderFrame} from "./embedFrame";
import {highlightRender} from "./highlightRender";

interface EmbedBlockResult {
    readonly block: IBlock & {readonly box: string; readonly id: string; readonly rootID: string};
    readonly blockPaths: IBreadcrumb[];
}

interface EmbedBlockResponse {
    readonly data: {
        readonly blocks: EmbedBlockResult[];
    };
}

interface EmbedLoad {
    readonly signal: AbortSignal;
    isCurrent: () => boolean;
}

type EmbedScriptRequest = <TResponse = IWebSocketData>(path: string, body?: unknown) => Promise<TResponse>;

const embedLoads = new WeakMap<HTMLElement, {controller: AbortController}>();

const beginEmbedLoad = (protyle: IProtyle, item: HTMLElement): EmbedLoad => {
    embedLoads.get(item)?.controller.abort();
    const state = {controller: new AbortController()};
    embedLoads.set(item, state);
    const signal = combineAbortSignals([protyle.requestSignal, state.controller.signal]);
    return {
        signal,
        isCurrent: () => embedLoads.get(item) === state &&
            !signal.aborted &&
            !protyle.destroyed &&
            protyle.element.contains(item),
    };
};

const requestEmbed = <TResponse>(
    protyle: IProtyle,
    load: EmbedLoad,
    path: string,
    body?: unknown,
) => {
    const runtime = protyle.session!.runtime as TProtyleRuntime;
    return runtime.transport.request<TResponse>(path, body, {
        identity: protyleContentIdentity(protyle),
        intent: "read",
        signal: load.signal,
    });
};

const renderFrame = (protyle: IProtyle, item: HTMLElement) => {
    genEmbedRenderFrame(item, {
        more: protyle.localization.text("more"),
        refPopover: protyle.localization.text("refPopover"),
        refresh: protyle.localization.text("refresh"),
        update: protyle.localization.text("update"),
    });
};

const headingMode = (protyle: IProtyle, item: HTMLElement) => {
    const customMode = item.getAttribute("custom-heading-mode");
    return customMode === "0" || customMode === "1" || customMode === "2" ?
        Number.parseInt(customMode, 10) : protyle.settings.editor.headingEmbedMode;
};

const showBreadcrumb = (protyle: IProtyle, item: HTMLElement) => {
    const attribute = item.getAttribute("breadcrumb");
    return attribute ? attribute === "true" : protyle.settings.editor.embedBlockBreadcrumb;
};

const scriptRequest = (protyle: IProtyle, load: EmbedLoad): EmbedScriptRequest =>
    <TResponse>(path: string, body?: unknown) => requestEmbed<TResponse>(protyle, load, path, body);

const runEmbedScript = async (
    protyle: IProtyle,
    item: HTMLElement,
    content: string,
    load: EmbedLoad,
    top?: number,
) => {
    const identity = protyleContentIdentity(protyle);
    const context = Object.freeze({
        documentId: identity.documentId,
        notebookId: identity.notebookId,
        spaceId: protyle.session!.spaceId,
    });
    const execute = new Function("request", "item", "context", "top", content) as (
        request: EmbedScriptRequest,
        item: HTMLElement,
        context: typeof context,
        top?: number,
    ) => unknown;
    return await execute(scriptRequest(protyle, load), item, context, top);
};

const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);

const renderBlockQuery = async (protyle: IProtyle, item: HTMLElement, top?: number) => {
    const load = beginEmbedLoad(protyle, item);
    const content = Lute.UnEscapeHTMLStr(item.getAttribute("data-content"));
    const embedBlockID = item.getAttribute("data-node-id");
    const breadcrumb = showBreadcrumb(protyle, item);
    try {
        let response: EmbedBlockResponse;
        if (content.startsWith("//!js")) {
            const includeIDs = await runEmbedScript(protyle, item, content, load, top);
            if (!load.isCurrent() || !Array.isArray(includeIDs)) {
                return;
            }
            response = await requestEmbed<EmbedBlockResponse>(protyle, load, "/api/search/getEmbedBlock", {
                breadcrumb,
                embedBlockID,
                headingMode: headingMode(protyle, item),
                includeIDs,
            });
        } else {
            const identity = protyleContentIdentity(protyle);
            response = await requestEmbed<EmbedBlockResponse>(protyle, load, "/api/search/searchEmbedBlock", {
                breadcrumb,
                embedBlockID,
                excludeIDs: [embedBlockID, identity.documentId],
                headingMode: headingMode(protyle, item),
                stmt: content,
            });
        }
        if (!load.isCurrent()) {
            return;
        }
        renderEmbed(response.data.blocks, protyle, item, top);
    } catch (error) {
        if (!load.isCurrent()) {
            return;
        }
        console.error("[protyle.transport] block embed request failed", {
            documentId: protyleContentIdentity(protyle).documentId,
            embedBlockID,
            error,
        });
        renderEmbed([], protyle, item, top, errorMessage(error));
    }
};

/** Render block query embeds through the bound Session transport. */
export const blockRender = (protyle: IProtyle, element: Element, top?: number) => {
    let blockElements: Element[] = [];
    if (element.getAttribute("data-type") === "NodeBlockQueryEmbed" && element.getAttribute("data-render") !== "true") {
        blockElements = [element];
    } else {
        blockElements = Array.from(element.querySelectorAll('[data-type="NodeBlockQueryEmbed"]:not([data-render="true"])'));
    }
    blockElements.forEach((item: HTMLElement) => {
        // Mark before issuing the request so rapid scrolling cannot enqueue the same embed twice.
        item.setAttribute("data-render", "true");
        renderFrame(protyle, item);
        if (item.childElementCount > 3) {
            item.style.height = (item.clientHeight - 4) + "px";
            for (let i = 1; i < item.children.length - 1; i++) {
                if (!item.children[i].classList.contains("protyle-cursor")) {
                    item.children[i].remove();
                    i--;
                }
            }
        }
        void renderBlockQuery(protyle, item, top);
    });
};

const renderEmbed = (
    blocks: EmbedBlockResult[],
    protyle: IProtyle,
    item: HTMLElement,
    top?: number,
    errorTip?: string,
) => {
    item.querySelector(".fn__rotate")?.classList.remove("fn__rotate");
    let html = "";
    blocks.forEach((blocksItem, index) => {
        const breadcrumbHTML = blocksItem.blockPaths.length === 0 ? "" : genBreadcrumb(blocksItem.blockPaths, true);
        let popover = "";
        if (index !== 0) {
            popover = `<div class="protyle-icons"><span data-id="${blocksItem.block.id}" data-notebook-id="${blocksItem.block.box}" data-document-id="${blocksItem.block.rootID}" data-action="openFloat" aria-label="${protyle.localization.text("refPopover")}" data-position="4north" class="ariaLabel protyle-icon protyle-icon--last protyle-icon--first"><svg><use xlink:href="#iconPictureInPicture"></use></svg></span></div>`;
        } else {
            item.querySelectorAll(".protyle-icon")[2]?.setAttribute("data-id", blocksItem.block.id);
            item.querySelectorAll(".protyle-icon")[2]?.setAttribute("data-notebook-id", blocksItem.block.box);
            item.querySelectorAll(".protyle-icon")[2]?.setAttribute("data-document-id", blocksItem.block.rootID);
        }
        html += `<div class="protyle-wysiwyg__embed" data-id="${blocksItem.block.id}" data-notebook-id="${blocksItem.block.box}" data-document-id="${blocksItem.block.rootID}">
${popover}${breadcrumbHTML}${blocksItem.block.content}
</div>`;
    });
    if (blocks.length > 0) {
        item.firstElementChild.insertAdjacentHTML("afterend", html);
        resolveProtyleContentAssetSources(protyle, item);
        improveBreadcrumbAppearance(item.querySelector(".protyle-wysiwyg__embed"));
    } else {
        const emptyElement = document.createElement("div");
        emptyElement.className = "protyle-wysiwyg__embed ft__smaller ft__secondary b3-form__space--small";
        emptyElement.contentEditable = "false";
        emptyElement.textContent = errorTip || protyle.localization.text("refExpired");
        item.firstElementChild.after(emptyElement);
    }

    processRender(item, protyle);
    highlightRender(item, protyle);
    avRender(item, protyle);
    if (top) {
        protyle.contentElement.scrollTop = top;
    }
    let maxDeep = 0;
    let deepEmbedElement: false | HTMLElement = item;
    while (maxDeep < 4 && deepEmbedElement) {
        deepEmbedElement = hasClosestByAttribute(deepEmbedElement.parentElement, "data-type", "NodeBlockQueryEmbed");
        maxDeep++;
    }
    if (maxDeep < 4) {
        item.querySelectorAll('[data-type="NodeBlockQueryEmbed"]').forEach((embedElement) => {
            blockRender(protyle, embedElement);
        });
    }
    item.style.height = "";
};
