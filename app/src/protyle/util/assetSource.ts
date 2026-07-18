import {protyleContentIdentity} from "./contentLoad";
import {getCompressURL} from "../../util/image";

/** Preserve persisted AV paths while routing browser-readable assets through the bound Session. */
export const resolveProtyleAssetSource = (protyle: IProtyle, path: string): string => {
    if (!path.startsWith("assets/")) {
        return path;
    }
    if (protyle.content.mode === "bound") {
        return protyle.session!.runtime.resources.resolveAsset(protyleContentIdentity(protyle), path);
    }
    return getCompressURL(path);
};

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
