import type {
  ProtyleApplicationPort,
  ProtyleApplicationSettings,
  ProtyleContentIdentity,
  ProtyleLocalizationPort,
  ProtyleScrollPosition,
  ProtyleToolbarHotkey,
} from "@singularity/protyle-browser";

import emojiGroups from "../../../../../app/appearance/emojis/conf.json";
import language from "../../../../../app/appearance/langs/zh-CN.json";

export type { ProtyleApplicationPort, ProtyleApplicationSettings } from "@singularity/protyle-browser";

const DEFAULT_EDITOR_FONT_SIZE = 16;
const MAXIMUM_RECENT_EMOJI_COUNT = 64;
const STORAGE_PREFIX = "singularity.protyle.application.v1";

const textDictionary = language as unknown as Readonly<Record<string, string>>;
const attributeViewDictionary = language._attrView as Readonly<Record<string, string>>;
const kernelDictionary = language._kernel as Readonly<Record<string, string>>;

export const protyleLocalization: ProtyleLocalizationPort = {
  attributeViewText: (key) => attributeViewDictionary[key]!,
  language: "zh_CN",
  kernelText: (index) => kernelDictionary[index]!,
  text: (key) => textDictionary[key]!,
};

interface PersistedApplicationState {
  fontSize: number;
  codeLanguage: string;
  positions: Record<string, ProtyleScrollPosition>;
  recentEmojis: string[];
  recentFontStyles: string[];
}

export interface ProtyleApplicationStorage {
  getItem: Storage["getItem"];
  setItem: Storage["setItem"];
}

export interface CreateProtyleApplicationPortOptions {
  readonly spaceId: string;
  readonly storage: ProtyleApplicationStorage;
}

function contentPositionKey(identity: ProtyleContentIdentity): string {
  return `${identity.notebookId}:${identity.documentId}`;
}

function readPersistedState(
  storage: ProtyleApplicationStorage,
  storageKey: string,
): PersistedApplicationState {
  const serialized = storage.getItem(storageKey);
  if (serialized === null) {
    return {
      codeLanguage: "",
      fontSize: DEFAULT_EDITOR_FONT_SIZE,
      positions: {},
      recentEmojis: [],
      recentFontStyles: [],
    };
  }
  const parsed = JSON.parse(serialized) as Partial<PersistedApplicationState>;
  return {
    codeLanguage: parsed.codeLanguage ?? "",
    fontSize: parsed.fontSize ?? DEFAULT_EDITOR_FONT_SIZE,
    positions: parsed.positions ?? {},
    recentEmojis: parsed.recentEmojis ?? [],
    recentFontStyles: parsed.recentFontStyles ?? [],
  };
}

const toolbarHotkeys: Readonly<Record<ProtyleToolbarHotkey, string>> = {
  appearance: "⌥⌘X",
  bold: "⌘B",
  clearInline: "⌘\\",
  "inline-code": "⌘G",
  "inline-math": "⌘M",
  italic: "⌘I",
  kbd: "⌘'",
  lastUsed: "⌥X",
  link: "⌘K",
  mark: "⌥D",
  memo: "⌥⌘M",
  ref: "⌥[",
  strike: "⇧⌘S",
  sub: "⌘J",
  sup: "⌘H",
  tag: "⌘T",
  underline: "⌘U",
};

/**
 * Owns browser-only display preferences and per-content scroll positions for
 * one authorized space. Content transport and identity remain on the Session.
 */
export function createProtyleApplicationPort(
  options: CreateProtyleApplicationPortOptions,
): ProtyleApplicationPort {
  const storageKey = `${STORAGE_PREFIX}:${options.spaceId}`;
  const state = readPersistedState(options.storage, storageKey);
  let readOnly = false;
  const persist = () => {
    options.storage.setItem(storageKey, JSON.stringify(state));
  };
  const editor = {
    blockRefDynamicAnchorTextMaxLen: 96,
    codeLigatures: false,
    codeLineWrap: false,
    codeSyntaxHighlightLineNum: false,
    codeTabSpaces: 0,
    displayBookmarkIcon: true,
    displayNetImgMark: true,
    dynamicLoadBlocks: 192,
    embedBlockBreadcrumb: false,
    get fontSize() {
      return state.fontSize;
    },
    fontSizeScrollZoom: true,
    fullWidth: true,
    headingEmbedMode: 0,
    listItemDotNumberClickFocus: true,
    katexMacros: "{}",
    listLogicalOutdent: false,
    pasteURLAutoConvert: true,
    markdown: {
      inlineAsterisk: true,
      inlineMark: true,
      inlineMath: true,
      inlineStrikethrough: true,
      inlineSub: true,
      inlineSup: true,
      inlineTag: true,
      inlineUnderscore: true,
    },
    persist,
    plantUMLServePath: "",
    get readOnly() {
      return readOnly;
    },
    rtl: false,
    setFontSize: (fontSize: number) => {
      state.fontSize = fontSize;
      document.documentElement.style.setProperty(
        "--b3-font-size-editor",
        `${fontSize}px`,
      );
    },
    setReadOnly: (value: boolean) => {
      readOnly = value;
    },
    spellcheck: false,
    suppressBlockLinkPopoverOnMenu: true,
  } satisfies ProtyleApplicationSettings["editor"];

  document.documentElement.style.setProperty(
    "--b3-font-size-editor",
    `${state.fontSize}px`,
  );

  const settings: ProtyleApplicationSettings = {
      appearance: {
        codeBlockThemeDark: "base16/dracula",
        codeBlockThemeLight: "github",
        get theme() {
          return document.documentElement.classList.contains("dark")
            ? "dark"
            : "light";
        },
      },
      editor,
      cover: {
        entries: [],
        resolve: (file) => `/appearance/covers/${encodeURIComponent(file)}`,
      },
      emojis: emojiGroups,
      export: {
        addTitle: true,
        paragraphBeginningSpace: false,
      },
      features: {
        aiActions: false,
        aiWriting: false,
        assetRename: false,
        blockAttributes: false,
        blockMove: false,
        blockRefTransfer: false,
        cloudAssetUpload: false,
        communityShare: false,
        documentDelete: false,
        documentExport: false,
        documentMove: false,
        flashcardDeck: false,
        fullscreen: false,
        navigationHistory: false,
        quickFlashcard: false,
        tableMenu: false,
        webBlockLink: false,
        wechatReminder: false,
        widget: false,
      },
      hotkeys: {
        includes: (hotkey) => [
          settings.hotkeys.general,
          settings.hotkeys.editor.general,
          settings.hotkeys.editor.heading,
          settings.hotkeys.editor.insert,
          settings.hotkeys.editor.list,
          settings.hotkeys.editor.table,
          toolbarHotkeys,
        ].some((group) => Object.values(group).includes(hotkey)),
        general: {
          addToDatabase: "",
          enter: "⌥→",
          enterBack: "⌥←",
          move: "",
          search: "⌘F",
        },
        editor: {
          general: {
            ai: "",
            aiWriting: "",
            alignCenter: "⌥C",
            alignLeft: "⌥L",
            alignRight: "⌥R",
            attr: "",
            backlinks: "⌥⌘B",
            collapse: "⌘↑",
            copyBlockEmbed: "",
            copyBlockRef: "",
            copyHPath: "",
            copyID: "",
            copyPlainText: "",
            copyProtocol: "",
            copyProtocolInMd: "",
            copyText: "",
            duplicate: "⌘D",
            duplicateCompletely: "",
            expand: "⌘↓",
            expandDown: "⌥⇧↓",
            expandUp: "⌥⇧↑",
            foldRecursive: "⌥⌘↑",
            fullscreen: "",
            graphView: "⌥⌘G",
            hLayout: "",
            insertAfter: "⇧⌘A",
            insertBefore: "⇧⌘B",
            insertBottom: "",
            insertRight: "⌥.",
            exitFocus: "",
            jumpToParent: "⇧⌘J",
            jumpToParentNext: "⇧⌘N",
            jumpToParentPrev: "⇧⌘M",
            ltr: "",
            moveToDown: "⇧⌘↓",
            moveToUp: "⇧⌘↑",
            netAssets2LocalAssets: "",
            netImg2LocalAsset: "",
            newContentFile: "",
            newNameFile: "",
            newNameSettingFile: "",
            openBy: "",
            openInNewTab: "",
            optimizeTypography: "",
            outline: "⌥⌘O",
            preview: "",
            quickMakeCard: "⌥⌘F",
            refresh: "",
            refPopover: "",
            refTab: "",
            redo: "⇧⌘Z",
            rename: "F2",
            rtl: "",
            spaceRepetition: "",
            undo: "⌘Z",
            vLayout: "",
            wysiwyg: "",
          },
          heading: {
            heading1: "⌥⌘1",
            heading2: "⌥⌘2",
            heading3: "⌥⌘3",
            heading4: "⌥⌘4",
            heading5: "⌥⌘5",
            heading6: "⌥⌘6",
            paragraph: "⌥⌘0",
          },
          insert: {
            check: "⌘L",
            code: "⇧⌘K",
            list: "",
            orderedList: "",
            quote: "",
            table: "⌘O",
          },
          list: {
            checkToggle: "⌘↩",
            indent: "⇥",
            outdent: "⇧⇥",
          },
          table: {
            "delete-column": "⇧⌘-",
            "delete-row": "⌘-",
            insertColumnLeft: "",
            insertColumnRight: "",
            insertRowAbove: "",
            insertRowBelow: "",
            moveToDown: "⌥⌘B",
            moveToLeft: "⌥⌘L",
            moveToRight: "⌥⌘R",
            moveToUp: "⌥⌘T",
          },
        },
      },
      icons: {
        file: "1f4c4",
      },
      localFilePosition: {
        get: (identity) => state.positions[contentPositionKey(identity)],
        persist,
        remove: (identity) => {
          delete state.positions[contentPositionKey(identity)];
        },
        set: (identity, position) => {
          state.positions[contentPositionKey(identity)] = position;
        },
      },
      navigation: {
        noSplitScreenWhenOpenTab: false,
        openFilesUseCurrentTab: false,
      },
      recentEmojis: {
        add: (unicode) => {
          const previousIndex = state.recentEmojis.indexOf(unicode);
          if (previousIndex !== -1) {
            state.recentEmojis.splice(previousIndex, 1);
          }
          state.recentEmojis.unshift(unicode);
          if (state.recentEmojis.length > MAXIMUM_RECENT_EMOJI_COUNT) {
            state.recentEmojis.pop();
          }
          persist();
        },
        get values() {
          return state.recentEmojis;
        },
      },
      toolbar: {
        get codeLanguage() {
          return state.codeLanguage;
        },
        hotkeys: toolbarHotkeys,
        persist,
        get recentFontStyles() {
          return state.recentFontStyles;
        },
        setCodeLanguage: (language) => {
          state.codeLanguage = language;
        },
        setRecentFontStyles: (styles) => {
          state.recentFontStyles = styles;
        },
      },
    };
  return {
    localization: protyleLocalization,
    settings,
  };
}
