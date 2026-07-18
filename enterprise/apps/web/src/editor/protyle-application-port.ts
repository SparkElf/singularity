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
const STORAGE_PREFIX = "singularity.protyle.application.v1";

const textDictionary = language as unknown as Readonly<Record<string, string>>;
const kernelDictionary = language._kernel as Readonly<Record<string, string>>;

export const protyleLocalization: ProtyleLocalizationPort = {
  language: "zh_CN",
  kernelText: (index) => kernelDictionary[index],
  text: (key) => textDictionary[key],
};

interface PersistedApplicationState {
  fontSize: number;
  codeLanguage: string;
  positions: Record<string, ProtyleScrollPosition>;
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
      recentFontStyles: [],
    };
  }
  const parsed = JSON.parse(serialized) as Partial<PersistedApplicationState>;
  return {
    codeLanguage: parsed.codeLanguage ?? "",
    fontSize: parsed.fontSize ?? DEFAULT_EDITOR_FONT_SIZE,
    positions: parsed.positions ?? {},
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
    katexMacros: "{}",
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
    plantUMLServePath: "https://www.plantuml.com/plantuml/svg/~1",
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
  } satisfies ProtyleApplicationSettings["editor"];

  document.documentElement.style.setProperty(
    "--b3-font-size-editor",
    `${state.fontSize}px`,
  );

  return {
    localization: protyleLocalization,
    settings: {
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
      emojis: emojiGroups,
      export: {
        addTitle: true,
        paragraphBeginningSpace: false,
      },
      hotkeys: {
        insertRight: "⌥.",
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
        openFilesUseCurrentTab: false,
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
    },
  };
}
