import {Constants} from "../../constants";
import {escapeAttr} from "../../util/escape";
import {assetDisplayName, contentPathExtension} from "./path";

const updatedAt = () => {
    const date = new Date();
    const part = (value: number) => value.toString().padStart(2, "0");
    return `${date.getFullYear()}${part(date.getMonth() + 1)}${part(date.getDate())}` +
        `${part(date.getHours())}${part(date.getMinutes())}${part(date.getSeconds())}`;
};

export const genAssetHTML = (path: string): string => {
    const type = contentPathExtension(path);
    const escapedPath = escapeAttr(path);
    const name = escapeAttr(assetDisplayName(path));
    if (Constants.SIYUAN_ASSETS_AUDIO.includes(type)) {
        return `<div data-node-id="${Lute.NewNodeID()}" data-type="NodeAudio" class="iframe" updated="${updatedAt()}"><div class="iframe-content"><audio controls="controls" src="${escapedPath}"></audio>${Constants.ZWSP}</div><div class="protyle-attr" contenteditable="false">${Constants.ZWSP}</div></div>`;
    }
    if (Constants.SIYUAN_ASSETS_IMAGE.includes(type)) {
        return `<span contenteditable="false" data-type="img" class="img"><span> </span><span><span class="protyle-action protyle-icons"><span class="protyle-icon protyle-icon--only"><svg><use xlink:href="#iconMore"></use></svg></span></span><img src="${escapedPath}" data-src="${escapedPath}" alt="${name}" /><span class="protyle-action__drag"></span><span class="protyle-action__title"></span></span><span> </span></span>`;
    }
    if (Constants.SIYUAN_ASSETS_VIDEO.includes(type)) {
        return `<div data-node-id="${Lute.NewNodeID()}" data-type="NodeVideo" class="iframe" updated="${updatedAt()}"><div class="iframe-content">${Constants.ZWSP}<video controls="controls" src="${escapedPath}"></video><span class="protyle-action__drag" contenteditable="false"></span></div><div class="protyle-attr" contenteditable="false">${Constants.ZWSP}</div></div>`;
    }
    return `<span data-type="a" data-href="${escapedPath}">${name}${type}</span>`;
};
