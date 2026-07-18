import type {ProtyleContentIdentity} from "../../../../../enterprise/packages/protyle-browser/src/contracts";
import {protyleContentIdentity} from "../../util/contentLoad";

interface AVLoadState {
    readonly controller: AbortController;
    readonly generation: number;
}

export interface AVRenderLoad {
    readonly identity: ProtyleContentIdentity;
    readonly owner: HTMLElement;
    readonly signal: AbortSignal;
    isCurrent: () => boolean;
}

const states = new WeakMap<HTMLElement, AVLoadState>();

export const beginAVRenderLoad = (protyle: IProtyle, owner: HTMLElement): AVRenderLoad => {
    const previous = states.get(owner);
    previous?.controller.abort();
    const state: AVLoadState = {
        controller: new AbortController(),
        generation: (previous?.generation ?? 0) + 1,
    };
    states.set(owner, state);
    const signal = AbortSignal.any([protyle.requestSignal, state.controller.signal]);
    return {
        identity: protyleContentIdentity(protyle),
        owner,
        signal,
        isCurrent: () => states.get(owner) === state &&
            !signal.aborted &&
            !protyle.destroyed &&
            owner.isConnected,
    };
};

export const requestAVRender = <TResponse>(
    protyle: IProtyle,
    load: AVRenderLoad,
    path: string,
    body: unknown,
) => protyle.session!.runtime.transport.request<TResponse>(path, body, {
    identity: load.identity,
    intent: "read",
    signal: load.signal,
});

export const reportAVLoadFailure = (load: AVRenderLoad, operation: string, error: unknown) => {
    if (load.isCurrent()) {
        console.error(`[protyle.transport] ${operation} failed`, {
            documentId: load.identity.documentId,
            notebookId: load.identity.notebookId,
            error,
        });
    }
};
