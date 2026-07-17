import {layoutToJSON} from "../layout/util";
/// #if !BROWSER
import {ipcRenderer} from "electron";
/// #endif
import {Constants} from "../constants";
import {Tab} from "../layout/Tab";
import {fetchSyncPost} from "../util/fetch";
import {showMessage} from "../dialog/message";
import {getDisplayName, isEncryptedBox, pathPosix} from "../util/pathName";
import {getSearch} from "../util/functions";

interface windowOptions {
    position?: {
        x: number,
        y: number,
    },
    width?: number,
    height?: number,
    alwaysOnTop?: boolean,
}

interface contentWindowOptions extends windowOptions {
    notebookId: string,
}

export const openNewWindow = (tab: Tab, options: windowOptions = {}) => {
    const json = {};
    layoutToJSON(tab, json);
    /// #if !BROWSER
    ipcRenderer.send(Constants.SIYUAN_OPEN_WINDOW, {
        position: options.position,
        width: options.width,
        height: options.height,
        alwaysOnTop: !!options.alwaysOnTop,
        // 需要 encode， 否则 https://github.com/siyuan-note/siyuan/issues/9343
        url: `${window.location.protocol}//${window.location.host}/stage/build/app/window.html?v=${Constants.SIYUAN_VERSION}&json=${encodeURIComponent(JSON.stringify([json]))}`
    });
    /// #endif
    tab.parent.removeTab(tab.id);
};

export const openNewWindowById = async (id: string | string[], options: contentWindowOptions) => {
    let ids = id;
    if (typeof ids === "string") {
        ids = [ids];
    }
    const json = [];
    for (let i = 0; i < ids.length; i++) {
        const blockInfoParam: IObject = {id: ids[i]};
        if (isEncryptedBox(options.notebookId)) {
            blockInfoParam.notebook = options.notebookId;
        }
        const response = await fetchSyncPost("/api/block/getBlockInfo", blockInfoParam);
        if (response.code === 3) {
            showMessage(response.msg);
            return;
        }
        json.push({
            title: response.data.rootTitle,
            docIcon: response.data.rootIcon,
            pin: false,
            active: true,
            instance: "Tab",
            action: "Tab",
            children: {
                notebookId: options.notebookId,
                blockId: ids[i],
                rootId: response.data.rootID,
                mode: "wysiwyg",
                instance: "Editor",
                action: response.data.rootID === ids[i] ? Constants.CB_GET_SCROLL : Constants.CB_GET_ALL
            }
        });
    }
    /// #if !BROWSER
    ipcRenderer.send(Constants.SIYUAN_OPEN_WINDOW, {
        position: options.position,
        width: options.width,
        height: options.height,
        alwaysOnTop: !!options.alwaysOnTop,
        url: `${window.location.protocol}//${window.location.host}/stage/build/app/window.html?v=${Constants.SIYUAN_VERSION}&json=${encodeURIComponent(JSON.stringify(json))}`
    });
    /// #endif
};

export const openAssetNewWindow = (assetPath: string, options: contentWindowOptions) => {
    /// #if !BROWSER
    const suffix = pathPosix().extname(assetPath).split("?")[0];
    if (Constants.SIYUAN_ASSETS_EXTS.includes(suffix)) {
        let docIcon = "iconPDF";
        if (Constants.SIYUAN_ASSETS_IMAGE.includes(suffix)) {
            docIcon = "iconImage";
        } else if (Constants.SIYUAN_ASSETS_AUDIO.includes(suffix)) {
            docIcon = "iconRecord";
        } else if (Constants.SIYUAN_ASSETS_VIDEO.includes(suffix)) {
            docIcon = "iconVideo";
        }
        const json: any = [{
            title: getDisplayName(assetPath),
            docIcon,
            pin: false,
            active: true,
            instance: "Tab",
            action: "Tab",
            children: {
                path: assetPath,
                notebookId: options.notebookId,
                page: parseInt(getSearch("page", assetPath)),
                instance: "Asset",
            }
        }];
        ipcRenderer.send(Constants.SIYUAN_OPEN_WINDOW, {
            position: options.position,
            width: options.width,
            height: options.height,
            alwaysOnTop: !!options.alwaysOnTop,
            url: `${window.location.protocol}//${window.location.host}/stage/build/app/window.html?v=${Constants.SIYUAN_VERSION}&json=${encodeURIComponent(JSON.stringify(json))}`
        });
    }
    /// #endif
};
