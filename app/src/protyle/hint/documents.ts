import {getNewDocTargetFromSavePath} from "../../util/parseNewDocTarget";
import {insertHTML} from "../util/insertHTML";
import {protyleContentIdentity} from "../util/contentLoad";
import {contentPathWithoutExtension, joinContentPath} from "./path";
import type {HintDocumentHPathResponse, HintDocumentSavePathResponse} from "./protocol";
import {beginHintRequest, reportHintRequestFailure, requestHint} from "./request";

type ReferencedDocumentPlacement = "configured" | "sub-document";

const insertDocumentReference = (
    protyle: IProtyle,
    notebookId: string,
    documentId: string,
    title: string,
) => {
    const trimmed = title.trim();
    const anchor = trimmed
        ? trimmed.substring(0, protyle.settings.editor.blockRefDynamicAnchorTextMaxLen)
        : protyle.localization.kernelText(16);
    insertHTML(`<span data-type="block-ref" data-id="${documentId}" data-notebook-id="${notebookId}" data-subtype="d">${Lute.EscapeHTMLStr(anchor)}</span>`, protyle);
    protyle.host.dispatch({
        type: "open-document",
        notebookId,
        documentId,
        disposition: "current",
        scope: "context",
        attention: "none",
        scroll: "auto",
        restoreScroll: "never",
        zoom: false,
    });
};

export const createReferencedDocument = (
    protyle: IProtyle,
    placement: ReferencedDocumentPlacement,
) => {
    const request = beginHintRequest(protyle, "document-create");
    const currentIdentity = protyleContentIdentity(protyle);
    const documentId = Lute.NewNodeID();
    let requestPath = "/api/filetree/createDoc";

    void (async () => {
        try {
            if (placement === "sub-document") {
                await requestHint<IWebSocketData>(protyle, requestPath, {
                    notebook: currentIdentity.notebookId,
                    path: joinContentPath(contentPathWithoutExtension(protyle.path!), documentId + ".sy"),
                    title: "",
                    md: "",
                }, "write", request, {
                    notebookId: currentIdentity.notebookId,
                    documentId,
                });
                if (request.isCurrent()) {
                    insertDocumentReference(protyle, currentIdentity.notebookId, documentId, "");
                }
                return;
            }

            requestPath = "/api/filetree/getDocCreateSavePath";
            const savePath = await requestHint<HintDocumentSavePathResponse>(
                protyle,
                requestPath,
                {},
                "read",
                request,
                currentIdentity,
            );
            if (!request.isCurrent()) {
                return;
            }

            const targetNotebookId = savePath.data.box;
            let hPath = "/";
            if (targetNotebookId === currentIdentity.notebookId) {
                requestPath = "/api/filetree/getHPathByPath";
                const response = await requestHint<HintDocumentHPathResponse>(protyle, requestPath, {
                    path: protyle.path,
                }, "read", request, currentIdentity);
                if (!request.isCurrent()) {
                    return;
                }
                hPath = response.data;
            }

            const target = getNewDocTargetFromSavePath({
                templatePath: savePath.data.path,
                hPath: hPath || "/",
                targetNotebookId,
                currentNotebookId: currentIdentity.notebookId,
                hasFocusTarget: true,
                currentPath: protyle.path,
            });
            const targetIdentity = {notebookId: targetNotebookId, documentId};
            if (target.kind === "hPath") {
                requestPath = "/api/filetree/createDocWithMd";
                await requestHint<IWebSocketData>(protyle, requestPath, {
                    path: target.hPath,
                    ...(targetNotebookId === currentIdentity.notebookId ? {
                        parentID: currentIdentity.documentId,
                    } : {}),
                    markdown: "",
                    titleEmpty: !target.title,
                }, "write", request, targetIdentity);
            } else {
                requestPath = "/api/filetree/createDoc";
                await requestHint<IWebSocketData>(protyle, requestPath, {
                    notebook: targetNotebookId,
                    path: joinContentPath(contentPathWithoutExtension(target.parentPath), documentId + ".sy"),
                    title: target.title,
                    md: "",
                }, "write", request, targetIdentity);
            }
            if (request.isCurrent()) {
                insertDocumentReference(protyle, targetNotebookId, documentId, target.title);
            }
        } catch (error) {
            reportHintRequestFailure(protyle, request, requestPath, error);
        }
    })();
};
