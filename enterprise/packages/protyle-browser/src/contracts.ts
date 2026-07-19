export type ProtyleDocumentDisposition =
  | "current"
  | "new-tab"
  | "duplicate-tab"
  | "background-tab"
  | "split-right"
  | "split-bottom";

export type ProtyleDocumentScope = "target" | "context" | "subtree";

export type ProtyleDocumentAttention =
  | "none"
  | "focus"
  | "highlight"
  | "focus-and-highlight";

export type ProtyleDocumentScroll = "auto" | "start";

export type ProtyleDocumentScrollRestore =
  | "never"
  | "always"
  | "if-document";

export type ProtyleRuntimeErrorCategory =
  | "unauthenticated"
  | "forbidden"
  | "kernel-unavailable"
  | "network-failure";

export interface ProtyleDocumentStatistics {
  readonly runeCount: number;
  readonly wordCount: number;
  readonly linkCount: number;
  readonly imageCount: number;
  readonly refCount: number;
  readonly blockCount: number;
}

export interface ProtyleTextPosition {
  readonly start: number;
  readonly end: number;
}

export type ProtyleBlockAttributeFocus =
  | "bookmark"
  | "name"
  | "alias"
  | "memo"
  | "av";

export type ProtyleHostEvent =
  | {
      type: "open-document";
      notebookId: string;
      documentId: string;
      blockId: string;
      disposition: ProtyleDocumentDisposition;
      scope: ProtyleDocumentScope;
      attention: ProtyleDocumentAttention;
      scroll: ProtyleDocumentScroll;
      restoreScroll: ProtyleDocumentScrollRestore;
      zoom: boolean;
    }
  | {
      type: "open-search";
      query: string;
      queryMode: "replace" | "toggle-term";
      method: "preferred" | "keyword";
    }
  | {
      type: "open-document-search";
      notebookId: string;
      documentId: string;
    }
  | {
      type: "open-outline";
      notebookId: string;
      documentId: string;
      preview: boolean;
    }
  | {
      type: "open-backlinks";
      notebookId: string;
      documentId: string;
    }
  | {
      type: "open-graph";
      scope: "space";
    }
  | {
      type: "open-graph";
      scope: "document";
      notebookId: string;
      documentId: string;
    }
  | {
      type: "open-document-history";
      notebookId: string;
      documentId: string;
    }
  | {
      type: "open-document-move";
      notebookId: string;
      documentId: string;
    }
  | {
      type: "delete-document";
      notebookId: string;
      documentId: string;
    }
  | {
      type: "open-document-export";
      notebookId: string;
      documentId: string;
      blockId: string;
      position: ProtyleMenuPosition;
    }
  | {
      type: "upload-cloud-assets";
      notebookId: string;
      documentId: string;
      blockId: string;
    }
  | {
      type: "share-document-community";
      notebookId: string;
      documentId: string;
      blockId: string;
    }
  | {
      type: "open-card-review";
      notebookId: string;
      documentId: string;
    }
  | {
      type: "open-card-browser";
      notebookId: string;
      documentId: string;
    }
  | {
      type: "open-card-deck-picker";
      documentId: string;
      notebookId: string;
      blockIds: readonly string[];
    }
  | {
      type: "add-blocks-to-agent";
      documentId: string;
      notebookId: string;
      blockIds: readonly string[];
    }
  | {
      type: "open-ai-writing";
      blockId: string;
      documentId: string;
      notebookId: string;
    }
  | {
      type: "open-ai-actions";
      notebookId: string;
      documentId: string;
      blockIds: readonly string[];
    }
  | {
      type: "open-block-attributes";
      notebookId: string;
      documentId: string;
      blockId: string;
      focus: ProtyleBlockAttributeFocus;
    }
  | {
      type: "open-block-move";
      notebookId: string;
      documentId: string;
      blockIds: readonly string[];
    }
  | {
      type: "open-block-ref-transfer";
      notebookId: string;
      documentId: string;
      blockId: string;
    }
  | {
      type: "open-block-reminder";
      notebookId: string;
      documentId: string;
      blockId: string;
    }
  | {
      type: "open-table-menu";
      notebookId: string;
      documentId: string;
      blockId: string;
    }
  | {
      type: "rename-asset";
      notebookId: string;
      documentId: string;
      blockId: string;
      assetPath: string;
    }
  | {
      type: "open-asset";
      documentId: string;
      notebookId: string;
      assetPath: string;
      page?: number | string;
      disposition: "current" | "split-right";
    }
  | {
      type: "open-external";
      url: string;
    }
  | {
      type: "close-document";
      notebookId: string;
      documentId: string;
      reason: "deleted" | "notebook-closed";
    }
  | {
      type: "refresh-outline";
      notebookId: string;
      documentId: string;
    }
  | {
      type: "refresh-backlinks";
      notebookId: string;
      documentId: string;
    }
  | {
      type: "set-document-title";
      notebookId: string;
      documentId: string;
      title: string;
    }
  | {
      type: "set-document-icon";
      notebookId: string;
      documentId: string;
      icon: string;
    }
  | {
      type: "activate-document";
      notebookId: string;
      documentId: string;
    }
  | {
      type: "record-navigation-location";
      notebookId: string;
      documentId: string;
      blockId: string;
      position: ProtyleTextPosition;
      zoomId?: string;
    }
  | {
      type: "toggle-document-fullscreen";
      notebookId: string;
      documentId: string;
    }
  | {
      type: "persist-workspace-layout";
      notebookId: string;
      documentId: string;
    }
  | {
      type: "update-document-statistics";
      notebookId: string;
      documentId: string;
      statistics: ProtyleDocumentStatistics;
    }
  | {
      type: "runtime-error";
      category: ProtyleRuntimeErrorCategory;
      documentId?: string;
      triggeringRequestId?: string;
    }
  | {
      type: "notify";
      level: "info" | "success" | "warning" | "error";
      message: string;
    };

export type ProtyleRuntimeErrorEvent = Extract<
  ProtyleHostEvent,
  { type: "runtime-error" }
>;

export type ProtyleEditorHostEvent = Exclude<
  ProtyleHostEvent,
  ProtyleRuntimeErrorEvent
>;

export type ProtyleHostDispatchEvent =
  | ProtyleRuntimeErrorEvent
  | (ProtyleEditorHostEvent & { readonly sourceEditorId: string });

export interface ProtyleEditorHostPort {
  dispatch: (event: ProtyleEditorHostEvent) => void;
}

export interface ProtyleHostPort {
  dispatch: (event: ProtyleHostDispatchEvent) => void;
}

export interface ProtyleEditorRegistry<TEditor> {
  register: (editor: TEditor) => () => void;
  unregister: (editor: TEditor) => void;
  forEach: (visitor: (editor: TEditor) => void) => void;
  find: (predicate: (editor: TEditor) => boolean) => TEditor | undefined;
  activate: (editor: TEditor) => boolean;
  getActive: () => TEditor | undefined;
  seal: () => void;
  dispose: () => void;
}

export type ProtyleSurface = "workspace" | "embedded";

export type ProtyleParticipation = "live" | "detached";

export interface ProtyleContentIdentity {
  readonly documentId: string;
  readonly notebookId: string;
}

export interface ProtyleContentTarget extends ProtyleContentIdentity {
  readonly blockId: string;
}

export interface ProtyleDocumentNavigation extends ProtyleContentTarget {
  readonly attention: ProtyleDocumentAttention;
  readonly restoreScroll: ProtyleDocumentScrollRestore;
  readonly scope: ProtyleDocumentScope;
  readonly scroll: ProtyleDocumentScroll;
  readonly zoom: boolean;
}

export interface ProtyleRequestOptions {
  readonly identity: ProtyleContentIdentity;
  readonly intent: "read" | "write";
  readonly range?: {
    readonly start: number;
    readonly end?: number;
  };
  readonly responseType?: "blob" | "json";
  readonly signal?: AbortSignal;
}

export interface ProtyleUploadOptions {
  readonly identity: ProtyleContentIdentity;
  readonly signal?: AbortSignal;
  readonly onProgress?: (progress: {
    readonly loadedBytes: number;
    readonly totalBytes?: number;
  }) => void;
}

export interface ProtyleTransport<TMessage> {
  request: <TResponse>(
    path: string,
    body: unknown,
    options: ProtyleRequestOptions,
  ) => Promise<TResponse>;
  upload: <TResponse>(
    body: FormData,
    options: ProtyleUploadOptions,
  ) => Promise<TResponse>;
  subscribe: (options: ProtyleSubscriptionOptions<TMessage>) => ProtyleSubscription;
  dispose: () => void;
}

export interface ProtyleSubscription {
  disconnect: () => void;
}

export interface ProtyleSubscriptionOptions<TMessage> extends ProtyleContentIdentity {
  readonly type: "protyle";
  readonly onMessage: (message: TMessage) => void;
}

export interface ProtyleResourcePort {
  resolveAsset: (identity: ProtyleContentIdentity, path: string) => string;
  resolveEmoji: (identity: ProtyleContentIdentity, path: string) => string;
  resolveExport: (identity: ProtyleContentIdentity, path: string) => string;
}

export interface ProtyleMenuPosition {
  readonly h?: number;
  readonly isLeft?: boolean;
  readonly w?: number;
  readonly x: number;
  readonly y: number;
}

export interface ProtyleMenuItem {
  readonly accelerator?: string;
  readonly action?: string;
  readonly bind?: (element: HTMLElement) => void;
  readonly checked?: boolean;
  readonly click?: (
    element: HTMLElement,
    event: MouseEvent,
  ) => boolean | void | Promise<boolean | void>;
  readonly current?: boolean;
  readonly disabled?: boolean;
  readonly element?: HTMLElement;
  readonly icon?: string;
  readonly iconClass?: string;
  readonly iconHTML?: string;
  readonly id?: string;
  readonly ignore?: boolean;
  readonly index?: number;
  readonly label?: string;
  readonly submenu?: readonly ProtyleMenuItem[];
  readonly type?: "empty" | "readonly" | "separator" | "submenu";
  readonly warning?: boolean;
}

export interface ProtyleMenuSurface {
  readonly element: HTMLElement;
  data: unknown;
  removeCB: (() => void) | undefined;
  addItem: (item: ProtyleMenuItem) => HTMLElement | undefined;
  append: (element: HTMLElement, index?: number) => void;
  close: () => void;
  fullscreen: (position?: "all" | "bottom") => void;
  popup: (position: ProtyleMenuPosition) => void;
  resetPosition: () => void;
  showSubMenu: (element: HTMLElement) => void;
}

export interface ProtyleMenuPort<TMenu> {
  open: () => ProtyleMenuHandle<TMenu>;
  dispose: () => void;
}

export interface ProtyleMenuHandle<TMenu> {
  readonly menu: TMenu;
  close: () => void;
}

export interface ProtyleOverlayPort<TOverlay> {
  add: (overlay: TOverlay, onBeforeClose?: () => void) => ProtyleOverlayHandle;
  bringToFront: (overlay: TOverlay) => void;
  forEach: (visitor: (overlay: TOverlay) => void) => void;
  dispose: () => void;
}

export interface ProtyleOverlayHandle {
  close: () => void;
}

export interface ProtyleRuntime<
  TEditor = unknown,
  TOptions = unknown,
  TToolbar = unknown,
  TMessage = unknown,
  TMenu = unknown,
  TOverlay = unknown,
> {
  readonly editors: ProtyleEditorRegistry<TEditor>;
  readonly host: ProtyleHostPort;
  readonly menu: ProtyleMenuPort<TMenu>;
  readonly overlays: ProtyleOverlayPort<TOverlay>;
  readonly plugins: ProtylePluginPort<TOptions, TToolbar, TEditor>;
  readonly resources: ProtyleResourcePort;
  readonly transport: ProtyleTransport<TMessage>;
}

export interface ProtyleSession<TRuntime = ProtyleRuntime> {
  readonly spaceId: string;
  readonly runtime: TRuntime;
  retrySubmission: () => Promise<void>;
  dispose: () => void | Promise<void>;
}

export type ProtyleSessionRuntime = {
  readonly editors: Pick<ProtyleEditorRegistry<ProtyleController>, "forEach" | "seal" | "dispose">;
  readonly menu: Pick<ProtyleMenuPort<never>, "dispose">;
  readonly overlays: Pick<ProtyleOverlayPort<never>, "dispose">;
  readonly plugins: Pick<ProtylePluginPort<never, never, never>, "dispose">;
  readonly transport: Pick<ProtyleTransport<never>, "dispose">;
};

export interface CreateProtyleSessionOptions<TRuntime extends ProtyleSessionRuntime> {
  readonly spaceId: string;
  readonly runtime: TRuntime;
  readonly retrySubmission: () => Promise<void>;
}

export type ProtylePluginEventType =
  | "click-blockicon"
  | "click-editortitleicon"
  | "click-editorcontent"
  | "code-language-change"
  | "code-language-update"
  | "destroy-protyle"
  | "loaded-protyle-dynamic"
  | "loaded-protyle-static"
  | "open-menu-av"
  | "open-menu-blockref"
  | "open-menu-breadcrumbmore"
  | "open-menu-content"
  | "open-menu-fileannotationref"
  | "open-menu-image"
  | "open-menu-link"
  | "open-menu-tag"
  | "open-noneditableblock"
  | "switch-protyle-mode";

export interface ProtylePluginEvent<TDetail extends object> {
  readonly type: ProtylePluginEventType;
  readonly detail: TDetail;
}

export interface ProtylePluginSlashItem {
  readonly id: string;
  readonly filter: string[];
  readonly html: string;
}

export interface ProtylePluginPort<TOptions, TToolbar, TEditor> {
  extendOptions: (options: TOptions) => TOptions;
  extendToolbar: (
    toolbar: TToolbar,
    normalizeToolbar: (toolbar: TToolbar) => TToolbar,
  ) => TToolbar;
  emit: <TDetail extends object>(event: ProtylePluginEvent<TDetail>) => void;
  runEditorCommand: (
    editor: TEditor,
    event: KeyboardEvent,
    matchesHotkey: (hotkey: string, event: KeyboardEvent) => boolean,
  ) => boolean;
  forEachSlashItem: (
    visitor: (pluginName: string, item: ProtylePluginSlashItem) => void,
  ) => void;
  runSlashItem: (
    pluginName: string,
    itemId: string,
    editor: TEditor,
    nodeElement: HTMLElement,
  ) => boolean;
  transformPaste: <TPayload extends object>(
    editor: TEditor,
    payload: TPayload,
  ) => Promise<TPayload>;
  dispose: () => void | Promise<void>;
}

export interface ProtyleController {
  destroy: () => void;
  focus: () => void;
  navigateDocument: (navigation: ProtyleDocumentNavigation) => Promise<void>;
  setHostReadOnly: (readOnly: boolean) => void;
}

export interface ProtyleScrollPosition {
  readonly rootId: string;
  readonly startId?: string;
  readonly endId?: string;
  readonly scrollTop?: number;
  readonly focusId?: string;
  readonly focusStart?: number;
  readonly focusEnd?: number;
  readonly zoomInId?: string;
}

export type ProtyleToolbarMessageKey =
  | "anchor"
  | "appearance"
  | "blockEmbed"
  | "bold"
  | "chart"
  | "clear"
  | "clearFontStyle"
  | "clearInline"
  | "color"
  | "colorFont"
  | "colorPrimary"
  | "copy"
  | "copied"
  | "confirmDelete"
  | "copyPlainText"
  | "default"
  | "emptyContent"
  | "export"
  | "fontStyle"
  | "hollow"
  | "htmlBlockTip"
  | "image"
  | "inline-code"
  | "inline-math"
  | "insertAfter"
  | "insertBefore"
  | "italic"
  | "kbd"
  | "lastUsed"
  | "link"
  | "mark"
  | "math"
  | "memo"
  | "mindmap"
  | "pasteAsPlainText"
  | "pasteEscaped"
  | "pin"
  | "ref"
  | "refresh"
  | "relativeFontSize"
  | "remove"
  | "search"
  | "shadow"
  | "staff"
  | "strike"
  | "sub"
  | "sup"
  | "tag"
  | "text"
  | "title"
  | "underline";

export type ProtyleMessageKey =
  | "cancel"
  | "close"
  | "confirm"
  | "copyToWechatMP"
  | "copyToZhihu"
  | "copyToYuque"
  | "cancelTempUnlock"
  | "desktop"
  | "edit"
  | "fileTypeError"
  | "fontSize"
  | "emptyPlaceholder"
  | "lockEdit"
  | "mobile"
  | "more"
  | "nameEmpty"
  | "over"
  | "pasteToWechatMP"
  | "pasteToZhihu"
  | "pasteToYuque"
  | "refExpired"
  | "refPopover"
  | "reset"
  | "scrollGetMore"
  | "tablet"
  | "tempUnlock"
  | "undo"
  | "undoCrossDocConfirm"
  | "unpin"
  | "unlockEdit"
  | "update"
  | "upload"
  | "uploadError"
  | "uploadFileTooLarge"
  | "uploading"
  | ProtyleToolbarMessageKey;

export type ProtyleToolbarHotkey =
  | "appearance"
  | "bold"
  | "clearInline"
  | "inline-code"
  | "inline-math"
  | "italic"
  | "kbd"
  | "lastUsed"
  | "link"
  | "mark"
  | "memo"
  | "ref"
  | "strike"
  | "sub"
  | "sup"
  | "tag"
  | "underline";

export interface ProtyleLocalizationPort {
  readonly attributeViewText: (key: string) => string;
  readonly language: string;
  readonly kernelText: (index: number) => string;
  readonly text: (key: string) => string;
}

export interface ProtyleEmojiItem {
  readonly description: string;
  readonly description_ja_jp: string;
  readonly description_zh_cn: string;
  readonly keywords: string;
  readonly unicode: string;
}

export interface ProtyleEmojiGroup {
  readonly id: string;
  readonly items: readonly ProtyleEmojiItem[];
  readonly title: string;
  readonly title_ja_jp: string;
  readonly title_zh_cn: string;
}

export interface ProtyleCoverEntry {
  readonly file: string;
  readonly category: string;
  readonly photographer: string;
  readonly photographer_url: string;
  readonly pexels_url: string;
  readonly width: number;
  readonly height: number;
}

/**
 * Settings are application-owned values that do not identify content. Bound
 * content capabilities remain on ProtyleSession and are intentionally absent
 * from this contract.
 */
export interface ProtyleApplicationSettings {
  readonly appearance: {
    readonly codeBlockThemeDark: string;
    readonly codeBlockThemeLight: string;
    readonly theme: "dark" | "light";
  };
  readonly editor: {
    readonly blockRefDynamicAnchorTextMaxLen: number;
    readonly codeLigatures: boolean;
    readonly codeLineWrap: boolean;
    readonly codeSyntaxHighlightLineNum: boolean;
    readonly codeTabSpaces: number;
    readonly displayBookmarkIcon: boolean;
    readonly embedBlockBreadcrumb: boolean;
    readonly fontSize: number;
    readonly fontSizeScrollZoom: boolean;
    readonly fullWidth: boolean;
    readonly headingEmbedMode: number;
    readonly listItemDotNumberClickFocus: boolean;
    readonly rtl: boolean;
    readonly dynamicLoadBlocks: number;
    readonly katexMacros: string;
    readonly listLogicalOutdent: boolean;
    readonly pasteURLAutoConvert: boolean;
    readonly plantUMLServePath: string;
    readonly readOnly: boolean;
    readonly spellcheck: boolean;
    readonly suppressBlockLinkPopoverOnMenu: boolean;
    readonly displayNetImgMark: boolean;
    readonly markdown: {
      readonly inlineAsterisk: boolean;
      readonly inlineUnderscore: boolean;
      readonly inlineSup: boolean;
      readonly inlineSub: boolean;
      readonly inlineTag: boolean;
      readonly inlineMath: boolean;
      readonly inlineStrikethrough: boolean;
      readonly inlineMark: boolean;
    };
    readonly setReadOnly: (readOnly: boolean) => void;
    readonly setFontSize: (fontSize: number) => void;
    readonly persist: () => void | Promise<void>;
  };
  readonly cover: {
    readonly entries: readonly ProtyleCoverEntry[];
    readonly resolve: (file: string) => string;
  };
  readonly export: {
    readonly addTitle: boolean;
    readonly paragraphBeginningSpace: boolean;
  };
  readonly features: {
    readonly aiActions: boolean;
    readonly aiWriting: boolean;
    readonly assetRename: boolean;
    readonly blockAttributes: boolean;
    readonly blockMove: boolean;
    readonly blockRefTransfer: boolean;
    readonly cloudAssetUpload: boolean;
    readonly communityShare: boolean;
    readonly documentDelete: boolean;
    readonly documentExport: boolean;
    readonly documentMove: boolean;
    readonly flashcardDeck: boolean;
    readonly fullscreen: boolean;
    readonly navigationHistory: boolean;
    readonly quickFlashcard: boolean;
    readonly tableMenu: boolean;
    readonly webBlockLink: boolean;
    readonly wechatReminder: boolean;
    readonly widget: boolean;
  };
  readonly emojis: readonly ProtyleEmojiGroup[];
  readonly recentEmojis: {
    readonly values: readonly string[];
    readonly add: (unicode: string) => void | Promise<void>;
  };
  readonly hotkeys: {
    readonly includes: (hotkey: string) => boolean;
    readonly general: {
      readonly addToDatabase: string;
      readonly enter: string;
      readonly enterBack: string;
      readonly move: string;
      readonly search: string;
    };
    readonly editor: {
      readonly general: {
        readonly ai: string;
        readonly aiWriting: string;
        readonly alignCenter: string;
        readonly alignLeft: string;
        readonly alignRight: string;
        readonly attr: string;
        readonly backlinks: string;
        readonly collapse: string;
        readonly copyBlockEmbed: string;
        readonly copyBlockRef: string;
        readonly copyHPath: string;
        readonly copyID: string;
        readonly copyPlainText: string;
        readonly copyProtocol: string;
        readonly copyProtocolInMd: string;
        readonly copyText: string;
        readonly duplicate: string;
        readonly duplicateCompletely: string;
        readonly expand: string;
        readonly expandDown: string;
        readonly expandUp: string;
        readonly foldRecursive: string;
        readonly fullscreen: string;
        readonly graphView: string;
        readonly hLayout: string;
        readonly insertAfter: string;
        readonly insertBefore: string;
        readonly insertBottom: string;
        readonly insertRight: string;
        readonly exitFocus: string;
        readonly jumpToParent: string;
        readonly jumpToParentNext: string;
        readonly jumpToParentPrev: string;
        readonly ltr: string;
        readonly moveToDown: string;
        readonly moveToUp: string;
        readonly netAssets2LocalAssets: string;
        readonly netImg2LocalAsset: string;
        readonly newContentFile: string;
        readonly newNameFile: string;
        readonly newNameSettingFile: string;
        readonly openBy: string;
        readonly openInNewTab: string;
        readonly optimizeTypography: string;
        readonly outline: string;
        readonly preview: string;
        readonly quickMakeCard: string;
        readonly refresh: string;
        readonly refPopover: string;
        readonly refTab: string;
        readonly redo: string;
        readonly rename: string;
        readonly rtl: string;
        readonly spaceRepetition: string;
        readonly undo: string;
        readonly vLayout: string;
        readonly wysiwyg: string;
      };
      readonly heading: {
        readonly heading1: string;
        readonly heading2: string;
        readonly heading3: string;
        readonly heading4: string;
        readonly heading5: string;
        readonly heading6: string;
        readonly paragraph: string;
      };
      readonly insert: {
        readonly check: string;
        readonly code: string;
        readonly list: string;
        readonly orderedList: string;
        readonly quote: string;
        readonly table: string;
      };
      readonly list: {
        readonly checkToggle: string;
        readonly indent: string;
        readonly outdent: string;
      };
      readonly table: {
        readonly "delete-column": string;
        readonly "delete-row": string;
        readonly insertColumnLeft: string;
        readonly insertColumnRight: string;
        readonly insertRowAbove: string;
        readonly insertRowBelow: string;
        readonly moveToDown: string;
        readonly moveToLeft: string;
        readonly moveToRight: string;
        readonly moveToUp: string;
      };
    };
  };
  readonly icons: {
    readonly file: string;
  };
  readonly localFilePosition: {
    readonly get: (identity: ProtyleContentIdentity) => ProtyleScrollPosition | undefined;
    readonly set: (
      identity: ProtyleContentIdentity,
      position: ProtyleScrollPosition,
    ) => void;
    readonly remove: (identity: ProtyleContentIdentity) => void;
    readonly persist: () => void;
  };
  readonly navigation: {
    readonly noSplitScreenWhenOpenTab: boolean;
    readonly openFilesUseCurrentTab: boolean;
  };
  readonly toolbar: {
    readonly codeLanguage: string;
    readonly hotkeys: Readonly<Record<ProtyleToolbarHotkey, string>>;
    readonly persist: () => void | Promise<void>;
    readonly recentFontStyles: readonly string[];
    readonly setCodeLanguage: (language: string) => void;
    readonly setRecentFontStyles: (styles: string[]) => void;
  };
}

export interface ProtyleApplicationPort<
  TOptions = unknown,
  TToolbar = unknown,
  TEditor extends ProtyleController = ProtyleController,
> {
  readonly localization: ProtyleLocalizationPort;
  readonly settings: ProtyleApplicationSettings;
  readonly protyleEditors?: ProtyleEditorRegistry<TEditor>;
  readonly protyleHost?: ProtyleHostPort;
  readonly protylePlugins?: ProtylePluginPort<TOptions, TToolbar, TEditor>;
}

export interface CreateProtyleOptions<TRuntime = ProtyleRuntime> {
  readonly documentId: string;
  readonly host: HTMLElement;
  readonly notebookId: string;
  readonly readOnly: boolean;
  readonly session: ProtyleSession<TRuntime>;
  readonly signal: AbortSignal;
}

export interface ProtyleFactory<TRuntime = ProtyleRuntime> {
  create: (options: CreateProtyleOptions<TRuntime>) => Promise<ProtyleController>;
}

export interface ProtyleCoreDocumentOptions {
  readonly blockId?: string;
  readonly notebookId?: string;
}

export interface ProtyleCoreCommonOptions {
  readonly host: HTMLElement;
  readonly readOnly: boolean;
  readonly signal: AbortSignal;
  readonly surface: ProtyleSurface;
}

export interface ProtyleBoundContent {
  readonly mode: "bound";
  readonly notebookId: string;
}

export interface ProtyleLocalOnlyContent {
  readonly mode: "local-only";
  readonly notebookId?: never;
}

export type ProtyleCoreCreateOptions<
  TOptions extends ProtyleCoreDocumentOptions,
  TRuntime = ProtyleRuntime,
> =
  | (ProtyleCoreCommonOptions & {
      readonly content: ProtyleBoundContent;
      readonly participation: "live";
      readonly session: ProtyleSession<TRuntime>;
      readonly initialLoad: "automatic" | "owner";
      readonly options: Omit<TOptions, "blockId" | "notebookId"> & {
        readonly blockId: string;
        readonly notebookId?: never;
      };
    })
  | (ProtyleCoreCommonOptions & {
      readonly content: ProtyleBoundContent;
      readonly participation: "detached";
      readonly session: ProtyleSession<TRuntime>;
      readonly initialLoad: "automatic" | "owner";
      readonly options: Omit<TOptions, "blockId" | "notebookId"> & {
        readonly blockId: string;
        readonly notebookId?: never;
      };
    })
  | (Omit<ProtyleCoreCommonOptions, "surface"> & {
      readonly content: ProtyleLocalOnlyContent;
      readonly participation: "detached";
      readonly session?: never;
      readonly surface: "embedded";
      readonly options: Omit<TOptions, "blockId" | "notebookId"> & {
        readonly blockId?: never;
        readonly notebookId?: never;
      };
    });

export interface ProtyleCoreFactory<
  TOptions extends ProtyleCoreDocumentOptions,
  TRuntime = ProtyleRuntime,
> {
  create: (options: ProtyleCoreCreateOptions<TOptions, TRuntime>) => Promise<ProtyleController>;
}

export type ProtyleWorkspaceCoreCreateOptions<
  TOptions extends ProtyleCoreDocumentOptions,
  TRuntime = ProtyleRuntime,
> = Omit<ProtyleCoreCommonOptions, "surface"> & {
  readonly content: ProtyleBoundContent;
  readonly participation: "live";
  readonly session: ProtyleSession<TRuntime>;
  readonly initialLoad: "automatic" | "owner";
  readonly options: Omit<TOptions, "blockId" | "notebookId"> & {
    readonly blockId: string;
    readonly notebookId?: never;
  };
  readonly surface: "workspace";
};

export interface ProtyleWorkspaceCoreFactory<
  TOptions extends ProtyleCoreDocumentOptions,
  TRuntime = ProtyleRuntime,
> {
  create: (
    options: ProtyleWorkspaceCoreCreateOptions<TOptions, TRuntime>,
  ) => Promise<ProtyleController>;
}
