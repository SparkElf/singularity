export interface SiYuanBlockUriTarget {
    readonly blockId: string;
    readonly documentId: string;
    readonly notebookId: string;
}

const BLOCK_ID_PATTERN = /^\/(\d{14}-\w{7})/;

export const buildSiYuanBlockUri = (blockId: string, notebookId: string, documentId: string) => {
    if (!blockId || !notebookId || !documentId) {
        throw new Error("[Singularity/ProtyleIdentity] SiYuan block URI requires block, notebook, and document identity");
    }
    return `siyuan://blocks/${blockId}?notebook=${encodeURIComponent(notebookId)}&document=${encodeURIComponent(documentId)}`;
};

export const parseSiYuanBlockUri = (value: string): SiYuanBlockUriTarget | undefined => {
    try {
        const uri = new URL(value);
        if ((uri.protocol !== "siyuan:" && uri.protocol !== "web+siyuan:") || uri.hostname !== "blocks") {
            return;
        }
        const blockId = uri.pathname.match(BLOCK_ID_PATTERN)?.[1];
        const notebookId = uri.searchParams.get("notebook");
        const documentId = uri.searchParams.get("document");
        if (!blockId || !notebookId || !documentId) {
            return;
        }
        return {blockId, documentId, notebookId};
    } catch {
        return;
    }
};
