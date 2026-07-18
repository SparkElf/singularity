import {Constants} from "../constants";
import {setStorageVal} from "../protyle/util/compatibility";
import {setInlineStyle} from "../util/assets";
import {fetchSyncPost} from "../util/fetch";
import {addRecentEmoji, getRecentEmojis} from "./recent-emojis";
import coverEntries from "../../appearance/covers/manifest.json";

const positionKey = (identity: {notebookId: string, documentId: string}) =>
    `${identity.notebookId}:${identity.documentId}`;

const includesConfiguredHotkey = (hotkey: string) => {
    let included = false;
    Object.keys(window.siyuan.config.keymap).some(key => {
        const group = window.siyuan.config.keymap[key as "editor"];
        return Object.keys(group).some(entryName => {
            const entry = group[entryName as "general"];
            if (typeof entry.custom === "string") {
                included = entry.custom === hotkey;
            } else {
                included = Object.keys(entry).some(keyName =>
                    (entry[keyName] as Config.IKey).custom === hotkey
                );
            }
            return included;
        });
    });
    return included;
};

/**
 * Legacy desktop composition owns these values while it is still present.
 * The extracted enterprise Core receives the same shape from its own
 * composition root; no Core module reads this legacy source directly.
 */
export const createAppProtyleApplicationSettings = (): TProtyleApplicationSettingsPort => ({
    get appearance() {
        const appearance = window.siyuan.config.appearance;
        return {
            codeBlockThemeDark: appearance.codeBlockThemeDark,
            codeBlockThemeLight: appearance.codeBlockThemeLight,
            theme: appearance.mode === 1 ? "dark" : "light",
        };
    },
    get editor() {
        const editor = window.siyuan.config.editor;
        return {
            blockRefDynamicAnchorTextMaxLen: editor.blockRefDynamicAnchorTextMaxLen,
            codeLigatures: editor.codeLigatures,
            codeLineWrap: editor.codeLineWrap,
            codeSyntaxHighlightLineNum: editor.codeSyntaxHighlightLineNum,
            codeTabSpaces: editor.codeTabSpaces,
            displayBookmarkIcon: editor.displayBookmarkIcon,
            displayNetImgMark: editor.displayNetImgMark,
            dynamicLoadBlocks: editor.dynamicLoadBlocks,
            embedBlockBreadcrumb: editor.embedBlockBreadcrumb,
            fontSize: editor.fontSize,
            fontSizeScrollZoom: editor.fontSizeScrollZoom,
            fullWidth: editor.fullWidth,
            headingEmbedMode: editor.headingEmbedMode,
            katexMacros: editor.katexMacros,
            listLogicalOutdent: editor.listLogicalOutdent,
            plantUMLServePath: editor.plantUMLServePath,
            get readOnly() {
                return editor.readOnly;
            },
            markdown: {
                inlineAsterisk: editor.markdown.inlineAsterisk,
                inlineMark: editor.markdown.inlineMark,
                inlineMath: editor.markdown.inlineMath,
                inlineStrikethrough: editor.markdown.inlineStrikethrough,
                inlineSub: editor.markdown.inlineSub,
                inlineSup: editor.markdown.inlineSup,
                inlineTag: editor.markdown.inlineTag,
                inlineUnderscore: editor.markdown.inlineUnderscore,
            },
            rtl: editor.rtl,
            setReadOnly: (readOnly: boolean) => {
                editor.readOnly = readOnly;
            },
            setFontSize: (fontSize: number) => {
                editor.fontSize = fontSize;
            },
            persist: async () => {
                await setInlineStyle();
                const response = await fetchSyncPost("/api/setting/setEditor", editor);
                window.siyuan.config.editor = response.data;
            },
            spellcheck: editor.spellcheck,
        };
    },
    cover: {
        entries: coverEntries,
        resolve: (file) => `/appearance/covers/${encodeURIComponent(file)}`,
    },
    get emojis() {
        return window.siyuan.emojis;
    },
    get export() {
        return {
            addTitle: window.siyuan.config.export.addTitle,
            paragraphBeginningSpace: window.siyuan.config.export.paragraphBeginningSpace,
        };
    },
    get features() {
        const user = window.siyuan.user;
        return {
            aiActions: true,
            aiWriting: true,
            assetRename: true,
            blockAttributes: true,
            blockMove: true,
            blockRefTransfer: true,
            cloudAssetUpload: true,
            communityShare: Boolean(user),
            documentDelete: true,
            documentExport: true,
            documentMove: true,
            flashcardDeck: window.siyuan.config.flashcard.deck,
            fullscreen: true,
            quickFlashcard: true,
            tableMenu: true,
            webBlockLink: true,
            wechatReminder: window.siyuan.config.cloudRegion === 0,
            widget: true,
        };
    },
    get hotkeys() {
        const keymap = window.siyuan.config.keymap;
        return {
            includes: includesConfiguredHotkey,
            general: {
                addToDatabase: keymap.general.addToDatabase.custom,
                enter: keymap.general.enter.custom,
                enterBack: keymap.general.enterBack.custom,
                move: keymap.general.move.custom,
                search: keymap.general.search.custom,
            },
            editor: {
                general: {
                    ai: keymap.editor.general.ai.custom,
                    aiWriting: keymap.editor.general.aiWriting.custom,
                    alignCenter: keymap.editor.general.alignCenter.custom,
                    alignLeft: keymap.editor.general.alignLeft.custom,
                    alignRight: keymap.editor.general.alignRight.custom,
                    attr: keymap.editor.general.attr.custom,
                    backlinks: keymap.editor.general.backlinks.custom,
                    collapse: keymap.editor.general.collapse.custom,
                    copyBlockEmbed: keymap.editor.general.copyBlockEmbed.custom,
                    copyBlockRef: keymap.editor.general.copyBlockRef.custom,
                    copyHPath: keymap.editor.general.copyHPath.custom,
                    copyID: keymap.editor.general.copyID.custom,
                    copyPlainText: keymap.editor.general.copyPlainText.custom,
                    copyProtocol: keymap.editor.general.copyProtocol.custom,
                    copyProtocolInMd: keymap.editor.general.copyProtocolInMd.custom,
                    copyText: keymap.editor.general.copyText.custom,
                    duplicate: keymap.editor.general.duplicate.custom,
                    duplicateCompletely: keymap.editor.general.duplicateCompletely.custom,
                    expand: keymap.editor.general.expand.custom,
                    expandDown: keymap.editor.general.expandDown.custom,
                    expandUp: keymap.editor.general.expandUp.custom,
                    foldRecursive: keymap.editor.general.foldRecursive.custom,
                    fullscreen: keymap.editor.general.fullscreen.custom,
                    graphView: keymap.editor.general.graphView.custom,
                    hLayout: keymap.editor.general.hLayout.custom,
                    insertAfter: keymap.editor.general.insertAfter.custom,
                    insertBefore: keymap.editor.general.insertBefore.custom,
                    insertBottom: keymap.editor.general.insertBottom.custom,
                    insertRight: keymap.editor.general.insertRight.custom,
                    exitFocus: keymap.editor.general.exitFocus.custom,
                    jumpToParent: keymap.editor.general.jumpToParent.custom,
                    jumpToParentNext: keymap.editor.general.jumpToParentNext.custom,
                    jumpToParentPrev: keymap.editor.general.jumpToParentPrev.custom,
                    ltr: keymap.editor.general.ltr.custom,
                    moveToDown: keymap.editor.general.moveToDown.custom,
                    moveToUp: keymap.editor.general.moveToUp.custom,
                    netAssets2LocalAssets: keymap.editor.general.netAssets2LocalAssets.custom,
                    netImg2LocalAsset: keymap.editor.general.netImg2LocalAsset.custom,
                    newContentFile: keymap.editor.general.newContentFile.custom,
                    newNameFile: keymap.editor.general.newNameFile.custom,
                    newNameSettingFile: keymap.editor.general.newNameSettingFile.custom,
                    openBy: keymap.editor.general.openBy.custom,
                    openInNewTab: keymap.editor.general.openInNewTab.custom,
                    optimizeTypography: keymap.editor.general.optimizeTypography.custom,
                    outline: keymap.editor.general.outline.custom,
                    preview: keymap.editor.general.preview.custom,
                    quickMakeCard: keymap.editor.general.quickMakeCard.custom,
                    refresh: keymap.editor.general.refresh.custom,
                    refPopover: keymap.editor.general.refPopover.custom,
                    refTab: keymap.editor.general.refTab.custom,
                    redo: keymap.editor.general.redo.custom,
                    rename: keymap.editor.general.rename.custom,
                    rtl: keymap.editor.general.rtl.custom,
                    spaceRepetition: keymap.editor.general.spaceRepetition.custom,
                    undo: keymap.editor.general.undo.custom,
                    vLayout: keymap.editor.general.vLayout.custom,
                    wysiwyg: keymap.editor.general.wysiwyg.custom,
                },
                heading: {
                    heading1: keymap.editor.heading.heading1.custom,
                    heading2: keymap.editor.heading.heading2.custom,
                    heading3: keymap.editor.heading.heading3.custom,
                    heading4: keymap.editor.heading.heading4.custom,
                    heading5: keymap.editor.heading.heading5.custom,
                    heading6: keymap.editor.heading.heading6.custom,
                    paragraph: keymap.editor.heading.paragraph.custom,
                },
                insert: {
                    check: keymap.editor.insert.check.custom,
                    code: keymap.editor.insert.code.custom,
                    list: keymap.editor.insert.list.custom,
                    orderedList: keymap.editor.insert["ordered-list"].custom,
                    quote: keymap.editor.insert.quote.custom,
                    table: keymap.editor.insert.table.custom,
                },
                list: {
                    checkToggle: keymap.editor.list.checkToggle.custom,
                    indent: keymap.editor.list.indent.custom,
                    outdent: keymap.editor.list.outdent.custom,
                },
            },
        };
    },
    get icons() {
        return {
            file: window.siyuan.storage[Constants.LOCAL_IMAGES].file,
        };
    },
    localFilePosition: {
        get: (identity) => window.siyuan.storage[Constants.LOCAL_FILEPOSITION][positionKey(identity)],
        persist: () => setStorageVal(
            Constants.LOCAL_FILEPOSITION,
            window.siyuan.storage[Constants.LOCAL_FILEPOSITION],
        ),
        remove: (identity) => {
            delete window.siyuan.storage[Constants.LOCAL_FILEPOSITION][positionKey(identity)];
        },
        set: (identity, position) => {
            window.siyuan.storage[Constants.LOCAL_FILEPOSITION][positionKey(identity)] = position;
        },
    },
    get navigation() {
        return {
            openFilesUseCurrentTab: window.siyuan.config.fileTree.openFilesUseCurrentTab,
        };
    },
    recentEmojis: {
        add: addRecentEmoji,
        get values() {
            return getRecentEmojis();
        },
    },
    get toolbar() {
        const insert = window.siyuan.config.keymap.editor.insert;
        return {
            get codeLanguage() {
                return window.siyuan.storage[Constants.LOCAL_CODELANG] || "";
            },
            hotkeys: {
                appearance: insert.appearance.custom,
                bold: insert.bold.custom,
                clearInline: insert.clearInline.custom,
                "inline-code": insert["inline-code"].custom,
                "inline-math": insert["inline-math"].custom,
                italic: insert.italic.custom,
                kbd: insert.kbd.custom,
                lastUsed: insert.lastUsed.custom,
                link: insert.link.custom,
                mark: insert.mark.custom,
                memo: insert.memo.custom,
                ref: insert.ref.custom,
                strike: insert.strike.custom,
                sub: insert.sub.custom,
                sup: insert.sup.custom,
                tag: insert.tag.custom,
                underline: insert.underline.custom,
            },
            persist: () => {
                setStorageVal(Constants.LOCAL_CODELANG, window.siyuan.storage[Constants.LOCAL_CODELANG]);
                setStorageVal(Constants.LOCAL_FONTSTYLES, window.siyuan.storage[Constants.LOCAL_FONTSTYLES]);
            },
            get recentFontStyles() {
                return window.siyuan.storage[Constants.LOCAL_FONTSTYLES] || [];
            },
            setCodeLanguage: (language: string) => {
                window.siyuan.storage[Constants.LOCAL_CODELANG] = language;
            },
            setRecentFontStyles: (styles: string[]) => {
                window.siyuan.storage[Constants.LOCAL_FONTSTYLES] = styles;
            },
        };
    },
});
