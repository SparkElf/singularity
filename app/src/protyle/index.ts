import {Constants} from "../constants";
import {Hint} from "./hint";
import {getLute} from "./render/setLute";
import {resolveProtyleEmojiPath} from "./util/emojiPath";
import {Preview} from "./preview";
import {addLoading, initUI, removeLoading} from "./ui/initUI";
import {LocalUndo, Undo} from "./undo";
import {Upload} from "./upload";
import {Options} from "./util/Options";
import {destroy} from "./util/destroy";
import {Scroll} from "./scroll";
import {genUUID} from "../util/genID";
import {WYSIWYG} from "./wysiwyg";
import {Toolbar} from "./toolbar";
import {Gutter} from "./gutter";
import {Breadcrumb} from "./breadcrumb";
import {
    onTransaction,
    transaction,
    turnsIntoOneTransaction,
    turnsIntoTransaction,
    updateBatchTransaction,
    updateTransaction
} from "./wysiwyg/transaction";
import {getProtyleDocumentDisplayName} from "./runtime/displayName";
import {initMirror, refreshUndoButtons, syncMirrorFromBroadcast} from "./undo/globalUndo";
import {Title} from "./header/Title";
import {Background} from "./header/Background";
import {disabledProtyle, enableProtyle, onGet, setReadonlyByConfig} from "./util/onGet";
import {reloadProtyle} from "./util/reload";
import {renderBacklink} from "./wysiwyg/renderBacklink";
import {resize} from "./util/resize";
import {getDocByScroll} from "./scroll/saveScroll";
import {insertHTML} from "./util/insertHTML";
import {avRender} from "./render/av/render";
import {focusBlock, getEditorRange} from "./util/selection";
import {hasClosestBlock} from "./util/hasClosest";
import {isSupportCSSHL} from "./render/searchMarkRender";
import {renderAVAttribute} from "./render/av/blockAttr";
import {setFoldById} from "./util/blockFold";
import {zoomOut} from "./util/zoom";
import {setEditMode} from "./util/setEditMode";
import {beginProtyleContentLoad, protyleContentIdentity, requestProtyleContent} from "./util/contentLoad";
import {createProtyleReadOnlyState, isProtyleReadOnly, setHostReadOnly} from "./runtime/readOnly";

type ProtyleTransactionsMessage = IWebSocketData & {
    cmd: "transactions";
    data: Array<{ doOperations: IOperation[] }>;
    sid: string;
};

const dispatchWorkspaceOutlineRefresh = (protyle: IProtyle) => {
    if (protyle.surface !== "workspace") {
        return;
    }
    protyle.host.dispatch({
        type: "refresh-outline",
        notebookId: protyle.notebookId,
        documentId: protyle.block.rootID,
    });
};

const dispatchWorkspaceActivation = (protyle: IProtyle) => {
    if (protyle.surface === "workspace") {
        protyle.host.dispatch({
            type: "activate-document",
            notebookId: protyle.notebookId,
            documentId: protyle.block.rootID,
        });
    }
};

export class Protyle {

    public readonly version: string;
    public protyle: IProtyle;
    private contentOwnerMouseover?: (event: MouseEvent & { contentNotebookId?: string }) => void;
    private onBacklinkChange?: () => void;
    private subscription?: TProtyleSubscription;
    private readonly requestController = new AbortController();
    private removeOwnerAbortListener?: () => void;
    private disposed = false;
    private readonly session?: TProtyleSession;
    private readonly settings: TProtyleApplicationSettingsPort;

    /**
     * @param id 要挂载 Protyle 的元素或者元素 ID。
     * @param options Protyle 参数
     */
    constructor(application: ProtyleApplicationPort | TProtyleLegacyApplicationPort, id: HTMLElement,
                options: Omit<IProtyleOptions, "notebookId"> & { blockId: string },
                lifecycle: (TProtyleBoundLifecycle | TProtyleLegacyBoundLifecycle) & { participation: "live" });
    constructor(application: ProtyleApplicationPort | TProtyleLegacyApplicationPort, id: HTMLElement,
                options: Omit<IProtyleOptions, "notebookId"> & { blockId: string },
                lifecycle: (TProtyleBoundLifecycle | TProtyleLegacyBoundLifecycle) & { participation: "detached" });
    constructor(application: ProtyleApplicationPort | TProtyleLegacyApplicationPort, id: HTMLElement,
                options: Omit<IProtyleOptions, "blockId" | "notebookId"> & { blockId?: never },
                lifecycle: TProtyleLocalOnlyLifecycle);
    constructor(application: ProtyleApplicationPort | TProtyleLegacyApplicationPort, id: HTMLElement,
                options: Omit<IProtyleOptions, "notebookId">,
                lifecycle: TProtyleBoundLifecycle | TProtyleLegacyBoundLifecycle | TProtyleLocalOnlyLifecycle) {
        this.version = Constants.SIYUAN_VERSION;
        this.onBacklinkChange = "onBacklinkChange" in lifecycle ? lifecycle.onBacklinkChange : undefined;
        if (!("settings" in application) || !application.settings) {
            throw new Error("[protyle.application] Core requires explicit application settings");
        }
        this.settings = application.settings;
        let runtime: TProtyleRuntime | undefined;
        let editors: TProtyleEditorRegistry;
        let hostPort: TProtyleHostPort;
        let plugins: TProtylePluginPort;
        if (lifecycle.content.mode === "bound") {
            const session = "session" in lifecycle ? lifecycle.session : undefined;
            if (!session) {
                throw new Error("[protyle.runtime] bound Core requires a ProtyleSession");
            }
            this.session = session;
            runtime = this.session.runtime;
            editors = runtime.editors;
            hostPort = runtime.host;
            plugins = runtime.plugins;
        } else {
            this.session = undefined;
            if (!application.protyleEditors || !application.protyleHost || !application.protylePlugins) {
                throw new Error("[protyle.application] local-only Core requires explicit local capabilities");
            }
            editors = application.protyleEditors;
            hostPort = application.protyleHost;
            plugins = application.protylePlugins;
        }
        if (lifecycle.content.mode === "bound") {
            if (!lifecycle.content.notebookId) {
                throw new Error("[protyle.content] bound Protyle requires a notebookId");
            }
            if (!options.blockId) {
                throw new Error("[protyle.content] bound Protyle requires a blockId");
            }
        } else if (options.blockId) {
            throw new Error("[protyle.content] local-only Protyle cannot bind a blockId");
        }
        const pluginsOptions = plugins.extendOptions(options);
        const getOptions = new Options(pluginsOptions, this.settings);
        const mergedOptions = getOptions.merge();
        const host: TProtyleEditorHostPort = {
            dispatch: (event) => {
                if (lifecycle.content.mode === "local-only") {
                    if (event.type === "open-search" || event.type === "open-external" ||
                        event.type === "notify" || (event.type === "open-graph" && event.scope === "space")) {
                        hostPort.dispatch({...event, sourceEditorId: this.protyle.id});
                        return;
                    }
                    throw new Error(`[protyle.content] local-only Protyle cannot dispatch ${event.type}`);
                }
                if (lifecycle.surface === "embedded" && [
                    "close-document",
                    "refresh-outline",
                    "refresh-backlinks",
                    "set-document-title",
                    "set-document-icon",
                    "activate-document",
                    "toggle-document-fullscreen",
                    "persist-workspace-layout",
                    "update-document-statistics",
                ].includes(event.type)) {
                    throw new Error(`[protyle.surface] embedded Protyle cannot dispatch ${event.type}`);
                }
                hostPort.dispatch({...event, sourceEditorId: this.protyle.id});
            },
        };
        this.protyle = {
            getInstance: () => this,
            destroy: () => this.destroy(),
            focus: () => this.focus(),
            navigateDocument: (navigation) => this.navigateDocument(navigation),
            setHostReadOnly: (readOnly) => this.setHostReadOnly(readOnly),
            // 旧下游仍读取 app；新的内容能力不从该视图取得。
            app: application as unknown as IProtyle["app"],
            application,
            localization: application.localization,
            settings: this.settings,
            editors,
            host,
            plugins,
            runtime,
            session: this.session,
            transport: runtime?.transport,
            surface: lifecycle.surface,
            participation: lifecycle.participation,
            content: lifecycle.content,
            ownerSignal: "signal" in lifecycle ? lifecycle.signal : undefined,
            requestSignal: this.requestController.signal,
            readonlyState: createProtyleReadOnlyState(
                "hostReadOnly" in lifecycle ? lifecycle.hostReadOnly : false,
                this.settings.editor.readOnly,
            ),
            id: genUUID(),
            disabled: false,
            lite: !!options.lite,
            updated: false,
            element: id,
            get notebookId() {
                if (lifecycle.content.mode === "local-only") {
                    throw new Error("[protyle.content] local-only Protyle has no notebookId");
                }
                return lifecycle.content.notebookId;
            },
            options: mergedOptions,
            block: {},
            highlight: {
                mark: isSupportCSSHL() ? new Highlight() : undefined,
                markHL: isSupportCSSHL() ? new Highlight() : undefined,
                ranges: [],
                rangeIndex: 0,
                styleElement: document.createElement("style"),
            }
        };
        const ownerSignal = "signal" in lifecycle ? lifecycle.signal : undefined;
        if (ownerSignal) {
            const abortRequests = () => this.requestController.abort();
            if (ownerSignal.aborted) {
                abortRequests();
            } else {
                ownerSignal.addEventListener("abort", abortRequests, {once: true});
                this.removeOwnerAbortListener = () => ownerSignal.removeEventListener("abort", abortRequests);
            }
        }
        this.contentOwnerMouseover = (event) => {
            if (lifecycle.content.mode === "bound" && !event.contentNotebookId) {
                event.contentNotebookId = lifecycle.content.notebookId;
            }
        };
        this.protyle.element.addEventListener("mouseover", this.contentOwnerMouseover);

        if (isSupportCSSHL()) {
            const styleId = genUUID();
            this.protyle.highlight.styleElement.dataset.uuid = styleId;
            this.protyle.highlight.styleElement.textContent = `.protyle-content::highlight(search-mark-${styleId}) {background-color: var(--b3-highlight-background);color: var(--b3-highlight-color);}
  .protyle-content::highlight(search-mark-hl-${styleId}) {color: var(--b3-highlight-color);background-color: var(--b3-highlight-current-background)}`;
        }

        this.protyle.hint = new Hint(this.protyle);
        if (mergedOptions.render.breadcrumb) {
            this.protyle.breadcrumb = new Breadcrumb(this.protyle);
        }
        if (mergedOptions.render.title) {
            this.protyle.title = new Title(this.protyle);
        }
        if (mergedOptions.render.background) {
            this.protyle.background = new Background(this.protyle);
        }

        this.protyle.element.innerHTML = "";
        this.protyle.element.classList.add("protyle");
        // 启用 RTL 时给 .protyle 元素添加 .rtl 类名，方便主题开发者判断 RTL 方向
        if (this.settings.editor.rtl) {
            this.protyle.element.classList.add("rtl");
        }
        if (mergedOptions.render.breadcrumb) {
            this.protyle.element.appendChild(this.protyle.breadcrumb.element.parentElement);
        }
        // lite 模式用前端操作日志 undo（不依赖 kernel），其余走 kernel 的 GlobalUndoLog。
        this.protyle.undo = this.protyle.lite ? new LocalUndo() : new Undo();
        this.protyle.wysiwyg = new WYSIWYG(this.protyle);
        this.protyle.toolbar = new Toolbar(this.protyle);
        this.protyle.scroll = new Scroll(this.protyle); // 不能使用 render.scroll 来判读是否初始化，除非重构后面用到的相关变量
        if (this.protyle.options.render.gutter) {
            this.protyle.gutter = new Gutter(this.protyle);
        }
        if (lifecycle.content.mode === "bound") {
            this.protyle.upload = new Upload();
        }

        this.init();
        this.applyReadOnlyState();
        if (lifecycle.participation === "live") {
            if (!runtime || lifecycle.content.mode !== "bound") {
                throw new Error("[protyle.runtime] live Core requires a bound Session runtime");
            }
            this.protyle.editors.register(this.protyle);
            this.protyle.wysiwyg.element.addEventListener("focusin", () => {
                this.protyle.editors.activate(this.protyle);
            });
            this.subscription = runtime.transport.subscribe({
                notebookId: lifecycle.content.notebookId,
                documentId: options.blockId,
                type: "protyle",
                onMessage: (data) => {
                    if (this.disposed) {
                        return;
                    }
                    switch (data.cmd) {
                        case "reload":
                            if (data.data.rootID === this.protyle.block.rootID) {
                                reloadProtyle(this.protyle, false);
                                dispatchWorkspaceOutlineRefresh(this.protyle);
                            }
                            break;
                        case "refreshAttributeView":
                            if (this.protyle.content.mode !== "bound") {
                                break;
                            }
                            Array.from(this.protyle.wysiwyg.element.querySelectorAll(`.av[data-av-id="${data.data.id}"]`)).forEach((item: HTMLElement) => {
                                item.removeAttribute("data-render");
                                avRender(item, this.protyle);
                            });
                            break;
                        case "addLoading":
                            if (data.data === this.protyle.block.rootID) {
                                addLoading(this.protyle, data.msg);
                            }
                            break;
                        case "unfoldHeading":
                            setFoldById(data.data, this.protyle);
                            break;
                        case "transactions":
                            this.onTransaction(data as ProtyleTransactionsMessage);
                            break;
                        case "readonly":
                            this.settings.editor.setReadOnly(data.data);
                            setReadonlyByConfig(this.protyle, true);
                            break;
                        case "heading2doc":
                        case "li2doc":
                            if (this.protyle.block.rootID === data.data.srcRootBlockID) {
                                if (this.protyle.block.showAll && data.cmd === "heading2doc" && !this.protyle.options.backlinkData) {
                                    const getDocParam: IObject = {
                                        id: this.protyle.block.rootID,
                                        size: this.settings.editor.dynamicLoadBlocks,
                                    };
                                    const load = beginProtyleContentLoad(this.protyle);
                                    void requestProtyleContent<IWebSocketData>(this.protyle, "/api/filetree/getDoc", getDocParam, load)
                                        .then((getResponse) => {
                                            if (load.isCurrent()) {
                                                onGet({data: getResponse, protyle: this.protyle, load});
                                            }
                                        })
                                        .catch((error) => this.reportRequestFailure(error));
                                } else {
                                    reloadProtyle(this.protyle, false);
                                }
                                if (data.cmd === "heading2doc") {
                                    // 文档标题互转后，需更新大纲
                                    dispatchWorkspaceOutlineRefresh(this.protyle);
                                }
                            }
                            break;
                        case "rename":
                            if (this.protyle.path === data.data.path) {
                                if (this.protyle.model) {
                                    this.protyle.model.parent.updateTitle(
                                        getProtyleDocumentDisplayName(data.data.title, data.data.empty),
                                    );
                                }
                                if (this.protyle.background) {
                                    this.protyle.background.ial.title = data.data.title;
                                }
                                if (this.settings.export.addTitle &&
                                    !this.protyle.preview.element.classList.contains("fn__none")) {
                                    this.protyle.preview.render(this.protyle);
                                }
                            }
                            if (this.protyle.options.render.title && this.protyle.block.parentID === data.data.id) {
                                if (!document.body.classList.contains("body--blur") && getSelection().rangeCount > 0 &&
                                    this.protyle.title.editElement?.contains(getSelection().getRangeAt(0).startContainer)) {
                                    // 标题编辑中的不用更新 https://github.com/siyuan-note/siyuan/issues/6565
                                } else {
                                    this.protyle.title.setTitle(data.data.title, data.data.empty);
                                }
                                if (data.data.empty) {
                                    this.protyle.wysiwyg.element.setAttribute(Constants.CUSTOM_SY_TITLE_EMPTY, "true");
                                } else {
                                    this.protyle.wysiwyg.element.removeAttribute(Constants.CUSTOM_SY_TITLE_EMPTY);
                                }
                            }
                            // update ref
                            this.protyle.wysiwyg.element.querySelectorAll(`[data-type~="block-ref"][data-id="${data.data.id}"]`).forEach(item => {
                                if (item.getAttribute("data-subtype") === "d") {
                                    // 同 updateRef 一样处理 https://github.com/siyuan-note/siyuan/issues/10458
                                    item.innerHTML = data.data.refText;
                                }
                            });
                            if (this.protyle.surface === "workspace" &&
                                this.protyle.content.mode === "bound" &&
                                data.data.box === this.protyle.content.notebookId &&
                                data.data.id === this.protyle.options.blockId) {
                                this.protyle.host.dispatch({
                                    type: "set-document-title",
                                    notebookId: data.data.box,
                                    documentId: data.data.id,
                                    title: getProtyleDocumentDisplayName(data.data.title, data.data.empty),
                                });
                            }
                            break;
                        case "moveDoc":
                            if (this.protyle.path === data.data.fromPath) {
                                this.protyle.path = data.data.newPath;
                                const identity = protyleContentIdentity(this.protyle);
                                this.protyle.host.dispatch({
                                    type: "open-document",
                                    notebookId: data.data.toNotebook,
                                    documentId: identity.documentId,
                                    blockId: this.protyle.block.rootID,
                                    disposition: "current",
                                    scope: "target",
                                    attention: "none",
                                    scroll: "auto",
                                    restoreScroll: "never",
                                    zoom: false,
                                });
                            }
                            break;
                        case "closeBox":
                        case "removeBox":
                            if (this.protyle.notebookId === data.data.box) {
                                if (this.protyle.model) {
                                    this.protyle.host.dispatch({
                                        type: "close-document",
                                        notebookId: this.protyle.notebookId,
                                        documentId: this.protyle.block.rootID,
                                        reason: "notebook-closed",
                                    });
                                }
                            }
                            break;
                        case "removeDoc":
                            if (data.data.ids.includes(this.protyle.block.rootID)) {
                                if (this.protyle.model) {
                                    this.protyle.host.dispatch({
                                        type: "close-document",
                                        notebookId: this.protyle.notebookId,
                                        documentId: this.protyle.block.rootID,
                                        reason: "deleted",
                                    });
                                }
                                this.settings.localFilePosition.remove(protyleContentIdentity(this.protyle));
                                this.settings.localFilePosition.persist();
                            }
                            break;
                    }
                }
            });
            if (options.backlinkData) {
                this.protyle.block.rootID = options.blockId;
                renderBacklink(this.protyle, options.backlinkData);
                // 为了满足 eventPath0.style.paddingLeft 从而显示块标 https://github.com/siyuan-note/siyuan/issues/11578
                this.protyle.wysiwyg.element.style.padding = "4px 16px 4px 24px";
                return;
            }
            if (lifecycle.content.mode === "bound" && lifecycle.initialLoad === "owner") {
                removeLoading(this.protyle);
                return;
            }

            if (this.protyle.options.mode !== "preview" &&
                options.rootId && this.settings.localFilePosition.get(protyleContentIdentity(this.protyle)) &&
                (
                    mergedOptions.action.includes(Constants.CB_GET_SCROLL) ||
                    (mergedOptions.action.includes(Constants.CB_GET_ROOTSCROLL) && options.rootId === options.blockId)
                )
            ) {
                getDocByScroll({
                    protyle: this.protyle,
                    scrollAttr: this.settings.localFilePosition.get(protyleContentIdentity(this.protyle)),
                    mergedOptions,
                    signal: lifecycle.signal,
                    isCurrent: () => !this.protyle.destroyed && !lifecycle.signal?.aborted,
                    cb: () => {
                        this.afterOnGet(mergedOptions);
                    }
                });
            } else {
                this.getDoc(mergedOptions, lifecycle.signal);
            }
        } else {
            this.protyle.contentElement.classList.add("protyle-content--transition");
        }
    }

    private request<TResponse>(path: string, body: unknown): Promise<TResponse> {
        if (!this.session || this.protyle.content.mode !== "bound") {
            return Promise.reject(new Error("[protyle.runtime] content request requires a bound Session"));
        }
        return this.session.runtime.transport.request(path, body, {
            identity: {
                notebookId: this.protyle.content.notebookId,
                documentId: this.protyle.options.blockId,
            },
            intent: "read",
            signal: this.requestController.signal,
        }) as Promise<TResponse>;
    }

    private reportRequestFailure(error: unknown) {
        if (this.requestController.signal.aborted) {
            return;
        }
        console.error("[protyle.transport] content request failed", error);
    }

    private applyReadOnlyState() {
        if (isProtyleReadOnly(this.protyle.readonlyState)) {
            disabledProtyle(this.protyle);
        } else {
            enableProtyle(this.protyle);
        }
    }

    public setHostReadOnly(readOnly: boolean) {
        setHostReadOnly(this.protyle.readonlyState, readOnly);
        this.applyReadOnlyState();
    }

    public async navigateDocument(navigation: TProtyleDocumentNavigation): Promise<void> {
        const action: TProtyleAction[] = [];
        if (navigation.scope === "context") {
            action.push(Constants.CB_GET_CONTEXT);
        }
        if (navigation.zoom) {
            action.push(Constants.CB_GET_ALL);
        }
        if (navigation.attention === "focus" || navigation.attention === "focus-and-highlight") {
            action.push(Constants.CB_GET_FOCUS);
        }
        if (navigation.attention === "highlight" || navigation.attention === "focus-and-highlight") {
            action.push(Constants.CB_GET_HL);
        }
        if (navigation.restoreScroll === "always") {
            action.push(Constants.CB_GET_SCROLL);
        } else if (navigation.restoreScroll === "if-document") {
            action.push(Constants.CB_GET_ROOTSCROLL);
        }

        const restoresDocumentPosition = navigation.restoreScroll === "always" ||
            (navigation.restoreScroll === "if-document" && navigation.blockId === navigation.documentId);
        const scrollAttr = restoresDocumentPosition
            ? this.settings.localFilePosition.get({
                notebookId: navigation.notebookId,
                documentId: navigation.documentId,
            })
            : undefined;
        const restoredZoomId = scrollAttr?.zoomInId && scrollAttr.zoomInId !== scrollAttr.rootId
            ? scrollAttr.zoomInId
            : undefined;
        if (restoredZoomId && !action.includes(Constants.CB_GET_ALL)) {
            action.push(Constants.CB_GET_ALL);
        }

        let requestBody: Record<string, unknown>;
        if (restoredZoomId) {
            requestBody = {
                id: restoredZoomId,
                size: Constants.SIZE_GET_MAX,
            };
        } else if (scrollAttr) {
            requestBody = {
                id: scrollAttr.rootId,
                startID: scrollAttr.startId,
                endID: scrollAttr.endId,
            };
        } else {
            requestBody = {
                id: navigation.blockId,
                mode: navigation.scope === "context" ? 3 : 0,
                size: navigation.zoom || navigation.scope === "subtree"
                    ? Constants.SIZE_GET_MAX
                    : this.settings.editor.dynamicLoadBlocks,
            };
        }

        const load = beginProtyleContentLoad(this.protyle);
        try {
            const response = await requestProtyleContent<IWebSocketData>(
                this.protyle,
                "/api/filetree/getDoc",
                requestBody,
                load,
            );
            if (!load.isCurrent()) {
                return;
            }
            onGet({
                action,
                data: response,
                load,
                protyle: this.protyle,
                scrollAttr,
                scrollPosition: navigation.scroll === "start" ? "start" : undefined,
            });
        } catch (error) {
            if (!load.isCurrent()) {
                return;
            }
            removeLoading(this.protyle);
            throw error;
        }
    }

    private onTransaction(data: ProtyleTransactionsMessage) {
        // Transport 已按当前 notebookId + documentId 建立订阅，消息合同不再从全局内容库推断。
        const transactions = data.data;
        if (transactions.length === 0) {
            return;
        }
        // 多窗口/多端：用广播附带的撤销状态同步本地镜像
        if (data.context?.undoState) {
            syncMirrorFromBroadcast(this.protyle.notebookId, data.context.undoState);
        }
        if (!this.protyle.preview.element.classList.contains("fn__none") &&
            data.context?.rootIDs?.includes(this.protyle.block.rootID)) {
            this.protyle.preview.render(this.protyle);
            return;
        }
        let needCreateAction = "";
        let hasDeleteOp = false;
        transactions.forEach((transaction: { doOperations: IOperation[] }) => {
            transaction.doOperations.find((item: IOperation) => {
                if (this.protyle.options.backlinkData && ["delete", "move"].includes(item.action)) {
                    // 只对特定情况刷新，否则展开、编辑等操作刷新会频繁
                    if (2 == transaction.doOperations.length && "insert" === transaction.doOperations[0].action &&
                        "delete" === transaction.doOperations[1].action) {
                        // 从反链面板复制块到正文粘贴时不再自动刷新反链面板
                        // The list in the backlink panel no longer collapses automatically https://github.com/siyuan-note/siyuan/issues/17362
                        return true;
                    }

                    this.onBacklinkChange?.();
                    return true;
                } else {
                    if (item.action === "delete") {
                        hasDeleteOp = true;
                    }
                    onTransaction(this.protyle, [item], false, data.sid);
                    // 反链面板移除元素后，文档为空
                    if (!(item.action === "delete" && typeof item.data?.createEmptyParagraph === "boolean" &&
                        !item.data.createEmptyParagraph)) {
                        needCreateAction = item.action;
                    }
                }
            });
        });
        // 聚焦块被分屏另一侧的删除操作连带删除时（容器块删除会级联删除其所有子孙块，如列表/超级块/引述等），当前页签的聚焦块已成为孤儿但仍显示，需退出聚焦
        // Improve editor state synchronization when deleting blocks https://github.com/siyuan-note/siyuan/issues/17742
        if (this.protyle.block.showAll && hasDeleteOp) {
            void this.request<IWebSocketData>("/api/block/checkBlockExist", {
                id: this.protyle.block.id,
            }).then((response) => {
                if (!response.data) {
                    zoomOut({
                        protyle: this.protyle,
                        id: this.protyle.block.rootID
                    });
                }
            }).catch((error) => this.reportRequestFailure(error));
            return;
        }
        if (this.protyle.wysiwyg.element.childElementCount === 0 && this.protyle.block.parentID && needCreateAction) {
            if (needCreateAction === "delete" && this.protyle.block.showAll) {
                if (this.protyle.options.handleEmptyContent) {
                    this.protyle.options.handleEmptyContent();
                } else {
                    zoomOut({
                        protyle: this.protyle,
                        id: this.protyle.block.rootID,
                        focusId: this.protyle.block.id
                    });
                }
            } else {
                // 不能使用 transaction，否则分屏后会重复添加
                refreshUndoButtons(this.protyle);
                this.reload(false);
            }
        }
        // undo/redo 重放广播到达后，整批操作已应用，重置 lastHTMLs 防下次本地编辑算错逆操作
        if (data.context?.isUndoReplay === true) {
            this.protyle.wysiwyg.lastHTMLs = {};
        }
    }

    private getDoc(mergedOptions: IResolvedProtyleOptions, signal?: AbortSignal) {
        const getDocParam: Record<string, any> = {
            id: mergedOptions.blockId,
            isBacklink: mergedOptions.action.includes(Constants.CB_GET_BACKLINK),
            originalRefBlockIDs: mergedOptions.originalRefBlockIDs,
            // 0: 仅当前 ID（默认值），1：向上 2：向下，3：上下都加载，4：加载最后
            mode: mergedOptions.action.includes(Constants.CB_GET_CONTEXT) ? 3 : 0,
            size: mergedOptions.action.includes(Constants.CB_GET_ALL) ? Constants.SIZE_GET_MAX : this.settings.editor.dynamicLoadBlocks,
        };
        const load = beginProtyleContentLoad(this.protyle);
        void requestProtyleContent<IWebSocketData>(this.protyle, "/api/filetree/getDoc", getDocParam, load)
            .then((getResponse) => {
                if (!load.isCurrent() || signal?.aborted) {
                    return;
                }
                onGet({
                    data: getResponse,
                    protyle: this.protyle,
                    action: mergedOptions.action,
                    scrollPosition: mergedOptions.scrollPosition,
                    afterCB: () => {
                        this.afterOnGet(mergedOptions);
                    },
                    load,
                });
            }).catch((error) => this.reportRequestFailure(error));
    }

    private afterOnGet(mergedOptions: IResolvedProtyleOptions) {
        // 文档加载完成后初始化撤销镜像（低频，不在 selectionchange 热路径）
        if (this.protyle.block?.rootID) {
            initMirror(this.protyle);
        }
        dispatchWorkspaceActivation(this.protyle);
        resize(this.protyle);   // 需等待 fullwidth 获取后设定完毕再重新计算 padding 和元素
        // 需等待 getDoc 完成后再绑定焦点同步，否则无页签时会重复刷新工作台面板
        // 只能用 focusin，否则点击表格无法执行
        this.protyle.wysiwyg.element.addEventListener("focusin", () => {
            dispatchWorkspaceActivation(this.protyle);
        });
        // 需等渲染完后再回调，用于定位搜索字段 https://github.com/siyuan-note/siyuan/issues/3171
        if (mergedOptions.after) {
            mergedOptions.after(this);
        }
        this.protyle.contentElement.classList.add("protyle-content--transition");
    }

    private init() {
        this.protyle.lute = getLute({
            emojis: this.protyle.options.hint.emoji,
            headingAnchor: false,
            listStyle: this.protyle.options.preview.markdown.listStyle,
            paragraphBeginningSpace: this.protyle.options.preview.markdown.paragraphBeginningSpace,
            resolveEmojiPath: (path) => resolveProtyleEmojiPath(this.protyle, path),
            sanitize: this.protyle.options.preview.markdown.sanitize,
        }, this.settings);

        this.protyle.preview = new Preview(this.protyle);

        initUI(this.protyle);
    }

    /** 聚焦到编辑器 */
    public focus() {
        this.protyle.wysiwyg.element.focus();
    }

    /** 上传是否还在进行中 */
    public isUploading() {
        return this.protyle.upload.isUploading;
    }

    /** 清空 undo & redo 栈 */
    public clearStack() {
        this.protyle.undo.clear();
    }

    /** 销毁编辑器 */
    public destroy() {
        if (this.disposed) {
            return;
        }
        this.disposed = true;
        this.requestController.abort();
        this.removeOwnerAbortListener?.();
        this.removeOwnerAbortListener = undefined;
        this.subscription?.disconnect();
        this.subscription = undefined;
        this.protyle.element.removeEventListener("mouseover", this.contentOwnerMouseover);
        destroy(this.protyle);
    }

    public resize() {
        resize(this.protyle);
    }

    public reload(focus: boolean, updateReadonly?: boolean) {
        reloadProtyle(this.protyle, focus, updateReadonly);
    }

    public insert(html: string, isBlock = false, useProtyleRange = false) {
        insertHTML(html, this.protyle, isBlock, useProtyleRange);
    }

    public transaction(doOperations: IOperation[], undoOperations?: IOperation[]) {
        transaction(this.protyle, doOperations, undoOperations);
    }

    /**
     * 多个块转换为一个块
     * @param {TTurnIntoOneSub} [subType] type 为 "BlocksMergeSuperBlock" 时必传
     */
    public turnIntoOneTransaction(selectsElement: Element[], type: TTurnIntoOne, subType?: TTurnIntoOneSub) {
        turnsIntoOneTransaction({
            protyle: this.protyle,
            selectsElement,
            type,
            level: subType
        });
    }

    /**
     * 多个块转换
     * @param {Element} [nodeElement] 优先使用包含 protyle-wysiwyg--select 的块，否则使用 nodeElement 单块
     * @param {number} [subType] type 为 "Blocks2Hs" 时必传
     */
    public turnIntoTransaction(nodeElement: Element, type: TTurnInto, subType?: number) {
        turnsIntoTransaction({
            protyle: this.protyle,
            nodeElement,
            type,
            level: subType,
        });
    }

    /**
     * @deprecated 将在 3.7.1 版本中移除。请改用 {@link updateTransactionElement}。
     */
    public updateTransaction(id: string, newHTML: string, html: string) {
        const element = document.createElement("template");
        element.innerHTML = newHTML;
        updateTransaction(this.protyle, element.content.firstElementChild, html);
    }

    public updateTransactionElement(element: Element, oldHTML: string) {
        updateTransaction(this.protyle, element, oldHTML);
    }

    public updateBatchTransaction(nodeElements: Element[], cb: (e: HTMLElement) => void) {
        updateBatchTransaction(nodeElements, this.protyle, cb);
    }

    public getRange(element: Element) {
        return getEditorRange(element);
    }

    public hasClosestBlock(element: Node) {
        return hasClosestBlock(element);
    }

    public focusBlock(element: Element, toStart = true) {
        return focusBlock(element, undefined, toStart);
    }

    public disable() {
        disabledProtyle(this.protyle);
    }

    public enable() {
        enableProtyle(this.protyle);
    }

    public renderAVAttribute(
        element: HTMLElement,
        id: string,
        cb?: (element: HTMLElement) => void,
        onEmpty?: () => void,
    ) {
        renderAVAttribute(element, id, this.protyle, cb, onEmpty);
    }

    public switchMode(mode: TEditorMode) {
        setEditMode(this.protyle, mode);
    }
}
