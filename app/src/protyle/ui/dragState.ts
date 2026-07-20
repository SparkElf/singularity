import {Constants} from "../../constants";
import {
    protyleContentScopeIdentity,
    type ProtyleContentScopeIdentity,
} from "../runtime/contentScope";

export interface ProtyleDragState {
    readonly element: HTMLElement;
    readonly identity: ProtyleContentScopeIdentity;
    readonly source: IProtyle;
    readonly title: string;
    readonly transferType: string;
}

interface OwnedProtyleDragState extends ProtyleDragState {
    removeAbortListener: () => void;
}

const states = new WeakMap<IProtyle["runtime"], OwnedProtyleDragState>();

const clearState = (runtime: IProtyle["runtime"], state: OwnedProtyleDragState) => {
    if (states.get(runtime) !== state) {
        return;
    }
    states.delete(runtime);
    state.removeAbortListener();
    state.element.style.opacity = "";
};

export const beginProtyleDrag = (options: {
    readonly data: string;
    readonly dataTransfer: DataTransfer;
    readonly element: HTMLElement;
    readonly html: string;
    readonly opacity?: string;
    readonly protyle: IProtyle;
    readonly subtype: string;
    readonly title?: string;
    readonly type: string;
}) => {
    const identity = protyleContentScopeIdentity(options.protyle);
    const runtime = options.protyle.runtime;
    const previousState = states.get(runtime);
    if (previousState) {
        clearState(runtime, previousState);
    }
    const serializedScope = "spaceId" in identity ?
        `spaceId=${identity.spaceId}` : `localAppId=${identity.localAppId}`;
    const transferType = `${Constants.SIYUAN_DROP_GUTTER}${options.type}${Constants.ZWSP}${options.subtype}` +
        `${Constants.ZWSP}${options.data}${Constants.ZWSP}${serializedScope}${Constants.ZWSP}` +
        `${identity.notebookId}${Constants.ZWSP}${identity.documentId}`;
    options.dataTransfer.setData(transferType, options.html);
    if (options.opacity) {
        options.element.style.opacity = options.opacity;
    }
    let state: OwnedProtyleDragState;
    const onAbort = () => clearState(runtime, state);
    state = {
        element: options.element,
        identity,
        removeAbortListener: () => options.protyle.requestSignal.removeEventListener("abort", onAbort),
        source: options.protyle,
        title: options.title ?? "",
        transferType: transferType.toLowerCase(),
    };
    states.set(runtime, state);
    options.protyle.requestSignal.addEventListener("abort", onAbort, {once: true});
    return state;
};

export const currentProtyleDrag = (protyle: IProtyle): ProtyleDragState | undefined =>
    states.get(protyle.runtime);

export const endProtyleDrag = (protyle: IProtyle) => {
    const state = states.get(protyle.runtime);
    if (state) {
        clearState(protyle.runtime, state);
    }
};
