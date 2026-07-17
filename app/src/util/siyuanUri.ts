export const buildSiYuanBlockUri = (blockId: string, notebookId: string) => {
    if (!blockId || !notebookId) {
        throw new Error("[Singularity/ProtyleIdentity] SiYuan block URI requires blockId and notebookId");
    }
    return `siyuan://blocks/${blockId}?notebook=${encodeURIComponent(notebookId)}`;
};
