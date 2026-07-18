import type {ProtyleDocumentStatistics} from "../../../../enterprise/packages/protyle-browser/src/contracts";
import {Constants} from "../../constants";
import {combineAbortSignals} from "./abortSignal";
import {protyleContentIdentity} from "./contentLoad";

interface StatisticsResponse {
    readonly data: {
        readonly stat: ProtyleDocumentStatistics;
    };
}

interface StatisticsState {
    controller?: AbortController;
    generation: number;
    timeout?: number;
}

type StatisticsRequest =
    | {readonly path: "/api/block/getContentWordCount"; readonly body: {readonly content: string}}
    | {readonly path: "/api/block/getBlocksWordCount"; readonly body: {readonly ids: readonly string[]}}
    | {readonly path: "/api/block/getTreeStat"; readonly body: {readonly id: string}};

const states = new WeakMap<IProtyle, StatisticsState>();

const stateFor = (protyle: IProtyle) => {
    let state = states.get(protyle);
    if (state) {
        return state;
    }
    state = {generation: 0};
    states.set(protyle, state);
    protyle.requestSignal.addEventListener("abort", () => {
        if (state.timeout !== undefined) {
            window.clearTimeout(state.timeout);
        }
        state.controller?.abort();
    }, {once: true});
    return state;
};

const scheduleStatistics = (protyle: IProtyle, request: StatisticsRequest) => {
    if (protyle.content.mode !== "bound" || protyle.surface !== "workspace") {
        return;
    }
    const state = stateFor(protyle);
    const generation = ++state.generation;
    if (state.timeout !== undefined) {
        window.clearTimeout(state.timeout);
    }
    state.controller?.abort();
    state.timeout = window.setTimeout(() => {
        const controller = new AbortController();
        state.controller = controller;
        state.timeout = undefined;
        const signal = combineAbortSignals([protyle.requestSignal, controller.signal]);
        const identity = protyleContentIdentity(protyle);
        void protyle.session!.runtime.transport.request<StatisticsResponse>(request.path, request.body, {
            identity,
            intent: "read",
            signal,
        }).then((response) => {
            if (signal.aborted || state.generation !== generation || protyle.destroyed) {
                return;
            }
            protyle.host.dispatch({
                type: "update-document-statistics",
                notebookId: identity.notebookId,
                documentId: identity.documentId,
                statistics: response.data.stat,
            });
        }).catch((error) => {
            if (!signal.aborted && state.generation === generation && !protyle.destroyed) {
                console.error("[protyle.transport] statistics request failed", error);
            }
        }).finally(() => {
            if (state.controller === controller) {
                state.controller = undefined;
            }
        });
    }, Constants.TIMEOUT_COUNT);
};

export const countSelectionStatistics = (protyle: IProtyle, range: Range) => {
    scheduleStatistics(protyle, {
        path: "/api/block/getContentWordCount",
        body: {content: range.toString()},
    });
};

export const countBlockStatistics = (protyle: IProtyle, ids: readonly string[]) => {
    if (ids.length > 0) {
        scheduleStatistics(protyle, {
            path: "/api/block/getBlocksWordCount",
            body: {ids},
        });
        return;
    }
    const selectedText = getSelection().rangeCount > 0 ? getSelection().getRangeAt(0).toString() : "";
    if (selectedText) {
        scheduleStatistics(protyle, {
            path: "/api/block/getContentWordCount",
            body: {content: selectedText},
        });
        return;
    }
    scheduleStatistics(protyle, {
        path: "/api/block/getTreeStat",
        body: {id: protyle.block.rootID!},
    });
};
