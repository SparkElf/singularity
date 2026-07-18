interface ILuteNode {
    TokensStr: () => string;
    __internal_object__: {
        Parent: {
            Type: number,
        },
        HeadingLevel: string,
    };
}

type THintSource = "search" | "av" | "hint";

type TTurnIntoOne =
    "BlocksMergeSuperBlock"
    | "Blocks2ULs"
    | "Blocks2OLs"
    | "Blocks2TLs"
    | "Blocks2Blockquote"
    | "Blocks2Callout"

type TTurnIntoOneSub = "row" | "col"

type TTurnInto = "Blocks2Ps" | "Blocks2Hs"

type TEditorMode = "preview" | "wysiwyg"

type ILuteRenderCallback = (node: ILuteNode, entering: boolean) => [string, number];

type TProtyleAction = "cb-get-append" | // 向下滚动加载
    "cb-get-before" | // 向上滚动加载
    "cb-get-unchangeid" | // 上下滚动，定位时不修改 blockid
    "cb-get-hl" | // 高亮
    "cb-get-focus" | // 光标定位
    "cb-get-focusfirst" | // 动态定位到第一个块
    "cb-get-setid" | // 无折叠大纲点击 重置 blockid
    "cb-get-outline" | // 大纲点击
    "cb-get-all" | // 获取所有块
    "cb-get-backlink" | // 悬浮窗为传递型需展示上下文
    "cb-get-unundo" | // 不需要记录历史
    "cb-get-scroll" | // 滚动到指定位置，用于直接打开文档，必有 rootID
    "cb-get-search" | // 使用搜索打开搜索
    "cb-get-context" | // 包含上下文
    "cb-get-rootscroll" | // 如果为 rootID 就滚动到指定位置，必有 rootID
    "cb-get-html" | // 直接渲染，不需要再 /api/block/getDocInfo，否则搜索表格无法定位
    "cb-get-history" | // 历史渲染
    "cb-get-opennew" | // 编辑器只读后新建文件需为临时解锁状态 & https://github.com/siyuan-note/siyuan/issues/12197
    "cb-get-av-no-create"  // 属性视图不自动创建

/** @link https://ld246.com/article/1588412297062 */
interface ILuteRender {
    renderDocument?: ILuteRenderCallback;
    renderParagraph?: ILuteRenderCallback;
    renderText?: ILuteRenderCallback;
    renderCodeBlock?: ILuteRenderCallback;
    renderCodeBlockOpenMarker?: ILuteRenderCallback;
    renderCodeBlockInfoMarker?: ILuteRenderCallback;
    renderCodeBlockCode?: ILuteRenderCallback;
    renderCodeBlockCloseMarker?: ILuteRenderCallback;
    renderMathBlock?: ILuteRenderCallback;
    renderMathBlockOpenMarker?: ILuteRenderCallback;
    renderMathBlockContent?: ILuteRenderCallback;
    renderMathBlockCloseMarker?: ILuteRenderCallback;
    renderBlockquote?: ILuteRenderCallback;
    renderBlockquoteMarker?: ILuteRenderCallback;
    renderHeading?: ILuteRenderCallback;
    renderHeadingC8hMarker?: ILuteRenderCallback;
    renderList?: ILuteRenderCallback;
    renderListItem?: ILuteRenderCallback;
    renderTaskListItemMarker?: ILuteRenderCallback;
    renderThematicBreak?: ILuteRenderCallback;
    renderHTML?: ILuteRenderCallback;
    renderTable?: ILuteRenderCallback;
    renderTableHead?: ILuteRenderCallback;
    renderTableRow?: ILuteRenderCallback;
    renderTableCell?: ILuteRenderCallback;
    renderCodeSpan?: ILuteRenderCallback;
    renderCodeSpanOpenMarker?: ILuteRenderCallback;
    renderCodeSpanContent?: ILuteRenderCallback;
    renderCodeSpanCloseMarker?: ILuteRenderCallback;
    renderInlineMath?: ILuteRenderCallback;
    renderInlineMathOpenMarker?: ILuteRenderCallback;
    renderInlineMathContent?: ILuteRenderCallback;
    renderInlineMathCloseMarker?: ILuteRenderCallback;
    renderEmphasis?: ILuteRenderCallback;
    renderEmAsteriskOpenMarker?: ILuteRenderCallback;
    renderEmAsteriskCloseMarker?: ILuteRenderCallback;
    renderEmUnderscoreOpenMarker?: ILuteRenderCallback;
    renderEmUnderscoreCloseMarker?: ILuteRenderCallback;
    renderStrong?: ILuteRenderCallback;
    renderStrongA6kOpenMarker?: ILuteRenderCallback;
    renderStrongA6kCloseMarker?: ILuteRenderCallback;
    renderStrongU8eOpenMarker?: ILuteRenderCallback;
    renderStrongU8eCloseMarker?: ILuteRenderCallback;
    renderStrikethrough?: ILuteRenderCallback;
    renderStrikethrough1OpenMarker?: ILuteRenderCallback;
    renderStrikethrough1CloseMarker?: ILuteRenderCallback;
    renderStrikethrough2OpenMarker?: ILuteRenderCallback;
    renderStrikethrough2CloseMarker?: ILuteRenderCallback;
    renderHardBreak?: ILuteRenderCallback;
    renderSoftBreak?: ILuteRenderCallback;
    renderInlineHTML?: ILuteRenderCallback;
    renderLink?: ILuteRenderCallback;
    renderOpenBracket?: ILuteRenderCallback;
    renderCloseBracket?: ILuteRenderCallback;
    renderOpenParen?: ILuteRenderCallback;
    renderCloseParen?: ILuteRenderCallback;
    renderLinkText?: ILuteRenderCallback;
    renderLinkSpace?: ILuteRenderCallback;
    renderLinkDest?: ILuteRenderCallback;
    renderLinkTitle?: ILuteRenderCallback;
    renderImage?: ILuteRenderCallback;
    renderBang?: ILuteRenderCallback;
    renderEmoji?: ILuteRenderCallback;
    renderEmojiUnicode?: ILuteRenderCallback;
    renderEmojiImg?: ILuteRenderCallback;
    renderEmojiAlias?: ILuteRenderCallback;
    renderBackslash?: ILuteRenderCallback;
    renderBackslashContent?: ILuteRenderCallback;
}

interface IBreadcrumb {
    id: string,
    name: string,
    type: string,
    subType: string,
    children: []
}

interface ILuteOptions extends IMarkdownConfig {
    emojis: IObject;
    emojiSite: string;
    headingAnchor?: boolean;
    lazyLoadImage?: string;
}

interface IProtyleLuteOptions extends Omit<ILuteOptions, "emojiSite"> {
    resolveEmojiPath: (path: string) => string;
}

declare class Viz {
    public static instance(): Promise<Viz>;

    renderSVGElement: (code: string) => SVGElement;
}

declare class Viewer {
    public destroyed: boolean;

    constructor(element: Element, options: {
        title: [number, (image: HTMLImageElement, imageData: IObject) => string],
        button: boolean,
        initialViewIndex?: number,
        transition: boolean,
        hidden: () => void,
        toolbar: {
            zoomIn: boolean,
            zoomOut: boolean,
            oneToOne: boolean,
            reset: boolean,
            prev: boolean,
            play: boolean,
            next: boolean,
            rotateLeft: boolean,
            rotateRight: boolean,
            flipHorizontal: boolean,
            flipVertical: boolean,
            close: () => void
        }
    })

    public destroy(): void

    public show(): void
}

declare class Lute {
    public static WalkStop: number;
    public static WalkSkipChildren: number;
    public static WalkContinue: number;
    public static Version: string;
    public static Caret: string;

    public static New(): Lute;

    public static EChartsMindmapStr(text: string): string;

    public static NewNodeID(): string;

    public static Sanitize(html: string): string;

    public static EscapeHTMLStr(str: string): string;

    public static UnEscapeHTMLStr(str: string): string;

    public static GetHeadingID(node: ILuteNode): string;

    public static BlockDOM2Content(html: string): string;

    private constructor();

    public BlockDOM2Content(text: string): string;

    public BlockDOM2EscapeMarkerContent(text: string): string;

    public SetSpin(enable: boolean): void;

    public SetTextMark(enable: boolean): void;

    public SetHTMLTag2TextMark(enable: boolean): void;

    public SetHeadingID(enable: boolean): void;

    public SetProtyleMarkNetImg(enable: boolean): void;

    public SetSpellcheck(enable: boolean): void;

    public SetFileAnnotationRef(enable: boolean): void;

    public SetSetext(enable: boolean): void;

    public SetYamlFrontMatter(enable: boolean): void;

    public SetChineseParagraphBeginningSpace(enable: boolean): void;

    public SetRenderListStyle(enable: boolean): void;

    public SetImgPathAllowSpace(enable: boolean): void;

    public SetKramdownIAL(enable: boolean): void;

    public BlockDOM2Md(html: string): string;

    public BlockDOM2StdMd(html: string): string;

    public SetSuperBlock(enable: boolean): void;

    public SetCallout(enable: boolean): void;

    public SetTag(enable: boolean): void;

    public SetInlineMath(enable: boolean): void;

    public SetGFMStrikethrough(enable: boolean): void;

    public SetGFMStrikethrough1(enable: boolean): void;

    public SetMark(enable: boolean): void;

    public SetSub(enable: boolean): void;

    public SetSup(enable: boolean): void;

    public SetInlineAsterisk(enable: boolean): void;

    public SetInlineUnderscore(enable: boolean): void;

    public SetBlockRef(enable: boolean): void;

    public SetSanitize(enable: boolean): void;

    public SetHeadingAnchor(enable: boolean): void;

    public SetImageLazyLoading(imagePath: string): void;

    public SetInlineMathAllowDigitAfterOpenMarker(enable: boolean): void;

    public SetToC(enable: boolean): void;

    public SetIndentCodeBlock(enable: boolean): void;

    public SetParagraphBeginningSpace(enable: boolean): void;

    public SetFootnotes(enable: boolean): void;

    public SetLinkRef(enable: boolean): void;

    public SetEmojiSite(emojiSite: string): void;

    public PutEmojis(emojis: IObject): void;

    public SpinBlockDOM(html: string): string;

    public Md2BlockDOM(html: string): string;

    public Md2BlockDOMWithAutoLink(html: string): string;

    public SetProtyleWYSIWYG(wysiwyg: boolean): void;

    public MarkdownStr(name: string, md: string): string;

    public ProtylePreviewStr(name: string, md: string): string;

    public GetLinkDest(text: string): string;

    public BlockDOM2InlineBlockDOM(html: string): string;

    public BlockDOM2HTML(html: string): string;

    public HTML2Md(html: string): string;

    public HTML2BlockDOM(html: string): string;

    public SetUnorderedListMarker(marker: string): void;

    public SetDataTask(marker: boolean): void;

    public SetExportNormalizeTaskListMarker(marker: boolean): void;

    public SetArbitraryTaskListItemMarker(marker: boolean): void;

    public SetEnsureListItemParagraph(enable: boolean): void;
}

declare const webkitAudioContext: {
    prototype: AudioContext
    new(contextOptions?: AudioContextOptions): AudioContext,
};

/** @link https://ld246.com/article/1549638745630#options-upload */
interface IUpload {
    /** 上传文件最大 Byte */
    max?: number;
    /** 文件上传类型，同 [input accept](https://www.w3schools.com/tags/att_input_accept.asp) */
    accept?: string;
    /** 额外请求参数 */
    extraData?: { [key: string]: string | Blob };
    /** 上传字段名。默认值：file[] */
    fieldName?: string;

    /** 上传成功回调 */
    success?(editor: HTMLDivElement, msg: string): void;

    /** 上传失败回调 */
    error?(msg: string): void;

    /** 文件名安全处理。 默认值: name => name.replace(/\W/g, '') */
    filename?(name: string): string;

    /** 校验，成功时返回 true 否则返回错误信息 */
    validate?(files: File[]): string | boolean;

    /** 对服务端返回的数据进行转换，以满足内置的数据结构 */
    format?(files: File[], responseText: string): string;

    /** 将上传的文件处理后再返回  */
    file?(files: File[]): File[];

}

interface IScrollAttr {
    rootId: string,
    startId?: string,
    endId?: string
    scrollTop?: number,
    focusId?: string,
    focusStart?: number
    focusEnd?: number
    zoomInId?: string
}

/** @link https://ld246.com/article/1549638745630#options-toolbar */
interface IMenuItem {
    /** 唯一标示 */
    name: string;
    /** 提示 */
    tip?: string;
    /** 语言 key */
    lang?: string;
    /** svg 图标 */
    icon?: string;
    /** 快捷键 */
    hotkey?: string;
    /** 提示的位置 */
    tipPosition?: string;

    click?(protyle: import("../protyle").Protyle): void;
}

/** @link https://ld246.com/article/1549638745630#options-preview-markdown */
interface IMarkdownConfig {
    /** 段落开头是否空两格。默认值: false */
    paragraphBeginningSpace?: boolean;
    /** 是否启用过滤 XSS。默认值: true */
    sanitize?: boolean;
    /** 为列表添加标记，以便[自定义列表样式](https://github.com/Vanessa219/vditor/issues/390) 默认值：false */
    listStyle?: boolean;
}

/** @link https://ld246.com/article/1549638745630#options-preview */
interface IPreview {
    /** 预览 debounce 毫秒间隔。默认值: 1000 */
    delay?: number;
    /** 显示模式。默认值: 'both' */
    mode?: "both" | "editor";
    /** md 解析请求 */
    url?: string;
    /** @link https://ld246.com/article/1549638745630#options-preview-markdown */
    markdown?: IMarkdownConfig;
    /** @link https://ld246.com/article/1549638745630#options-preview-actions  */
    actions?: Array<IPreviewAction | IPreviewActionCustom>;

    /** 渲染之前回调 */
    transform?(html: string): string;
}

type IPreviewAction = "desktop" | "tablet" | "mobile" | "mp-wechat" | "zhihu" | "yuque";

interface IPreviewActionCustom {
    /** 键名 */
    key: string;
    /** 按钮文本 */
    text: string;
    /** 按钮 className 值 */
    className?: string;
    /** 点击回调 */
    click: (key: string) => void;
}

interface IHintData {
    avBlockTarget?: string;
    id?: string;
    html: string;
    value: string;
    filter?: string[];
    focus?: boolean;
}

interface IHintExtend {
    key: string;

    hint?(value: string, protyle: IProtyle, source: THintSource): IHintData[];
}

/** @link https://ld246.com/article/1549638745630#options-hint */
interface IHint {
    /** 常用表情提示 HTML */
    emojiTail?: string;
    /** 提示 debounce 毫秒间隔。默认值: 200 */
    delay?: number;
    /** 默认表情，可从 [lute/emoji_map](https://github.com/88250/lute/blob/master/parse/emoji_map.go#L32) 中选取，也可自定义 */
    emoji?: IObject;
    emojiPath?: string;
    extend?: IHintExtend[];
}

/** @link https://ld246.com/article/1549638745630#options */
interface IProtyleOptions {
    history?: {
        created?: string
        snapshot?: string
    },
    backlinkData?: {
        blockPaths: IBreadcrumb[],
        dom: string
        expand: boolean
    }[],
    action?: TProtyleAction[],
    scrollPosition?: ScrollLogicalPosition,
    mode?: TEditorMode,
    blockId?: string
    rootId?: string
    notebookId?: string
    originalRefBlockIDs?: IObject
    key?: string
    defIds?: string[]
    render?: {
        background?: boolean
        title?: boolean
        titleShowTop?: boolean
        gutter?: boolean
        scroll?: boolean
        breadcrumb?: boolean
        breadcrumbDocName?: boolean
        hideTitleOnZoom?: boolean
    }
    /** 内部调试时使用 */
    _lutePath?: string;
    /** 是否启用打字机模式。默认值: false */
    typewriterMode?: boolean;
    toolbar?: Array<string | IMenuItem>;
    /** @link https://ld246.com/article/1549638745630#options-preview */
    preview?: IPreview;
    /** @link https://ld246.com/article/1549638745630#options-hint */
    hint?: IHint;
    /** @link https://ld246.com/article/1549638745630#options-upload */
    upload?: IUpload;
    /** @link https://ld246.com/article/1549638745630#options-classes */
    classes?: {
        preview?: string;
    };
    click?: {
        /** 点击末尾是否阻止插入新块 */
        preventInsetEmptyBlock?: boolean
    }

    handleEmptyContent?(): void

    /** 编辑器异步渲染完成后的回调方法 */
    after?(protyle: import("../protyle").Protyle): void;

    /** 精简版本 */
    lite?: boolean;
}

/** Options.merge 负责补齐默认值，下游编辑器直接消费该完整合同。 */
type IResolvedProtyleOptions = IProtyleOptions & {
    action: TProtyleAction[];
};

type TProtylePluginPort = import("../../../enterprise/packages/protyle-browser/src/contracts").ProtylePluginPort<
    IProtyleOptions | undefined,
    Array<string | IMenuItem>,
    IProtyle
>;

type TProtyleEditorRegistry = import("../../../enterprise/packages/protyle-browser/src/contracts").ProtyleEditorRegistry<IProtyle>;

type TProtyleRuntime = import("../../../enterprise/packages/protyle-browser/src/contracts").ProtyleRuntime<
    IProtyle,
    IProtyleOptions | undefined,
    Array<string | IMenuItem>,
    IWebSocketData,
    import("../../../enterprise/packages/protyle-browser/src/contracts").ProtyleMenuSurface,
    HTMLElement
>;

/** Core 入口保留 Factory 的 Runtime 泛型；具体能力由 bound Session 的唯一实例提供。 */
type TProtyleSession = import("../../../enterprise/packages/protyle-browser/src/contracts").ProtyleSession<any>;

type TProtyleSubscription = import("../../../enterprise/packages/protyle-browser/src/contracts").ProtyleSubscription;

type TProtyleApplicationSettingsPort = import("../../../enterprise/packages/protyle-browser/src/contracts").ProtyleApplicationSettings;

type TProtyleLocalizationPort = import("../../../enterprise/packages/protyle-browser/src/contracts").ProtyleLocalizationPort;

/**
 * Protyle 仍需的最小应用边界。内容运行时能力由 bound Session 提供；该端口只承接未迁移的
 * local-only 表面以及编辑器显示设置，不代表完整的旧 App。
 */
type ProtyleApplicationPort = import("../../../enterprise/packages/protyle-browser/src/contracts").ProtyleApplicationPort<
    IProtyleOptions | undefined,
    Array<string | IMenuItem>,
    IProtyle
>;

/** 旧壳调用点的结构化过渡类型；缺少新设置时由 Core 显式拒绝，不回退到全局状态。 */
type TProtyleLegacyApplicationPort = {
    readonly localization: TProtyleLocalizationPort;
    readonly protyleEditors: TProtyleEditorRegistry;
    readonly protyleHost: TProtyleHostPort;
    readonly protylePlugins: TProtylePluginPort;
};

type TProtyleHostPort = import("../../../enterprise/packages/protyle-browser/src/contracts").ProtyleHostPort;

type TProtyleEditorHostPort = import("../../../enterprise/packages/protyle-browser/src/contracts").ProtyleEditorHostPort;

type TProtyleSurface = import("../../../enterprise/packages/protyle-browser/src/contracts").ProtyleSurface;

type TProtyleParticipation = import("../../../enterprise/packages/protyle-browser/src/contracts").ProtyleParticipation;

type TProtyleReadOnlyState = import("../protyle/runtime/readOnly").ProtyleReadOnlyState;

type TProtyleBoundContent = import("../../../enterprise/packages/protyle-browser/src/contracts").ProtyleBoundContent;

type TProtyleLocalOnlyContent = import("../../../enterprise/packages/protyle-browser/src/contracts").ProtyleLocalOnlyContent;

type TProtyleBoundLifecycle = {
    surface: TProtyleSurface,
    participation: TProtyleParticipation,
    content: TProtyleBoundContent,
    initialLoad: "automatic" | "owner",
    session: TProtyleSession,
    hostReadOnly: boolean,
    signal?: AbortSignal,
    onBacklinkChange?: () => void,
};

/** 旧构造点只用于迁移期类型检查；bound 实例没有 Session 时会在 Core 边界显式失败。 */
type TProtyleLegacyBoundLifecycle = Omit<TProtyleBoundLifecycle, "session"> & {
    session?: never,
};

type TProtyleLocalOnlyLifecycle = {
    surface: "embedded",
    participation: "detached",
    content: TProtyleLocalOnlyContent,
};

interface IProtyle {
    highlight: {
        mark: Highlight
        markHL: Highlight
        ranges: Range[]
        rangeIndex: number
        styleElement: HTMLStyleElement
    }
    getInstance: () => import("../protyle").Protyle,
    /** Registry entries own the same lifecycle surface as the public Core controller. */
    destroy: () => void,
    focus: () => void,
    setHostReadOnly: (readOnly: boolean) => void,
    observerLoad?: ResizeObserver,
    observer?: ResizeObserver,
    uiEventController?: AbortController,
    ownerSignal?: AbortSignal,
    requestSignal: AbortSignal,
    readonlyState: TProtyleReadOnlyState,
    /** 旧调用方的类型视图；新的内容能力必须从 session/runtime 读取。 */
    app: import("../index").App,
    application: ProtyleApplicationPort | TProtyleLegacyApplicationPort,
    localization: TProtyleLocalizationPort,
    settings: TProtyleApplicationSettingsPort,
    editors: TProtyleEditorRegistry,
    host: TProtyleEditorHostPort,
    plugins: TProtylePluginPort,
    runtime?: TProtyleRuntime,
    session?: TProtyleSession,
    transport?: import("../../../enterprise/packages/protyle-browser/src/contracts").ProtyleTransport<IWebSocketData>,
    surface: TProtyleSurface,
    participation: TProtyleParticipation,
    content: TProtyleBoundContent | TProtyleLocalOnlyContent,
    id: string,
    destroyed?: boolean,
    query?: {
        key: string,
        method: number
        types: Config.IUILayoutTabSearchConfigTypes
        subTypes: Config.IUILayoutTabSearchConfigSubTypes
    },
    block: {
        id?: string,
        scroll?: boolean
        parentID?: string,
        parent2ID?: string,
        rootID?: string,
        showAll?: boolean
        mode?: number
        blockCount?: number
        action?: TProtyleAction[]
    },
    disabled: boolean,
    lite?: boolean,
    selectElement?: HTMLElement,
    readonly notebookId: string
    path?: string
    model?: import("../../src/editor").Editor,
    updated: boolean;
    element: HTMLElement;
    scroll?: import("../protyle/scroll").Scroll,
    gutter?: import("../protyle/gutter").Gutter,
    breadcrumb?: import("../protyle/breadcrumb").Breadcrumb,
    title?: import("../protyle/header/Title").Title,
    background?: import("../protyle/header/Background").Background,
    contentElement?: HTMLElement,
    options: IResolvedProtyleOptions;
    lute?: Lute;
    toolbar?: import("../protyle/toolbar").Toolbar,
    preview?: import("../protyle/preview").Preview;
    hint?: import("../protyle/hint").Hint;
    upload?: import("../protyle/upload").Upload;
    undo?: import("../protyle/undo").IUndo;
    wysiwyg?: import("../protyle/wysiwyg").WYSIWYG
}
