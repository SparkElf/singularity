export interface ProtyleDocumentDragTarget {
    readonly documentId: string;
    readonly notebookId: string;
}

export const encodeDocumentDragTargets = (targets: readonly ProtyleDocumentDragTarget[]) =>
    JSON.stringify(targets);

export const parseDocumentDragTargets = (value: string): readonly ProtyleDocumentDragTarget[] => {
    let parsed: unknown;
    try {
        parsed = JSON.parse(value);
    } catch {
        return [];
    }
    if (!Array.isArray(parsed) || parsed.some((target) =>
        !target || typeof target !== "object" ||
        typeof target.documentId !== "string" || typeof target.notebookId !== "string")) {
        return [];
    }
    return parsed as ProtyleDocumentDragTarget[];
};
