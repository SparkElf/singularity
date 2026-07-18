import {Constants} from "../constants";
import {setStorageVal} from "../protyle/util/compatibility";
import {setInlineStyle} from "../util/assets";
import {fetchSyncPost} from "../util/fetch";

const positionKey = (identity: {notebookId: string, documentId: string}) =>
    `${identity.notebookId}:${identity.documentId}`;

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
    get emojis() {
        return window.siyuan.emojis;
    },
    get export() {
        return {
            addTitle: window.siyuan.config.export.addTitle,
            paragraphBeginningSpace: window.siyuan.config.export.paragraphBeginningSpace,
        };
    },
    get hotkeys() {
        return {
            insertRight: window.siyuan.config.keymap.editor.general.insertRight.custom,
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
