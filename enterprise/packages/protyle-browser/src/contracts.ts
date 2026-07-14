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

export type ProtyleHostEvent =
  | {
      type: "open-document";
      documentId: string;
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
      documentId: string;
    }
  | {
      type: "open-outline";
      documentId: string;
      preview: boolean;
    }
  | {
      type: "open-backlinks";
      documentId: string;
    }
  | {
      type: "open-graph";
      scope: "space";
    }
  | {
      type: "open-graph";
      scope: "document";
      documentId: string;
    }
  | {
      type: "open-document-history";
      documentId: string;
    }
  | {
      type: "open-card-review";
      documentId: string;
    }
  | {
      type: "open-card-browser";
      documentId: string;
    }
  | {
      type: "open-card-deck-picker";
      blockIds: readonly string[];
    }
  | {
      type: "open-asset";
      assetPath: string;
      page?: number;
      disposition: "current" | "split-right";
    }
  | {
      type: "open-external";
      url: string;
    }
  | {
      type: "close-document";
      documentId: string;
      reason: "deleted" | "notebook-closed";
    }
  | {
      type: "refresh-outline";
      documentId: string;
    }
  | {
      type: "refresh-backlinks";
      documentId: string;
    }
  | {
      type: "set-document-title";
      documentId: string;
      title: string;
    }
  | {
      type: "set-document-icon";
      documentId: string;
      icon: string;
    }
  | {
      type: "activate-document";
      documentId: string;
    }
  | {
      type: "toggle-document-fullscreen";
      documentId: string;
    }
  | {
      type: "persist-workspace-layout";
      documentId: string;
    }
  | {
      type: "update-document-statistics";
      documentId: string;
      statistics: ProtyleDocumentStatistics;
    }
  | {
      type: "runtime-error";
      category: ProtyleRuntimeErrorCategory;
      requestId: string;
    }
  | {
      type: "notify";
      level: "info" | "success" | "warning" | "error";
      message: string;
    };

export interface ProtyleHostPort {
  dispatch: (event: ProtyleHostEvent) => void;
}

export interface ProtyleEditorRegistry<TEditor> {
  register: (editor: TEditor) => () => void;
  unregister: (editor: TEditor) => void;
  forEach: (visitor: (editor: TEditor) => void) => void;
  find: (predicate: (editor: TEditor) => boolean) => TEditor | undefined;
  activate: (editor: TEditor) => boolean;
  getActive: () => TEditor | undefined;
  dispose: () => void;
}

export type ProtyleSurface = "workspace" | "embedded";

export type ProtyleParticipation = "live" | "detached";

export interface ProtyleRequestOptions {
  readonly headers?: Readonly<Record<string, string>>;
  readonly signal?: AbortSignal;
}

export interface ProtyleTransport<TMessage> {
  request: <TResponse>(
    path: string,
    body?: unknown,
    options?: ProtyleRequestOptions,
  ) => Promise<TResponse>;
  subscribe: (options: ProtyleSubscriptionOptions<TMessage>) => ProtyleSubscription;
  dispose: () => void;
}

export interface ProtyleSubscription {
  disconnect: () => void;
}

export interface ProtyleSubscriptionOptions<TMessage> {
  readonly id: string;
  readonly type: "protyle";
  readonly onMessage: (message: TMessage) => void;
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
  add: (overlay: TOverlay) => ProtyleOverlayHandle;
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
  readonly transport: ProtyleTransport<TMessage>;
}

export interface ProtyleSession<TRuntime = ProtyleRuntime> {
  readonly spaceId: string;
  readonly runtime: TRuntime;
  retrySubmission: () => Promise<void>;
  dispose: () => void | Promise<void>;
}

export type ProtyleSessionRuntime = {
  readonly editors: Pick<ProtyleEditorRegistry<never>, "dispose">;
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
  setHostReadOnly: (readOnly: boolean) => void;
}

export interface CreateProtyleOptions<TRuntime = ProtyleRuntime> {
  readonly documentId: string;
  readonly host: HTMLElement;
  readonly readOnly: boolean;
  readonly session: ProtyleSession<TRuntime>;
  readonly signal: AbortSignal;
}

export interface ProtyleFactory<TRuntime = ProtyleRuntime> {
  create: (options: CreateProtyleOptions<TRuntime>) => Promise<ProtyleController>;
}

export interface ProtyleCoreDocumentOptions {
  readonly blockId?: string;
}

export interface ProtyleCoreBaseOptions<TRuntime = ProtyleRuntime> {
  readonly host: HTMLElement;
  readonly session: ProtyleSession<TRuntime>;
  readonly readOnly: boolean;
  readonly signal: AbortSignal;
  readonly surface: ProtyleSurface;
}

export type ProtyleCoreCreateOptions<
  TOptions extends ProtyleCoreDocumentOptions,
  TRuntime = ProtyleRuntime,
> = ProtyleCoreBaseOptions<TRuntime> &
  (
    | {
        readonly participation: "live";
        readonly options: Omit<TOptions, "blockId"> & { readonly blockId: string };
      }
    | {
        readonly participation: "detached";
        readonly options: Omit<TOptions, "blockId"> & { readonly blockId?: string };
      }
  );

export interface ProtyleCoreFactory<
  TOptions extends ProtyleCoreDocumentOptions,
  TRuntime = ProtyleRuntime,
> {
  create: (options: ProtyleCoreCreateOptions<TOptions, TRuntime>) => Promise<ProtyleController>;
}
