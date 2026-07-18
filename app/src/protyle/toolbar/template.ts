export const previewTemplate = (
    protyle: IProtyle,
    path: string,
    element: Element,
    parentId: string,
) => {
    if (!path) {
        element.innerHTML = "";
        return;
    }
    const generation = path;
    element.setAttribute("data-preview-path", generation);
    void protyle.transport!.request<{data: {content: string}}>("/api/template/render", {
        id: parentId,
        path,
        preview: true,
    }, {
        identity: {
            documentId: protyle.options.blockId!,
            notebookId: protyle.notebookId,
        },
        intent: "read",
        signal: protyle.requestSignal,
    }).then((response) => {
        if (protyle.destroyed || protyle.requestSignal.aborted ||
            element.getAttribute("data-preview-path") !== generation) {
            return;
        }
        element.innerHTML = `<div class="protyle-wysiwyg" style="padding: 8px">${response.data.content.replace(/contenteditable="true"/g, "")}</div>`;
    }).catch((error) => {
        if (!protyle.requestSignal.aborted && element.getAttribute("data-preview-path") === generation) {
            console.error("[protyle.transport] template preview failed", error);
        }
    });
};
