import type {App} from "../../index";
import {Model} from "../../layout/Model";
import {Constants} from "../../constants";
import {fetchSyncPost} from "../../util/fetch";
import {processMessage} from "../../util/processMessage";
import {createAppProtyleHost} from "../../host/protyle";
import {createAppProtylePluginPort} from "../../host/plugin";
import {ProtyleDOMMenu} from "../ui/Menu";
import {isNarrowViewport} from "../util/browserPlatform";
import {updateHotkeyTip} from "../util/keyboard";
import {
    createProtyleMenuPort,
    createProtyleOverlayPort,
} from "../../../../enterprise/packages/protyle-browser/src";
import type {
    ProtyleRequestOptions,
    ProtyleUploadOptions,
} from "../../../../enterprise/packages/protyle-browser/src/contracts";
import {createUpstreamLocalProtyleTransport} from "./upstreamLocalTransport";

/** 为上游本地编辑器执行带 AbortSignal 的二进制请求，并拒绝非成功 HTTP 响应。 */
const requestBlob = async <TResponse>(
    path: string,
    body: unknown,
    options: ProtyleRequestOptions,
): Promise<TResponse> => {
    const headers = new Headers();
    if (options.range) {
        headers.set("Range", `bytes=${options.range.start}-${options.range.end ?? ""}`);
    }
    const response = await fetch(path, {
        body: body === undefined ? undefined : JSON.stringify(body),
        headers,
        method: "POST",
        signal: options.signal,
    });
    if (!response.ok) {
        throw new Error(`[protyle.upstream-local] request failed with HTTP ${response.status}`);
    }
    return await response.blob() as TResponse;
};

/** 执行上游本地上传并把进度、取消和响应解析绑定到同一 XMLHttpRequest。 */
const upload = <TResponse>(body: FormData, options: ProtyleUploadOptions) =>
    new Promise<TResponse>((resolve, reject) => {
        const request = new XMLHttpRequest();
        let settled = false;

        const finish = (callback: () => void) => {
            if (settled) {
                return;
            }
            settled = true;
            options.signal?.removeEventListener("abort", abort);
            request.onload = null;
            request.onerror = null;
            request.onabort = null;
            request.upload.onprogress = null;
            callback();
        };
        const rejectAbort = () => finish(() => reject(
            options.signal?.reason ?? new DOMException("Upload was aborted", "AbortError"),
        ));
        const abort = () => {
            request.abort();
            rejectAbort();
        };

        request.open("POST", Constants.UPLOAD_ADDRESS);
        request.upload.onprogress = (event) => options.onProgress?.({
            loadedBytes: event.loaded,
            ...(event.lengthComputable ? {totalBytes: event.total} : {}),
        });
        request.onerror = () => finish(() => reject(new Error("[protyle.upstream-local] upload failed")));
        request.onabort = rejectAbort;
        request.onload = () => {
            const responseText = request.responseText;
            finish(() => {
                void Promise.resolve(responseText)
                    .then((value) => JSON.parse(value) as TResponse)
                    .then((response) => {
                        processMessage(response as IWebSocketData);
                        resolve(response);
                    })
                    .then(undefined, reject);
            });
        };
        if (options.signal?.aborted) {
            rejectAbort();
            return;
        }
        options.signal?.addEventListener("abort", abort, {once: true});
        request.send(body);
    });

/** 组装思源 desktop/mobile 专用本地 Runtime；企业 bound 分支不使用此入口。 */
export const createUpstreamLocalProtyleRuntime = (
    app: App,
    options: {
        readonly editors: TProtyleEditorRegistry;
        readonly localAppId: string;
        readonly localization: TProtyleLocalizationPort;
    },
): TProtyleUpstreamLocalRuntime => {
    const transport = createUpstreamLocalProtyleTransport<IWebSocketData>({
        connect: (subscription) => {
            const model = new Model({app});
            model.connect({
                id: subscription.sourceEditorId,
                type: "protyle",
                msgCallback: subscription.onMessage,
            });
            return {disconnect: () => model.disconnect()};
        },
        request: <TResponse>(path: string, body: unknown, requestOptions: ProtyleRequestOptions) =>
            requestOptions.responseType === "blob"
                ? requestBlob<TResponse>(path, body, requestOptions)
                : fetchSyncPost(path, body, undefined, {signal: requestOptions.signal}) as Promise<TResponse>,
        upload,
    });
    const host = createAppProtyleHost(app);
    const plugins = createAppProtylePluginPort(app);

    return {
        editors: options.editors,
        host,
        localAppId: options.localAppId,
        menu: createProtyleMenuPort(
            (close) => new ProtyleDOMMenu({
                formatHotkey: updateHotkeyTip,
                isNarrowViewport,
                localization: options.localization,
                portalRoot: document.body,
                requestClose: close,
            }),
            (menu) => menu.dispose(),
        ),
        overlays: createProtyleOverlayPort((overlay: HTMLElement) => overlay.remove()),
        plugins,
        resources: {
            resolveAsset: (_identity, path) => path,
            resolveEmoji: (_identity, path) => `/emojis/${path}`,
            resolveExport: (_identity, path) => path,
        },
        transport,
    };
};
