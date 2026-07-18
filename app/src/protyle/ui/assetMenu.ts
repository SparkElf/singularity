import {Constants} from "../../constants";
import {contentPathExtension} from "../hint/path";
import {combineAbortSignals} from "../util/abortSignal";
import {isNarrowViewport} from "../util/browserPlatform";
import {protyleContentIdentity} from "../util/contentLoad";
import {hasClosestByAttribute, hasClosestByClassName} from "../util/hasClosest";
import {upDownHint} from "../util/upDownHint";

interface AssetSearchResponse {
    data: Array<{
        hName: string;
        path: string;
    }>;
}

export interface OpenAssetMenuOptions {
    readonly extensions?: readonly string[];
    readonly onCancel?: () => void;
    readonly onSelect: (path: string, name: string) => void;
    readonly position: IPosition;
    readonly protyle: IProtyle;
}

type AssetMenuHandle = ReturnType<TProtyleRuntime["menu"]["open"]>;

interface AssetMenuState {
    readonly controller: AbortController;
    readonly handle: AssetMenuHandle;
    readonly identity: ReturnType<typeof protyleContentIdentity>;
    requestController?: AbortController;
    requestGeneration: number;
}

const activeAssetMenus = new WeakMap<IProtyle, AssetMenuState>();

const isCurrent = (protyle: IProtyle, state: AssetMenuState) =>
    activeAssetMenus.get(protyle) === state && !state.controller.signal.aborted;

const showMenu = (state: AssetMenuState, position: IPosition) => {
    if (isNarrowViewport()) {
        state.handle.menu.fullscreen();
    } else {
        state.handle.menu.popup(position);
    }
};

const renderListMessage = (element: HTMLElement, message: string) => {
    const item = document.createElement("div");
    item.className = "b3-list--empty";
    item.textContent = message;
    element.replaceChildren(item);
};

const renderPreview = (
    protyle: IProtyle,
    state: AssetMenuState,
    element: HTMLElement,
    path: string,
) => {
    const type = contentPathExtension(path);
    const source = protyle.session!.runtime.resources.resolveAsset(state.identity, path);
    let preview: HTMLElement;
    if (Constants.SIYUAN_ASSETS_IMAGE.includes(type)) {
        const image = document.createElement("img");
        image.style.maxHeight = "100%";
        image.src = source;
        preview = image;
    } else if (Constants.SIYUAN_ASSETS_AUDIO.includes(type)) {
        const audio = document.createElement("audio");
        audio.controls = true;
        audio.style.maxWidth = "100%";
        audio.src = source;
        preview = audio;
    } else if (Constants.SIYUAN_ASSETS_VIDEO.includes(type)) {
        const video = document.createElement("video");
        video.controls = true;
        video.style.maxWidth = "100%";
        video.src = source;
        preview = video;
    } else {
        preview = document.createElement("span");
        preview.textContent = path;
    }
    element.replaceChildren(preview);
};

export const openAssetMenu = (options: OpenAssetMenuOptions) => {
    const {protyle} = options;
    activeAssetMenus.get(protyle)?.handle.close();

    const runtime = protyle.session!.runtime as TProtyleRuntime;
    const handle = runtime.menu.open();
    const state: AssetMenuState = {
        controller: new AbortController(),
        handle,
        identity: protyleContentIdentity(protyle),
        requestGeneration: 0,
    };
    activeAssetMenus.set(protyle, state);

    const closeOnOwnerAbort = () => handle.close();
    protyle.requestSignal.addEventListener("abort", closeOnOwnerAbort, {once: true});
    handle.menu.removeCB = () => {
        protyle.requestSignal.removeEventListener("abort", closeOnOwnerAbort);
        state.controller.abort();
        if (activeAssetMenus.get(protyle) === state) {
            activeAssetMenus.delete(protyle);
        }
    };

    const cancel = () => {
        if (!isCurrent(protyle, state)) {
            return;
        }
        handle.close();
        options.onCancel?.();
    };
    document.addEventListener("pointerdown", (event) => {
        const target = event.target;
        if (target instanceof Node && !handle.menu.element.contains(target)) {
            handle.close();
        }
    }, {capture: true, signal: state.controller.signal});
    document.addEventListener("keydown", (event) => {
        if (event.key === "Escape") {
            cancel();
        }
    }, {capture: true, signal: state.controller.signal});

    handle.menu.addItem({
        iconHTML: "",
        type: "empty",
        label: `<div class="fn__flex" style="max-height:${isNarrowViewport() ? "80" : "50"}vh">
<div class="fn__flex-column" style="${isNarrowViewport() ? "width:100%" : "min-width:260px;max-width:420px"}">
    <div class="fn__flex" style="margin:0 8px 4px 8px">
        <input class="b3-text-field fn__flex-1">
        <span class="fn__space"></span>
        <span data-type="previous" class="block__icon block__icon--show"><svg><use xlink:href="#iconLeft"></use></svg></span>
        <span class="fn__space"></span>
        <span data-type="next" class="block__icon block__icon--show"><svg><use xlink:href="#iconRight"></use></svg></span>
    </div>
    <div class="b3-list fn__flex-1 b3-list--background" style="position:relative"><img style="margin:0 auto;display:block;width:64px;height:64px" src="/stage/loading-pure.svg"></div>
</div>
<div data-type="preview" style="width:360px;display:${isNarrowViewport() ? "none" : "flex"};padding:8px;overflow:auto;justify-content:center;align-items:center;word-break:break-all"></div>
</div>`,
        bind: (element) => {
            element.style.maxWidth = "none";
            const listElement = element.querySelector<HTMLElement>(".b3-list")!;
            const previewElement = element.querySelector<HTMLElement>('[data-type="preview"]')!;
            const inputElement = element.querySelector<HTMLInputElement>("input")!;
            const assets = new WeakMap<HTMLElement, AssetSearchResponse["data"][number]>();
            inputElement.setAttribute("aria-label", protyle.localization.text("search"));

            const selectAsset = (item: HTMLElement) => {
                if (!isCurrent(protyle, state)) {
                    return;
                }
                const asset = assets.get(item)!;
                handle.close();
                options.onSelect(asset.path, asset.hName);
            };
            const render = (keyword: string) => {
                state.requestController?.abort();
                const requestController = new AbortController();
                const generation = ++state.requestGeneration;
                state.requestController = requestController;
                const signal = combineAbortSignals([
                    protyle.requestSignal,
                    state.controller.signal,
                    requestController.signal,
                ]);
                const requestIsCurrent = () => isCurrent(protyle, state) && !signal.aborted &&
                    state.requestController === requestController && state.requestGeneration === generation;
                listElement.innerHTML = '<div class="fn__loading"><img width="64px" src="/stage/loading-pure.svg"></div>';
                void runtime.transport.request<AssetSearchResponse>("/api/search/searchAsset", {
                    exts: options.extensions ?? [],
                    k: keyword,
                }, {
                    identity: state.identity,
                    intent: "read",
                    signal,
                }).then((response) => {
                    if (!requestIsCurrent()) {
                        return;
                    }
                    if (response.data.length === 0) {
                        renderListMessage(listElement, protyle.localization.text("emptyContent"));
                        previewElement.textContent = protyle.localization.text("emptyContent");
                    } else {
                        const items = response.data.map((asset, index) => {
                            const item = document.createElement("div");
                            item.className = `b3-list-item${index === 0 ? " b3-list-item--focus" : ""}`;
                            const name = document.createElement("span");
                            name.className = "b3-list-item__text";
                            name.textContent = asset.hName;
                            item.append(name);
                            assets.set(item, asset);
                            return item;
                        });
                        listElement.replaceChildren(...items);
                        renderPreview(protyle, state, previewElement, response.data[0].path);
                    }
                    showMenu(state, options.position);
                    if (!keyword) {
                        inputElement.select();
                    }
                }).catch((error) => {
                    if (!requestIsCurrent()) {
                        return;
                    }
                    renderListMessage(listElement, protyle.localization.kernelText(258));
                    previewElement.textContent = protyle.localization.kernelText(258);
                    console.error("[protyle.asset-menu] search failed", {
                        documentId: state.identity.documentId,
                        error,
                        notebookId: state.identity.notebookId,
                        spaceId: protyle.session!.spaceId,
                    });
                });
            };

            listElement.addEventListener("mouseover", (event) => {
                const item = hasClosestByClassName(event.target as HTMLElement, "b3-list-item");
                if (item) {
                    renderPreview(protyle, state, previewElement, assets.get(item)!.path);
                }
            }, {signal: state.controller.signal});
            inputElement.addEventListener("keydown", (event) => {
                if (event.isComposing || !isCurrent(protyle, state)) {
                    return;
                }
                const current = upDownHint(listElement, event);
                if (current) {
                    renderPreview(protyle, state, previewElement, assets.get(current)!.path);
                    event.stopPropagation();
                }
                if (event.key === "Enter") {
                    const selected = listElement.querySelector<HTMLElement>(".b3-list-item--focus");
                    if (selected) {
                        selectAsset(selected);
                    } else {
                        cancel();
                    }
                    event.preventDefault();
                    event.stopPropagation();
                } else if (event.key === "Escape") {
                    cancel();
                }
            }, {signal: state.controller.signal});
            const search = (event: InputEvent) => {
                if (!event.isComposing) {
                    event.stopPropagation();
                    render(inputElement.value);
                }
            };
            inputElement.addEventListener("input", search, {signal: state.controller.signal});
            inputElement.addEventListener("compositionend", search, {signal: state.controller.signal});
            element.addEventListener("click", (event) => {
                const target = event.target as HTMLElement;
                if (hasClosestByAttribute(target, "data-type", "previous")) {
                    inputElement.dispatchEvent(new KeyboardEvent("keydown", {key: "ArrowUp"}));
                    event.stopPropagation();
                    return;
                }
                if (hasClosestByAttribute(target, "data-type", "next")) {
                    inputElement.dispatchEvent(new KeyboardEvent("keydown", {key: "ArrowDown"}));
                    event.stopPropagation();
                    return;
                }
                const item = hasClosestByClassName(target, "b3-list-item");
                if (item) {
                    selectAsset(item);
                    event.stopPropagation();
                }
            }, {signal: state.controller.signal});
            render("");
        },
    });
    showMenu(state, options.position);
};
