import {transaction} from "../../wysiwyg/transaction";
import {updateAttrViewCellAnimation} from "./action";
import {isNarrowViewport} from "../../util/browserPlatform";
import {Constants} from "../../../constants";
import {uploadFiles} from "../../upload";
import {contentPathExtension} from "../../hint/path";
import {setToolbarPosition} from "../../toolbar/position";
import {previewAttrViewImages} from "../../preview/image";
import {genAVValueHTML} from "./blockAttr";
import {hasClosestBlock} from "../../util/hasClosest";
import {genCellValueByElement, getTypeByCellElement} from "./cell";
import {writeText} from "../../util/clipboard";
import {escapeAriaLabel, escapeAttr, escapeHtml} from "../../../util/escape";
import * as dayjs from "dayjs";
import {getColId} from "./col";
import {getFieldIdByCellElement} from "./row";
import {filesize} from "filesize";
import {protyleContentIdentity} from "../../util/contentLoad";
import {closeAVOverlay, currentAVOverlay} from "./overlay";
import {openAVMenu} from "./menu";
import {resolveProtyleAssetSource} from "../../util/assetSource";
import {downloadExportFile} from "../../util/download";
import {openProtyleConfirm} from "../../wysiwyg/dialogOwner";

interface AVUploadResponse extends Omit<IWebSocketData, "data"> {
    data: {
        succMap: Record<string, string>;
    };
}

const uploadedAVAssets = (responseText: string): IAVCellAssetValue[] => {
    const response = JSON.parse(responseText) as AVUploadResponse;
    return Object.entries(response.data.succMap).map(([filename, content]) => {
        const extension = contentPathExtension(filename);
        return {
            content,
            name: extension ? filename.slice(0, -extension.length) : filename,
            type: Constants.SIYUAN_ASSETS_IMAGE.includes(extension) ? "image" : "file",
        };
    });
};

export const uploadAVFiles = (options: {
    readonly files: FileList | File[];
    readonly input?: HTMLInputElement;
    readonly onUploaded: (assets: IAVCellAssetValue[]) => void;
    readonly owner: Element;
    readonly protyle: IProtyle;
}) => {
    uploadFiles(options.protyle, options.files, options.input, (responseText) => {
        if (options.protyle.requestSignal.aborted || options.protyle.destroyed || !options.owner.isConnected) {
            return;
        }
        options.onUploaded(uploadedAVAssets(responseText));
    });
};

const copyImageAsPNG = async (protyle: IProtyle, path: string) => {
    try {
        const response = await fetch(resolveProtyleAssetSource(protyle, path), {
            credentials: "same-origin",
            signal: protyle.requestSignal,
        });
        if (!response.ok) {
            throw new Error(`image request failed with HTTP ${response.status}`);
        }
        let blob = await response.blob();
        if (blob.type !== "image/png") {
            const bitmap = await createImageBitmap(blob);
            const canvas = document.createElement("canvas");
            canvas.width = bitmap.width;
            canvas.height = bitmap.height;
            canvas.getContext("2d")!.drawImage(bitmap, 0, 0);
            bitmap.close();
            blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob((png) => {
                if (png) {
                    resolve(png);
                } else {
                    reject(new Error("image could not be encoded as PNG"));
                }
            }, "image/png"));
        }
        await navigator.clipboard.write([new ClipboardItem({"image/png": blob})]);
        protyle.host.dispatch({
            type: "notify",
            level: "success",
            message: protyle.localization.text("copied"),
        });
    } catch (error) {
        if (!protyle.requestSignal.aborted) {
            console.error("[protyle.av.asset] image clipboard write failed", error);
            protyle.host.dispatch({
                type: "notify",
                level: "error",
                message: protyle.localization.text("clipboardPermissionDenied"),
            });
        }
    }
};

export const bindAssetEvent = (options: {
    protyle: IProtyle,
    menuElement: HTMLElement,
    cellElements: HTMLElement[],
    blockElement: Element
}) => {
    options.menuElement.querySelector("input").addEventListener("change", (event: InputEvent & {
        target: HTMLInputElement
    }) => {
        if (event.target.files.length === 0) {
            return;
        }
        uploadAVFiles({
            files: event.target.files,
            input: event.target,
            onUploaded: (assets) => updateAssetCell({
                protyle: options.protyle,
                cellElements: options.cellElements,
                addValue: assets,
                blockElement: options.blockElement,
            }),
            owner: options.blockElement,
            protyle: options.protyle,
        });
    });
};

export const getAssetHTML = (
    cellElements: HTMLElement[],
    localization: IProtyle["localization"],
    protyle: IProtyle,
) => {
    let html = "";
    genCellValueByElement(protyle, "mAsset", cellElements[0]).mAsset.forEach((item, index) => {
        let contentHTML;
        if (item.type === "image") {
            contentHTML = `<span data-type="openAssetItem" class="fn__flex-1 ariaLabel" aria-label="${escapeAriaLabel(item.content)}">
    <img style="max-height: 180px;max-width: 360px;border-radius: var(--b3-border-radius);margin: 4px 0;" data-src="${escapeAttr(item.content)}" src="${escapeAttr(resolveProtyleAssetSource(protyle, item.content))}"/>
</span>`;
        } else {
            contentHTML = `<span data-type="openAssetItem" class="fn__ellipsis b3-menu__label ariaLabel" aria-label="${escapeAriaLabel(item.content)}" style="max-width: 360px">${escapeHtml(item.name || item.content)}</span>`;
        }

        html += `<button class="b3-menu__item" draggable="true" data-index="${index}" data-name="${escapeAttr(item.name)}" data-type="${item.type}" data-content="${escapeAttr(item.content)}">
<svg class="b3-menu__icon fn__grab"><use xlink:href="#iconDrag"></use></svg>
${contentHTML}
<svg class="b3-menu__action" data-type="editAssetItem"><use xlink:href="#iconEdit"></use></svg>
</button>`;
    });
    const ids: string[] = [];
    cellElements.forEach(item => {
        ids.push(item.dataset.id);
    });
    return `<div class="b3-menu__items" data-ids="${ids}">
    ${html}
    <button data-type="addAssetExist" class="b3-menu__item b3-menu__item--current">
        <svg class="b3-menu__icon"><use xlink:href="#iconImage"></use></svg>
        <span class="b3-menu__label">${localization.text("assets")}</span>
    </button>
    <button class="b3-menu__item">
        <svg class="b3-menu__icon"><use xlink:href="#iconDownload"></use></svg>
        <span class="b3-menu__label">${localization.text("insertAsset")}</span>
        <input multiple class="b3-form__upload" type="file">
    </button>
    <button data-type="addAssetLink" class="b3-menu__item">
        <svg class="b3-menu__icon"><use xlink:href="#iconLink"></use></svg>
        <span class="b3-menu__label">${localization.text("link")}</span>
    </button>
</div>`;
};

export const updateAssetCell = (options: {
    protyle: IProtyle,
    cellElements: HTMLElement[],
    replaceValue?: IAVCellAssetValue[],
    addValue?: IAVCellAssetValue[],
    updateValue?: { index: number, value: IAVCellAssetValue }
    removeIndex?: number,
    blockElement: Element
}) => {
    const {localization} = options.protyle;
    const viewType = options.blockElement.getAttribute("data-av-type") as TAVView;
    const colId = getColId(options.cellElements[0], viewType);
    const cellDoOperations: IOperation[] = [];
    const cellUndoOperations: IOperation[] = [];
    let mAssetValue: IAVCellAssetValue[];
    options.cellElements.forEach((item, elementIndex) => {
        const rowID = getFieldIdByCellElement(item, viewType);
        if (!options.blockElement.contains(item)) {
            if (viewType === "table") {
                item = options.cellElements[elementIndex] = (options.blockElement.querySelector(`.av__row[data-id="${rowID}"] .av__cell[data-col-id="${item.dataset.colId}"]`) ||
                    options.blockElement.querySelector(`.fn__flex-1[data-col-id="${item.dataset.colId}"]`)) as HTMLElement;
            } else {
                item = options.cellElements[elementIndex] = (options.blockElement.querySelector(`.av__gallery-item[data-id="${rowID}"] .av__cell[data-field-id="${item.dataset.fieldId}"]`)) as HTMLElement;
            }
        }
        const cellValue = genCellValueByElement(options.protyle, getTypeByCellElement(item) || item.dataset.type as TAVCol, item);
        const oldValue = JSON.parse(JSON.stringify(cellValue));
        if (elementIndex === 0) {
            if (typeof options.removeIndex === "number") {
                cellValue.mAsset.splice(options.removeIndex, 1);
            } else if (options.addValue?.length > 0) {
                cellValue.mAsset = cellValue.mAsset.concat(options.addValue);
            } else if (options.updateValue) {
                cellValue.mAsset.find((assetItem, index) => {
                    if (index === options.updateValue.index) {
                        assetItem.content = options.updateValue.value.content;
                        assetItem.type = options.updateValue.value.type;
                        assetItem.name = options.updateValue.value.name;
                        return true;
                    }
                });
            } else if (options.replaceValue?.length > 0) {
                cellValue.mAsset = options.replaceValue;
            }
            mAssetValue = cellValue.mAsset;
        } else {
            cellValue.mAsset = mAssetValue;
        }
        const avID = options.blockElement.getAttribute("data-av-id");
        cellDoOperations.push({
            action: "updateAttrViewCell",
            id: cellValue.id,
            keyID: colId,
            rowID,
            avID,
            data: cellValue
        });
        cellUndoOperations.push({
            action: "updateAttrViewCell",
            id: cellValue.id,
            keyID: colId,
            rowID,
            avID,
            data: oldValue
        });
        if (item.classList.contains("custom-attr__avvalue")) {
            item.innerHTML = genAVValueHTML(cellValue, options.protyle.settings.icons.file, localization, options.protyle);
        } else {
            updateAttrViewCellAnimation(options.protyle, item, cellValue);
        }
    });
    cellDoOperations.push({
        action: "doUpdateUpdated",
        id: options.blockElement.getAttribute("data-node-id"),
        data: dayjs().format("YYYYMMDDHHmmss"),
    });
    transaction(options.protyle, cellDoOperations, cellUndoOperations);
    const menuElement = currentAVOverlay(options.protyle, "panel")?.lastElementChild as HTMLElement;
    if (menuElement) {
        menuElement.innerHTML = getAssetHTML(options.cellElements, localization, options.protyle);
        bindAssetEvent({
            protyle: options.protyle,
            menuElement,
            cellElements: options.cellElements,
            blockElement: options.blockElement
        });
        const cellRect = (options.cellElements[0].classList.contains("custom-attr__avvalue") ? options.cellElements[0] : options.protyle.wysiwyg.element.querySelector(`.av__cell[data-id="${options.cellElements[0].dataset.id}"]`)).getBoundingClientRect();
        setTimeout(() => {
            setToolbarPosition(menuElement, cellRect.left, cellRect.bottom, cellRect.height, 0, true);
        }, Constants.TIMEOUT_LOAD);  // 等待图片加载
    }
};

export const editAssetItem = (options: {
    protyle: IProtyle,
    cellElements: HTMLElement[],
    blockElement: Element,
    content: string,
    type: "image" | "file",
    name: string,
    index: number,
    rect: DOMRect
}) => {
    const {localization} = options.protyle;
    const identity = protyleContentIdentity(options.protyle);
    const linkAddress = options.content.replace(/\?style=thumb$/, "");
    const type = options.type as "image" | "file";
    const menuHandle = openAVMenu(options.protyle, Constants.MENU_AV_ASSET_EDIT, (menu) => {
        const textElements = menu.element.querySelectorAll("textarea");
        const currentLink = textElements[0].value;
        if ((!textElements[1] && currentLink === decodeURI(linkAddress)) ||
            (textElements[1] && currentLink === decodeURI(linkAddress) && textElements[1].value === options.name)) {
            return;
        }
        const update = (content: string) => updateAssetCell({
            protyle: options.protyle,
            cellElements: options.cellElements,
            blockElement: options.blockElement,
            updateValue: {
                index: options.index,
                value: {
                    content,
                    name: textElements[1] ? textElements[1].value : "",
                    type,
                },
            },
        });
        if (type !== "image" || !currentLink.startsWith("data:image/")) {
            update(currentLink);
            return;
        }
        void fetch(currentLink, {signal: options.protyle.requestSignal}).then((response) => response.blob()).then((blob) => {
            const subtype = blob.type.split("/", 2)[1] || "png";
            const extension = subtype === "jpeg" ? "jpg" : subtype === "svg+xml" ? "svg" : subtype;
            uploadAVFiles({
                files: [new File([blob], `base64image-${Lute.NewNodeID()}.${extension}`, {type: blob.type})],
                onUploaded: (assets) => update(assets[0].content),
                owner: options.blockElement,
                protyle: options.protyle,
            });
        }).catch((error) => {
            if (!options.protyle.requestSignal.aborted) {
                console.error("[protyle.av.asset] data image conversion failed", error);
                options.protyle.host.dispatch({
                    type: "notify",
                    level: "error",
                    message: localization.text("uploadError"),
                });
            }
        });
    });
    if (!menuHandle) {
        return;
    }
    const {menu} = menuHandle;
    if (type === "file") {
        menu.addItem({
            id: "linkAndTitle",
            iconHTML: "",
            type: "readonly",
            label: `<div class="fn__flex">
    <span class="fn__flex-center">${localization.text("link")}</span>
    <span class="fn__space"></span>
    <span data-action="copy" class="block__icon block__icon--show b3-tooltips b3-tooltips__e fn__flex-center" aria-label="${localization.text("copy")}">
        <svg><use xlink:href="#iconCopy"></use></svg>
    </span>   
</div><textarea rows="1" style="margin:4px 0;width: ${isNarrowViewport() ? "100%" : "360px"};resize: vertical;" class="b3-text-field"></textarea><div class="fn__hr"></div><div class="fn__flex">
    <span class="fn__flex-center">${localization.text("title")}</span>
    <span class="fn__space"></span>
    <span data-action="copy" class="block__icon block__icon--show b3-tooltips b3-tooltips__e fn__flex-center" aria-label="${localization.text("copy")}">
        <svg><use xlink:href="#iconCopy"></use></svg>
    </span>   
</div><textarea style="width: ${isNarrowViewport() ? "100%" : "360px"};margin: 4px 0;resize: vertical;" rows="1" class="b3-text-field"></textarea>`,
            bind(element) {
                element.addEventListener("click", (event) => {
                    let target = event.target as HTMLElement;
                    while (target) {
                        if (target.dataset.action === "copy") {
                            writeText((target.parentElement.nextElementSibling as HTMLTextAreaElement).value);
                            options.protyle.host.dispatch({
                                type: "notify",
                                level: "success",
                                message: localization.text("copied"),
                            });
                            break;
                        }
                        target = target.parentElement;
                    }
                });
            }
        });
        menu.addItem({id: "separator_1", type: "separator"});
        menu.addItem({
            id: "copy",
            label: localization.text("copy"),
            icon: "iconCopy",
            click() {
                writeText(`[${textElements[1].value || textElements[0].value}](${textElements[0].value})`);
            }
        });
    } else {
        menu.addItem({
            id: "link",
            iconHTML: "",
            type: "readonly",
            label: `<div class="fn__flex">
    <span class="fn__flex-center">${localization.text("link")}</span>
    <span class="fn__space"></span>
    <span data-action="copy" class="block__icon block__icon--show b3-tooltips b3-tooltips__e fn__flex-center" aria-label="${localization.text("copy")}">
        <svg><use xlink:href="#iconCopy"></use></svg>
    </span>   
</div><textarea rows="1" style="margin:4px 0;width: ${isNarrowViewport() ? "100%" : "360px"};resize: vertical;" class="b3-text-field"></textarea>`,
            bind(element) {
                element.addEventListener("click", (event) => {
                    let target = event.target as HTMLElement;
                    while (target) {
                        if (target.dataset.action === "copy") {
                            writeText((target.parentElement.nextElementSibling as HTMLTextAreaElement).value);
                            options.protyle.host.dispatch({
                                type: "notify",
                                level: "success",
                                message: localization.text("copied"),
                            });
                            break;
                        }
                        target = target.parentElement;
                    }
                });
            }
        });
        menu.addItem({id: "separator_1", type: "separator"});
        menu.addItem({
            id: "copy",
            label: localization.text("copy"),
            icon: "iconCopy",
            click() {
                writeText(`![](${textElements[0].value})`);
            }
        });
        menu.addItem({
            id: "copyAsPNG",
            label: localization.text("copyAsPNG"),
            icon: "iconImage",
            click() {
                void copyImageAsPNG(options.protyle, textElements[0].value);
            }
        });
    }
    menu.addItem({
        id: "delete",
        icon: "iconTrashcan",
        label: localization.text("delete"),
        click() {
            updateAssetCell({
                protyle: options.protyle,
                cellElements: options.cellElements,
                blockElement: options.blockElement,
                removeIndex: options.index
            });
        }
    });
    if (options.protyle.settings.features.assetRename && linkAddress?.startsWith("assets/")) {
        menu.addItem({
            id: "rename",
            label: localization.text("rename"),
            icon: "iconEdit",
            click() {
                options.protyle.host.dispatch({
                    type: "rename-asset",
                    notebookId: identity.notebookId,
                    documentId: identity.documentId,
                    blockId: options.blockElement.getAttribute("data-node-id")!,
                    assetPath: decodeURI(linkAddress),
                });
                closeAVOverlay(options.protyle, "panel");
            }
        });
    }
    const openSubMenu: IMenu[] = [];
    if (linkAddress) {
        const assetPath = linkAddress.trim();
        const isSupportedAsset = assetPath.startsWith("assets/") &&
            Constants.SIYUAN_ASSETS_EXTS.includes(contentPathExtension(assetPath.split("?", 1)[0])) &&
            (!assetPath.endsWith(".pdf") || !assetPath.startsWith("file://"));
        if (isSupportedAsset) {
            const page = Number.parseInt(new URLSearchParams(assetPath.split("?", 2)[1] ?? "").get("page") ?? "", 10);
            openSubMenu.push({
                id: "insertRight",
                icon: "iconLayoutRight",
                label: localization.text("insertRight"),
                click: () => options.protyle.host.dispatch({
                    type: "open-asset",
                    documentId: identity.documentId,
                    notebookId: identity.notebookId,
                    assetPath,
                    page,
                    disposition: "split-right",
                }),
            }, {
                id: "openBy",
                icon: "iconOpen",
                label: localization.text("openBy"),
                click: () => options.protyle.host.dispatch({
                    type: "open-asset",
                    documentId: identity.documentId,
                    notebookId: identity.notebookId,
                    assetPath,
                    page,
                    disposition: "current",
                }),
            });
        } else {
            const url = assetPath.startsWith("/") || assetPath.includes(":") ? assetPath : `https://${assetPath}`;
            openSubMenu.push({
                id: "useBrowserView",
                label: localization.text("useBrowserView"),
                click: () => options.protyle.host.dispatch({type: "open-external", url}),
            });
        }
    }
    if (type !== "file" || openSubMenu.length > 0) {
        menu.addItem({id: "separator_2", type: "separator"});
    }
    if (type !== "file") {
        menu.addItem({
            id: "cardPreview",
            icon: "iconPreview",
            label: localization.text("cardPreview"),
            click() {
                previewAttrViewImages(
                    options.protyle,
                    linkAddress,
                    options.blockElement.getAttribute("data-av-id"),
                    options.blockElement.getAttribute(Constants.CUSTOM_SY_AV_VIEW),
                    options.blockElement.querySelector('[data-type="av-search"]')?.textContent.trim() || ""
                );
            }
        });
    }
    if (openSubMenu.length > 0) {
        menu.addItem({
            id: "openBy",
            label: localization.text("openBy"),
            icon: "iconOpen",
            submenu: openSubMenu
        });
    }
    if (linkAddress?.startsWith("assets/")) {
        menu.addItem({
            id: "export",
            label: localization.text("export"),
            icon: "iconUpload",
            click: () => downloadExportFile(resolveProtyleAssetSource(options.protyle, decodeURI(linkAddress))),
        });
    }
    const rect = options.rect;
    menu.popup({
        x: rect.right,
        y: rect.top,
        w: rect.width,
        h: rect.height,
    });
    const textElements = menu.element.querySelectorAll("textarea");
    textElements[0].value = decodeURI(linkAddress);
    textElements[0].focus();
    textElements[0].select();
    if (textElements.length > 1) {
        textElements[1].value = options.name;
    }
};

export const addAssetLink = (protyle: IProtyle, cellElements: HTMLElement[], target: HTMLElement, blockElement: Element) => {
    const {localization} = protyle;
    const menuHandle = openAVMenu(protyle, Constants.MENU_AV_ASSET_EDIT, (menu) => {
        const textElements = menu.element.querySelectorAll("textarea");
        if (!textElements[0].value && !textElements[1].value) {
            return;
        }
        updateAssetCell({
            protyle,
            cellElements,
            blockElement,
            addValue: [{
                type: "file",
                name: textElements[1].value,
                content: textElements[0].value,
            }]
        });
    });
    if (!menuHandle) {
        return;
    }
    const {menu} = menuHandle;
    menu.addItem({
        iconHTML: "",
        type: "readonly",
        label: `${localization.text("link")}
<textarea rows="1" style="margin:4px 0;width: ${isNarrowViewport() ? "200" : "360"}px;resize: vertical;" class="b3-text-field"></textarea>
<div class="fn__hr"></div>
${localization.text("title")}
<textarea style="width: ${isNarrowViewport() ? "200" : "360"}px;margin: 4px 0;resize: vertical;" rows="1" class="b3-text-field"></textarea>`,
    });
    const rect = target.getBoundingClientRect();
    menu.popup({
        x: rect.right,
        y: rect.bottom,
        w: target.parentElement.clientWidth + 8,
        h: rect.height,
    });
    menu.element.querySelector("textarea").focus();
};

export const dragUpload = (files: ILocalFiles[], protyle: IProtyle, cellElement: HTMLElement) => {
    const {localization} = protyle;
    let msg = "";
    const assetPaths: string[] = [];
    files.forEach(item => {
        if (item.size && Constants.SIZE_UPLOAD_TIP_SIZE <= item.size) {
            msg += localization.text("uploadFileTooLarge").replace("${x}", item.path)
                .replace("${y}", filesize(item.size, {standard: "iec"})) + "\n";
        }
        assetPaths.push(item.path);
    });

    const insert = () => {
        const identity = protyleContentIdentity(protyle);
        void protyle.transport!.request<IWebSocketData>("/api/asset/insertLocalAssets", {
            assetPaths,
            isUpload: true,
            id: protyle.block.rootID
        }, {
            identity,
            intent: "write",
            signal: protyle.requestSignal,
        }).then((response) => {
            if (protyle.requestSignal.aborted || protyle.destroyed || !cellElement.isConnected) {
                return;
            }
            const blockElement = hasClosestBlock(cellElement);
            if (blockElement) {
                const addValue: IAVCellAssetValue[] = [];
                Object.keys(response.data.succMap).forEach(key => {
                    const type = contentPathExtension(key);
                    const name = key.substring(0, key.length - type.length);
                    if (Constants.SIYUAN_ASSETS_IMAGE.includes(type)) {
                        addValue.push({
                            type: "image",
                            name,
                            content: response.data.succMap[key],
                        });
                    } else {
                        addValue.push({
                            type: "file",
                            name,
                            content: response.data.succMap[key],
                        });
                    }
                });
                updateAssetCell({
                    protyle,
                    blockElement,
                    cellElements: [cellElement],
                    addValue
                });
            }
        }).catch((error) => {
            if (!protyle.requestSignal.aborted) {
                console.error("[protyle.transport] local asset insertion failed", {
                    documentId: identity.documentId,
                    notebookId: identity.notebookId,
                    error,
                });
            }
        });
    };
    if (msg) {
        openProtyleConfirm({
            message: msg.trimEnd(),
            onConfirm: insert,
            protyle,
            title: localization.text("upload"),
        });
    } else {
        insert();
    }
};
