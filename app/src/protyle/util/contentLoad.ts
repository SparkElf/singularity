import type {ProtyleContentIdentity} from "../../../../enterprise/packages/protyle-browser/src/contracts";

/**
 * Owns the cancellation and generation boundary for one Protyle content load.
 * The transport remains the direct request owner; this module only prevents a
 * response from an older load or a destroyed editor from reaching onGet.
 */
export interface ProtyleContentLoad {
    readonly generation: number;
    readonly signal: AbortSignal;
    isCurrent: () => boolean;
}

interface ContentLoadState {
    generation: number;
    controller?: AbortController;
    signal?: AbortSignal;
}

const states = new WeakMap<IProtyle, ContentLoadState>();

const stateFor = (protyle: IProtyle): ContentLoadState => {
    let state = states.get(protyle);
    if (!state) {
        state = {generation: 0};
        states.set(protyle, state);
    }
    return state;
};

const combineSignals = (signals: AbortSignal[]): AbortSignal => {
    const controller = new AbortController();
    const abort = (event: Event) => {
        const source = event.target as AbortSignal;
        signals.forEach((signal) => signal.removeEventListener("abort", abort));
        controller.abort(source.reason);
    };
    const aborted = signals.find((signal) => signal.aborted);
    if (aborted) {
        controller.abort(aborted.reason);
        return controller.signal;
    }
    signals.forEach((signal) => signal.addEventListener("abort", abort, {once: true}));
    return controller.signal;
};

const makeLoad = (
    protyle: IProtyle,
    state: ContentLoadState,
    generation: number,
): ProtyleContentLoad => {
    const signal = state.signal!;
    return {
        generation,
        signal,
        isCurrent: () => !protyle.destroyed &&
            !signal.aborted &&
            state.generation === generation,
    };
};

/** Start a new load and make every older load ineligible to publish. */
export const beginProtyleContentLoad = (
    protyle: IProtyle,
    ownerSignal?: AbortSignal,
): ProtyleContentLoad => {
    const state = stateFor(protyle);
    state.controller?.abort();
    const controller = new AbortController();
    state.controller = controller;
    const generation = ++state.generation;
    const signals = [protyle.requestSignal, controller.signal];
    if (ownerSignal && ownerSignal !== protyle.requestSignal) {
        signals.push(ownerSignal);
    }
    state.signal = combineSignals(signals);
    return makeLoad(protyle, state, generation);
};

/** Reuse the current owner when a response is handed back through onGet. */
export const currentProtyleContentLoad = (protyle: IProtyle): ProtyleContentLoad | undefined => {
    const state = states.get(protyle);
    if (!state?.controller || !state.signal) {
        return undefined;
    }
    return makeLoad(protyle, state, state.generation);
};

/** Content identity is fixed at construction and never inferred from a response or DOM. */
export const protyleContentIdentity = (protyle: IProtyle): ProtyleContentIdentity => {
    if (protyle.content.mode !== "bound") {
        throw new Error("[protyle.content] local-only Protyle cannot issue content requests");
    }
    return {
        documentId: protyle.options.blockId!,
        notebookId: protyle.content.notebookId,
    };
};

/** Issue one read through the bound Session transport for the current load. */
export const requestProtyleContent = <TResponse>(
    protyle: IProtyle,
    path: string,
    body: unknown,
    load: ProtyleContentLoad,
): Promise<TResponse> => {
    const identity = protyleContentIdentity(protyle);
    const runtime = protyle.session!.runtime as TProtyleRuntime;
    return runtime.transport.request<TResponse>(path, body, {
        identity,
        intent: "read",
        signal: load.signal,
    });
};
