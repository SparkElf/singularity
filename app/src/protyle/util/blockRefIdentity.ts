const blockRefSelector = '[data-type~="block-ref"][data-id]';

const blockRefNotebooks = (html: string) => {
    const template = document.createElement("template");
    template.innerHTML = html;
    const notebooks = new Map<string, string>();
    template.content.querySelectorAll(blockRefSelector).forEach((item) => {
        const notebookId = item.getAttribute("data-notebook-id");
        if (notebookId) {
            notebooks.set(item.getAttribute("data-id")!, notebookId);
        }
    });
    return notebooks;
};

export const preserveBlockRefNotebookIDs = (sourceHTML: string, renderedHTML: string) => {
    const notebooks = blockRefNotebooks(sourceHTML);
    if (notebooks.size === 0) {
        return renderedHTML;
    }
    const template = document.createElement("template");
    template.innerHTML = renderedHTML;
    template.content.querySelectorAll(blockRefSelector).forEach((item) => {
        const notebookId = notebooks.get(item.getAttribute("data-id")!);
        if (notebookId) {
            item.setAttribute("data-notebook-id", notebookId);
        }
    });
    return template.innerHTML;
};

export const syncBlockRefNotebookIDs = (element: Element, authoritativeHTML: string) => {
    const notebooks = blockRefNotebooks(authoritativeHTML);
    element.querySelectorAll(blockRefSelector).forEach((item) => {
        const notebookId = notebooks.get(item.getAttribute("data-id")!);
        if (notebookId) {
            item.setAttribute("data-notebook-id", notebookId);
        } else {
            item.removeAttribute("data-notebook-id");
        }
    });
};
