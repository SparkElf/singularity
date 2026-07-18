import {downloadExportFile} from "../util/download";
import {protyleContentIdentity} from "../util/contentLoad";
import {updateTransaction} from "../wysiwyg/transaction";
import {escapeAttr, escapeHtml} from "../../util/escape";

const cleanSource = (value: string) => value.replace(/\n|\r|\u2028|\u2029/g, "").trim();

const bilibiliSource = (value: string) => {
    const match = value.match(/(?:www\.|\/)bilibili\.com\/video\/(\w+)/);
    if (!value.includes("bilibili.com") || (!value.includes("bvid=") && !match?.[1])) {
        return undefined;
    }
    const source = new URL(value.startsWith("http") ? value : `https:${value}`);
    const params = new URLSearchParams({
        bvid: source.searchParams.get("bvid") || match?.[1] || "",
        page: source.searchParams.get("p") || source.searchParams.get("page") || "1",
        high_quality: "1",
        as_wide: "1",
        allowfullscreen: "true",
        autoplay: "0",
    });
    return `https://player.bilibili.com/player.html?${params.toString()}`;
};

export const createIframeMenu = (protyle: IProtyle, nodeElement: Element): IMenu[] => {
    const iframe = nodeElement.querySelector("iframe")!;
    let previousHTML = nodeElement.outerHTML;
    const menu: IMenu[] = [{
        id: "asset",
        iconHTML: "",
        type: "readonly",
        label: `<textarea spellcheck="false" rows="1" class="b3-text-field fn__block" placeholder="${escapeAttr(protyle.localization.text("link"))}" style="margin: 4px 0">${escapeHtml(iframe.getAttribute("src") || "")}</textarea>`,
        bind(element) {
            element.style.maxWidth = "none";
            element.querySelector("textarea")!.addEventListener("change", (event) => {
                const source = cleanSource((event.target as HTMLTextAreaElement).value);
                iframe.setAttribute("src", bilibiliSource(source) || source);
                if (source.includes("bilibili.com")) {
                    iframe.setAttribute("sandbox", "allow-top-navigation-by-user-activation allow-same-origin allow-forms allow-scripts allow-popups allow-storage-access-by-user-activation");
                    iframe.style.height ||= "360px";
                    iframe.style.width ||= "640px";
                }
                updateTransaction(protyle, nodeElement, previousHTML);
                previousHTML = nodeElement.outerHTML;
                event.stopPropagation();
            });
        },
    }];
    const source = iframe.getAttribute("src");
    if (source) {
        menu.push({type: "separator"}, {
            id: "openBy",
            icon: "iconOpen",
            label: protyle.localization.text("openBy"),
            click: () => protyle.host.dispatch({type: "open-external", url: source}),
        });
    }
    return menu;
};

export const createMediaMenu = (
    protyle: IProtyle,
    nodeElement: Element,
    type: "NodeAudio" | "NodeVideo",
): IMenu[] => {
    const media = nodeElement.querySelector(type === "NodeVideo" ? "video" : "audio")!;
    let previousHTML = nodeElement.outerHTML;
    const menu: IMenu[] = [{
        id: "asset",
        iconHTML: "",
        type: "readonly",
        label: `<textarea spellcheck="false" rows="1" class="b3-text-field fn__block" placeholder="${escapeAttr(protyle.localization.text("link"))}" style="margin: 4px 0">${escapeHtml(media.getAttribute("src") || "")}</textarea>`,
        bind(element) {
            element.style.maxWidth = "none";
            element.querySelector("textarea")!.addEventListener("change", (event) => {
                media.setAttribute("src", cleanSource((event.target as HTMLTextAreaElement).value));
                updateTransaction(protyle, nodeElement, previousHTML);
                previousHTML = nodeElement.outerHTML;
                event.stopPropagation();
            });
        },
    }];
    const source = media.getAttribute("src");
    if (!source) {
        return menu;
    }
    const identity = protyleContentIdentity(protyle);
    menu.push({type: "separator"}, {
        id: "openBy",
        icon: "iconOpen",
        label: protyle.localization.text("openBy"),
        click: () => source.startsWith("assets/")
            ? protyle.host.dispatch({
                type: "open-asset",
                documentId: identity.documentId,
                notebookId: identity.notebookId,
                assetPath: source,
                disposition: "current",
            })
            : protyle.host.dispatch({type: "open-external", url: source}),
    });
    if (source.startsWith("assets/")) {
        if (protyle.settings.features.assetRename) {
            menu.push({
                id: "rename",
                icon: "iconEdit",
                label: protyle.localization.text("rename"),
                click: () => protyle.host.dispatch({
                    type: "rename-asset",
                    notebookId: identity.notebookId,
                    documentId: identity.documentId,
                    blockId: nodeElement.getAttribute("data-node-id")!,
                    assetPath: source,
                }),
            });
        }
        menu.push({
            id: "export",
            icon: "iconUpload",
            label: protyle.localization.text("export"),
            click: () => downloadExportFile(protyle.session!.runtime.resources.resolveAsset(identity, source)),
        });
    }
    return menu;
};
