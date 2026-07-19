const blockRefSelector = '[data-type~="block-ref"][data-id]';

interface BlockRefContentIdentity {
    readonly documentId: string;
    readonly notebookId: string;
}

const blockRefContentIdentities = (html: string) => {
    const template = document.createElement("template");
    template.innerHTML = html;
    const identities = new Map<string, BlockRefContentIdentity[]>();
    template.content.querySelectorAll(blockRefSelector).forEach((item) => {
        const notebookId = item.getAttribute("data-notebook-id");
        const documentId = item.getAttribute("data-document-id");
        if (notebookId && documentId) {
            const id = item.getAttribute("data-id")!;
            const targets = identities.get(id) ?? [];
            targets.push({documentId, notebookId});
            identities.set(id, targets);
        }
    });
    return identities;
};

export const preserveBlockRefContentIdentities = (sourceHTML: string, renderedHTML: string) => {
    const identities = blockRefContentIdentities(sourceHTML);
    if (identities.size === 0) {
        return renderedHTML;
    }
    const template = document.createElement("template");
    template.innerHTML = renderedHTML;
    template.content.querySelectorAll(blockRefSelector).forEach((item) => {
        const identity = identities.get(item.getAttribute("data-id")!)?.shift();
        if (identity) {
            item.setAttribute("data-notebook-id", identity.notebookId);
            item.setAttribute("data-document-id", identity.documentId);
        }
    });
    return template.innerHTML;
};

export const syncBlockRefContentIdentities = (element: Element, authoritativeHTML: string) => {
    const identities = blockRefContentIdentities(authoritativeHTML);
    element.querySelectorAll(blockRefSelector).forEach((item) => {
        const identity = identities.get(item.getAttribute("data-id")!)?.shift();
        if (identity) {
            item.setAttribute("data-notebook-id", identity.notebookId);
            item.setAttribute("data-document-id", identity.documentId);
        } else {
            item.removeAttribute("data-notebook-id");
            item.removeAttribute("data-document-id");
        }
    });
};
