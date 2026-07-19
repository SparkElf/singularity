import {getIconByType} from "../util/getIconByType";
import {Constants} from "../../constants";
import {net2LocalAssets, updateReadonly} from "./action";
import {setEditMode} from "../util/setEditMode";
import {RecordMedia} from "../util/RecordMedia";
import {uploadFiles} from "../upload";
import {hasClosestBlock, hasTopClosestByClassName} from "../util/hasClosest";
import {zoomOut} from "../util/zoom";
import {getEditorRange} from "../util/selection";
import {onGet} from "../util/onGet";
import {hideElements} from "../ui/hideElements";
import {reloadProtyle} from "../util/reload";
import {getNoContainerElement} from "../wysiwyg/getBlock";
import {openTitleMenu} from "../header/openTitleMenu";
import {emitProtylePluginMenu} from "../util/plugin";
import {isMac, isNarrowViewport, isTouchInput} from "../util/browserPlatform";
import {isOnlyMeta, updateHotkeyTip} from "../util/keyboard";
import {listIndent, listOutdent} from "../wysiwyg/list";
import {improveBreadcrumbAppearance} from "../wysiwyg/renderBacklink";
import {beginProtyleContentLoad, protyleContentIdentity, requestProtyleContent} from "../util/contentLoad";
import type {ProtyleOverlayHandle} from "../../../../enterprise/packages/protyle-browser/src/contracts";

type BreadcrumbMenuHandle = ReturnType<NonNullable<IProtyle["runtime"]>["menu"]["open"]>;

const requestBreadcrumb = <TResponse>(
    protyle: IProtyle,
    path: string,
    body: unknown,
    intent: "read" | "write" = "read",
) => protyle.session!.runtime.transport.request<TResponse>(path, body, {
    identity: protyleContentIdentity(protyle),
    intent,
    signal: protyle.requestSignal,
});

const reportBreadcrumbFailure = (protyle: IProtyle, action: string, error: unknown) => {
    if (!protyle.requestSignal.aborted) {
        console.error(`[protyle.breadcrumb] ${action} failed`, error);
    }
};

const submitBreadcrumb = (protyle: IProtyle, path: string, body: unknown) => {
    void requestBreadcrumb<IWebSocketData>(protyle, path, body, "write")
        .catch((error) => reportBreadcrumbFailure(protyle, path, error));
};

export class Breadcrumb {
    public element: HTMLElement;
    private mediaRecorder: RecordMedia;
    private id: string;
    private menuHandle?: BreadcrumbMenuHandle;
    private recordingOverlay?: {readonly element: HTMLElement; readonly handle: ProtyleOverlayHandle};
    private renderGeneration = 0;
    private restoreOnMouseMove = false;
    private readonly protyle: IProtyle;

    private closeMenu() {
        const handle = this.menuHandle;
        this.menuHandle = undefined;
        handle?.close();
    }

    private openMenu(protyle: IProtyle) {
        this.closeMenu();
        const handle = protyle.runtime!.menu.open();
        this.menuHandle = handle;
        handle.menu.removeCB = () => {
            if (this.menuHandle === handle) {
                this.menuHandle = undefined;
            }
        };
        return handle;
    }

    private closeRecordingOverlay() {
        const overlay = this.recordingOverlay;
        this.recordingOverlay = undefined;
        overlay?.handle.close();
    }

    constructor(protyle: IProtyle) {
        this.protyle = protyle;
        protyle.requestSignal.addEventListener("abort", () => {
            this.closeMenu();
            this.mediaRecorder?.stopRecording();
            this.closeRecordingOverlay();
        }, {once: true});
        const element = document.createElement("div");
        element.className = "protyle-breadcrumb";
        let padHTML = "";
        if (isTouchInput()) {
            padHTML = `<button class="block__icon fn__flex-center ariaLabel" disabled aria-label="${protyle.localization.text("undo")}" data-type="undo"><svg><use xlink:href="#iconUndo"></use></svg></button>
<button class="block__icon fn__flex-center ariaLabel" disabled aria-label="${protyle.localization.text("redo")}" data-type="redo"><svg><use xlink:href="#iconRedo"></use></svg></button>
<button class="block__icon fn__flex-center ariaLabel" disabled aria-label="${protyle.localization.text("outdent")}" data-type="outdent"><svg><use xlink:href="#iconOutdent"></use></svg></button>
<button class="block__icon fn__flex-center ariaLabel" disabled aria-label="${protyle.localization.text("indent")}" data-type="indent"><svg><use xlink:href="#iconIndent"></use></svg></button>`;
        }
        const gutterTip = protyle.localization.text("gutterTip2");
        element.innerHTML = `${isNarrowViewport() ?
            `<button class="protyle-breadcrumb__icon" data-type="mobile-menu">${protyle.localization.text("breadcrumb")}</button>` :
            '<div class="protyle-breadcrumb__bar"></div>'}
<span class="protyle-breadcrumb__space"></span>
<button class="protyle-breadcrumb__icon fn__none ariaLabel" aria-label="${updateHotkeyTip(protyle.settings.hotkeys.editor.general.exitFocus)}" data-type="exit-focus">${protyle.localization.text("exitFocus")}</button>
${padHTML}
<button class="block__icon fn__flex-center ariaLabel${protyle.readonlyState.host ? " fn__none" : ""}" aria-label="${protyle.localization.text("lockEdit")}" data-type="readonly" data-subtype="unlock"><svg><use xlink:href="#iconUnlock"></use></svg></button>
<button class="block__icon fn__flex-center ariaLabel" data-type="doc" aria-label="${isMac() ? gutterTip : gutterTip.replace("⇧", "Shift+")}"><svg><use xlink:href="#iconFile"></use></svg></button>
<button class="block__icon fn__flex-center ariaLabel" data-type="more" aria-label="${protyle.localization.text("more")}"><svg><use xlink:href="#iconMore"></use></svg></button>
<button class="block__icon fn__flex-center fn__none ariaLabel" data-type="context" aria-label="${protyle.localization.text("context")}"><svg><use xlink:href="#iconAlignCenter"></use></svg></button>`;
        this.element = element.firstElementChild as HTMLElement;
        element.addEventListener("click", (event) => {
            let target = event.target as HTMLElement;
            while (target && !target.isEqualNode(element)) {
                const id = target.getAttribute("data-node-id");
                const type = target.getAttribute("data-type");
                if (id) {
                    if (protyle.options.render.breadcrumbDocName && isOnlyMeta(event)) {
                        protyle.host.dispatch({
                            type: "open-document",
                            notebookId: target.dataset.notebookId!,
                            documentId: target.dataset.documentId!,
                            blockId: id,
                            disposition: "current",
                            scope: id === protyle.block.rootID ? "target" : "subtree",
                            attention: "focus",
                            scroll: "auto",
                            restoreScroll: "never",
                            zoom: false,
                        });
                    } else {
                        zoomOut({protyle, id});
                    }
                    event.preventDefault();
                    break;
                } else if (type === "mobile-menu") {
                    this.genMobileMenu(protyle);
                    event.preventDefault();
                    event.stopPropagation();
                    break;
                } else if (type === "doc") {
                    // 使用当前点击事件，避免窗口失焦后遗留的全局 Shift 状态。
                    if (event.shiftKey && protyle.settings.features.blockAttributes) {
                        const identity = protyleContentIdentity(protyle);
                        protyle.host.dispatch({
                            type: "open-block-attributes",
                            notebookId: identity.notebookId,
                            documentId: identity.documentId,
                            blockId: protyle.block.rootID!,
                            focus: "bookmark",
                        });
                    } else if (!event.shiftKey) {
                        const targetRect = target.getBoundingClientRect();
                        openTitleMenu(protyle, {x: targetRect.right, y: targetRect.bottom, isLeft: true}, Constants.MENU_FROM_TITLE_BREADCRUMB);
                    }
                    event.stopPropagation();
                    event.preventDefault();
                    break;
                } else if (type === "more") {
                    const targetRect = target.getBoundingClientRect();
                    this.showMenu(protyle, {
                        x: targetRect.right,
                        y: targetRect.bottom,
                        isLeft: true,
                    });
                    event.stopPropagation();
                    event.preventDefault();
                    break;
                } else if (type === "readonly") {
                    updateReadonly(target, protyle);
                    event.stopPropagation();
                    event.preventDefault();
                    break;
                } else if (type === "exit-focus") {
                    zoomOut({protyle, id: protyle.block.rootID, focusId: protyle.block.id});
                    event.stopPropagation();
                    event.preventDefault();
                    break;
                } else if (type === "context") {
                    event.stopPropagation();
                    event.preventDefault();
                    if (target.classList.contains("block__icon--active")) {
                        zoomOut({protyle, id: protyle.options.blockId});
                        target.classList.remove("block__icon--active");
                    } else {
                        const getDocParam = {
                            id: protyle.options.blockId,
                            mode: 3,
                            size: protyle.settings.editor.dynamicLoadBlocks,
                            notebook: protyle.notebookId,
                        };
                        const load = beginProtyleContentLoad(protyle);
                        void requestProtyleContent<IWebSocketData>(
                            protyle,
                            "/api/filetree/getDoc",
                            getDocParam,
                            load,
                        ).then((getResponse) => {
                            if (!load.isCurrent()) {
                                return;
                            }
                            onGet({data: getResponse, protyle, action: [Constants.CB_GET_HL], load});
                            target.classList.add("block__icon--active");
                        }).catch((error) => reportBreadcrumbFailure(protyle, "load context", error));
                    }
                    break;
                } else if (type === "undo") {
                    protyle.undo.undo(protyle);
                    event.preventDefault();
                    event.stopPropagation();
                    break;
                } else if (type === "redo") {
                    protyle.undo.redo(protyle);
                    event.preventDefault();
                    event.stopPropagation();
                    break;
                } else if (type === "outdent") {
                    if (protyle.toolbar.range) {
                        const blockElement = hasClosestBlock(protyle.toolbar.range.startContainer);
                        if (blockElement) {
                            listOutdent(protyle, [blockElement.parentElement], protyle.toolbar.range);
                        }
                    }
                    event.preventDefault();
                    event.stopPropagation();
                    break;
                } else if (type === "indent") {
                    if (protyle.toolbar.range) {
                        const blockElement = hasClosestBlock(protyle.toolbar.range.startContainer);
                        if (blockElement) {
                            listIndent(protyle, [blockElement.parentElement], protyle.toolbar.range);
                        }
                    }
                    event.preventDefault();
                    event.stopPropagation();
                    break;
                }
                target = target.parentElement;
            }
        });
        element.addEventListener("mouseleave", () => {
            protyle.wysiwyg.element.querySelectorAll(".protyle-wysiwyg--hl").forEach(item => {
                item.classList.remove("protyle-wysiwyg--hl");
            });
        });
        this.element.addEventListener("mousewheel", (event: WheelEvent) => {
            this.element.scrollLeft = this.element.scrollLeft + event.deltaY;
        }, {passive: true});
    }

    private finishRecord(protyle: IProtyle) {
        this.mediaRecorder.stopRecording();
        this.closeRecordingOverlay();
        const file = new File(
            [this.mediaRecorder.buildWavFileBlob()],
            `record${Date.now()}.wav`,
            {type: "audio/wav"},
        );
        uploadFiles(protyle, [file]);
    }

    private startRecord(protyle: IProtyle) {
        this.closeRecordingOverlay();
        const element = document.createElement("div");
        element.className = "fn__flex fn__flex-wrap b3-snackbar";
        element.style.position = "absolute";
        element.style.bottom = "16px";
        element.style.left = "50%";
        element.style.transform = "translateX(-50%)";
        element.innerHTML = `<span class="fn__flex-center">${protyle.localization.text("recording")}</span><span class="fn__space"></span>
<button class="b3-button b3-button--white">${protyle.localization.text("endRecord")}</button>`;
        protyle.element.append(element);
        const handle = protyle.session!.runtime.overlays.add(element);
        this.recordingOverlay = {element, handle};
        protyle.session!.runtime.overlays.bringToFront(element);
        element.querySelector("button").addEventListener("click", () => this.finishRecord(protyle), {once: true});
        this.mediaRecorder.startRecordingNewWavFile();
    }

    private genMobileMenu(protyle: IProtyle) {
        if (protyle.toolbar.isMultiSelectMode()) {
            return;
        }
        const menuHandle = this.openMenu(protyle);
        const {menu} = menuHandle;
        menu.element.setAttribute("data-name", Constants.MENU_BREADCRUMB_MOBILE_PATH);
        let blockElement: Element;
        if (getSelection().rangeCount > 0) {
            const range = getSelection().getRangeAt(0);
            if (!protyle.wysiwyg.element.isEqualNode(range.startContainer) && !protyle.wysiwyg.element.contains(range.startContainer)) {
                blockElement = getNoContainerElement(protyle.wysiwyg.element.firstElementChild) || protyle.wysiwyg.element.firstElementChild;
            } else {
                blockElement = hasClosestBlock(range.startContainer) as Element;
            }
        }
        if (!blockElement) {
            blockElement = getNoContainerElement(protyle.wysiwyg.element.firstElementChild) || protyle.wysiwyg.element.firstElementChild;
        }
        if (!blockElement) {
            return;
        }
        const id = blockElement.getAttribute("data-node-id");
        const breadcrumbParam = {id, excludeTypes: [], notebook: protyle.notebookId};
        void requestBreadcrumb<IWebSocketData>(protyle, "/api/block/getBlockBreadcrumb", breadcrumbParam).then((response) => {
            if (this.menuHandle !== menuHandle) {
                return;
            }
            response.data.forEach((item: IBreadcrumb) => {
                let isCurrent = false;
                if (!protyle.block.showAll && item.blockId === protyle.block.parentID) {
                    isCurrent = true;
                } else if (protyle.block.showAll && item.blockId === protyle.block.id) {
                    isCurrent = true;
                }
                menu.addItem({
                    current: isCurrent,
                    icon: getIconByType(item.type, item.subType),
                    label: item.name,
                    click() {
                        zoomOut({protyle, id: item.blockId});
                    }
                });
            });
            menu.fullscreen();
        }).catch((error) => reportBreadcrumbFailure(protyle, "load mobile path", error));
    }

    public toggleExit(hide: boolean) {
        const exitFocusElement = this.element.parentElement.querySelector('[data-type="exit-focus"]');
        if (hide) {
            exitFocusElement.classList.add("fn__none");
        } else {
            exitFocusElement.classList.remove("fn__none");
        }
    }

    public showMenu(protyle: IProtyle, position: IPosition) {
        if (this.menuHandle) {
            this.closeMenu();
            return;
        }
        const menuHandle = this.openMenu(protyle);
        const {menu} = menuHandle;
        let id;
        const cursorNodeElement = hasClosestBlock(getEditorRange(protyle.element).startContainer);
        if (cursorNodeElement) {
            id = cursorNodeElement.getAttribute("data-node-id");
        }
        void requestBreadcrumb<IWebSocketData>(protyle, "/api/block/getTreeStat", {
            id: id || (protyle.block.showAll ? protyle.block.id : protyle.block.rootID),
        }).then((response) => {
            if (this.menuHandle !== menuHandle) {
                return;
            }
            menu.element.setAttribute("data-name", Constants.MENU_BREADCRUMB_MORE);
            if (!protyle.contentElement.classList.contains("fn__none") && !protyle.disabled) {
                let uploadHTML = "";
                uploadHTML = '<input class="b3-form__upload" type="file" multiple="multiple"';
                if (protyle.options.upload.accept) {
                    uploadHTML += ` accept="${protyle.options.upload.accept}">`;
                } else {
                    uploadHTML += ">";
                }
                const uploadMenu = menu.addItem({
                    id: "insertAsset",
                    icon: "iconDownload",
                    label: `${protyle.localization.text("insertAsset")}${uploadHTML}`,
                })!;
                uploadMenu.querySelector("input").addEventListener("change", (event: InputEvent & {
                    target: HTMLInputElement
                }) => {
                    if (event.target.files.length === 0) {
                        return;
                    }
                    uploadFiles(protyle, event.target.files, event.target);
                    this.closeMenu();
                });
                menu.addItem({
                    id: this.mediaRecorder?.isRecording ? "endRecord" : "startRecord",
                    current: this.mediaRecorder && this.mediaRecorder.isRecording,
                    icon: "iconRecord",
                    label: this.mediaRecorder?.isRecording ? protyle.localization.text("endRecord") : protyle.localization.text("startRecord"),
                    click: () => {
                        if (!this.mediaRecorder) {
                            navigator.mediaDevices.getUserMedia({audio: true}).then((mediaStream: MediaStream) => {
                                this.mediaRecorder = new RecordMedia(mediaStream);
                                this.mediaRecorder.recorder.onaudioprocess = (e: AudioProcessingEvent) => {
                                    // Do nothing if not recording:
                                    if (!this.mediaRecorder.isRecording) {
                                        return;
                                    }
                                    // Copy the data from the input buffers;
                                    const left = e.inputBuffer.getChannelData(0);
                                    const right = e.inputBuffer.getChannelData(1);
                                    this.mediaRecorder.cloneChannelData(left, right);
                                };
                                this.startRecord(protyle);
                            }).catch(() => {
                                protyle.host.dispatch({
                                    type: "notify",
                                    level: "error",
                                    message: protyle.localization.text("record-tip"),
                                });
                            });
                            return;
                        }

                        if (this.mediaRecorder.isRecording) {
                            this.finishRecord(protyle);
                        } else {
                            this.startRecord(protyle);
                        }
                    }
                });
            }
            if (!protyle.disabled) {
                menu.addItem({
                    id: "netImg2LocalAsset",
                    label: protyle.localization.text("netImg2LocalAsset"),
                    icon: "iconImgDown",
                    accelerator: protyle.settings.hotkeys.editor.general.netImg2LocalAsset,
                    click() {
                        net2LocalAssets(protyle, "Img");
                    }
                });
                menu.addItem({
                    id: "netAssets2LocalAssets",
                    label: protyle.localization.text("netAssets2LocalAssets"),
                    icon: "iconDownloadAssets",
                    accelerator: protyle.settings.hotkeys.editor.general.netAssets2LocalAssets,
                    click() {
                        net2LocalAssets(protyle, "Assets");
                    }
                });
                const identity = protyleContentIdentity(protyle);
                if (protyle.settings.features.cloudAssetUpload) {
                    menu.addItem({
                        id: "uploadAssets2CDN",
                        label: protyle.localization.text("uploadAssets2CDN"),
                        icon: "iconUploadAssets",
                        click: () => protyle.host.dispatch({
                            type: "upload-cloud-assets",
                            notebookId: identity.notebookId,
                            documentId: identity.documentId,
                            blockId: protyle.block.id!,
                        }),
                    });
                }
                if (protyle.settings.features.communityShare) {
                    menu.addItem({
                        id: "share2Liandi",
                        label: protyle.localization.text("share2Liandi"),
                        icon: "iconLiandi",
                        click: () => protyle.host.dispatch({
                            type: "share-document-community",
                            notebookId: identity.notebookId,
                            documentId: identity.documentId,
                            blockId: protyle.block.parentID!,
                        }),
                    });
                }
            }
            if (!protyle.scroll?.element.classList.contains("fn__none")) {
                menu.addItem({
                    id: "keepLazyLoad",
                    icon: "iconKeepContent",
                    current: protyle.scroll.keepLazyLoad,
                    label: protyle.localization.text("keepLazyLoad"),
                    click: () => {
                        protyle.scroll.keepLazyLoad = !protyle.scroll.keepLazyLoad;
                    }
                });
            }
            if (menu.element.lastElementChild.childElementCount > 0) {
                menu.addItem({id: "separator_1", type: "separator"});
            }
            menu.addItem({
                id: "refresh",
                icon: "iconRefresh",
                accelerator: protyle.settings.hotkeys.editor.general.refresh,
                label: protyle.localization.text("refresh"),
                click: () => {
                    reloadProtyle(protyle, !isNarrowViewport());
                }
            });
            if (!protyle.disabled) {
                menu.addItem({
                    id: "optimizeTypography",
                    label: protyle.localization.text("optimizeTypography"),
                    accelerator: protyle.settings.hotkeys.editor.general.optimizeTypography,
                    icon: "iconFormat",
                    click: () => {
                        hideElements(["toolbar"], protyle);
                        submitBreadcrumb(protyle, "/api/format/autoSpace", {
                            id: protyle.block.rootID
                        });
                    }
                });
            }
            if (protyle.settings.features.fullscreen) {
                menu.addItem({
                    id: "fullscreen",
                    icon: protyle.element.className.includes("fullscreen") ? "iconFullscreenExit" : "iconFullscreen",
                    accelerator: protyle.settings.hotkeys.editor.general.fullscreen,
                    label: protyle.localization.text("fullscreen"),
                    click: () => {
                        const identity = protyleContentIdentity(protyle);
                        protyle.host.dispatch({
                            type: "toggle-document-fullscreen",
                            notebookId: identity.notebookId,
                            documentId: identity.documentId,
                        });
                    }
                });
            }
            menu.addItem({
                id: "editMode",
                icon: "iconEdit",
                label: protyle.localization.text("edit-mode"),
                type: "submenu",
                submenu: [{
                    id: "wysiwyg",
                    current: !protyle.contentElement.classList.contains("fn__none"),
                    label: protyle.localization.text("wysiwyg"),
                    accelerator: protyle.settings.hotkeys.editor.general.wysiwyg,
                    click: () => {
                        setEditMode(protyle, "wysiwyg");
                        reloadProtyle(protyle, true);
                        const identity = protyleContentIdentity(protyle);
                        protyle.host.dispatch({
                            type: "persist-workspace-layout",
                            notebookId: identity.notebookId,
                            documentId: identity.documentId,
                        });
                    }
                }, {
                    id: "preview",
                    current: !protyle.preview.element.classList.contains("fn__none"),
                    icon: "iconPreview",
                    label: protyle.localization.text("preview"),
                    accelerator: protyle.settings.hotkeys.editor.general.preview,
                    click: () => {
                        setEditMode(protyle, "preview");
                        this.closeMenu();
                        const identity = protyleContentIdentity(protyle);
                        protyle.host.dispatch({
                            type: "persist-workspace-layout",
                            notebookId: identity.notebookId,
                            documentId: identity.documentId,
                        });
                    }
                }]
            });
            if (!protyle.settings.editor.readOnly && !protyle.readonlyState.host) {
                const isCustomReadonly = protyle.wysiwyg.element.getAttribute(Constants.CUSTOM_SY_READONLY);
                menu.addItem({
                    id: "editReadonly",
                    label: protyle.localization.text("editReadonly"),
                    icon: "iconLock",
                    type: "submenu",
                    submenu: [{
                        id: "enable",
                        iconHTML: "",
                        current: isCustomReadonly === "true",
                        label: protyle.localization.text("enable"),
                        click() {
                            submitBreadcrumb(protyle, "/api/attr/setBlockAttrs", {
                                id: protyle.block.rootID,
                                attrs: {[Constants.CUSTOM_SY_READONLY]: "true"}
                            });
                        }
                    }, {
                        id: "disable",
                        iconHTML: "",
                        current: !isCustomReadonly || isCustomReadonly === "false",
                        label: protyle.localization.text("disable"),
                        click() {
                            submitBreadcrumb(protyle, "/api/attr/setBlockAttrs", {
                                id: protyle.block.rootID,
                                attrs: {[Constants.CUSTOM_SY_READONLY]: "false"}
                            });
                        }
                    }]
                });
            }
            if (!protyle.disabled) {
                const isCustomFullWidth = protyle.wysiwyg.element.getAttribute(Constants.CUSTOM_SY_FULLWIDTH);
                menu.addItem({
                    id: "fullWidth",
                    label: protyle.localization.text("fullWidth"),
                    icon: "iconFullWidth",
                    type: "submenu",
                    submenu: [{
                        id: "enable",
                        iconHTML: "",
                        current: isCustomFullWidth === "true",
                        label: protyle.localization.text("enable"),
                        click() {
                            submitBreadcrumb(protyle, "/api/attr/setBlockAttrs", {
                                id: protyle.block.rootID,
                                attrs: {[Constants.CUSTOM_SY_FULLWIDTH]: "true"}
                            });
                        }
                    }, {
                        id: "disable",
                        iconHTML: "",
                        current: isCustomFullWidth === "false",
                        label: protyle.localization.text("disable"),
                        click() {
                            submitBreadcrumb(protyle, "/api/attr/setBlockAttrs", {
                                id: protyle.block.rootID,
                                attrs: {[Constants.CUSTOM_SY_FULLWIDTH]: "false"}
                            });
                        }
                    }, {
                        id: "default",
                        iconHTML: "",
                        current: !isCustomFullWidth,
                        label: protyle.localization.text("default"),
                        click() {
                            submitBreadcrumb(protyle, "/api/attr/setBlockAttrs", {
                                id: protyle.block.rootID,
                                attrs: {[Constants.CUSTOM_SY_FULLWIDTH]: ""}
                            });
                        }
                    }]
                });
            }
            emitProtylePluginMenu({
                localization: protyle.localization,
                menu,
                plugins: protyle.plugins,
                type: "open-menu-breadcrumbmore",
                detail: {
                    protyle,
                    data: response.data.stat,
                },
                separatorPosition: "top",
            });
            menu.addItem({id: "separator_2", type: "separator"});
            menu.addItem({
                id: "docInfo",
                iconHTML: "",
                type: "readonly",
                // 不能换行，否则移动端间距过大
                label: `<div class="fn__flex">${protyle.localization.text("runeCount")}<span class="fn__space fn__flex-1"></span>${response.data.stat.runeCount}</div><div class="fn__flex">${protyle.localization.text("wordCount")}<span class="fn__space fn__flex-1"></span>${response.data.stat.wordCount}</div><div class="fn__flex">${protyle.localization.text("linkCount")}<span class="fn__space fn__flex-1"></span>${response.data.stat.linkCount}</div><div class="fn__flex">${protyle.localization.text("imgCount")}<span class="fn__space fn__flex-1"></span>${response.data.stat.imageCount}</div><div class="fn__flex">${protyle.localization.text("refCount")}<span class="fn__space fn__flex-1"></span>${response.data.stat.refCount}</div><div class="fn__flex">${protyle.localization.text("blockCount")}<span class="fn__space fn__flex-1"></span>${response.data.stat.blockCount}</div>`,
            });
            menu.popup(position);
            const popoverElement = hasTopClosestByClassName(protyle.element, "block__popover", true);
            menu.element.setAttribute("data-from", popoverElement ? popoverElement.dataset.level + "popover" : "app");
        }).catch((error) => reportBreadcrumbFailure(protyle, "load menu statistics", error));
    }

    public render(protyle: IProtyle, update = false, nodeElement?: Element | false) {
        if (protyle.element.getAttribute("disabled-forever") === "true") {
            return;
        }
        let range: Range;
        let blockElement: Element;
        if (nodeElement &&
            !nodeElement.classList.contains("list")   // 列表 id 不会返回数据，因此不进行处理 https://github.com/siyuan-note/siyuan/issues/11685
        ) {
            blockElement = nodeElement;
        } else if (getSelection().rangeCount > 0) {
            range = getSelection().getRangeAt(0);
            if (!protyle.wysiwyg.element.isEqualNode(range.startContainer) && !protyle.wysiwyg.element.contains(range.startContainer)) {
                if (protyle.element.id === "searchPreview") {
                    // https://github.com/siyuan-note/siyuan/issues/8807
                    blockElement = hasClosestBlock(protyle.wysiwyg.element.querySelector('[data-type="search-mark"]')) as Element;
                } else {
                    blockElement = getNoContainerElement(protyle.wysiwyg.element.firstElementChild) || protyle.wysiwyg.element.firstElementChild;
                }
            } else {
                blockElement = hasClosestBlock(range.startContainer) as Element;
            }
        }
        if (!blockElement) {
            blockElement = getNoContainerElement(protyle.wysiwyg.element.firstElementChild) || protyle.wysiwyg.element.firstElementChild;
        }
        if (!blockElement) {
            // 浮窗删除单个块后，面包屑无法获取到 blockElement，直接返回即可
            return;
        }
        const id = blockElement.getAttribute("data-node-id");
        if (id === this.id && !update) {
            protyle.breadcrumb.element.querySelectorAll(".protyle-breadcrumb__item--active").forEach(item => {
                item.classList.remove("protyle-breadcrumb__item--active");
            });
            const currentElement = protyle.breadcrumb.element.querySelector(`[data-node-id="${protyle.block.showAll ? protyle.block.id : protyle.block.parentID}"]`);
            if (currentElement) {
                currentElement.classList.add("protyle-breadcrumb__item--active");
            }
            return;
        }
        this.id = id;
        const generation = ++this.renderGeneration;
        const excludeTypes: string[] = [];
        if (this.element.parentElement?.parentElement && this.element.parentElement.parentElement.classList.contains("card__block")) {
            // 闪卡面包屑不能显示答案
            excludeTypes.push("NodeTextMark-mark");
        }
        const breadcrumbParam = {id, excludeTypes, notebook: protyle.notebookId};
        void requestBreadcrumb<IWebSocketData>(protyle, "/api/block/getBlockBreadcrumb", breadcrumbParam).then((response) => {
            if (generation !== this.renderGeneration || this.id !== id || protyle.requestSignal.aborted) {
                return;
            }
            let html = "";
            response.data.forEach((item: IBreadcrumb, index: number) => {
                let isCurrent = false;
                if (!protyle.block.showAll && item.blockId === protyle.block.parentID) {
                    isCurrent = true;
                } else if (protyle.block.showAll && item.blockId === protyle.block.id) {
                    isCurrent = true;
                }
                if (index === 0 && !protyle.options.render.breadcrumbDocName) {
                    html += `<span class="protyle-breadcrumb__item${isCurrent ? " protyle-breadcrumb__item--active" : ""}" data-node-id="${item.blockId}" data-notebook-id="${item.notebookId}" data-document-id="${item.documentId}"${response.data.length === 1 ? ' style="max-width:none"' : ""}>
    <svg class="popover__block" data-id="${item.blockId}"><use xlink:href="#${getIconByType(item.type, item.subType)}"></use></svg>
</span>`;
                } else {
                    html += `<span class="protyle-breadcrumb__item${isCurrent ? " protyle-breadcrumb__item--active" : ""}" data-node-id="${item.blockId}" data-notebook-id="${item.notebookId}" data-document-id="${item.documentId}"${(response.data.length === 1 || index === 0) ? ' style="max-width:none"' : ""}>
    <svg class="popover__block" data-id="${item.blockId}"><use xlink:href="#${getIconByType(item.type, item.subType)}"></use></svg>
    ${item.name ? `<span class="protyle-breadcrumb__text" title="${item.name}">${item.name}</span>` : ""}
</span>`;
                }
                if (index !== response.data.length - 1) {
                    html += '<svg class="protyle-breadcrumb__arrow"><use xlink:href="#iconRight"></use></svg>';
                }
            });
            this.element.innerHTML = html;
            improveBreadcrumbAppearance(this.element.parentElement);
        }).catch((error) => reportBreadcrumbFailure(protyle, "render path", error));
    }

    public hide() {
        if (isNarrowViewport()) {
            return;
        }
        this.element.classList.add("protyle-breadcrumb__bar--hide");
        if (this.restoreOnMouseMove) {
            return;
        }
        this.restoreOnMouseMove = true;
        document.addEventListener("mousemove", () => {
            this.restoreOnMouseMove = false;
            this.element.classList.remove("protyle-breadcrumb__bar--hide");
            this.render(this.protyle, true);
        }, {once: true, signal: this.protyle.requestSignal});
    }
}
