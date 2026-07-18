import {Constants} from "../../constants";
import {escapeAttr, escapeHtml} from "../../util/escape";
import {contentPathExtension} from "../hint/path";

export interface AssetBlockDOMOptions {
    readonly imageAlt: string;
    readonly linkLabel: string;
    readonly path: string;
    readonly showNetworkMark: boolean;
}

const updatedAt = () => {
    const date = new Date();
    const part = (value: number) => value.toString().padStart(2, "0");
    return `${date.getFullYear()}${part(date.getMonth() + 1)}${part(date.getDate())}` +
        `${part(date.getHours())}${part(date.getMinutes())}${part(date.getSeconds())}`;
};

const escapeAttribute = (value: string) => escapeAttr(escapeHtml(value));

export const createAssetBlockDOM = (options: AssetBlockDOMOptions): string => {
    const extension = contentPathExtension(options.path);
    const path = escapeAttribute(options.path);
    if (Constants.SIYUAN_ASSETS_AUDIO.includes(extension)) {
        return `<div data-node-id="${Lute.NewNodeID()}" data-type="NodeAudio" class="iframe" updated="${updatedAt()}"><div class="iframe-content"><audio controls="controls" src="${path}"></audio>${Constants.ZWSP}</div><div class="protyle-attr" contenteditable="false">${Constants.ZWSP}</div></div>`;
    }
    if (Constants.SIYUAN_ASSETS_IMAGE.includes(extension)) {
        const networkMark = options.showNetworkMark
            ? '<span class="img__net"><svg><use xlink:href="#iconGlobe"></use></svg></span>'
            : "";
        return `<span contenteditable="false" data-type="img" class="img"><span> </span><span><span class="protyle-action protyle-icons"><span class="protyle-icon protyle-icon--only"><svg><use xlink:href="#iconMore"></use></svg></span></span><img src="${path}" data-src="${path}" alt="${escapeAttribute(options.imageAlt)}" /><span class="protyle-action__drag"></span>${networkMark}<span class="protyle-action__title"></span></span><span> </span></span>`;
    }
    if (Constants.SIYUAN_ASSETS_VIDEO.includes(extension)) {
        return `<div data-node-id="${Lute.NewNodeID()}" data-type="NodeVideo" class="iframe" updated="${updatedAt()}"><div class="iframe-content">${Constants.ZWSP}<video controls="controls" src="${path}"></video><span class="protyle-action__drag" contenteditable="false"></span></div><div class="protyle-attr" contenteditable="false">${Constants.ZWSP}</div></div>`;
    }
    return `<span data-type="a" data-href="${path}">${escapeHtml(options.linkLabel)}</span>`;
};
