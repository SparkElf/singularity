import {Constants} from "../../constants";
import {beginHintRequest, reportHintRequestFailure, requestHint} from "../hint/request";
import {contentPathWithoutExtension, joinContentPath} from "../hint/path";
import {protyleContentIdentity} from "../util/contentLoad";
import {normalizeFileName} from "../util/fileNameRules";
import {hasClosestBlock} from "../util/hasClosest";
import {hideElements} from "../ui/hideElements";
import {removeEmbed} from "./removeEmbed";

type NamedReferencePlacement = "configured" | "current-path";

const normalizeCreationTitle = (protyle: IProtyle, value: string) => {
    const normalized = normalizeFileName(value);
    if (normalized.replacedPathSeparator) {
        protyle.host.dispatch({
            type: "notify",
            level: "warning",
            message: protyle.localization.text("fileNameRule"),
        });
    }
    return normalized.name;
};

const insertDocumentReference = (
    protyle: IProtyle,
    notebookId: string,
    documentId: string,
    title: string,
) => {
    const anchor = title
        ? title.substring(0, protyle.settings.editor.blockRefDynamicAnchorTextMaxLen)
        : protyle.localization.kernelText(16);
    const referenceElements = protyle.toolbar.setInlineMark(protyle, "block-ref", "range", {
        type: "id",
        notebookId,
        color: `${documentId}${Constants.ZWSP}d${Constants.ZWSP}${anchor}`,
    });
    if (referenceElements[0]) {
        referenceElements[0].setAttribute("data-document-id", documentId);
        protyle.toolbar.range.selectNodeContents(referenceElements[0]);
    }
    hideElements(["toolbar"], protyle);
};

const requestContentPath = async (
    protyle: IProtyle,
    notebookId: string,
    documentId: string,
    path: string,
    request: ReturnType<typeof beginHintRequest>,
) => {
    const response = await requestHint<IWebSocketData>(protyle, "/api/filetree/getHPathByPath", {
        notebook: notebookId,
        path,
    }, "read", request, {notebookId, documentId});
    return contentPathWithoutExtension(response.data);
};

export const createNamedReferenceFromSelection = (
    protyle: IProtyle,
    selectText: string,
    nodeElement: HTMLElement,
    placement: NamedReferencePlacement,
) => {
    const request = beginHintRequest(protyle, "document-create");
    const currentIdentity = protyleContentIdentity(protyle);
    const candidateDocumentId = Lute.NewNodeID();
    const rawTitle = selectText.trim() || protyle.lute.BlockDOM2Content(nodeElement.outerHTML).replace(/\n/g, "").trim();
    const title = normalizeCreationTitle(protyle, rawTitle);
    let requestPath = "/api/filetree/getHPathByPath";

    void (async () => {
        try {
            let targetNotebookId = currentIdentity.notebookId;
            let pathDirectory: string;
            if (placement === "current-path") {
                pathDirectory = await requestContentPath(
                    protyle,
                    targetNotebookId,
                    currentIdentity.documentId,
                    protyle.path!,
                    request,
                );
            } else {
                requestPath = "/api/filetree/getRefCreateSavePath";
                const savePath = await requestHint<IWebSocketData>(protyle, requestPath, {
                    notebook: currentIdentity.notebookId,
                }, "read", request, currentIdentity);
                if (!request.isCurrent()) {
                    return;
                }
                targetNotebookId = savePath.data.box;
                const configuredPath = savePath.data.path as string;
                if (configuredPath.startsWith("/")) {
                    pathDirectory = contentPathWithoutExtension(configuredPath);
                } else {
                    const targetPath = targetNotebookId === currentIdentity.notebookId
                        ? protyle.path!
                        : configuredPath || "/";
                    requestPath = "/api/filetree/getHPathByPath";
                    const targetHPath = await requestContentPath(
                        protyle,
                        targetNotebookId,
                        candidateDocumentId,
                        targetPath,
                        request,
                    );
                    pathDirectory = configuredPath
                        ? contentPathWithoutExtension(joinContentPath(targetHPath, configuredPath))
                        : targetHPath;
                }
            }
            if (!request.isCurrent()) {
                return;
            }

            const targetIdentity = {notebookId: targetNotebookId, documentId: candidateDocumentId};
            const hPath = joinContentPath(pathDirectory, title || protyle.localization.kernelText(16));
            requestPath = "/api/filetree/getIDsByHPath";
            const existing = await requestHint<IWebSocketData>(protyle, requestPath, {
                notebook: targetNotebookId,
                path: hPath,
            }, "read", request, targetIdentity);
            if (!request.isCurrent()) {
                return;
            }
            if (existing.data.length > 0) {
                insertDocumentReference(protyle, targetNotebookId, existing.data[0], title);
                return;
            }

            requestPath = "/api/filetree/createDocWithMd";
            const created = await requestHint<IWebSocketData>(protyle, requestPath, {
                notebook: targetNotebookId,
                path: hPath,
                ...(targetNotebookId === currentIdentity.notebookId ? {
                    parentID: currentIdentity.documentId,
                } : {}),
                markdown: "",
                titleEmpty: !title,
            }, "write", request, targetIdentity);
            if (request.isCurrent()) {
                insertDocumentReference(protyle, targetNotebookId, created.data, title);
            }
        } catch (error) {
            reportHintRequestFailure(protyle, request, requestPath, error);
        }
    })();
};

export const createDocumentFromSelection = (protyle: IProtyle) => {
    if (getSelection().rangeCount === 0) {
        return;
    }
    const range = getSelection().getRangeAt(0);
    const nodeElement = hasClosestBlock(range.startContainer);
    if (!nodeElement) {
        return;
    }
    let nodeElements = Array.from(protyle.wysiwyg.element.querySelectorAll<HTMLElement>(".protyle-wysiwyg--select"));
    if (nodeElements.length === 0) {
        nodeElements = [nodeElement];
    }
    let html = "";
    let title = range.toString();
    if (!title) {
        title = nodeElements[0].textContent!;
        nodeElements.forEach((element) => {
            html += removeEmbed(element);
        });
        if (!title) {
            return;
        }
    } else {
        const container = document.createElement("div");
        container.appendChild(range.cloneContents());
        html = container.innerHTML;
    }
    if (title.length > 10) {
        title = title.substring(0, 10) + "...";
    }
    title = normalizeCreationTitle(protyle, title);

    const request = beginHintRequest(protyle, "document-create");
    const currentIdentity = protyleContentIdentity(protyle);
    const documentId = Lute.NewNodeID();
    const identity = {notebookId: currentIdentity.notebookId, documentId};
    void requestHint<IWebSocketData>(protyle, "/api/filetree/createDoc", {
        notebook: identity.notebookId,
        path: joinContentPath(contentPathWithoutExtension(protyle.path!), documentId + ".sy"),
        title,
        md: protyle.lute.BlockDOM2StdMd(html),
    }, "write", request, identity).catch((error) => {
        reportHintRequestFailure(protyle, request, "/api/filetree/createDoc", error);
    });
};
