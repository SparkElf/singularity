import type {
    ProtyleDocumentAttention,
    ProtyleDocumentDisposition,
    ProtyleDocumentScope,
    ProtyleDocumentScrollRestore,
    ProtyleHostDispatchEvent,
    ProtyleHostPort,
} from "../../../enterprise/packages/protyle-browser/src/contracts";
import type {App} from "../index";
import {openAsset, openFileById, updatePanelByEditor} from "../editor/util";
import {openGlobalSearch} from "../search/util";
import {openSearch} from "../search/spread";
import {
    openBacklink,
    openGraph,
    openOutline,
    refreshBacklinkPanels,
    refreshOutlinePanels,
} from "../layout/dock/util";
import {getDockByType} from "../layout/tabUtil";
import {openDocHistory} from "../history/doc";
import {openCardByData} from "../card/openCard";
import {viewCards} from "../card/viewCards";
import {makeCard} from "../card/makeCard";
import {openByMobile} from "../editor/openLink";
import {deleteFile} from "../editor/deleteFile";
import {Constants} from "../constants";
import {fetchPost, fetchSyncPost} from "../util/fetch";
import {
    getDisplayName,
    getNotebookName,
    isEncryptedBox,
    isSameNotebookContentDomain,
    movePathTo,
    moveToPath,
    pathPosix,
} from "../util/pathName";
import {showMessage} from "../dialog/message";
import {resolveAgentBlockMentions} from "./agentMentions";
import {saveLayout, setPanelFocus} from "../layout/util";
import {renderStatusbarCounter} from "../layout/status";
import {AIChat} from "../ai/chat";
import {AIActions} from "../ai/actions";
import {exportMd, openFileAttr, openWechatNotify} from "../menus/commonMenuItem";
import {hintMoveBlock} from "../protyle/hint/extend";
import {tableMenu} from "../menus/protyle";
import {renameAsset} from "../editor/rename";
import {openBlockRefTransfer} from "../menus/block";
import {getEditorRange} from "../protyle/util/selection";
import {hasClosestByTag} from "../protyle/util/hasClosest";
import {updateFileTreeEmoji, updateOutlineEmoji} from "../emoji";
import {confirmDialog} from "../dialog/confirmDialog";
import {needSubscribe} from "../util/needSubscribe";
import {getCloudURL} from "../config/util/about";
import {resize} from "../protyle/util/resize";
import {pushBackLocation} from "../util/backForward";

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
            notebookId,
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
            notebookId,
            pathString: blockResponse.data.rootTitle,
        });
    });
};

const openCardBrowser = (app: App, notebookId: string, documentId: string) => {
    fetchPost("/api/block/getBlockInfo", {id: documentId}, (blockResponse) => {
        if (handleHostRequestError(blockResponse)) {
            return;
        }
        fetchPost("/api/filetree/getHPathByID", {id: documentId, notebook: notebookId}, (pathResponse) => {
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

const isCurrentWorkspaceDocument = (app: App, notebookId: string, documentId: string) => {
    const activeEditor = app.protyleEditors.getActive();
    return activeEditor?.surface === "workspace" &&
        activeEditor.block.rootID === documentId &&
        isSameNotebookContentDomain(activeEditor.notebookId, notebookId);
};

const requireSourceEditor = (
    app: App,
    event: {readonly sourceEditorId: string},
) => {
    const editor = app.protyleEditors.find((candidate) => candidate.id === event.sourceEditorId);
    if (!editor) {
        throw new Error(`[protyle-host] source editor unavailable: ${event.sourceEditorId}`);
    }
    return editor;
};

const requireEditorBlock = (
    editor: IProtyle,
    blockId: string,
) => {
    const block = editor.wysiwyg.element.querySelector(`[data-node-id="${blockId}"]`);
    if (!block) {
        throw new Error(`[protyle-host] block unavailable for ${editor.notebookId}:${editor.options.blockId}:${blockId}`);
    }
    return block;
};

const requireEditorBlocks = (
    editor: IProtyle,
    blockIds: readonly string[],
) => blockIds.map((blockId) => requireEditorBlock(editor, blockId));

const openTableActions = (editor: IProtyle, nodeElement: Element) => {
    let range = getEditorRange(nodeElement);
    const tableElement = nodeElement.querySelector("table");
    if (!tableElement) {
        throw new Error(`[protyle-host:open-table-menu] table unavailable for ${nodeElement.getAttribute("data-node-id")}`);
    }
    if (!tableElement.contains(range.startContainer)) {
        const firstCell = tableElement.querySelector("th, td");
        if (!firstCell) {
            throw new Error(`[protyle-host:open-table-menu] table has no cells for ${nodeElement.getAttribute("data-node-id")}`);
        }
        range = getEditorRange(firstCell);
    }
    const cellElement = hasClosestByTag(range.startContainer, "TD") ||
        hasClosestByTag(range.startContainer, "TH") || tableElement.querySelector("th, td");
    if (!cellElement) {
        throw new Error(`[protyle-host:open-table-menu] active cell unavailable for ${nodeElement.getAttribute("data-node-id")}`);
    }
    const menu = window.siyuan.menus.menu;
    menu.remove();
    tableMenu(editor, nodeElement, cellElement as HTMLTableCellElement, range).menus
        .forEach((item) => menu.addItem(item));
    const rect = nodeElement.getBoundingClientRect();
    menu.popup({x: rect.left, y: rect.bottom});
};

interface AgentChatPort {
    insertBlockMentions: (mentions: Array<{ id: string; label: string }>) => void;
}

const addBlocksToAgent = async (notebookId: string, blockIds: readonly string[]) => {
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
        (id) => {
            const refTextParam: IObject = {id};
            if (isEncryptedBox(notebookId)) {
                refTextParam.notebook = notebookId;
            }
            return fetchSyncPost(
                "/api/block/getRefText",
                refTextParam,
                undefined,
                {processResponse: false}
            );
        },
    );
    if (mentions.length === 0) {
        return;
    }
    agentChat.insertBlockMentions(mentions);
};

const openAIWriting = (
    app: App,
    event: {readonly blockId: string; readonly sourceEditorId: string},
) => {
    const editor = requireSourceEditor(app, event);
    const blockElement = requireEditorBlock(editor, event.blockId);
    AIChat(editor, blockElement);
};

const toggleDocumentFullscreen = (
    app: App,
    event: {readonly sourceEditorId: string},
) => {
    const editor = requireSourceEditor(app, event);
    const enteringFullscreen = !editor.element.classList.contains("fullscreen");
    editor.element.classList.toggle("fullscreen", enteringFullscreen);
    document.getElementById("drag")?.classList.toggle("fn__hidden", enteringFullscreen);
    window.siyuan.editorIsFullscreen = enteringFullscreen;
    app.protyleEditors.forEach((candidate) => {
        if (candidate !== editor && candidate.element.classList.contains("fullscreen")) {
            candidate.element.classList.remove("fullscreen");
            resize(candidate);
        }
    });
    resize(editor);
};

const dispatchAppHostEvent = (app: App, event: ProtyleHostDispatchEvent) => {
    switch (event.type) {
        case "open-document":
            void openFileById({
                app,
                id: event.blockId,
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
                void openGraph({
                    app,
                    blockId: event.documentId,
                    notebookId: event.notebookId,
                });
            }
            return;
        case "open-document-history":
            openDocumentHistory(app, event.notebookId, event.documentId);
            return;
        case "open-document-move": {
            const editor = requireSourceEditor(app, event);
            const path = editor.path!;
            movePathTo({
                cb: (toPath, toNotebook) => moveToPath([path], toNotebook[0], toPath[0]),
                flashcard: false,
                paths: [path],
                rootIDs: [event.documentId],
            });
            return;
        }
        case "delete-document": {
            const editor = requireSourceEditor(app, event);
            deleteFile(event.notebookId, editor.path!);
            return;
        }
        case "open-document-export": {
            const item = exportMd(event.blockId, event.notebookId);
            if (!item) {
                return;
            }
            const menu = window.siyuan.menus.menu;
            menu.remove();
            menu.addItem(item);
            menu.popup(event.position);
            return;
        }
        case "upload-cloud-assets":
            if (!needSubscribe()) {
                confirmDialog(
                    "📦 " + window.siyuan.languages.uploadAssets2CDN,
                    window.siyuan.languages.uploadAssets2CDNConfirmTip,
                    () => fetchPost("/api/asset/uploadCloud", {id: event.blockId}),
                );
            }
            return;
        case "share-document-community":
            confirmDialog(
                "🤩 " + window.siyuan.languages.share2Liandi,
                window.siyuan.languages.share2LiandiConfirmTip.replace("${accountServer}", getCloudURL("")),
                () => fetchPost("/api/export/export2Liandi", {
                    id: event.blockId,
                    notebook: event.notebookId,
                }),
            );
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
            openCardBrowser(app, event.notebookId, event.documentId);
            return;
        case "open-card-deck-picker":
            if (rejectUnsupportedEncryptedOperation(event.notebookId)) {
                return;
            }
            makeCard(app, event.blockIds);
            return;
        case "add-blocks-to-agent":
            void addBlocksToAgent(event.notebookId, event.blockIds).catch((error: unknown) => {
                console.error("[protyle-host:add-blocks-to-agent]", error);
                const message = error instanceof Error && error.message ?
                    error.message : window.siyuan.languages.unexpectedResponseError;
                showMessage(message, 6000, "error");
            });
            return;
        case "open-ai-writing":
            openAIWriting(app, event);
            return;
        case "open-ai-actions": {
            const editor = requireSourceEditor(app, event);
            AIActions(requireEditorBlocks(editor, event.blockIds), editor);
            return;
        }
        case "open-block-attributes": {
            const editor = requireSourceEditor(app, event);
            requireEditorBlock(editor, event.blockId);
            void editor.session!.runtime.transport.request<IWebSocketData>(
                "/api/attr/getBlockAttrs",
                {id: event.blockId},
                {
                    identity: {
                        documentId: event.documentId,
                        notebookId: event.notebookId,
                    },
                    intent: "read",
                    signal: editor.requestSignal,
                },
            ).then((response) => {
                openFileAttr(response.data, event.focus, editor, event.notebookId);
            }).catch((error) => {
                if (!editor.requestSignal.aborted) {
                    console.error("[protyle-host:open-block-attributes] request failed", error);
                }
            });
            return;
        }
        case "open-block-move": {
            movePathTo({
                cb: (toPath) => {
                    const editor = requireSourceEditor(app, event);
                    hintMoveBlock(toPath[0], requireEditorBlocks(editor, event.blockIds), editor);
                },
                flashcard: false,
            });
            return;
        }
        case "open-block-ref-transfer": {
            const editor = requireSourceEditor(app, event);
            requireEditorBlock(editor, event.blockId);
            openBlockRefTransfer(event.blockId, async (targetId) => {
                const currentEditor = requireSourceEditor(app, event);
                requireEditorBlock(currentEditor, event.blockId);
                await currentEditor.session!.runtime.transport.request<IWebSocketData>(
                    "/api/block/transferBlockRef",
                    {fromID: event.blockId, toID: targetId},
                    {
                        identity: {
                            documentId: event.documentId,
                            notebookId: event.notebookId,
                        },
                        intent: "write",
                        signal: currentEditor.requestSignal,
                    },
                );
            });
            return;
        }
        case "open-block-reminder": {
            const editor = requireSourceEditor(app, event);
            openWechatNotify(requireEditorBlock(editor, event.blockId));
            return;
        }
        case "open-table-menu": {
            const editor = requireSourceEditor(app, event);
            openTableActions(editor, requireEditorBlock(editor, event.blockId));
            return;
        }
        case "rename-asset":
            requireEditorBlock(requireSourceEditor(app, event), event.blockId);
            renameAsset(event.assetPath);
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
                if (editor.block.rootID === event.documentId &&
                    isSameNotebookContentDomain(editor.notebookId, event.notebookId) && editor.model) {
                    editor.model.parent.parent.removeTab(editor.model.parent.id);
                }
            });
            return;
        case "notify":
            showMessage(event.message, 6000, event.level === "error" ? "error" : "info");
            return;
        case "refresh-outline":
            refreshOutlinePanels(
                event.notebookId,
                event.documentId,
                () => isCurrentWorkspaceDocument(app, event.notebookId, event.documentId),
            );
            return;
        case "refresh-backlinks":
            refreshBacklinkPanels(
                event.notebookId,
                event.documentId,
                () => isCurrentWorkspaceDocument(app, event.notebookId, event.documentId),
            );
            return;
        case "activate-document": {
            const editor = requireSourceEditor(app, event);
            app.protyleEditors.activate(editor);
            if (editor.surface === "workspace") {
                if (editor.model) {
                    setPanelFocus(editor.model.element.parentElement.parentElement);
                }
                updatePanelByEditor({
                    protyle: editor,
                    focus: false,
                    pushBackStack: false,
                    reload: false,
                    resize: false,
                });
            }
            return;
        }
        case "record-navigation-location": {
            const editor = requireSourceEditor(app, event);
            pushBackLocation(editor, {
                blockId: event.blockId,
                position: event.position,
                zoomId: event.zoomId,
            });
            return;
        }
        case "update-document-statistics":
            if (app.protyleEditors.getActive() === requireSourceEditor(app, event)) {
                renderStatusbarCounter(event.statistics);
            }
            return;
        case "set-document-icon":
            updateFileTreeEmoji(event.icon, event.documentId);
            updateOutlineEmoji(event.icon, event.documentId);
            return;
        case "set-document-title":
            app.protyleEditors.forEach((editor) => {
                if (editor.content.mode === "bound" &&
                    editor.content.notebookId === event.notebookId &&
                    editor.options.blockId === event.documentId) {
                    editor.model?.parent.updateTitle(event.title);
                }
            });
            return;
        case "toggle-document-fullscreen":
            toggleDocumentFullscreen(app, event);
            return;
        case "persist-workspace-layout":
            saveLayout();
            return;
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
