import type {ProtyleContentIdentity} from "../../../../../enterprise/packages/protyle-browser/src/contracts";
import {protyleContentIdentity} from "../../util/contentLoad";
import {combineAbortSignals} from "../../util/abortSignal";

interface AVLoadState {
    readonly controller: AbortController;
    readonly generation: number;
}

export type AVLoadNamespace = "owner" | "render" | "panel" | "column";

export interface AVRenderLoad {
    readonly identity: ProtyleContentIdentity;
    readonly namespace: AVLoadNamespace;
    readonly owner: HTMLElement;
    readonly signal: AbortSignal;
    isCurrent: () => boolean;
}

const states = new WeakMap<object, Map<AVLoadNamespace, AVLoadState>>();

export const beginAVRenderLoad = (
    protyle: IProtyle,
    owner: HTMLElement,
    namespace: AVLoadNamespace = "owner",
    generationOwner: object = owner,
): AVRenderLoad => {
    let ownerStates = states.get(generationOwner);
    if (!ownerStates) {
        ownerStates = new Map();
        states.set(generationOwner, ownerStates);
    }
    const previous = ownerStates.get(namespace);
    previous?.controller.abort();
    const state: AVLoadState = {
        controller: new AbortController(),
        generation: (previous?.generation ?? 0) + 1,
    };
    ownerStates.set(namespace, state);
    const signal = combineAbortSignals([protyle.requestSignal, state.controller.signal]);
    return {
        identity: protyleContentIdentity(protyle),
        namespace,
        owner,
        signal,
        isCurrent: () => states.get(generationOwner)?.get(namespace) === state &&
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
