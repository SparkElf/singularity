/**
 * Format a document name for the editor surface without consulting workspace
 * paths or application globals.
 */
export const getProtyleDocumentDisplayName = (
    name: string,
    titleEmpty = false,
    emptyTitle = "",
): string => {
    if (titleEmpty) {
        return emptyTitle;
    }
    const basename = name.split(/[\\/]/).pop() ?? name;
    return basename.endsWith(".sy") ? basename.slice(0, -3) : basename;
};
