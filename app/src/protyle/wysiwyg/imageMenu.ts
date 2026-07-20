import * as dayjs from "dayjs";
import {Constants} from "../../constants";
import {downloadExportFile} from "../util/download";
import {combineAbortSignals} from "../util/abortSignal";
import {resolveProtyleAssetSource} from "../util/assetSource";
import {isNarrowViewport} from "../util/browserPlatform";
import {writeText} from "../util/clipboard";
import {protyleContentIdentity} from "../util/contentLoad";
import {hasClosestBlock, hasTopClosestByClassName} from "../util/hasClosest";
import {openProtyleLink} from "../util/openLink";
import {emitProtylePluginMenu} from "../util/plugin";
import {focusBlock, focusByWbr} from "../util/selection";
import {hideElements} from "../ui/hideElements";
import {mathRender} from "../render/mathRender";
import {updateTransaction} from "./transaction";

type ImageMenuHandle = ReturnType<TProtyleRuntime["menu"]["open"]>;

interface OpenImageMenuOptions {
    readonly assetElement: HTMLElement;
    readonly position: {
        readonly clientX: number;
        readonly clientY: number;
    };
    readonly protyle: IProtyle;
    readonly range: Range;
}

interface ImageOCRResponse {
    readonly data: {
        readonly text: string;
    };
}

interface ImageUploadResponse extends Omit<IWebSocketData, "data"> {
    readonly data: {
        readonly succMap: Record<string, string>;
    };
}

const IMAGE_PERCENTAGES = [25, 33, 50, 67, 75, 100] as const;

const removeLineBreaks = (value: string) => value.replace(/\n|\r|\u2028|\u2029/g, "");
const cleanSource = (value: string) => removeLineBreaks(value).trim();
const isLocalAssetSource = (source: string | null): source is string => source?.startsWith("assets/") ?? false;

const updateImageNetworkMark = (
    protyle: IProtyle,
    assetElement: HTMLElement,
    source: string,
) => {
    const networkMark = assetElement.querySelector(".img__net");
    if (source.startsWith("assets/") || source.startsWith("data:image/") ||
        !protyle.settings.editor.displayNetImgMark) {
        networkMark?.remove();
    } else if (!networkMark) {
        assetElement.querySelector(".protyle-action__drag")!.insertAdjacentHTML(
            "afterend",
            '<span class="img__net"><svg><use href="#iconGlobe"></use></svg></span>',
        );
    }
};

export const normalizeImageContainerStyles = (element: HTMLElement) => {
    if (element.style.minWidth) {
        element.style.width = "";
    } else {
        element.removeAttribute("style");
    }
};

const notify = (
    protyle: IProtyle,
    level: "error" | "success",
    message: string,
) => protyle.host.dispatch({type: "notify", level, message});

const requestImageOperation = <TResponse>(
    protyle: IProtyle,
    signal: AbortSignal,
    path: string,
    body: unknown,
    intent: "read" | "write",
) => protyle.runtime.transport.request<TResponse>(path, body, {
    identity: protyleContentIdentity(protyle),
    intent,
    signal,
});

const copyImageAsPNG = async (protyle: IProtyle, source: string, signal: AbortSignal) => {
    try {
        const response = await fetch(resolveProtyleAssetSource(protyle, source), {
            credentials: "same-origin",
            signal,
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
        notify(protyle, "success", protyle.localization.text("copied"));
    } catch (error) {
        if (!signal.aborted) {
            console.error("[protyle.image-menu] image clipboard write failed", error);
            notify(protyle, "error", protyle.localization.text("clipboardPermissionDenied"));
        }
    }
};

const uploadDataImage = async (
    protyle: IProtyle,
    source: string,
): Promise<string> => {
    const response = await fetch(source, {signal: protyle.requestSignal});
    if (!response.ok) {
        throw new Error(`data image decode failed with HTTP ${response.status}`);
    }
    const blob = await response.blob();
    const subtype = blob.type.split("/", 2)[1] || "png";
    const extension = subtype === "jpeg" ? "jpg" : subtype === "svg+xml" ? "svg" : subtype;
    const formData = new FormData();
    const extraData = protyle.options.upload.extraData;
    Object.keys(extraData).forEach((key) => formData.append(key, extraData[key]));
    formData.append(
        protyle.options.upload.fieldName,
        new File([blob], `base64image-${Lute.NewNodeID()}.${extension}`, {type: blob.type}),
    );
    const identity = protyleContentIdentity(protyle);
    formData.set("id", identity.documentId);
    formData.set("notebook", identity.notebookId);
    const upload = await protyle.runtime.transport.upload<ImageUploadResponse>(formData, {
        identity,
        signal: protyle.requestSignal,
    });
    const uploadedSource = Object.values(upload.data.succMap)[0];
    if (!uploadedSource) {
        throw new Error("data image upload returned no asset path");
    }
    return uploadedSource;
};

const createCopyControl = (
    protyle: IProtyle,
    textarea: HTMLTextAreaElement,
    signal: AbortSignal,
) => {
    const control = document.createElement("span");
    control.className = "block__icon block__icon--show b3-tooltips b3-tooltips__e fn__flex-center";
    control.dataset.action = "copy";
    control.setAttribute("aria-label", protyle.localization.text("copy"));
    control.innerHTML = '<svg><use href="#iconCopy"></use></svg>';
    control.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        void writeText(textarea.value).then(() => {
            if (!signal.aborted) {
                notify(protyle, "success", protyle.localization.text("copied"));
            }
        }).catch((error) => {
            if (!signal.aborted) {
                console.error("[protyle.image-menu] clipboard write failed", error);
                notify(protyle, "error", protyle.localization.text("clipboardPermissionDenied"));
            }
        });
    }, {signal});
    return control;
};

const createMetadataEditor = (
    protyle: IProtyle,
    imgElement: HTMLImageElement,
    titleElement: HTMLElement,
    assetElement: HTMLElement,
    signal: AbortSignal,
) => {
    const root = document.createElement("div");
    const width = isNarrowViewport() ? "100%" : "360px";
    const createField = (label: string, value: string, spellcheck: boolean) => {
        const heading = document.createElement("div");
        heading.className = "fn__flex";
        const text = document.createElement("span");
        text.className = "fn__flex-center";
        text.textContent = label;
        const space = document.createElement("span");
        space.className = "fn__space";
        const textarea = document.createElement("textarea");
        textarea.className = "b3-text-field";
        textarea.rows = 1;
        textarea.spellcheck = spellcheck;
        textarea.style.margin = "4px 0";
        textarea.style.width = width;
        textarea.value = value;
        heading.append(text, space, createCopyControl(protyle, textarea, signal));
        root.append(heading, textarea);
        return textarea;
    };

    const sourceInput = createField(
        protyle.localization.text("imageURL"),
        imgElement.getAttribute("data-src") ?? imgElement.getAttribute("src") ?? "",
        false,
    );
    const sourceDivider = document.createElement("div");
    sourceDivider.className = "fn__hr";
    root.append(sourceDivider);
    const titleInput = createField(
        protyle.localization.text("title"),
        titleElement.innerText,
        true,
    );
    const titleDivider = document.createElement("div");
    titleDivider.className = "fn__hr";
    root.append(titleDivider);
    const altInput = createField(
        protyle.localization.text("tooltipText"),
        imgElement.getAttribute("alt") || "",
        true,
    );

    sourceInput.addEventListener("input", () => {
        const value = cleanSource(sourceInput.value);
        imgElement.setAttribute("data-src", value);
        imgElement.setAttribute("src", resolveProtyleAssetSource(protyle, value));
        updateImageNetworkMark(protyle, assetElement, value);
    }, {signal});
    titleInput.addEventListener("input", () => {
        imgElement.title = titleInput.value;
        titleElement.innerText = titleInput.value;
        mathRender(titleElement, protyle);
    }, {signal});
    return {altInput, root, sourceInput, titleInput};
};

const addSizeMenus = (
    handle: ImageMenuHandle,
    protyle: IProtyle,
    imgElement: HTMLImageElement,
    assetElement: HTMLElement,
    nodeElement: HTMLElement,
) => {
    const {menu} = handle;
    const defaultLabel = protyle.localization.text("default");
    const closeAndFocus = (nodeElement: HTMLElement) => {
        handle.close();
        focusBlock(nodeElement);
    };
    let widthSlider!: HTMLInputElement;
    const widthItems: IMenu[] = [{
        id: "widthInput",
        iconHTML: "",
        type: "readonly",
        label: `<div class="fn__flex"><input class="b3-text-field fn__flex-1" style="margin:4px 8px 4px 0" value="${imgElement.parentElement!.style.width.endsWith("px") ? parseInt(imgElement.parentElement!.style.width) : ""}" type="number" placeholder="${protyle.localization.text("width")}"><span class="fn__flex-center">px</span></div>`,
        bind(element) {
            const input = element.querySelector<HTMLInputElement>("input")!;
            input.addEventListener("input", () => {
                widthSlider.value = "0";
                widthSlider.parentElement!.setAttribute("aria-label", input.value ? `${input.value}px` : defaultLabel);
                normalizeImageContainerStyles(assetElement);
                imgElement.parentElement!.style.width = input.value ? `${input.value}px` : "";
                imgElement.style.height = "";
            });
            input.addEventListener("blur", () => closeAndFocus(nodeElement));
        },
    }, ...IMAGE_PERCENTAGES.map((percentage): IMenu => ({
        id: `width_${percentage}`,
        iconHTML: "",
        label: `${percentage}%`,
        click() {
            normalizeImageContainerStyles(assetElement);
            imgElement.parentElement!.style.width = `calc(${percentage}% - 8px)`;
            imgElement.style.height = "";
        },
    })), {
        id: "width_separator_1",
        type: "separator",
    }, {
        id: "widthDrag",
        iconHTML: "",
        type: "readonly",
        label: `<div style="margin:4px 0" aria-label="${imgElement.parentElement!.style.width ? imgElement.parentElement!.style.width.replace("vw", "%").replace("calc(", "").replace(" - 8px)", "") : defaultLabel}" class="b3-tooltips b3-tooltips__n"><input style="box-sizing:border-box" value="${imgElement.parentElement!.style.width.includes("%") || imgElement.parentElement!.style.width.endsWith("vw") ? parseInt(imgElement.parentElement!.style.width.replace("calc(", "")) : 0}" class="b3-slider fn__block" max="100" min="1" step="1" type="range"></div>`,
        bind(element) {
            widthSlider = element.querySelector<HTMLInputElement>("input")!;
            widthSlider.addEventListener("input", () => {
                normalizeImageContainerStyles(assetElement);
                imgElement.parentElement!.style.width = `calc(${widthSlider.value}% - 8px)`;
                imgElement.style.height = "";
                widthSlider.parentElement!.setAttribute("aria-label", `${widthSlider.value}%`);
            });
            widthSlider.addEventListener("change", () => closeAndFocus(nodeElement));
        },
    }, {
        id: "width_separator_2",
        type: "separator",
    }, {
        id: "width_default",
        iconHTML: "",
        label: defaultLabel,
        click() {
            normalizeImageContainerStyles(assetElement);
            imgElement.parentElement!.style.width = "";
            imgElement.style.height = "";
        },
    }];
    menu.addItem({id: "width", label: protyle.localization.text("width"), submenu: widthItems});

    let heightSlider!: HTMLInputElement;
    const heightItems: IMenu[] = [{
        id: "heightInput",
        iconHTML: "",
        type: "readonly",
        label: `<div class="fn__flex"><input class="b3-text-field fn__flex-1" style="margin:4px 8px 4px 0" value="${imgElement.style.height.endsWith("px") ? parseInt(imgElement.style.height) : ""}" type="number" placeholder="${protyle.localization.text("height")}"><span class="fn__flex-center">px</span></div>`,
        bind(element) {
            const input = element.querySelector<HTMLInputElement>("input")!;
            input.addEventListener("input", () => {
                heightSlider.value = "0";
                heightSlider.parentElement!.setAttribute("aria-label", input.value ? `${input.value}px` : defaultLabel);
                imgElement.style.height = input.value ? `${input.value}px` : "";
                normalizeImageContainerStyles(assetElement);
                imgElement.parentElement!.style.width = "";
            });
            input.addEventListener("blur", () => closeAndFocus(nodeElement));
        },
    }, ...IMAGE_PERCENTAGES.map((percentage): IMenu => ({
        id: `height_${percentage}`,
        iconHTML: "",
        label: `${percentage}%`,
        click() {
            imgElement.style.height = `${percentage}vh`;
            normalizeImageContainerStyles(assetElement);
            imgElement.parentElement!.style.width = "";
        },
    })), {
        id: "height_separator_1",
        type: "separator",
    }, {
        id: "heightDrag",
        iconHTML: "",
        type: "readonly",
        label: `<div style="margin:4px 0" aria-label="${imgElement.style.height ? imgElement.style.height.replace("vh", "%") : defaultLabel}" class="b3-tooltips b3-tooltips__n"><input style="box-sizing:border-box" value="${imgElement.style.height.endsWith("vh") ? parseInt(imgElement.style.height) : 0}" class="b3-slider fn__block" max="100" min="1" step="1" type="range"></div>`,
        bind(element) {
            heightSlider = element.querySelector<HTMLInputElement>("input")!;
            heightSlider.addEventListener("input", () => {
                normalizeImageContainerStyles(assetElement);
                imgElement.parentElement!.style.width = "";
                imgElement.style.height = `${heightSlider.value}vh`;
                heightSlider.parentElement!.setAttribute("aria-label", `${heightSlider.value}%`);
            });
            heightSlider.addEventListener("change", () => closeAndFocus(nodeElement));
        },
    }, {
        id: "height_separator_2",
        type: "separator",
    }, {
        id: "height_default",
        iconHTML: "",
        label: defaultLabel,
        click() {
            imgElement.style.height = "";
            normalizeImageContainerStyles(assetElement);
            imgElement.parentElement!.style.width = "";
        },
    }];
    menu.addItem({id: "height", label: protyle.localization.text("height"), submenu: heightItems});
};

export const openImageMenu = (options: OpenImageMenuOptions): ImageMenuHandle | undefined => {
    const {assetElement, position, protyle, range} = options;
    const closestNode = hasClosestBlock(assetElement);
    if (!closestNode) {
        return;
    }
    const nodeElement = closestNode as HTMLElement;
    const imgElement = assetElement.querySelector<HTMLImageElement>("img")!;
    const titleElement = assetElement.querySelector<HTMLElement>(".protyle-action__title span")!;
    const originalHTML = nodeElement.outerHTML;
    const originalDisplaySource = imgElement.getAttribute("src") || "";
    const originalPersistedSource = imgElement.getAttribute("data-src") ?? "";
    // Kernel OCR 只接收持久化资源路径，不接收 Gateway 解析后的 src。
    const currentPersistedSource = () => imgElement.getAttribute("data-src");
    const identity = protyleContentIdentity(protyle);
    const runtime = protyle.runtime;
    const handle = runtime.menu.open();
    const {menu} = handle;
    const controller = new AbortController();
    const menuSignal = combineAbortSignals([protyle.requestSignal, controller.signal]);
    let removed = false;
    let ocrEdited = false;
    let originalOCR = "";
    let ocrInput: HTMLTextAreaElement | undefined;

    menu.element.dataset.name = Constants.MENU_INLINE_IMG;
    hideElements(["util", "toolbar", "hint"], protyle);

    let metadata: ReturnType<typeof createMetadataEditor> | undefined;
    if (!protyle.disabled) {
        metadata = createMetadataEditor(protyle, imgElement, titleElement, assetElement, menuSignal);
        menu.addItem({
            id: "imageUrlAndTitleAndTooltipText",
            element: metadata.root,
            type: "readonly",
            bind: (element) => {
                element.style.maxWidth = "none";
            },
        });
        menu.addItem({id: "separator_1", type: "separator"});
    }

    menu.addItem({
        id: "copy",
        label: protyle.localization.text("copy"),
        accelerator: "⌘C",
        icon: "iconCopy",
        click: () => writeText(protyle.lute.BlockDOM2StdMd(assetElement.outerHTML).replace(/%20/g, " ")),
    });
    if (protyle.disabled) {
        menu.addItem({
            id: "copyImageURL",
            label: `${protyle.localization.text("copy")} ${protyle.localization.text("imageURL")}`,
            icon: "iconLink",
            click: () => writeText(imgElement.getAttribute("src") || ""),
        });
    } else {
        const remove = (copy: boolean) => {
            if (copy) {
                void writeText(protyle.lute.BlockDOM2StdMd(assetElement.outerHTML).replace(/%20/g, " "));
            }
            removed = true;
            assetElement.outerHTML = "<wbr>";
            nodeElement.setAttribute("updated", dayjs().format("YYYYMMDDHHmmss"));
            updateTransaction(protyle, nodeElement, originalHTML);
            focusByWbr(protyle.wysiwyg.element, range);
        };
        menu.addItem({
            id: "cut",
            icon: "iconCut",
            accelerator: "⌘X",
            label: protyle.localization.text("cut"),
            click: () => remove(true),
        });
        menu.addItem({
            id: "delete",
            icon: "iconTrashcan",
            accelerator: "⌫",
            label: protyle.localization.text("delete"),
            click: () => remove(false),
        });
        menu.addItem({id: "separator_2", type: "separator"});
        const imagePath = imgElement.getAttribute("data-src") || "";
        if (protyle.settings.features.assetRename && imagePath.startsWith("assets/")) {
            menu.addItem({
                id: "rename",
                label: protyle.localization.text("rename"),
                icon: "iconEdit",
                click: () => protyle.host.dispatch({
                    type: "rename-asset",
                    notebookId: identity.notebookId,
                    documentId: identity.documentId,
                    blockId: nodeElement.getAttribute("data-node-id")!,
                    assetPath: imagePath,
                }),
            });
        }
        menu.addItem({
            id: "ocr",
            label: "OCR",
            submenu: [{
                id: "ocrResult",
                iconHTML: "",
                type: "readonly",
                label: `<textarea spellcheck="false" data-type="ocr" style="margin:4px 0" rows="1" class="b3-text-field fn__block" placeholder="${protyle.localization.text("ocrResult")}"></textarea>`,
                bind(element) {
                    element.style.maxWidth = "none";
                    ocrInput = element.querySelector<HTMLTextAreaElement>("textarea")!;
                    ocrInput.addEventListener("input", () => {
                        ocrEdited = true;
                    }, {signal: menuSignal});
                    const persistedSource = currentPersistedSource();
                    if (!isLocalAssetSource(persistedSource)) {
                        return;
                    }
                    void requestImageOperation<ImageOCRResponse>(
                        protyle,
                        menuSignal,
                        "/api/asset/getImageOCRText",
                        {path: persistedSource},
                        "read",
                    ).then((response) => {
                        originalOCR = response.data.text;
                        if (!ocrEdited) {
                            ocrInput!.value = originalOCR;
                        }
                    }).catch((error) => {
                        if (!menuSignal.aborted) {
                            console.error("[protyle.image-menu] OCR text request failed", error);
                        }
                    });
                },
            }, {
                id: "ocr_separator",
                type: "separator",
            }, {
                id: "reOCR",
                iconHTML: "",
                label: protyle.localization.text("reOCR"),
                click: () => {
                    const persistedSource = currentPersistedSource();
                    if (!isLocalAssetSource(persistedSource)) {
                        return;
                    }
                    return requestImageOperation<IWebSocketData>(
                        protyle,
                        menuSignal,
                        "/api/asset/ocr",
                        {path: persistedSource, force: true},
                        "write",
                    ).then(() => undefined);
                },
            }],
        });
        menu.addItem({
            id: "alignCenter",
            icon: "iconAlignCenter",
            label: protyle.localization.text("alignCenter"),
            accelerator: protyle.settings.hotkeys.editor.general.alignCenter,
            click() {
                assetElement.style.minWidth = "calc(100% - 0.1em)";
            },
        });
        menu.addItem({
            id: "alignLeft",
            icon: "iconAlignLeft",
            label: protyle.localization.text("alignLeft"),
            accelerator: protyle.settings.hotkeys.editor.general.alignLeft,
            click() {
                assetElement.removeAttribute("style");
            },
        });
        addSizeMenus(handle, protyle, imgElement, assetElement, nodeElement);
    }

    const source = imgElement.getAttribute("data-src") ?? imgElement.getAttribute("src") ?? "";
    if (source) {
        menu.addItem({id: "separator_3", type: "separator"});
        menu.addItem({
            id: "openBy",
            icon: "iconOpen",
            label: protyle.localization.text("openBy"),
            click: () => openProtyleLink(protyle, source),
        });
    }
    const persistedSource = imgElement.getAttribute("data-src") || "";
    if (persistedSource.startsWith("assets/")) {
        menu.addItem({
            id: "export",
            label: protyle.localization.text("export"),
            icon: "iconUpload",
            click: () => downloadExportFile(runtime.resources.resolveAsset(identity, persistedSource)),
        });
    }
    menu.addItem({
        id: "copyAsPNG",
        label: protyle.localization.text("copyAsPNG"),
        accelerator: protyle.settings.hotkeys.editor.general.copyBlockRef,
        icon: "iconImage",
        click: () => copyImageAsPNG(protyle, imgElement.getAttribute("src") || "", menuSignal),
    });
    emitProtylePluginMenu({
        plugins: protyle.plugins,
        type: "open-menu-image",
        detail: {protyle, element: assetElement},
        separatorPosition: "top",
        localization: protyle.localization,
        menu,
    });

    if (isNarrowViewport()) {
        menu.fullscreen();
    } else {
        menu.popup({x: position.clientX, y: position.clientY});
    }
    const popoverElement = hasTopClosestByClassName(protyle.element, "block__popover", true);
    menu.element.dataset.from = popoverElement ? `${popoverElement.dataset.level}popover` : "app";
    if (metadata) {
        (metadata.sourceInput.value ? metadata.titleInput : metadata.sourceInput).select();
    }

    menu.removeCB = () => {
        controller.abort();
        if (removed || !metadata || protyle.requestSignal.aborted) {
            return;
        }
        const commit = () => {
            imgElement.alt = removeLineBreaks(metadata!.altInput.value);
            nodeElement.setAttribute("updated", dayjs().format("YYYYMMDDHHmmss"));
            updateTransaction(protyle, nodeElement, originalHTML);
        };
        const persistOCR = (source: string | null) => {
            if (!isLocalAssetSource(source) || !ocrEdited || !ocrInput || ocrInput.value === originalOCR) {
                return;
            }
            void requestImageOperation(
                protyle,
                protyle.requestSignal,
                "/api/asset/setImageOCRText",
                {path: source, text: ocrInput.value},
                "write",
            ).catch((error) => {
                if (!protyle.requestSignal.aborted) {
                    console.error("[protyle.image-menu] OCR text update failed", error);
                }
            });
        };
        const newSource = cleanSource(metadata.sourceInput.value);
        if (originalPersistedSource === newSource || !newSource.startsWith("data:image/")) {
            persistOCR(currentPersistedSource());
            commit();
            return;
        }
        void uploadDataImage(protyle, newSource).then((uploadedSource) => {
            if (protyle.requestSignal.aborted) {
                return;
            }
            imgElement.setAttribute("data-src", uploadedSource);
            imgElement.setAttribute("src", resolveProtyleAssetSource(protyle, uploadedSource));
            updateImageNetworkMark(protyle, assetElement, uploadedSource);
            persistOCR(uploadedSource);
            commit();
        }).catch((error) => {
            if (!protyle.requestSignal.aborted) {
                console.error("[protyle.image-menu] data image upload failed", error);
                imgElement.setAttribute("src", originalDisplaySource);
                imgElement.setAttribute("data-src", originalPersistedSource);
                updateImageNetworkMark(protyle, assetElement, originalPersistedSource || originalDisplaySource);
                notify(protyle, "error", protyle.localization.text("uploadError"));
                persistOCR(originalPersistedSource);
                commit();
            }
        });
    };
    return handle;
};
