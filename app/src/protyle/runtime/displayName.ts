/** 为编辑器生成文档显示名，只处理传入名称，不读取工作区路径或应用全局状态。 */
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
