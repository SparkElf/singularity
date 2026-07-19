import {fetchPost} from "../../util/fetch";
import {Constants} from "../../constants";
import {getDefaultSubType, getDefaultType} from "../../search/getDefault";
import {hideMessage, showMessage} from "../../dialog/message";
import {
    getTextSiyuanFromTextHTML,
    plainTextForClipboard,
    readClipboard as readBrowserClipboard,
    readText as readBrowserText,
    writeText as writeBrowserText,
} from "./clipboard";
import type {ProtyleClipboardData} from "./clipboard";
import {downloadExportFile} from "./download";
import {getViewportWidth} from "./browserPlatform";

export {encodeBase64, getTextSiyuanFromTextHTML} from "./clipboard";
export {
    getEventName,
    isChromeBrowser,
    isInEdge,
    isIPad,
    isIPhone,
    isMac,
    isPhablet,
    isSafari,
    isWin11,
    isWindows,
} from "./browserPlatform";
export {isNotCtrl, isOnlyMeta, updateHotkeyAfterTip, updateHotkeyTip} from "./keyboard";

const DOCUMENT_ID_PATTERN = /^\d{14}-\w{7}$/;

export const parseStoredDocumentIdentity = (value: unknown): ILocalDocInfo | undefined => {
    if (!value || typeof value !== "object") {
        return;
    }
    const identity = value as Partial<ILocalDocInfo>;
    if (identity.id === "" && identity.notebookId === "") {
        return identity as ILocalDocInfo;
    }
    if (typeof identity.id !== "string" || typeof identity.notebookId !== "string" ||
        !DOCUMENT_ID_PATTERN.test(identity.id) || !DOCUMENT_ID_PATTERN.test(identity.notebookId)) {
        return;
    }
    return identity as ILocalDocInfo;
};

export const saveExportFile = (uri: string, msgId?: string) => {
    if (!uri) {
        return;
    }
    try {
        if (isInAndroid()) {
            window.JSAndroid.saveExportFile(uri);
            if (msgId) {
                hideMessage(msgId);
            }
            return;
        }
        if (isInIOS()) {
            window.webkit.messageHandlers.saveExportFile.postMessage(uri);
            if (msgId) {
                hideMessage(msgId);
            }
            return;
        }
        if (isInHarmony()) {
            window.JSHarmony.saveExportFile(uri);
            if (msgId) {
                hideMessage(msgId);
            }
            return;
        }
        downloadExportFile(uri);
        if (msgId) {
            hideMessage(msgId);
        }
    } catch (e) {
        if (msgId) {
            hideMessage(msgId);
        }
        showMessage("saveExportFile failed: " + e);
    }
};

export const readText = async () => {
    if (isInAndroid()) {
        return window.JSAndroid.readClipboard();
    } else if (isInHarmony()) {
        return window.JSHarmony.readClipboard();
    }
    return readBrowserText();
};


export const readClipboard = async () => {
    const text: ProtyleClipboardData = {textPlain: "", textHTML: "", siyuanHTML: ""};
    if (isInAndroid()) {
        text.textPlain = window.JSAndroid.readClipboard();
        text.textHTML = window.JSAndroid.readHTMLClipboard();
        const textObj = getTextSiyuanFromTextHTML(text.textHTML);
        text.textHTML = textObj.textHtml;
        text.siyuanHTML = textObj.textSiyuan;
        text.sourceIdentity = textObj.sourceIdentity;
        if (!text.siyuanHTML) {
            text.siyuanHTML = window.JSAndroid.readSiYuanHTMLClipboard();
        }
        return text;
    }
    if (isInHarmony()) {
        text.textPlain = window.JSHarmony.readClipboard();
        text.textHTML = window.JSHarmony.readHTMLClipboard();
        const textObj = getTextSiyuanFromTextHTML(text.textHTML);
        text.textHTML = textObj.textHtml;
        text.siyuanHTML = textObj.textSiyuan;
        text.sourceIdentity = textObj.sourceIdentity;
        if (!text.siyuanHTML) {
            text.siyuanHTML = window.JSHarmony.readSiYuanHTMLClipboard();
        }
        return text;
    }
    return readBrowserClipboard();
};

export const writeText = async (text: string) => {
    if (isInAndroid()) {
        window.JSAndroid.writeClipboard(text);
        return;
    }
    if (isInHarmony()) {
        window.JSHarmony.writeClipboard(text);
        return;
    }
    if (isInIOS()) {
        window.webkit.messageHandlers.setClipboard.postMessage(text);
        return;
    }
    return writeBrowserText(text);
};

export const copyPlainText = async (text: string) => writeText(plainTextForClipboard(text));

export const isHuawei = () => {
    return window.siyuan.config.system.osPlatform.toLowerCase().indexOf("huawei") > -1;
};

export const isDisabledFeature = (feature: string): boolean => {
    return window.siyuan.config.system.disabledFeatures?.indexOf(feature) > -1;
};

export const getScreenWidth = () => {
    if (isInAndroid()) {
        return window.JSAndroid.getScreenWidthPx();
    } else if (isInHarmony()) {
        return window.JSHarmony.getScreenWidthPx();
    }
    return getViewportWidth();
};

export const isInAndroid = () => {
    return window.siyuan.config.system.container === "android" && window.JSAndroid;
};

export const isInIOS = () => {
    return window.siyuan.config.system.container === "ios" && window.webkit?.messageHandlers;
};

export const isInMobileApp = () => {
    if (isInAndroid() || isInHarmony() || isInIOS()) {
        return true;
    }
    return false;
};

export const isInHarmony = () => {
    return window.siyuan.config.system.container === "harmony" && window.JSHarmony;
};

export const getLocalStorage = (cb: () => void) => {
    fetchPost("/api/storage/getLocalStorage", undefined, (response) => {
        window.siyuan.storage = response.data;
        // 历史数据迁移
        const defaultStorage: any = {};
        defaultStorage[Constants.LOCAL_SEARCHASSET] = {
            keys: [],
            col: "",
            row: "",
            layout: 0,
            method: 0,
            types: {},
            sort: 0,
            k: "",
        };
        defaultStorage[Constants.LOCAL_SEARCHUNREF] = {
            col: "",
            row: "",
            layout: 0,
        };
        Constants.SIYUAN_ASSETS_SEARCH.forEach(type => {
            defaultStorage[Constants.LOCAL_SEARCHASSET].types[type] = true;
        });
        defaultStorage[Constants.LOCAL_SEARCHKEYS] = {
            keys: [],
            replaceKeys: [],
            col: "",
            row: "",
            layout: 0,
            colTab: "",
            rowTab: "",
            layoutTab: 0
        };
        defaultStorage[Constants.LOCAL_PDFTHEME] = {
            light: "light",
            dark: "dark",
            annoColor: "var(--b3-pdf-background1)"
        };
        defaultStorage[Constants.LOCAL_LAYOUTS] = [];   // {name: "", layout:{}, time: number, filespaths: IFilesPath[]}
        defaultStorage[Constants.LOCAL_AI] = [];   // {name: "", memo: ""}
        defaultStorage[Constants.LOCAL_PLUGIN_DOCKS] = {};  // { pluginName: {dockId: IPluginDockTab}}
        defaultStorage[Constants.LOCAL_PLUGINTOPUNPIN] = [];
        defaultStorage[Constants.LOCAL_OUTLINE] = {keepCurrentExpand: false};
        defaultStorage[Constants.LOCAL_FILEPOSITION] = {}; // {id: IScrollAttr}
        defaultStorage[Constants.LOCAL_DIALOGPOSITION] = {}; // {id: IPosition}
        defaultStorage[Constants.LOCAL_HISTORY] = {
            notebookId: "%",
            type: 0,
            operation: "all",
            sideWidth: "256px",
            sideDocWidth: "256px",
            sideDiffWidth: "256px",
        };
        defaultStorage[Constants.LOCAL_FLASHCARD] = {
            fullscreen: false
        };
        defaultStorage[Constants.LOCAL_BAZAAR] = {
            theme: "0",
            template: "0",
            icon: "0",
            widget: "0",
        };
        defaultStorage[Constants.LOCAL_EXPORTWORD] = {removeAssets: false, mergeSubdocs: false};
        defaultStorage[Constants.LOCAL_EXPORTPDF] = {
            landscape: false,
            marginType: "0",
            scale: 1,
            pageSize: "A4",
            removeAssets: true,
            keepFold: false,
            mergeSubdocs: false,
            watermark: false,
            paged: true
        };
        defaultStorage[Constants.LOCAL_EXPORTIMG] = {
            keepFold: false,
            watermark: false
        };
        defaultStorage[Constants.LOCAL_DOCINFO] = {
            id: "",
            notebookId: "",
        };
        defaultStorage[Constants.LOCAL_IMAGES] = {
            file: "1f4c4",
            note: "1f5c3",
            folder: "1f4d1"
        };
        defaultStorage[Constants.LOCAL_EMOJIS] = {
            currentTab: "emoji"
        };
        defaultStorage[Constants.LOCAL_FONTSTYLES] = [];
        defaultStorage[Constants.LOCAL_CLOSED_TABS] = [];
        defaultStorage[Constants.LOCAL_FILESPATHS] = [];    // IFilesPath[]
        defaultStorage[Constants.LOCAL_SEARCHDATA] = {
            removed: true,
            page: 1,
            sort: 0,
            group: 0,
            hasReplace: false,
            method: 0,
            hPath: "",
            idPath: [],
            k: "",
            r: "",
            types: getDefaultType(),
            subTypes: getDefaultSubType(),
            replaceTypes: Object.assign({}, Constants.SIYUAN_DEFAULT_REPLACETYPES),
        };
        defaultStorage[Constants.LOCAL_ZOOM] = 1;
        defaultStorage[Constants.LOCAL_MOVE_PATH] = {keys: [], k: ""};
        defaultStorage[Constants.LOCAL_RECENT_DOCS] = {type: "viewedAt"};   // TRecentDocsSort

        [Constants.LOCAL_EXPORTIMG, Constants.LOCAL_SEARCHKEYS, Constants.LOCAL_PDFTHEME, Constants.LOCAL_BAZAAR,
            Constants.LOCAL_EXPORTWORD, Constants.LOCAL_EXPORTPDF, Constants.LOCAL_DOCINFO, Constants.LOCAL_FONTSTYLES,
            Constants.LOCAL_SEARCHDATA, Constants.LOCAL_ZOOM, Constants.LOCAL_LAYOUTS, Constants.LOCAL_AI,
            Constants.LOCAL_PLUGINTOPUNPIN, Constants.LOCAL_SEARCHASSET, Constants.LOCAL_FLASHCARD,
            Constants.LOCAL_DIALOGPOSITION, Constants.LOCAL_SEARCHUNREF, Constants.LOCAL_HISTORY,
            Constants.LOCAL_OUTLINE, Constants.LOCAL_FILEPOSITION, Constants.LOCAL_FILESPATHS, Constants.LOCAL_IMAGES,
            Constants.LOCAL_PLUGIN_DOCKS, Constants.LOCAL_EMOJIS, Constants.LOCAL_MOVE_PATH, Constants.LOCAL_RECENT_DOCS,
            Constants.LOCAL_CLOSED_TABS].forEach((key) => {
            if (typeof response.data[key] === "string") {
                try {
                    const parseData = JSON.parse(response.data[key]);
                    if (typeof parseData === "number") {
                        // https://github.com/siyuan-note/siyuan/issues/8852 Object.assign 会导致 number to Number
                        window.siyuan.storage[key] = parseData;
                    } else {
                        window.siyuan.storage[key] = Object.assign(defaultStorage[key], parseData);
                    }
                } catch (e) {
                    window.siyuan.storage[key] = defaultStorage[key];
                }
            } else if (typeof response.data[key] === "undefined") {
                window.siyuan.storage[key] = defaultStorage[key];
            }
        });
        const localDoc = parseStoredDocumentIdentity(window.siyuan.storage[Constants.LOCAL_DOCINFO]);
        if (!localDoc) {
            window.siyuan.storage[Constants.LOCAL_DOCINFO] = {id: "", notebookId: ""};
            setStorageVal(Constants.LOCAL_DOCINFO, window.siyuan.storage[Constants.LOCAL_DOCINFO]);
        } else {
            window.siyuan.storage[Constants.LOCAL_DOCINFO] = localDoc;
        }
        // 搜索数据添加 replaceTypes 兼容
        if (!window.siyuan.storage[Constants.LOCAL_SEARCHDATA].replaceTypes ||
            Object.keys(window.siyuan.storage[Constants.LOCAL_SEARCHDATA].replaceTypes).length === 0) {
            window.siyuan.storage[Constants.LOCAL_SEARCHDATA].replaceTypes = Object.assign({}, Constants.SIYUAN_DEFAULT_REPLACETYPES);
        }
        // Migrate stored search data to include subTypes when absent
        if (!window.siyuan.storage[Constants.LOCAL_SEARCHDATA].subTypes ||
            Object.keys(window.siyuan.storage[Constants.LOCAL_SEARCHDATA].subTypes).length === 0) {
            window.siyuan.storage[Constants.LOCAL_SEARCHDATA].subTypes = getDefaultSubType();
        }
        cb();
    });
};

export const setStorageVal = (key: string, val: any, cb?: () => void) => {
    if (window.siyuan.config.readonly || window.siyuan.isPublish) {
        return;
    }
    fetchPost("/api/storage/setLocalStorageVal", {
        app: Constants.SIYUAN_APPID,
        key,
        val,
    }, () => {
        if (cb) {
            cb();
        }
    });
};
