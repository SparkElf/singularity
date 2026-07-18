import {Constants} from "../../constants";
import {protyleContentIdentity} from "../util/contentLoad";

export interface ProtyleDragState {
    readonly element: HTMLElement;
    readonly identity: {
        readonly documentId: string;
        readonly notebookId: string;
        readonly spaceId: string;
    };
    readonly source: IProtyle;
    readonly title: string;
    readonly transferType: string;
}

interface OwnedProtyleDragState extends ProtyleDragState {
    removeAbortListener: () => void;
}

const states = new WeakMap<TProtyleSession, OwnedProtyleDragState>();

const clearState = (session: TProtyleSession, state: OwnedProtyleDragState) => {
    if (states.get(session) !== state) {
        return;
    }
    states.delete(session);
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
    const identity = protyleContentIdentity(options.protyle);
    const session = options.protyle.session!;
    const previousState = states.get(session);
    if (previousState) {
        clearState(session, previousState);
    }
    const transferType = `${Constants.SIYUAN_DROP_GUTTER}${options.type}${Constants.ZWSP}${options.subtype}` +
        `${Constants.ZWSP}${options.data}${Constants.ZWSP}${session.spaceId}${Constants.ZWSP}` +
        `${identity.notebookId}${Constants.ZWSP}${identity.documentId}`;
    options.dataTransfer.setData(transferType, options.html);
    if (options.opacity) {
        options.element.style.opacity = options.opacity;
    }
    let state: OwnedProtyleDragState;
    const onAbort = () => clearState(session, state);
    state = {
        element: options.element,
        identity: {
            documentId: identity.documentId,
            notebookId: identity.notebookId,
            spaceId: session.spaceId,
        },
        removeAbortListener: () => options.protyle.requestSignal.removeEventListener("abort", onAbort),
        source: options.protyle,
        title: options.title ?? "",
        transferType: transferType.toLowerCase(),
    };
    states.set(session, state);
    options.protyle.requestSignal.addEventListener("abort", onAbort, {once: true});
    return state;
};

export const currentProtyleDrag = (protyle: IProtyle): ProtyleDragState | undefined =>
    protyle.session ? states.get(protyle.session) : undefined;

export const endProtyleDrag = (protyle: IProtyle) => {
    const session = protyle.session;
    if (!session) {
        return;
    }
    const state = states.get(session);
    if (state) {
        clearState(session, state);
    }
};
