import {insertHTML} from "../util/insertHTML";
import {Constants} from "../../constants";
import {getEditorRange} from "../util/selection";
import {createAssetBlockDOM} from "../util/assetBlockDOM";
import {hasClosestBlock, hasClosestByClassName} from "../util/hasClosest";
import {getContenteditableElement} from "../wysiwyg/getBlock";
import {getTypeByCellElement, updateCellsValue} from "../render/av/cell";
import {scrollCenter} from "../util/highlightById";
import {filesize} from "filesize";
import {transaction} from "../wysiwyg/transaction";
import dayjs from "dayjs";
import {protyleContentIdentity} from "../util/contentLoad";
import {openProtyleConfirm} from "../wysiwyg/dialogOwner";
import {canWriteProtyleContent} from "../runtime/readOnly";

interface UploadResponse extends Omit<IWebSocketData, "data"> {
    data: {
        errFiles?: string[];
        succMap: Record<string, string>;
    };
}

const isUploadCurrent = (protyle: IProtyle) =>
    !protyle.destroyed && !protyle.requestSignal.aborted && protyle.element.isConnected;

const isAbort = (error: unknown) =>
    error instanceof DOMException && error.name === "AbortError";

const getErrorMessage = (error: unknown) =>
    error instanceof Error ? error.message : String(error);

const notifyUpload = (
    protyle: IProtyle,
    level: "error" | "info",
    message: string,
) => protyle.host.dispatch({type: "notify", level, message});

const getFileExtension = (filename: string) => {
    const lastIndex = filename.lastIndexOf(".");
    return lastIndex <= 0 ? "" : filename.substring(lastIndex).toLowerCase();
};

export class Upload {
    public element: HTMLElement;
    public isUploading: boolean;

    constructor() {
        this.isUploading = false;
        this.element = document.createElement("div");
        this.element.className = "protyle-upload";
    }
}

/** 在上传请求前按大小、类型和命名策略筛选文件，并返回可展示的状态文案。 */
const validateFile = (protyle: IProtyle, files: File[]) => {
    const uploadFileList = [];
    const errors: string[] = [];
    const uploading: string[] = [];

    for (let iMax = files.length, i = 0; i < iMax; i++) {
        const file = files[i];
        let validate = true;

        if (!file.name) {
            errors.push(protyle.localization.text("nameEmpty"));
            validate = false;
        }

        if (file.size > protyle.options.upload.max) {
            errors.push(`${file.name} ${protyle.localization.text("over")} ${protyle.options.upload.max / 1024 / 1024}M`);
            validate = false;
        }

        const lastIndex = file.name.lastIndexOf(".");
        const fileExt = lastIndex === -1 ? "" : file.name.substr(lastIndex);
        const filename = lastIndex === -1 ? file.name : (protyle.options.upload.filename(file.name.substr(0, lastIndex)) + fileExt);

        if (protyle.options.upload.accept) {
            const isAccept = protyle.options.upload.accept.split(",").some((item) => {
                const type = item.trim();
                if (type.indexOf(".") === 0) {
                    if (fileExt.toLowerCase() === type.toLowerCase()) {
                        return true;
                    }
                } else {
                    if (file.type.split("/")[0] === type.split("/")[0]) {
                        return true;
                    }
                }
                return false;
            });

            if (!isAccept) {
                errors.push(`${file.name} ${protyle.localization.text("fileTypeError")}`);
                validate = false;
            }
        }

        if (validate) {
            uploadFileList.push(file);
            uploading.push(`${filename} ${protyle.localization.text("uploading")}`);
        }
    }
    if (errors.length > 0) {
        notifyUpload(protyle, "error", errors.join("\n"));
    }
    return {files: uploadFileList, statusMessages: uploading};
};

/** 处理上传结果并把资源写入当前编辑器或属性视图，迟到响应不得操作已销毁编辑器。 */
const genUploadedLabel = async (response: UploadResponse, protyle: IProtyle) => {
    if (!isUploadCurrent(protyle)) {
        return;
    }
    const errors: string[] = [];

    if (response.code === 1) {
        errors.push(response.msg);
    }

    if (response.data.errFiles && response.data.errFiles.length > 0) {
        response.data.errFiles.forEach((data: string) => {
            const lastIndex = data.lastIndexOf(".");
            const filename = lastIndex === -1 ? data : (protyle.options.upload.filename(data.substr(0, lastIndex)) + data.substr(lastIndex));
            errors.push(`${filename} ${protyle.localization.text("uploadError")}`);
        });
    }

    if (errors.length > 0) {
        notifyUpload(protyle, "error", errors.join("\n"));
    }
    let insertBlock = true;
    const range = getEditorRange(protyle.wysiwyg.element);
    if (range.toString() === "" && range.startContainer.nodeType === 3 && protyle.toolbar.getCurrentType(range).length > 0) {
        // 防止链接插入其他元素中 https://ld246.com/article/1676003478664
        range.setEndAfter(range.startContainer.parentElement);
        range.collapse(false);
    }
    const keys = Object.keys(response.data.succMap);
    // https://github.com/siyuan-note/siyuan/issues/7624
    const nodeElement = hasClosestBlock(range.startContainer);
    if (nodeElement) {
        if (nodeElement.classList.contains("table")) {
            insertBlock = false;
        } else {
            const editableElement = getContenteditableElement(nodeElement);
            if (editableElement && nodeElement.classList.contains("p") &&
                (editableElement.textContent !== "" || keys.length < 2)) {
                insertBlock = false;
            }
        }
    }
    let successFileText = "";
    // 插入多个资源文件时按文件名自然升序排列 https://github.com/siyuan-note/siyuan/issues/14643
    keys.sort((a, b) => a.localeCompare(b, undefined, {numeric: true}));
    const avAssets: IAVCellAssetValue[] = [];
    let hasImage = false;
    keys.forEach((key, index) => {
        const path = response.data.succMap[key];
        const type = getFileExtension(key);
        const filename = protyle.options.upload.filename(key);
        const name = filename.substring(0, filename.length - type.length);
        hasImage = Constants.SIYUAN_ASSETS_IMAGE.includes(type);
        avAssets.push({
            type: Constants.SIYUAN_ASSETS_IMAGE.includes(type) ? "image" : "file",
            content: path,
            name: name
        });
        successFileText += createAssetBlockDOM({
            path,
            imageAlt: name,
            linkLabel: filename,
            showNetworkMark: !path.startsWith("assets/"),
        });
        if (!Constants.SIYUAN_ASSETS_AUDIO.includes(type) && !Constants.SIYUAN_ASSETS_VIDEO.includes(type) &&
            keys.length - 1 !== index) {
            if (nodeElement && nodeElement.classList.contains("table")) {
                successFileText += "<br>";
            } else if (insertBlock) {
                successFileText += "\n\n";
            } else {
                successFileText += "\n";
            }
        }
    });

    if (document.querySelector(".av__panel")) {
        const cellElements: HTMLElement[] = [document.querySelector('.custom-attr__avvalue[data-type="mAsset"][data-active="true"]')];
        if (!cellElements[0]) {
            cellElements.splice(0, 1);
            protyle.wysiwyg.element.querySelectorAll(".av__cell--active").forEach((item: HTMLElement) => {
                if (getTypeByCellElement(item) === "mAsset") {
                    cellElements.push(item);
                }
            });
            if (cellElements.length === 0) {
                document.querySelector(".av__panel .b3-menu__items")?.getAttribute("data-ids")?.split(",").forEach((id: string) => {
                    const item = protyle.wysiwyg.element.querySelector(`.av__gallery-fields [data-dtype="mAsset"][data-id="${id}"]`) as HTMLElement;
                    if (item) {
                        cellElements.push(item);
                    }
                });
            }
        }
        if (cellElements.length > 0) {
            const blockElement = hasClosestBlock(cellElements[0]);
            if (blockElement) {
                updateCellsValue(protyle, blockElement, avAssets, cellElements);
                document.querySelector(".av__panel")?.remove();
                return;
            }
        } else {
            return;
        }
    } else if (nodeElement && nodeElement.classList.contains("av")) {
        const cellElements: HTMLElement[] = [];
        nodeElement.querySelectorAll(".av__row--select:not(.av__row--header)").forEach(item => {
            item.querySelectorAll(".av__cell").forEach((cellItem: HTMLElement) => {
                if (getTypeByCellElement(cellItem) === "mAsset") {
                    cellElements.push(cellItem);
                }
            });
        });
        if (cellElements.length === 0) {
            protyle.wysiwyg.element.querySelectorAll(".av__cell--active").forEach((item: HTMLElement) => {
                if (getTypeByCellElement(item) === "mAsset") {
                    cellElements.push(item);
                }
            });
        }
        if (cellElements.length === 1) {
            updateCellsValue(protyle, nodeElement, avAssets, cellElements);
        } else if (cellElements.length > 1) {
            const doOperations: IOperation[] = [];
            const undoOperations: IOperation[] = [];
            let currentRowElement;
            const colId = cellElements[0].getAttribute("data-col-id");
            for (let i = 0; i < avAssets.length; i++) {
                let cellElement = cellElements[i];
                if (!cellElement) {
                    if (!currentRowElement) {
                        currentRowElement = hasClosestByClassName(cellElements[i - 1], "av__row") as HTMLElement;
                    }
                    if (currentRowElement) {
                        currentRowElement = currentRowElement.nextElementSibling;
                        if (currentRowElement && currentRowElement.classList.contains("av__row")) {
                            cellElement = currentRowElement.querySelector(`.av__cell[data-col-id="${colId}"]`);
                        }
                    }
                }
                if (!cellElement) {
                    break;
                }
                const operations = await updateCellsValue(protyle, nodeElement,
                    [avAssets[i]], [cellElement], null, null, true);
                if (!isUploadCurrent(protyle)) {
                    return;
                }
                doOperations.push(...operations.doOperations);
                undoOperations.push(...operations.undoOperations);
            }
            if (doOperations.length > 0) {
                const id = nodeElement.dataset.nodeId;
                doOperations.push({
                    action: "doUpdateUpdated",
                    id,
                    data: dayjs().format("YYYYMMDDHHmmss"),
                });
                undoOperations.push({
                    action: "doUpdateUpdated",
                    id,
                    data: nodeElement.getAttribute("updated"),
                });
                transaction(protyle, doOperations, undoOperations);
            }
        }
        return;
    }
    // 避免插入代码块中，其次因为都要独立成块 https://github.com/siyuan-note/siyuan/issues/7607
    insertHTML(successFileText, protyle, insertBlock);
    // 粘贴图片后定位不准确 https://github.com/siyuan-note/siyuan/issues/13336
    setTimeout(() => {
        if (isUploadCurrent(protyle)) {
            scrollCenter(protyle, undefined, "nearest", "smooth");
        }
    }, hasImage ? 0 : Constants.TIMEOUT_LOAD);
};

/** 校验并上传文件，统一绑定当前编辑器的身份、取消信号和事务插入边界。 */
export const uploadFiles = (protyle: IProtyle, files: FileList | DataTransferItemList | File[], element?: HTMLInputElement, successCB?: (res: string) => void) => {
    if (!canWriteProtyleContent(protyle.readonlyState)) {
        return;
    }
    // 将 FileList、DataTransferItemList 和 File[] 统一转换为普通文件数组。
    let fileList = [];
    let hasLocalPath = false;
    for (let i = 0; i < files.length; i++) {
        let fileItem = files[i];
        if (fileItem instanceof DataTransferItem) {
            fileItem = fileItem.getAsFile();
        }
        if (0 === fileItem.size && "" === fileItem.type && -1 === fileItem.name.indexOf(".")) {
            hasLocalPath = true;
        } else {
            fileList.push(fileItem);
        }
    }
    if (hasLocalPath) {
        protyle.host.dispatch({
            type: "notify",
            level: "error",
            message: protyle.localization.text("uploadError"),
        });
    }

    if (protyle.options.upload.file) {
        fileList = protyle.options.upload.file(fileList);
    }

    if (protyle.options.upload.validate) {
        const isValidate = protyle.options.upload.validate(fileList);
        if (typeof isValidate === "string") {
            notifyUpload(protyle, "error", isValidate);
            return;
        }
    }
    const editorElement = protyle.wysiwyg.element;

    const validated = validateFile(protyle, fileList);
    if (validated.files.length === 0) {
        if (element) {
            element.value = "";
        }
        return;
    }

    const formData = new FormData();

    const extraData = protyle.options.upload.extraData;
    for (const key of Object.keys(extraData)) {
        formData.append(key, extraData[key]);
    }
    const warnings: string[] = [];
    for (let i = 0, iMax = validated.files.length; i < iMax; i++) {
        formData.append(protyle.options.upload.fieldName, validated.files[i]);
        if (Constants.SIZE_UPLOAD_TIP_SIZE <= validated.files[i].size) {
            warnings.push(protyle.localization.text("uploadFileTooLarge")
                .replace("${x}", validated.files[i].name)
                .replace("${y}", filesize(validated.files[i].size, {standard: "iec"})));
        }
    }
    formData.set("id", protyle.options.blockId!);
    formData.set("notebook", protyle.notebookId);
    const upload = () => {
        if (!isUploadCurrent(protyle)) {
            return;
        }
        notifyUpload(protyle, "info", validated.statusMessages.join("\n"));
        protyle.upload.isUploading = true;
        void protyle.runtime.transport.upload<UploadResponse>(formData, {
            identity: protyleContentIdentity(protyle),
            signal: protyle.requestSignal,
            onProgress: ({loadedBytes, totalBytes}) => {
                if (!isUploadCurrent(protyle) || totalBytes === undefined) {
                    return;
                }
                const progress = loadedBytes / totalBytes * 100;
                protyle.upload.element.style.display = "block";
                protyle.upload.element.style.width = progress + "%";
            },
        }).then((response) => {
            if (!isUploadCurrent(protyle)) {
                return;
            }
            const responseText = JSON.stringify(response);
            if (protyle.options.upload.success) {
                protyle.options.upload.success(editorElement, responseText);
            } else if (successCB) {
                successCB(responseText);
            } else {
                if (protyle.options.upload.format) {
                    return genUploadedLabel(
                        JSON.parse(protyle.options.upload.format(files as File[], responseText)),
                        protyle,
                    );
                } else {
                    return genUploadedLabel(response, protyle);
                }
            }
        }, (error) => {
            if (!isAbort(error) && isUploadCurrent(protyle)) {
                const message = getErrorMessage(error);
                console.error("[protyle.transport] asset upload failed", error);
                if (protyle.options.upload.error) {
                    protyle.options.upload.error(message);
                } else {
                    notifyUpload(protyle, "error", protyle.localization.kernelText(28));
                }
            }
        }).finally(() => {
            protyle.upload.isUploading = false;
            if (isUploadCurrent(protyle)) {
                if (element) {
                    element.value = "";
                }
                protyle.upload.element.style.display = "none";
            }
        }).catch((error) => {
            if (isUploadCurrent(protyle)) {
                console.error("[protyle.upload] uploaded asset handling failed", error);
                notifyUpload(protyle, "error", protyle.localization.text("uploadError"));
            }
        });
    };
    if (warnings.length > 0) {
        openProtyleConfirm({
            message: warnings.join("\n"),
            onConfirm: upload,
            protyle,
            title: protyle.localization.text("upload"),
        });
    } else {
        upload();
    }
};
