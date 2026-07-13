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
import {fetchPost} from "../util/fetch";
import {getAllModels} from "../layout/getAll";
import {getDisplayName, getNotebookName, pathPosix} from "../util/pathName";
import {showMessage} from "../dialog/message";

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

const openDocumentSearch = (app: App, documentId: string) => {
    fetchPost("/api/block/getBlockInfo", {id: documentId}, (response) => {
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

const openDocumentHistory = (app: App, documentId: string) => {
    fetchPost("/api/block/getBlockInfo", {id: documentId}, (blockResponse) => {
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

const dispatchAppHostEvent = (app: App, event: ProtyleHostEvent) => {
    switch (event.type) {
        case "open-document":
            void openFileById({
                app,
                id: event.documentId,
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
            openDocumentSearch(app, event.documentId);
            return;
        case "open-outline":
            void openOutline({app, rootId: event.documentId, title: "", isPreview: event.preview});
            return;
        case "open-backlinks":
            void openBacklink({app, blockId: event.documentId});
            return;
        case "open-graph":
            if (event.scope === "space") {
                getDockByType("globalGraph").toggleModel("globalGraph");
            } else {
                void openGraph({app, blockId: event.documentId});
            }
            return;
        case "open-document-history":
            openDocumentHistory(app, event.documentId);
            return;
        case "open-card-review":
            fetchPost("/api/riff/getTreeRiffDueCards", {rootID: event.documentId}, (response) => {
                if (handleHostRequestError(response)) {
                    return;
                }
                void openCardByData(app, response.data, "doc", event.documentId, response.data.name);
            });
            return;
        case "open-card-browser":
            openCardBrowser(app, event.documentId);
            return;
        case "open-card-deck-picker":
            makeCard(app, event.blockIds);
            return;
        case "open-asset":
            openAsset(app, event.assetPath, event.page, event.disposition === "split-right" ? "right" : undefined);
            return;
        case "open-external":
            openByMobile(event.url);
            return;
        case "close-document":
            getAllModels().editor.forEach((editor) => {
                if (editor.editor.protyle.block.rootID === event.documentId) {
                    editor.parent.parent.removeTab(editor.parent.id);
                }
            });
            return;
        case "notify":
            showMessage(event.message, 6000, event.level === "error" ? "error" : "info");
            return;
    }
    const unhandledEvent: never = event;
    return unhandledEvent;
};

export const createAppProtyleHost = (app: App): ProtyleHostPort => ({
    dispatch: (event) => dispatchAppHostEvent(app, event),
});
