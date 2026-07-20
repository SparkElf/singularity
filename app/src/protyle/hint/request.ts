import {protyleContentIdentity} from "../util/contentLoad";
import {combineAbortSignals} from "../util/abortSignal";

export type HintRequestChannel = "document-create" | "suggestions" | "template";

export interface HintRequestGeneration {
    readonly signal: AbortSignal;
    isCurrent: () => boolean;
}

interface HintRequestState {
    controller?: AbortController;
    generation: number;
}

const requestStates = new WeakMap<IProtyle, Map<HintRequestChannel, HintRequestState>>();

const stateFor = (protyle: IProtyle, channel: HintRequestChannel): HintRequestState => {
    let states = requestStates.get(protyle);
    if (!states) {
        states = new Map();
        requestStates.set(protyle, states);
    }
    let state = states.get(channel);
    if (!state) {
        state = {generation: 0};
        states.set(channel, state);
    }
    return state;
};

export const beginHintRequest = (
    protyle: IProtyle,
    channel: HintRequestChannel,
): HintRequestGeneration => {
    const state = stateFor(protyle, channel);
    state.controller?.abort();
    const controller = new AbortController();
    state.controller = controller;
    const generation = ++state.generation;
    const signal = combineAbortSignals([protyle.requestSignal, controller.signal]);
    return {
        signal,
        isCurrent: () => !protyle.destroyed && !signal.aborted &&
            state.controller === controller && state.generation === generation,
    };
};

export const requestHint = <TResponse>(
    protyle: IProtyle,
    path: string,
    body: unknown,
    intent: "read" | "write",
    request: HintRequestGeneration,
    identity?: {readonly notebookId: string; readonly documentId: string},
): Promise<TResponse> => {
    return protyle.runtime.transport.request<TResponse>(path, body, {
        identity: identity ?? protyleContentIdentity(protyle),
        intent,
        signal: request.signal,
    });
};

export const reportHintRequestFailure = (
    protyle: IProtyle,
    request: HintRequestGeneration,
    path: string,
    error: unknown,
) => {
    if (!request.signal.aborted && !protyle.destroyed) {
        console.error("[protyle.hint] request failed", {error, path});
    }
};
