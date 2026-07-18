import {Protyle} from "../protyle";
import {setEditor} from "./util/setEmpty";
import {closePanel} from "./util/closePanel";
import {Constants} from "../constants";
import {fetchPost} from "../util/fetch";
import {onGet} from "../protyle/util/onGet";
import {addLoading} from "../protyle/ui/initUI";
import {highlightById, scrollCenter} from "../protyle/util/highlightById";
import {isInEmbedBlock} from "../protyle/util/hasClosest";
import {setEditMode} from "../protyle/util/setEditMode";
import {hideElements} from "../protyle/ui/hideElements";
import {pushBack} from "./util/MobileBackFoward";
import {setStorageVal} from "../protyle/util/compatibility";
import {showMessage} from "../dialog/message";
import {App} from "../index";
import {initMirror} from "../protyle/undo/globalUndo";
import {getDocByScroll, saveScroll} from "../protyle/scroll/saveScroll";
import {isEncryptedBox} from "../util/pathName";
import {mobileEditorOwner} from "./util/mobileEditorOwner";

const persistMobileDocument = (notebookId: string, id: string) => {
    window.siyuan.storage[Constants.LOCAL_DOCINFO] = {id, notebookId};
    setStorageVal(Constants.LOCAL_DOCINFO, window.siyuan.storage[Constants.LOCAL_DOCINFO]);
};

export const getCurrentEditor = () => {
    return window.siyuan.mobile.popEditor || window.siyuan.mobile.editor;
};

export const openMobileFileById = (app: App, notebookId: string, id: string,
                                   action: TProtyleAction[] = [Constants.CB_GET_HL],
                                   scrollPosition?: ScrollLogicalPosition,
                                   afterLoad?: () => void) => {
    const ownerGeneration = mobileEditorOwner.begin();
    const signal = ownerGeneration.signal;
    if (window.siyuan.mobile.editor) {
        window.siyuan.mobile.editor.protyle.ownerSignal = signal;
    }
    const isCurrent = () => mobileEditorOwner.isCurrent(ownerGeneration, true);
    const avPanelElement = document.querySelector(".av__panel");
    if (avPanelElement && !avPanelElement.classList.contains("fn__none")) {
        avPanelElement.dispatchEvent(new CustomEvent("click", {detail: "close"}));
    }
    if (window.siyuan.mobile.editor && window.siyuan.mobile.editor.protyle.notebookId === notebookId) {
        saveScroll(window.siyuan.mobile.editor.protyle);
        hideElements(["toolbar", "hint", "util"], window.siyuan.mobile.editor.protyle);
        if (window.siyuan.mobile.editor.protyle.contentElement.classList.contains("fn__none")) {
            setEditMode(window.siyuan.mobile.editor.protyle, "wysiwyg");
        }
        let blockElement;
        Array.from(window.siyuan.mobile.editor.protyle.wysiwyg.element.querySelectorAll(`[data-node-id="${id}"]`)).find((item: HTMLElement) => {
            if (!isInEmbedBlock(item)) {
                blockElement = item;
                return true;
            }
        });
        if (blockElement) {
            pushBack();
            if (action.includes(Constants.CB_GET_HL)) {
                highlightById(window.siyuan.mobile.editor.protyle, id, scrollPosition);
            } else {
                scrollCenter(window.siyuan.mobile.editor.protyle, blockElement, scrollPosition);
            }
            closePanel();
            // 更新文档浏览时间
            fetchPost("/api/storage/updateRecentDocViewTime", {
                rootID: window.siyuan.mobile.editor.protyle.block.rootID,
                notebookId,
            });
            persistMobileDocument(notebookId, id);
            afterLoad?.();
            return;
        }
    }

    const blockInfoParam: IObject = {id};
    if (isEncryptedBox(notebookId)) {
        blockInfoParam.notebook = notebookId;
    }
    fetchPost("/api/block/getBlockInfo", blockInfoParam, (data) => {
        if (!isCurrent()) {
            return;
        }
        if (data.code === 3) {
            showMessage(data.msg);
            return;
        }
        if (data.data?.box !== notebookId) {
            console.error("[Singularity/ProtyleIdentity] mobile block resolved to a different notebook", {
                blockId: id,
                expectedNotebookId: notebookId,
                actualNotebookId: data.data?.box,
            });
            return;
        }
        const protyleOptions: Omit<IProtyleOptions, "notebookId"> & { blockId: string } = {
            blockId: id,
            rootId: data.data.rootID,
            scrollPosition,
            action,
            render: {
                scroll: true,
                title: true,
                titleShowTop: true,
                background: true,
                gutter: true,
            },
            typewriterMode: true,
            preview: {
                actions: ["mp-wechat", "zhihu", "yuque"]
            },
            after: () => {
                if (isCurrent()) {
                    persistMobileDocument(notebookId, id);
                    afterLoad?.();
                }
            },
        };
        if (window.siyuan.mobile.editor && window.siyuan.mobile.editor.protyle.notebookId !== notebookId) {
            pushBack();
            window.siyuan.mobile.editor.destroy();
            window.siyuan.mobile.editor = undefined;
        }
        if (window.siyuan.mobile.editor) {
            window.siyuan.mobile.editor.protyle.title.element.removeAttribute("data-render");
            pushBack();
            addLoading(window.siyuan.mobile.editor.protyle);
            if (window.siyuan.mobile.editor.protyle.block.rootID !== data.data.rootID) {
                window.siyuan.mobile.editor.protyle.wysiwyg.element.innerHTML = "";
                fetchPost("/api/storage/updateRecentDocOpenTime", {rootID: data.data.rootID, notebookId});
            } else {
                fetchPost("/api/storage/updateRecentDocViewTime", {rootID: data.data.rootID, notebookId});
            }
            if (action.includes(Constants.CB_GET_SCROLL) && window.siyuan.storage[Constants.LOCAL_FILEPOSITION][data.data.rootID]) {
                getDocByScroll({
                    protyle: window.siyuan.mobile.editor.protyle,
                    scrollAttr: window.siyuan.storage[Constants.LOCAL_FILEPOSITION][data.data.rootID],
                    mergedOptions: protyleOptions,
                    signal,
                    isCurrent,
                    cb() {
                        if (!isCurrent()) {
                            return;
                        }
                        persistMobileDocument(notebookId, id);
                        initMirror(window.siyuan.mobile.editor.protyle);
                        afterLoad?.();
                        app.plugins.forEach(item => {
                            item.eventBus.emit("switch-protyle", {protyle: window.siyuan.mobile.editor.protyle});
                        });
                    }
                });
            } else {
                const getDocParam: IObject = {
                    id,
                    size: action.includes(Constants.CB_GET_ALL) ? Constants.SIZE_GET_MAX : window.siyuan.config.editor.dynamicLoadBlocks,
                    mode: action.includes(Constants.CB_GET_CONTEXT) ? 3 : 0,
                };
                if (isEncryptedBox(notebookId)) {
                    getDocParam.notebook = notebookId;
                }
                fetchPost("/api/filetree/getDoc", getDocParam, getResponse => {
                    if (!isCurrent() || window.siyuan.mobile.editor?.protyle.notebookId !== notebookId) {
                        return;
                    }
                    onGet({
                        data: getResponse,
                        protyle: window.siyuan.mobile.editor.protyle,
                        action,
                        scrollPosition,
                        afterCB() {
                            if (!isCurrent()) {
                                return;
                            }
                            persistMobileDocument(notebookId, id);
                            initMirror(window.siyuan.mobile.editor.protyle);
                            afterLoad?.();
                            app.plugins.forEach(item => {
                                item.eventBus.emit("switch-protyle", {protyle: window.siyuan.mobile.editor.protyle});
                            });
                        }
                    });
                }, undefined, undefined, signal);
            }
            window.siyuan.mobile.editor.protyle.undo.clear();
        } else {
            fetchPost("/api/storage/updateRecentDocOpenTime", {rootID: data.data.rootID, notebookId});
            window.siyuan.mobile.editor = new Protyle(app, document.getElementById("editor"), protyleOptions, {
                surface: "workspace",
                participation: "live",
                content: {mode: "bound", notebookId},
                initialLoad: "automatic",
                hostReadOnly: window.siyuan.config.readonly,
                signal,
            });
        }
        setEditor();
        closePanel();
    }, undefined, undefined, signal);
};
