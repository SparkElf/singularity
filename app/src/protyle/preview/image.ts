import {Constants} from "../../constants";
import {addScript} from "../util/addScript";

/** 创建可取消的图片预览实例，并在关闭或取消时释放 Viewer 资源。 */
export const previewImages = (srcList: string[], currentSrc?: string, onHidden?: () => void, signal?: AbortSignal) => {
    addScript(`${Constants.PROTYLE_CDN}/js/viewerjs/viewer.js?v=1.11.7`, "protyleViewerScript").then(() => {
        if (signal?.aborted) {
            return;
        }
        const imagesElement = document.createElement("ul");
        let html = "";
        let initialViewIndex = -1;
        srcList.forEach((item: string, index: number) => {
            if (item) {
                html += `<li><img src="${encodeURI(item)}"></li>`;
                if (currentSrc && initialViewIndex === -1 && (currentSrc.endsWith(encodeURI(item)) || currentSrc.endsWith(item))) {
                    initialViewIndex = index;
                }
            }
        });
        imagesElement.innerHTML = html;
        let viewer: Viewer;
        const destroyViewer = () => {
            signal?.removeEventListener("abort", destroyViewer);
            if (!viewer.destroyed) {
                viewer.destroy();
            }
        };
        viewer = new Viewer(imagesElement, {
            initialViewIndex: currentSrc ? initialViewIndex : 0,
            title: [1, (image: HTMLImageElement, imageData: IObject) => {
                let name = image.alt;
                if (!name) {
                    name = image.src.substring(image.src.lastIndexOf("/") + 1);
                }
                name = name.substring(0, name.lastIndexOf(".")).replace(/-\d{14}-\w{7}$/, "");
                return `${name} [${imageData.naturalWidth} × ${imageData.naturalHeight}]`;
            }],
            button: false,
            transition: false,
            hidden: function () {
                destroyViewer();
                if (onHidden) {
                    onHidden();
                }
            },
            toolbar: {
                zoomIn: true,
                zoomOut: true,
                oneToOne: true,
                reset: true,
                prev: true,
                play: true,
                next: true,
                rotateLeft: true,
                rotateRight: true,
                flipHorizontal: true,
                flipVertical: true,
                close: destroyViewer,
            },
        });
        signal?.addEventListener("abort", destroyViewer, {once: true});
        viewer.show();
    });
};

/** 按当前文档身份获取文档图片资源并打开预览。 */
export const previewDocImage = (currentSrc: string, protyle: IProtyle) => {
    void protyle.runtime.transport.request<IWebSocketData>("/api/asset/getDocImageAssets", {
        id: protyle.block.rootID,
        notebook: protyle.notebookId,
    }, {
        identity: {
            documentId: protyle.options.blockId!,
            notebookId: protyle.notebookId,
        },
        intent: "read",
        signal: protyle.requestSignal,
    }).then((response) => {
        if (protyle.destroyed || protyle.requestSignal.aborted) {
            return;
        }
        previewImages(response.data, currentSrc, undefined, protyle.requestSignal);
    }).catch((error) => {
        if (!protyle.requestSignal.aborted) {
            console.error("[protyle.transport] document image preview failed", error);
        }
    });
};

/** 按当前文档身份获取属性视图图片资源并打开预览。 */
export const previewAttrViewImages = (protyle: IProtyle, currentSrc: string, avID: string, viewID: string, query: string) => {
    void protyle.runtime.transport.request<IWebSocketData>("/api/av/getCurrentAttrViewImages", {
        id: avID,
        viewID,
        query,
    }, {
        identity: {
            documentId: protyle.options.blockId!,
            notebookId: protyle.notebookId,
        },
        intent: "read",
        signal: protyle.requestSignal,
    }).then((response) => {
        if (protyle.destroyed || protyle.requestSignal.aborted) {
            return;
        }
        previewImages(response.data, currentSrc, undefined, protyle.requestSignal);
    }).catch((error) => {
        if (!protyle.requestSignal.aborted) {
            console.error("[protyle.transport] attribute view image preview failed", error);
        }
    });
};
