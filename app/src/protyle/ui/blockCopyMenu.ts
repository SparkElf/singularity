import {copyBlockText, type BlockTextFormat} from "../util/copyBlockText";
import {writeText} from "../util/clipboard";
import {protyleContentIdentity} from "../util/contentLoad";
import {focusBlock} from "../util/selection";

interface CreateBlockCopyMenuOptions {
    readonly blockIds: readonly string[];
    readonly focusElement?: Element;
    readonly protyle: IProtyle;
    readonly standardMarkdownDocumentId?: string;
}

const reportCopyFailure = (error: unknown) => {
    console.error("[protyle.transport] block copy failed", error);
};

export const createBlockCopyMenu = ({
    blockIds,
    focusElement,
    protyle,
    standardMarkdownDocumentId,
}: CreateBlockCopyMenuOptions): IMenu[] => {
    const copy = (format: BlockTextFormat) => async () => {
        try {
            await copyBlockText(protyle, blockIds, format);
        } catch (error) {
            reportCopyFailure(error);
            throw error;
        } finally {
            if (focusElement) {
                focusBlock(focusElement);
            }
        }
    };
    const hotkeys = protyle.settings.hotkeys.editor.general;
    const menu: IMenu[] = [{
        id: "copyBlockRef",
        iconHTML: "",
        accelerator: hotkeys.copyBlockRef,
        label: protyle.localization.text("copyBlockRef"),
        click: copy("ref"),
    }, {
        id: "copyBlockEmbed",
        iconHTML: "",
        accelerator: hotkeys.copyBlockEmbed,
        label: protyle.localization.text("copyBlockEmbed"),
        click: copy("blockEmbed"),
    }, {
        id: "copyProtocol",
        iconHTML: "",
        accelerator: hotkeys.copyProtocol,
        label: protyle.localization.text("copyProtocol"),
        click: copy("protocol"),
    }, {
        id: "copyProtocolInMd",
        iconHTML: "",
        accelerator: hotkeys.copyProtocolInMd,
        label: protyle.localization.text("copyProtocolInMd"),
        click: copy("protocolMd"),
    }];
    if (protyle.settings.features.webBlockLink) {
        menu.push({
            id: "copyWebURL",
            iconHTML: "",
            label: protyle.localization.text("copyWebURL"),
            click: copy("webURL"),
        });
    }
    menu.push({
        id: "copyHPath",
        iconHTML: "",
        accelerator: hotkeys.copyHPath,
        label: protyle.localization.text("copyHPath"),
        click: copy("hPath"),
    }, {
        id: "copyID",
        iconHTML: "",
        accelerator: hotkeys.copyID,
        label: protyle.localization.text("copyID"),
        click: copy("id"),
    });

    if (standardMarkdownDocumentId) {
        menu.push({
            id: "copyMarkdown",
            iconHTML: "",
            label: protyle.localization.text("copyMarkdown"),
            click: async () => {
                const identity = protyleContentIdentity(protyle);
                const response = await protyle.runtime.transport.request<{
                    readonly data: {readonly content: string};
                }>("/api/export/exportMdContent", {
                    id: standardMarkdownDocumentId,
                    notebook: identity.notebookId,
                    refMode: 3,
                    embedMode: 1,
                    yfm: false,
                    fillCSSVar: false,
                    adjustHeadingLevel: false,
                }, {
                    identity,
                    intent: "read",
                    signal: protyle.requestSignal,
                });
                await writeText(response.data.content);
                if (focusElement) {
                    focusBlock(focusElement);
                }
            },
        });
    }
    return menu;
};
