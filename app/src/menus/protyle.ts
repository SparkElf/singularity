import {
    hasClosestBlock,
    hasClosestByClassName,
    hasTopClosestByClassName,
    isInEmbedBlock
} from "../protyle/util/hasClosest";
import {MenuItem} from "./Menu";
import {focusBlock, focusByRange, focusByWbr,} from "../protyle/util/selection";
import {mathRender} from "../protyle/render/mathRender";
import {transaction, updateTransaction} from "../protyle/wysiwyg/transaction";
import {openMenu} from "./commonMenuItem";
import {fetchPost, fetchSyncPost} from "../util/fetch";
import {Constants} from "../constants";
import {setStorageVal, writeText} from "../protyle/util/compatibility";
import {onGet} from "../protyle/util/onGet";
import {getAllModels} from "../layout/getAll";
/// #if !MOBILE
import {updateBacklinkGraph} from "../editor/util";
/// #endif
import {getSearch, isMobile} from "../util/functions";
import * as dayjs from "dayjs";
import {renameAsset} from "../editor/rename";
import {pushBack} from "../mobile/util/MobileBackFoward";
import {copyPNGByLink, exportAsset, writeAssetToClipboard} from "./util";
import {alignImgCenter, alignImgLeft} from "../protyle/wysiwyg/commonHotkey";
import {hideElements} from "../protyle/ui/hideElements";
import {emitOpenMenu} from "../plugin/EventBus";
import {getFirstBlock} from "../protyle/wysiwyg/getBlock";
import {showMessage} from "../dialog/message";
import {img3115} from "../boot/compatibleVersion";
import {base64ToURL} from "../util/image";
import {setFold} from "../protyle/util/blockFold";
import {isEncryptedBox} from "../util/pathName";

export {
    fileAnnotationRefMenu,
    inlineMathMenu,
    linkMenu,
    refMenu,
    tagMenu,
} from "../protyle/ui/inlineMenu";

export {contentMenu, tableMenu} from "../protyle/ui/contentMenu";
export const enterBack = (protyle: IProtyle, id: string) => {
    if (!protyle.block.showAll) {
        const parentDocument = protyle.block.parentDocument;
        if (parentDocument) {
            protyle.host.dispatch({
                type: "open-document",
                notebookId: parentDocument.notebookId,
                documentId: parentDocument.documentId,
                blockId: parentDocument.blockId,
                disposition: "current",
                scope: "target",
                attention: "focus",
                scroll: "auto",
                restoreScroll: "always",
                zoom: false,
            });
        }
    } else {
        zoomOut({protyle, id: protyle.block.parent2ID, focusId: id});
    }
};

export const zoomOut = (options: {
    protyle: IProtyle,
    id: string,
    focusId?: string,
    isPushBack?: boolean,
    callback?: () => void,
    reload?: boolean
}) => {
    if (options.protyle.options.backlinkData) {
        return;
    }
    if (typeof options.isPushBack === "undefined") {
        options.isPushBack = true;
    }
    if (typeof options.reload === "undefined") {
        options.reload = false;
    }
    const blockPanelElement = hasClosestByClassName(options.protyle.element, "block__popover", true);
    if (blockPanelElement) {
        const pingElement = blockPanelElement.querySelector('[data-type="pin"]');
        if (pingElement && blockPanelElement.getAttribute("data-pin") !== "true") {
            pingElement.setAttribute("aria-label", window.siyuan.languages.unpin);
            pingElement.querySelector("use").setAttribute("xlink:href", "#iconUnpin");
            blockPanelElement.setAttribute("data-pin", "true");
        }
    }
    const breadcrumbHLElement = options.protyle.breadcrumb?.element.querySelector(".protyle-breadcrumb__item--active");
    if (!options.reload && breadcrumbHLElement && breadcrumbHLElement.getAttribute("data-node-id") === options.id) {
        if (options.id === options.protyle.block.rootID) {
            return;
        }
        const focusElement = options.protyle.wysiwyg.element.querySelector(`[data-node-id="${options.focusId || options.id}"]`);
        if (focusElement) {
            focusBlock(focusElement);
            focusElement.scrollIntoView();
            return;
        }
    }
    if (window.siyuan.mobile?.editor) {
        if (options.isPushBack) {
            pushBack();
        }
    }
    const getDocParam: IObject = {
        id: options.id,
        size: options.id === options.protyle.block.rootID ? window.siyuan.config.editor.dynamicLoadBlocks : Constants.SIZE_GET_MAX,
    };
    if (isEncryptedBox(options.protyle.notebookId)) {
        getDocParam.notebook = options.protyle.notebookId;
    }
    fetchPost("/api/filetree/getDoc", getDocParam, async (getResponse) => {
        const action: TProtyleAction[] = [Constants.CB_GET_HTML];
        if (!options.isPushBack) {
            action.push(Constants.CB_GET_UNUNDO);
        }
        if (options.id !== options.protyle.block.rootID) {
            action.push(Constants.CB_GET_ALL);
        }
        if (options.focusId) {
            action.push(Constants.CB_GET_FOCUS);
        }
        onGet({
            data: getResponse,
            protyle: options.protyle,
            action,
            scrollAttr: options.focusId ? {
                rootId: options.id,
                focusId: options.focusId
            } : undefined,
            scrollPosition: options.focusId ? "start" : undefined,
            afterCB: () => {
                if (window.siyuan.mobile?.editor) {
                    window.siyuan.storage[Constants.LOCAL_DOCINFO] = {
                        id: options.id,
                        notebookId: options.protyle.notebookId,
                    };
                    setStorageVal(Constants.LOCAL_DOCINFO, window.siyuan.storage[Constants.LOCAL_DOCINFO]);
                }
                options.callback?.();
            },
        });
        // https://github.com/siyuan-note/siyuan/issues/4874
        if (options.focusId) {
            let focusElement = options.protyle.wysiwyg.element.querySelector(`[data-node-id="${options.focusId}"]`);
            if (!focusElement) {
                const unfoldedParentParam: IObject = {id: options.focusId};
                if (isEncryptedBox(options.protyle.notebookId)) {
                    unfoldedParentParam.notebook = options.protyle.notebookId;
                }
                const unfoldResponse = await fetchSyncPost("/api/block/getUnfoldedParentID", unfoldedParentParam);
                options.focusId = unfoldResponse.data.parentID;
                focusElement = options.protyle.wysiwyg.element.querySelector(`[data-node-id="${unfoldResponse.data.parentID}"]`);
            }
            if (focusElement) {
                // 退出聚焦后块在折叠中 https://github.com/siyuan-note/siyuan/issues/10746
                let showElement = focusElement;
                while (showElement.getBoundingClientRect().height === 0) {
                    showElement = showElement.parentElement;
                }
                if (showElement.classList.contains("protyle-wysiwyg")) {
                    // 闪卡退出聚焦元素被隐藏 https://github.com/siyuan-note/siyuan/issues/10058#issuecomment-2029524211
                    showElement = focusElement.previousElementSibling || focusElement.nextElementSibling;
                } else {
                    showElement = getFirstBlock(showElement);
                }
                focusBlock(showElement);
            } else if (!options.focusId) {
                const getDocParam: IObject = {
                    id: options.protyle.block.rootID,
                    size: window.siyuan.config.editor.dynamicLoadBlocks,
                };
                if (isEncryptedBox(options.protyle.notebookId)) {
                    getDocParam.notebook = options.protyle.notebookId;
                }
                fetchPost("/api/filetree/getDoc", getDocParam, getFocusResponse => {
                    onGet({
                        data: getFocusResponse,
                        protyle: options.protyle,
                        action: options.isPushBack ? [Constants.CB_GET_FOCUS] : [Constants.CB_GET_FOCUS, Constants.CB_GET_UNUNDO],
                    });
                });
                return;
            } else if (options.id === options.protyle.block.rootID) { // 聚焦返回后，该块是动态加载的，但是没加载出来
                const getDocParam: IObject = {
                    id: options.focusId,
                    mode: 3,
                    size: window.siyuan.config.editor.dynamicLoadBlocks,
                };
                if (isEncryptedBox(options.protyle.notebookId)) {
                    getDocParam.notebook = options.protyle.notebookId;
                }
                fetchPost("/api/filetree/getDoc", getDocParam, getFocusResponse => {
                    onGet({
                        data: getFocusResponse,
                        protyle: options.protyle,
                        action: options.isPushBack ? [Constants.CB_GET_FOCUS] : [Constants.CB_GET_FOCUS, Constants.CB_GET_UNUNDO],
                        scrollAttr: {
                            rootId: options.id,
                            focusId: options.focusId
                        }
                    });
                });
                return;
            }
        } else if (options.id !== options.protyle.block.rootID) {
            options.protyle.wysiwyg.element.classList.add("protyle-wysiwyg--animate");
            setTimeout(() => {
                options.protyle.wysiwyg.element.classList.remove("protyle-wysiwyg--animate");
            }, 365);
        }
        /// #if !MOBILE
        if (options.protyle.model) {
            const allModels = getAllModels();
            allModels.outline.forEach(item => {
                if (item.blockId === options.protyle.block.rootID) {
                    item.setCurrent(options.protyle.wysiwyg.element.querySelector(`[data-node-id="${options.focusId || options.id}"]`));
                }
            });
            updateBacklinkGraph(allModels, options.protyle);
        }
        /// #endif
    });
};

export const imgMenu = (protyle: IProtyle, range: Range, assetElement: HTMLElement, position: {
    clientX: number,
    clientY: number
}) => {
    window.siyuan.menus.menu.remove();
    window.siyuan.menus.menu.element.setAttribute("data-name", Constants.MENU_INLINE_IMG);
    const nodeElement = hasClosestBlock(assetElement);
    if (!nodeElement) {
        return;
    }
    hideElements(["util", "toolbar", "hint"], protyle);
    const id = nodeElement.getAttribute("data-node-id");
    const imgElement = assetElement.querySelector("img");
    const titleElement = assetElement.querySelector(".protyle-action__title span") as HTMLElement;
    const html = nodeElement.outerHTML;
    let src = imgElement.getAttribute("src");
    if (!src) {
        src = "";
    }
    if (!protyle.disabled) {
        window.siyuan.menus.menu.append(new MenuItem({
            id: "imageUrlAndTitleAndTooltipText",
            iconHTML: "",
            type: "readonly",
            label: `<div class="fn__flex">
    <span class="fn__flex-center">${window.siyuan.languages.imageURL}</span>
    <span class="fn__space"></span>
    <span data-action="copy" class="block__icon block__icon--show b3-tooltips b3-tooltips__e fn__flex-center" aria-label="${window.siyuan.languages.copy}">
        <svg><use xlink:href="#iconCopy"></use></svg>
    </span>   
</div><textarea spellcheck="false" style="margin:4px 0;width: ${isMobile() ? "100%" : "360px"}" rows="1" class="b3-text-field">${src}</textarea><div class="fn__hr"></div><div class="fn__flex">
    <span class="fn__flex-center">${window.siyuan.languages.title}</span>
    <span class="fn__space"></span>
    <span data-action="copy" class="block__icon block__icon--show b3-tooltips b3-tooltips__e fn__flex-center" aria-label="${window.siyuan.languages.copy}">
        <svg><use xlink:href="#iconCopy"></use></svg>
    </span>   
</div><textarea style="margin:4px 0;width: ${isMobile() ? "100%" : "360px"}" rows="1" class="b3-text-field"></textarea><div class="fn__hr"></div><div class="fn__flex">
    <span class="fn__flex-center">${window.siyuan.languages.tooltipText}</span>
    <span class="fn__space"></span>
    <span data-action="copy" class="block__icon block__icon--show b3-tooltips b3-tooltips__e fn__flex-center" aria-label="${window.siyuan.languages.copy}">
        <svg><use xlink:href="#iconCopy"></use></svg>
    </span>   
</div><textarea style="margin:4px 0;width: ${isMobile() ? "100%" : "360px"}" rows="1" class="b3-text-field"></textarea>`,
            bind(element) {
                element.style.maxWidth = "none";
                const textElements = element.querySelectorAll("textarea");
                textElements[0].addEventListener("input", (event: InputEvent) => {
                    const value = (event.target as HTMLInputElement).value.replace(/\n|\r\n|\r|\u2028|\u2029/g, "").trim();
                    imgElement.setAttribute("src", value);
                    imgElement.setAttribute("data-src", value);
                    const imgNetElement = assetElement.querySelector(".img__net");
                    if (value.startsWith("assets/") || value.startsWith("data:image/")) {
                        if (imgNetElement) {
                            imgNetElement.remove();
                        }
                    } else if (window.siyuan.config.editor.displayNetImgMark && !imgNetElement) {
                        assetElement.querySelector(".protyle-action__drag").insertAdjacentHTML("afterend", '<span class="img__net"><svg><use xlink:href="#iconGlobe"></use></svg></span>');
                    }
                });
                textElements[1].value = titleElement.innerText;
                textElements[1].addEventListener("input", (event) => {
                    const value = (event.target as HTMLInputElement).value;
                    imgElement.setAttribute("title", value);
                    titleElement.innerText = value;
                    mathRender(titleElement, protyle);
                });
                textElements[2].value = imgElement.getAttribute("alt") || "";
                element.addEventListener("click", (event) => {
                    let target = event.target as HTMLElement;
                    while (target) {
                        if (target.dataset.action === "copy") {
                            writeText((target.parentElement.nextElementSibling as HTMLTextAreaElement).value);
                            showMessage(window.siyuan.languages.copied);
                            break;
                        }
                        target = target.parentElement;
                    }
                });
            }
        }).element);
        window.siyuan.menus.menu.append(new MenuItem({id: "separator_1", type: "separator"}).element);
    }
    window.siyuan.menus.menu.append(new MenuItem({
        id: "copy",
        label: window.siyuan.languages.copy,
        accelerator: "⌘C",
        icon: "iconCopy",
        click() {
            let content = protyle.lute.BlockDOM2StdMd(assetElement.outerHTML);
            // The file name encoding is abnormal after copying the image and pasting it https://github.com/siyuan-note/siyuan/issues/11246
            content = content.replace(/%20/g, " ");
            writeText(content);
        }
    }).element);
    if (protyle.disabled) {
        window.siyuan.menus.menu.append(new MenuItem({
            id: "copyImageURL",
            label: window.siyuan.languages.copy + " " + window.siyuan.languages.imageURL,
            icon: "iconLink",
            click() {
                writeText(imgElement.getAttribute("src"));
            }
        }).element);
    }
    if (!protyle.disabled) {
        window.siyuan.menus.menu.append(new MenuItem({
            id: "cut",
            icon: "iconCut",
            accelerator: "⌘X",
            label: window.siyuan.languages.cut,
            click() {
                let content = protyle.lute.BlockDOM2StdMd(assetElement.outerHTML);
                // The file name encoding is abnormal after copying the image and pasting it https://github.com/siyuan-note/siyuan/issues/11246
                content = content.replace(/%20/g, " ");
                writeText(content);
                (assetElement as HTMLElement).outerHTML = "<wbr>";
                nodeElement.setAttribute("updated", dayjs().format("YYYYMMDDHHmmss"));
                updateTransaction(protyle, nodeElement, html);
                focusByWbr(protyle.wysiwyg.element, range);
            }
        }).element);
        window.siyuan.menus.menu.append(new MenuItem({
            id: "delete",
            icon: "iconTrashcan",
            accelerator: "⌫",
            label: window.siyuan.languages.delete,
            click: function () {
                (assetElement as HTMLElement).outerHTML = "<wbr>";
                nodeElement.setAttribute("updated", dayjs().format("YYYYMMDDHHmmss"));
                updateTransaction(protyle, nodeElement, html);
                focusByWbr(protyle.wysiwyg.element, range);
            }
        }).element);
        window.siyuan.menus.menu.append(new MenuItem({id: "separator_2", type: "separator"}).element);
        const imagePath = imgElement.getAttribute("data-src");
        if (imagePath.startsWith("assets/")) {
            window.siyuan.menus.menu.append(new MenuItem({
                id: "rename",
                label: window.siyuan.languages.rename,
                icon: "iconEdit",
                click() {
                    renameAsset(imagePath);
                }
            }).element);
        }
        window.siyuan.menus.menu.append(new MenuItem({
            id: "ocr",
            label: "OCR",
            submenu: [{
                id: "ocrResult",
                iconHTML: "",
                type: "readonly",
                label: `<textarea spellcheck="false" data-type="ocr" style="margin: 4px 0" rows="1" class="b3-text-field fn__block" placeholder="${window.siyuan.languages.ocrResult}"></textarea>`,
                bind(element) {
                    element.style.maxWidth = "none";
                    fetchPost("/api/asset/getImageOCRText", {
                        path: imgElement.getAttribute("src")
                    }, (response) => {
                        const textarea = element.querySelector("textarea");
                        textarea.value = response.data.text;
                        textarea.dataset.ocrText = response.data.text;
                    });
                }
            }, {
                type: "separator"
            }, {
                id: "reOCR",
                iconHTML: "",
                label: window.siyuan.languages.reOCR,
                click() {
                    fetchPost("/api/asset/ocr", {
                        path: imgElement.getAttribute("src"),
                        force: true
                    });
                }
            }],
        }).element);
        window.siyuan.menus.menu.append(new MenuItem({
            id: "alignCenter",
            icon: "iconAlignCenter",
            label: window.siyuan.languages.alignCenter,
            accelerator: window.siyuan.config.keymap.editor.general.alignCenter.custom,
            click() {
                alignImgCenter(protyle, nodeElement, [assetElement], id, html);
            }
        }).element);
        window.siyuan.menus.menu.append(new MenuItem({
            id: "alignLeft",
            icon: "iconAlignLeft",
            label: window.siyuan.languages.alignLeft,
            accelerator: window.siyuan.config.keymap.editor.general.alignLeft.custom,
            click() {
                alignImgLeft(protyle, nodeElement, [assetElement], id, html);
            }
        }).element);
        let rangeElement: HTMLInputElement;
        window.siyuan.menus.menu.append(new MenuItem({
            id: "width",
            label: window.siyuan.languages.width,
            submenu: [{
                id: "widthInput",
                iconHTML: "",
                type: "readonly",
                label: `<div class="fn__flex"><input class="b3-text-field fn__flex-1" style="margin: 4px 8px 4px 0" value="${imgElement.parentElement.style.width.endsWith("px") ? parseInt(imgElement.parentElement.style.width) : ""}" type="number" placeholder="${window.siyuan.languages.width}"><span class="fn__flex-center">px</span></div>`,
                bind(element) {
                    const inputElement = element.querySelector("input");
                    inputElement.addEventListener("input", () => {
                        rangeElement.value = "0";
                        rangeElement.parentElement.setAttribute("aria-label", inputElement.value ? (inputElement.value + "px") : window.siyuan.languages.default);

                        img3115(assetElement);
                        imgElement.parentElement.style.width = inputElement.value ? (inputElement.value + "px") : "";
                        imgElement.style.height = "";
                    });
                    inputElement.addEventListener("blur", () => {
                        if (inputElement.value === imgElement.parentElement.style.width.replace("px", "")) {
                            return;
                        }
                        nodeElement.setAttribute("updated", dayjs().format("YYYYMMDDHHmmss"));
                        updateTransaction(protyle, nodeElement, html);
                        window.siyuan.menus.menu.remove();
                        focusBlock(nodeElement);
                    });
                }
            },
                genImageWidthMenu("25%", imgElement, protyle, id, nodeElement, html),
                genImageWidthMenu("33%", imgElement, protyle, id, nodeElement, html),
                genImageWidthMenu("50%", imgElement, protyle, id, nodeElement, html),
                genImageWidthMenu("67%", imgElement, protyle, id, nodeElement, html),
                genImageWidthMenu("75%", imgElement, protyle, id, nodeElement, html),
                genImageWidthMenu("100%", imgElement, protyle, id, nodeElement, html), {
                    id: "separator_1",
                    type: "separator",
                }, {
                    id: "widthDrag",
                    iconHTML: "",
                    type: "readonly",
                    label: `<div style="margin: 4px 0;" aria-label="${imgElement.parentElement.style.width ? imgElement.parentElement.style.width.replace("vw", "%").replace("calc(", "").replace(" - 8px)", "") : window.siyuan.languages.default}" class="b3-tooltips b3-tooltips__n"><input style="box-sizing: border-box" value="${(imgElement.parentElement.style.width.indexOf("%") > -1 || imgElement.parentElement.style.width.endsWith("vw")) ? parseInt(imgElement.parentElement.style.width.replace("calc(", "")) : 0}" class="b3-slider fn__block" max="100" min="1" step="1" type="range"></div>`,
                    bind(element) {
                        rangeElement = element.querySelector("input");
                        rangeElement.addEventListener("input", () => {
                            img3115(assetElement);
                            imgElement.parentElement.style.width = `calc(${rangeElement.value}% - 8px)`;
                            imgElement.style.height = "";
                            rangeElement.parentElement.setAttribute("aria-label", `${rangeElement.value}%`);
                        });
                        rangeElement.addEventListener("change", () => {
                            nodeElement.setAttribute("updated", dayjs().format("YYYYMMDDHHmmss"));
                            updateTransaction(protyle, nodeElement, html);
                            window.siyuan.menus.menu.remove();
                            focusBlock(nodeElement);
                        });
                    }
                }, {
                    id: "separator_2",
                    type: "separator",
                },
                genImageWidthMenu(window.siyuan.languages.default, imgElement, protyle, id, nodeElement, html),
            ]
        }).element);
        let rangeHeightElement: HTMLInputElement;
        window.siyuan.menus.menu.append(new MenuItem({
            id: "height",
            label: window.siyuan.languages.height,
            submenu: [{
                id: "heightInput",
                iconHTML: "",
                type: "readonly",
                label: `<div class="fn__flex"><input class="b3-text-field fn__flex-1" value="${imgElement.style.height.endsWith("px") ? parseInt(imgElement.style.height) : ""}" type="number" style="margin: 4px 8px 4px 0" placeholder="${window.siyuan.languages.height}"><span class="fn__flex-center">px</span></div>`,
                bind(element) {
                    const inputElement = element.querySelector("input");
                    inputElement.addEventListener("input", () => {
                        rangeHeightElement.value = "0";
                        rangeHeightElement.parentElement.setAttribute("aria-label", inputElement.value ? (inputElement.value + "px") : window.siyuan.languages.default);

                        imgElement.style.height = inputElement.value ? (inputElement.value + "px") : "";
                        img3115(assetElement);
                        imgElement.parentElement.style.width = "";
                    });
                    inputElement.addEventListener("blur", () => {
                        if (inputElement.value === imgElement.style.height.replace("px", "")) {
                            return;
                        }
                        nodeElement.setAttribute("updated", dayjs().format("YYYYMMDDHHmmss"));
                        updateTransaction(protyle, nodeElement, html);
                        window.siyuan.menus.menu.remove();
                        focusBlock(nodeElement);
                    });
                }
            },
                genImageHeightMenu("25%", imgElement, protyle, id, nodeElement, html),
                genImageHeightMenu("33%", imgElement, protyle, id, nodeElement, html),
                genImageHeightMenu("50%", imgElement, protyle, id, nodeElement, html),
                genImageHeightMenu("67%", imgElement, protyle, id, nodeElement, html),
                genImageHeightMenu("75%", imgElement, protyle, id, nodeElement, html),
                genImageHeightMenu("100%", imgElement, protyle, id, nodeElement, html), {
                    id: "separator_1",
                    type: "separator",
                }, {
                    id: "heightDrag",
                    iconHTML: "",
                    type: "readonly",
                    label: `<div style="margin: 4px 0;" aria-label="${imgElement.style.height ? imgElement.style.height.replace("vh", "%") : window.siyuan.languages.default}" class="b3-tooltips b3-tooltips__n"><input style="box-sizing: border-box" value="${imgElement.style.height.endsWith("vh") ? parseInt(imgElement.style.height) : 0}" class="b3-slider fn__block" max="100" min="1" step="1" type="range"></div>`,
                    bind(element) {
                        rangeHeightElement = element.querySelector("input");
                        rangeHeightElement.addEventListener("input", () => {
                            img3115(assetElement);
                            imgElement.parentElement.style.width = "";
                            imgElement.style.height = rangeHeightElement.value + "vh";
                            rangeHeightElement.parentElement.setAttribute("aria-label", `${rangeHeightElement.value}%`);
                        });
                        rangeHeightElement.addEventListener("change", () => {
                            nodeElement.setAttribute("updated", dayjs().format("YYYYMMDDHHmmss"));
                            updateTransaction(protyle, nodeElement, html);
                            window.siyuan.menus.menu.remove();
                            focusBlock(nodeElement);
                        });
                    }
                }, {
                    id: "separator_2",
                    type: "separator",
                },
                genImageHeightMenu(window.siyuan.languages.default, imgElement, protyle, id, nodeElement, html),
            ]
        }).element);
    }
    const imgSrc = imgElement.getAttribute("src");
    if (imgSrc) {
        window.siyuan.menus.menu.append(new MenuItem({id: "separator_3", type: "separator"}).element);
        openMenu(protyle.app, imgSrc, protyle.notebookId, false, false);
    }
    const dataSrc = imgElement.getAttribute("data-src");
    if (dataSrc && dataSrc.startsWith("assets/")) {
        window.siyuan.menus.menu.append(new MenuItem(exportAsset(dataSrc)).element);
        window.siyuan.menus.menu.append(new MenuItem(writeAssetToClipboard(dataSrc)).element);
    }
    window.siyuan.menus.menu.append(new MenuItem({
        id: "copyAsPNG",
        label: window.siyuan.languages.copyAsPNG,
        accelerator: window.siyuan.config.keymap.editor.general.copyBlockRef.custom,
        icon: "iconImage",
        click() {
            copyPNGByLink(imgElement.getAttribute("src"));
        }
    }).element);
    if (protyle?.app?.plugins) {
        emitOpenMenu({
            plugins: protyle.app.plugins,
            type: "open-menu-image",
            detail: {
                protyle,
                element: assetElement,
            },
            separatorPosition: "top",
        });
    }
    /// #if MOBILE
    window.siyuan.menus.menu.fullscreen();
    /// #else
    window.siyuan.menus.menu.popup({x: position.clientX, y: position.clientY});
    /// #endif
    const popoverElement = hasTopClosestByClassName(protyle.element, "block__popover", true);
    window.siyuan.menus.menu.element.setAttribute("data-from", popoverElement ? popoverElement.dataset.level + "popover" : "app");
    if (!protyle.disabled) {
        const textElements = window.siyuan.menus.menu.element.querySelectorAll("textarea");
        if (textElements[0].value) {
            textElements[1].select();
        } else {
            textElements[0].select();
        }
        window.siyuan.menus.menu.removeCB = async () => {
            const newSrc = textElements[0].value;
            if (src !== newSrc && newSrc.startsWith("data:image/")) {
                const base64Src = await base64ToURL([newSrc]);
                imgElement.setAttribute("src", base64Src[0]);
                imgElement.setAttribute("data-src", base64Src[0]);
                assetElement.querySelector(".img__net")?.remove();
            }

            const ocrElement = window.siyuan.menus.menu.element.querySelector('[data-type="ocr"]') as HTMLTextAreaElement;
            if (ocrElement && ocrElement.dataset.ocrText !== ocrElement.value) {
                fetchPost("/api/asset/setImageOCRText", {
                    path: imgElement.getAttribute("src"),
                    text: ocrElement.value
                });
            }
            imgElement.setAttribute("alt", textElements[2].value.replace(/\n|\r\n|\r|\u2028|\u2029/g, ""));
            nodeElement.setAttribute("updated", dayjs().format("YYYYMMDDHHmmss"));
            updateTransaction(protyle, nodeElement, html);
        };
    }
};

const genImageWidthMenu = (label: string, imgElement: HTMLElement, protyle: IProtyle, id: string, nodeElement: HTMLElement, html: string) => {
    return {
        id: label === window.siyuan.languages.default ? "default" : "width_" + label,
        iconHTML: "",
        label,
        click() {
            nodeElement.setAttribute("updated", dayjs().format("YYYYMMDDHHmmss"));
            img3115(imgElement.parentElement.parentElement);
            imgElement.parentElement.style.width = label === window.siyuan.languages.default ? "" : `calc(${label} - 8px)`;
            imgElement.style.height = "";
            updateTransaction(protyle, nodeElement, html);
            focusBlock(nodeElement);
        }
    };
};

const genImageHeightMenu = (label: string, imgElement: HTMLElement, protyle: IProtyle, id: string, nodeElement: HTMLElement, html: string) => {
    return {
        id: label === window.siyuan.languages.default ? "default" : "width_" + label,
        iconHTML: "",
        label,
        click() {
            nodeElement.setAttribute("updated", dayjs().format("YYYYMMDDHHmmss"));
            imgElement.style.height = label === window.siyuan.languages.default ? "" : parseInt(label) + "vh";
            img3115(imgElement.parentElement.parentElement);
            imgElement.parentElement.style.width = "";
            updateTransaction(protyle, nodeElement, html);
            focusBlock(nodeElement);
        }
    };
};

export const iframeMenu = (protyle: IProtyle, nodeElement: Element) => {
    const iframeElement = nodeElement.querySelector("iframe");
    let html = nodeElement.outerHTML;
    const subMenus: IMenu[] = [{
        id: "asset",
        iconHTML: "",
        type: "readonly",
        label: `<textarea spellcheck="false" rows="1" class="b3-text-field fn__block" placeholder="${window.siyuan.languages.link}" style="margin: 4px 0">${iframeElement.getAttribute("src") || ""}</textarea>`,
        bind(element) {
            element.style.maxWidth = "none";
            element.querySelector("textarea").addEventListener("change", (event) => {
                const value = (event.target as HTMLTextAreaElement).value.replace(/\n|\r\n|\r|\u2028|\u2029/g, "").trim();
                const biliMatch = value.match(/(?:www\.|\/\/)bilibili\.com\/video\/(\w+)/);
                if (value.indexOf("bilibili.com") > -1 && (value.indexOf("bvid=") > -1 || (biliMatch && biliMatch[1]))) {
                    const params: IObject = {
                        bvid: getSearch("bvid", value) || (biliMatch && biliMatch[1]),
                        page: "1",
                        high_quality: "1",
                        as_wide: "1",
                        allowfullscreen: "true",
                        autoplay: "0"
                    };
                    // `//player.bilibili.com/player.html?aid=895154192&bvid=BV1NP4y1M72N&cid=562898119&page=1`
                    // `https://www.bilibili.com/video/BV1ys411472E?t=3.4&p=4`
                    new URL(value.startsWith("http") ? value : "https:" + value).search.split("&").forEach((item, index) => {
                        if (!item) {
                            return;
                        }
                        if (index === 0) {
                            item = item.substr(1);
                        }
                        const keyValue = item.split("=");
                        params[keyValue[0]] = keyValue[1];
                    });
                    let src = "https://player.bilibili.com/player.html?";
                    const keys = Object.keys(params);
                    keys.forEach((key, index) => {
                        src += `${key}=${params[key]}`;
                        if (index < keys.length - 1) {
                            src += "&";
                        }
                    });
                    iframeElement.setAttribute("src", src);
                    iframeElement.setAttribute("sandbox", "allow-top-navigation-by-user-activation allow-same-origin allow-forms allow-scripts allow-popups allow-storage-access-by-user-activation");
                    if (!iframeElement.style.height) {
                        iframeElement.style.height = "360px";
                    }
                    if (!iframeElement.style.width) {
                        iframeElement.style.width = "640px";
                    }
                } else {
                    iframeElement.setAttribute("src", value);
                }

                updateTransaction(protyle, nodeElement, html);
                html = nodeElement.outerHTML;
                event.stopPropagation();
            });
        }
    }];
    const iframeSrc = iframeElement.getAttribute("src");
    if (iframeSrc) {
        subMenus.push({
            type: "separator"
        });
        return subMenus.concat(openMenu(
            protyle.app,
            iframeSrc,
            protyle.notebookId,
            true,
            false,
        ) as IMenu[]);
    }
    return subMenus;
};

export const videoMenu = (protyle: IProtyle, nodeElement: Element, type: string) => {
    const videoElement = nodeElement.querySelector(type === "NodeVideo" ? "video" : "audio");
    let html = nodeElement.outerHTML;
    const subMenus: IMenu[] = [{
        id: "asset",
        iconHTML: "",
        type: "readonly",
        label: `<textarea spellcheck="false" rows="1" style="margin: 4px 0" class="b3-text-field fn__block" placeholder="${window.siyuan.languages.link}">${videoElement.getAttribute("src")}</textarea>`,
        bind(element) {
            element.style.maxWidth = "none";
            element.querySelector("textarea").addEventListener("change", (event) => {
                videoElement.setAttribute("src", (event.target as HTMLTextAreaElement).value.replace(/\n|\r\n|\r|\u2028|\u2029/g, "").trim());
                updateTransaction(protyle, nodeElement, html);
                html = nodeElement.outerHTML;
                event.stopPropagation();
            });
        }
    }];
    const src = videoElement.getAttribute("src");
    if (src && src.startsWith("assets/")) {
        subMenus.push({
            type: "separator"
        });
        subMenus.push({
            id: "rename",
            label: window.siyuan.languages.rename,
            icon: "iconEdit",
            click() {
                renameAsset(src);
            }
        });
    }
    if (src) {
        subMenus.push({
            id: "openBy",
            label: window.siyuan.languages.openBy,
            icon: "iconOpen",
            submenu: openMenu(
                protyle.app,
                src,
                protyle.notebookId,
                true,
                false,
            ) as IMenu[]
        });
    }
    if (src && src.startsWith("assets/")) {
        subMenus.push(exportAsset(src));
        subMenus.push(writeAssetToClipboard(src));
    }
    return subMenus;
};

export const setFoldById = (data: {
    id: string,
    currentNodeID: string,
}, protyle: IProtyle) => {
    Array.from(protyle.wysiwyg.element.querySelectorAll(`[data-node-id="${data.id}"]`)).find((item: Element) => {
        if (!isInEmbedBlock(item)) {
            const operations = setFold(protyle, item, true, false, true, true);
            operations.doOperations[0].context = {
                focusId: data.currentNodeID,
            };
            transaction(protyle, operations.doOperations, operations.undoOperations);
            return true;
        }
    });
};
