import {hasClosestBlock} from "../util/hasClosest";
import {getSelectionOffset} from "../util/selection";
import {onGet} from "../util/onGet";
import {Constants} from "../../constants";
import {isSupportCSSHL} from "../render/searchMarkRender";
import {removeLoading} from "../ui/initUI";
import {
    beginProtyleContentLoad,
    protyleContentIdentity,
    requestProtyleContent,
    type ProtyleContentLoad,
} from "../util/contentLoad";

export const saveScroll = (protyle: IProtyle, getObject = false) => {
    if (!protyle.wysiwyg.element.firstElementChild) {
        // 报错或者空白页面
        return undefined;
    }
    const attr: IScrollAttr = {
        rootId: protyle.block.rootID,
        startId: protyle.wysiwyg.element.firstElementChild.getAttribute("data-node-id"),
        endId: protyle.wysiwyg.element.lastElementChild.getAttribute("data-node-id"),
        scrollTop: protyle.contentElement.scrollTop || parseInt(protyle.contentElement.getAttribute("data-scrolltop")) || 0,
    };
    let range: Range;
    if (getSelection().rangeCount > 0) {
        range = getSelection().getRangeAt(0);
    }
    // 光标位于文档标题时用文档 id 作为焦点标识 https://github.com/siyuan-note/siyuan/issues/17456
    if (range && protyle.title?.editElement?.contains(range.startContainer)) {
        const position = getSelectionOffset(protyle.title.editElement, undefined, range);
        attr.focusId = protyle.block.rootID;
        attr.focusStart = position.start;
        attr.focusEnd = position.end;
    } else {
        if (!range || !protyle.wysiwyg.element.contains(range.startContainer)) {
            range = protyle.toolbar.range;
        }
        if (range && protyle.wysiwyg.element.contains(range.startContainer)) {
            const blockElement = hasClosestBlock(range.startContainer);
            if (blockElement) {
                const position = getSelectionOffset(blockElement, undefined, range);
                attr.focusId = blockElement.getAttribute("data-node-id");
                attr.focusStart = position.start;
                attr.focusEnd = position.end;
            }
        }
    }

    if (protyle.block.showAll) {
        attr.zoomInId = protyle.block.id;
    }
    if (getObject) {
        return attr;
    }

    protyle.settings.localFilePosition.set(protyleContentIdentity(protyle), attr);
    protyle.settings.localFilePosition.persist();
    return Promise.resolve(true);
};

export const getDocByScroll = (options: {
    protyle: IProtyle,
    scrollAttr?: IScrollAttr,
    mergedOptions?: IResolvedProtyleOptions,
    cb?: (keys: string[]) => void
    focus?: boolean,
    updateReadonly?: boolean,
    signal?: AbortSignal,
    isCurrent?: () => boolean,
    load?: ProtyleContentLoad,
}) => {
    const load = options.load ?? beginProtyleContentLoad(options.protyle, options.signal);
    const isCurrent = () => load.isCurrent() && options.isCurrent?.() !== false;
    let actions: TProtyleAction[] = [];
    if (options.mergedOptions) {
        actions = options.mergedOptions.action;
    } else {
        if (options.focus) {
            actions = [Constants.CB_GET_UNUNDO, Constants.CB_GET_FOCUS];
        } else {
            actions = [Constants.CB_GET_UNUNDO];
        }
    }
    if (options.scrollAttr?.zoomInId && options.scrollAttr?.rootId && options.scrollAttr.zoomInId !== options.scrollAttr.rootId) {
        const getDocParam: Record<string, any> = {
            id: options.scrollAttr.zoomInId,
            size: Constants.SIZE_GET_MAX,
            query: options.protyle.query?.key,
            queryMethod: options.protyle.query?.method,
            queryTypes: options.protyle.query?.types,
            querySubTypes: options.protyle.query?.subTypes,
            highlight: !isSupportCSSHL(),
        };
        void requestProtyleContent<IWebSocketData>(options.protyle, "/api/filetree/getDoc", getDocParam, load)
            .then((response) => {
                if (!isCurrent()) {
                    return;
                }
                if (response.code === 1) {
                    const getDocParam: Record<string, any> = {
                        id: options.scrollAttr.rootId || options.mergedOptions?.blockId || options.protyle.block?.rootID || options.scrollAttr.startId,
                        query: options.protyle.query?.key,
                        queryMethod: options.protyle.query?.method,
                        queryTypes: options.protyle.query?.types,
                        querySubTypes: options.protyle.query?.subTypes,
                        highlight: !isSupportCSSHL(),
                    };
                    void requestProtyleContent<IWebSocketData>(options.protyle, "/api/filetree/getDoc", getDocParam, load)
                        .then((response) => {
                            if (!isCurrent()) {
                                return;
                            }
                            onGet({
                                scrollPosition: options.mergedOptions?.scrollPosition,
                                data: response,
                                protyle: options.protyle,
                                action: actions,
                                scrollAttr: options.scrollAttr,
                                afterCB: options.cb ? () => {
                                    options.cb(response.data.keywords);
                                } : undefined,
                                updateReadonly: options.updateReadonly,
                                load,
                            });
                        }).catch((error) => {
                            if (isCurrent()) {
                                removeLoading(options.protyle);
                                console.error("[protyle.transport] scroll restore failed", error);
                            }
                        });
                } else {
                    actions.push(Constants.CB_GET_ALL);
                    onGet({
                        scrollPosition: options.mergedOptions?.scrollPosition,
                        data: response,
                        protyle: options.protyle,
                        action: actions,
                        scrollAttr: options.scrollAttr,
                        afterCB: options.cb ? () => {
                            options.cb(response.data.keywords);
                        } : undefined,
                        updateReadonly: options.updateReadonly,
                        load,
                    });
                }
            }).catch((error) => {
                if (isCurrent()) {
                    removeLoading(options.protyle);
                    console.error("[protyle.transport] zoom scroll restore failed", error);
                }
            });
        return;
    }
    const getDocParam: Record<string, any> = {
        id: options.scrollAttr?.rootId || options.mergedOptions?.blockId || options.protyle.block?.rootID || options.scrollAttr?.startId,
        startID: options.scrollAttr?.startId,
        endID: options.scrollAttr?.endId,
        query: options.protyle.query?.key,
        queryMethod: options.protyle.query?.method,
        queryTypes: options.protyle.query?.types,
        querySubTypes: options.protyle.query?.subTypes,
        highlight: !isSupportCSSHL(),
    };
    void requestProtyleContent<IWebSocketData>(options.protyle, "/api/filetree/getDoc", getDocParam, load)
        .then((response) => {
            if (!isCurrent()) {
                return;
            }
            onGet({
                scrollPosition: options.mergedOptions?.scrollPosition,
                data: response,
                protyle: options.protyle,
                action: actions,
                scrollAttr: options.scrollAttr,
                afterCB: options.cb ? () => {
                    options.cb(response.data.keywords);
                } : undefined,
                updateReadonly: options.updateReadonly,
                load,
            });
        }).catch((error) => {
            if (isCurrent()) {
                removeLoading(options.protyle);
                console.error("[protyle.transport] scroll restore failed", error);
            }
        });
};
