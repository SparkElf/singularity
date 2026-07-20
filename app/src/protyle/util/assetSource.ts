import {protyleContentIdentity} from "./contentLoad";

const thumbnailAssetSource = (path: string) =>
    path.startsWith("assets/") && [".jpeg", ".jpg", ".png"].some((extension) => path.endsWith(extension))
        ? `${path}?style=thumb`
        : path;

/** 保留持久化资源路径，并将浏览器可读资源通过绑定 Session 路由。 */
export const resolveProtyleAssetSource = (protyle: IProtyle, path: string): string => {
    if (!path.startsWith("assets/")) {
        return path;
    }
    if (protyle.content.mode === "bound") {
        return protyle.runtime.resources.resolveAsset(protyleContentIdentity(protyle), path);
    }
    return thumbnailAssetSource(path);
};

/** 将内容树中待解析的图片资源替换为当前编辑器身份对应的可读地址。 */
export const resolveProtyleContentAssetSources = (protyle: IProtyle, root: ParentNode): void => {
    root.querySelectorAll<HTMLImageElement>(".img img[data-src]").forEach((image) => {
        const persistedSource = image.getAttribute("data-src");
        if (persistedSource) {
            image.setAttribute("src", resolveProtyleAssetSource(protyle, persistedSource));
        }
    });
};

/** 解析背景样式中的资源路径，并通过当前编辑器身份生成安全地址。 */
export const resolveProtyleAssetBackground = (protyle: IProtyle, cssText: string): string => {
    const style = protyle.wysiwyg.element.ownerDocument.createElement("span").style;
    style.cssText = cssText;
    const match = /^url\((?:"([^"]*)"|'([^']*)'|([^)]*))\)$/i.exec(style.backgroundImage);
    const path = match?.[1] ?? match?.[2] ?? match?.[3]?.trim();
    if (!path?.startsWith("assets/")) {
        return cssText;
    }
    style.backgroundImage = `url(${JSON.stringify(resolveProtyleAssetSource(protyle, path))})`;
    return style.cssText;
};
