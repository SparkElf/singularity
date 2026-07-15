import type {
    ProtyleDocumentAttention,
    ProtyleDocumentDisposition,
    ProtyleDocumentScope,
    ProtyleDocumentScrollRestore,
    ProtyleHostEvent,
    ProtyleHostPort,
} from "../../../enterprise/packages/protyle-browser/src/contracts";
import type {App} from "../index";
import {openAsset, openFileById} from "../editor/util";
import {openGlobalSearch} from "../search/util";
import {openSearch} from "../search/spread";
import {openBacklink, openGraph, openOutline} from "../layout/dock/util";
import {getDockByType} from "../layout/tabUtil";
import {openDocHistory} from "../history/doc";
import {openCardByData} from "../card/openCard";
import {viewCards} from "../card/viewCards";
import {makeCard} from "../card/makeCard";
import {openByMobile} from "../editor/openLink";
import {Constants} from "../constants";
import {fetchPost, fetchSyncPost} from "../util/fetch";
import {getDisplayName, getNotebookName, isEncryptedBox, pathPosix} from "../util/pathName";
import {showMessage} from "../dialog/message";
import {resolveAgentBlockMentions} from "./agentMentions";

const handleHostRequestError = (response: IWebSocketData) => {
    if (response.code === 0) {
        return false;
    }
    showMessage(response.msg, 6000, "error");
    return true;
};

const getLegacyDocumentActions = (
    scope: ProtyleDocumentScope,
    attention: ProtyleDocumentAttention,
    restoreScroll: ProtyleDocumentScrollRestore,
): TProtyleAction[] => {
    const actions: TProtyleAction[] = [];
    if (scope === "context") {
        actions.push(Constants.CB_GET_CONTEXT);
    } else if (scope === "subtree") {
        actions.push(Constants.CB_GET_ALL);
    }
    if (attention === "focus" || attention === "focus-and-highlight") {
        actions.push(Constants.CB_GET_FOCUS);
    }
    if (attention === "highlight" || attention === "focus-and-highlight") {
        actions.push(Constants.CB_GET_HL);
    }
    if (restoreScroll === "always") {
        actions.push(Constants.CB_GET_SCROLL);
    } else if (restoreScroll === "if-document") {
        actions.push(Constants.CB_GET_ROOTSCROLL);
    }
    return actions;
};

const getLegacyDisposition = (disposition: ProtyleDocumentDisposition) => {
    switch (disposition) {
        case "current":
            return {};
        case "new-tab":
            return {removeCurrentTab: false};
        case "duplicate-tab":
            return {openNewTab: true};
        case "background-tab":
            return {keepCursor: true};
        case "split-right":
            return {position: "right"};
        case "split-bottom":
            return {position: "bottom"};
    }
    const unhandledDisposition: never = disposition;
    return unhandledDisposition;
};

const openDocumentSearch = (app: App, notebookId: string, documentId: string) => {
    const blockInfoParam: IObject = {id: documentId};
    if (isEncryptedBox(notebookId)) {
        blockInfoParam.notebook = notebookId;
    }
    fetchPost("/api/block/getBlockInfo", blockInfoParam, (response) => {
        if (handleHostRequestError(response)) {
            return;
        }
        void openSearch({
            app,
            hotkey: Constants.DIALOG_SEARCH,
            notebookId: response.data.box,
            searchPath: getDisplayName(response.data.path, false, true),
        });
    });
};

const openDocumentHistory = (app: App, notebookId: string, documentId: string) => {
    const blockInfoParam: IObject = {id: documentId};
    if (isEncryptedBox(notebookId)) {
        blockInfoParam.notebook = notebookId;
    }
    fetchPost("/api/block/getBlockInfo", blockInfoParam, (blockResponse) => {
        if (handleHostRequestError(blockResponse)) {
            return;
        }
        openDocHistory({
            app,
            id: blockResponse.data.rootID,
            notebookId: blockResponse.data.box,
            pathString: blockResponse.data.rootTitle,
        });
    });
};

const openCardBrowser = (app: App, documentId: string) => {
    fetchPost("/api/block/getBlockInfo", {id: documentId}, (blockResponse) => {
        if (handleHostRequestError(blockResponse)) {
            return;
        }
        fetchPost("/api/filetree/getHPathByID", {id: documentId}, (pathResponse) => {
            if (handleHostRequestError(pathResponse)) {
                return;
            }
            viewCards(
                app,
                blockResponse.data.rootID,
                pathPosix().join(getNotebookName(blockResponse.data.box), pathResponse.data),
                "Tree",
            );
        });
    });
};

const rejectUnsupportedEncryptedOperation = (notebookId: string) => {
    if (!isEncryptedBox(notebookId)) {
        return false;
    }
    showMessage(window.siyuan.languages._kernel[313], 6000, "error");
    return true;
};

interface AgentChatPort {
    insertBlockMentions: (mentions: Array<{ id: string; label: string }>) => void;
}

const addBlocksToAgent = async (blockIds: readonly string[]) => {
    const dock = getDockByType("agentChat");
    if (!dock) {
        return;
    }
    const isReady = (value: unknown): value is AgentChatPort =>
        Boolean(value) && typeof (value as AgentChatPort).insertBlockMentions === "function";
    let agentChat = dock.data.agentChat;
    const dockItem = document.querySelector('.dock__item[data-type="agentChat"]');
    if (!isReady(agentChat) || !dockItem?.classList.contains("dock__item--active")) {
        dock.toggleModel("agentChat", true);
        agentChat = dock.data.agentChat;
    }
    if (!isReady(agentChat)) {
        return;
    }
    const mentions = await resolveAgentBlockMentions(
        blockIds,
        (id) => fetchSyncPost("/api/block/getRefText", {id}, undefined, {processResponse: false}),
    );
    if (mentions.length === 0) {
        return;
    }
    agentChat.insertBlockMentions(mentions);
};

const dispatchAppHostEvent = (app: App, event: ProtyleHostEvent) => {
    switch (event.type) {
        case "open-document":
            void openFileById({
                app,
                id: event.documentId,
                notebookId: event.notebookId,
                action: getLegacyDocumentActions(event.scope, event.attention, event.restoreScroll),
                scrollPosition: event.scroll === "start" ? "start" : undefined,
                zoomIn: event.zoom,
                ...getLegacyDisposition(event.disposition),
            });
            return;
        case "open-search":
            openGlobalSearch(
                app,
                event.query,
                event.queryMode === "replace",
                event.method === "keyword" ? {method: 0} : undefined,
            );
            return;
        case "open-document-search":
            openDocumentSearch(app, event.notebookId, event.documentId);
            return;
        case "open-outline":
            void openOutline({
                app,
                rootId: event.documentId,
                notebookId: event.notebookId,
                title: "",
                isPreview: event.preview,
            });
            return;
        case "open-backlinks":
            void openBacklink({app, blockId: event.documentId, notebookId: event.notebookId});
            return;
        case "open-graph":
            if (event.scope === "space") {
                getDockByType("globalGraph").toggleModel("globalGraph");
            } else if (!rejectUnsupportedEncryptedOperation(event.notebookId)) {
                void openGraph({app, blockId: event.documentId});
            }
            return;
        case "open-document-history":
            openDocumentHistory(app, event.notebookId, event.documentId);
            return;
        case "open-card-review":
            if (rejectUnsupportedEncryptedOperation(event.notebookId)) {
                return;
            }
            fetchPost("/api/riff/getTreeRiffDueCards", {rootID: event.documentId}, (response) => {
                if (handleHostRequestError(response)) {
                    return;
                }
                void openCardByData(app, response.data, "doc", event.documentId, response.data.name);
            });
            return;
        case "open-card-browser":
            if (rejectUnsupportedEncryptedOperation(event.notebookId)) {
                return;
            }
            openCardBrowser(app, event.documentId);
            return;
        case "open-card-deck-picker":
            if (rejectUnsupportedEncryptedOperation(event.notebookId)) {
                return;
            }
            makeCard(app, event.blockIds);
            return;
        case "add-blocks-to-agent":
            void addBlocksToAgent(event.blockIds).catch((error: unknown) => {
                console.error("[protyle-host:add-blocks-to-agent]", error);
                const message = error instanceof Error && error.message ?
                    error.message : window.siyuan.languages.unexpectedResponseError;
                showMessage(message, 6000, "error");
            });
            return;
        case "open-asset":
            openAsset(
                app,
                event.assetPath,
                event.page,
                event.disposition === "split-right" ? "right" : undefined,
                event.notebookId,
            );
            return;
        case "open-external":
            openByMobile(event.url);
            return;
        case "close-document":
            app.protyleEditors.forEach((editor) => {
                if (editor.block.rootID === event.documentId && editor.model) {
                    editor.model.parent.parent.removeTab(editor.model.parent.id);
                }
            });
            return;
        case "notify":
            showMessage(event.message, 6000, event.level === "error" ? "error" : "info");
            return;
        case "refresh-outline":
        case "refresh-backlinks":
        case "set-document-title":
        case "set-document-icon":
        case "activate-document":
        case "toggle-document-fullscreen":
        case "persist-workspace-layout":
        case "update-document-statistics":
        case "runtime-error":
            console.warn(`[protyle-host:unsupported-event] ${event.type}`);
            return;
    }
    const unhandledEvent: never = event;
    return unhandledEvent;
};

export const createAppProtyleHost = (app: App): ProtyleHostPort => ({
    dispatch: (event) => dispatchAppHostEvent(app, event),
});
