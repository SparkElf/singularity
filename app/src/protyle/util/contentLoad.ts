import type {ProtyleContentIdentity} from "../../../../enterprise/packages/protyle-browser/src/contracts";
import {combineAbortSignals} from "./abortSignal";

/** 拥有一次 Protyle 内容加载的取消与代次边界，阻止旧响应或已销毁编辑器继续进入 onGet。 */
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

// 识别生命周期取消，不把正常的旧代次终止误报为内容服务故障。
export const isAbortError = (error: unknown): boolean =>
    error instanceof Error && error.name === "AbortError";

const states = new WeakMap<IProtyle, ContentLoadState>();

const stateFor = (protyle: IProtyle): ContentLoadState => {
    let state = states.get(protyle);
    if (!state) {
        state = {generation: 0};
        states.set(protyle, state);
    }
    return state;
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

/** 开始新的内容加载并让所有旧代次失去发布资格。 */
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
    state.signal = combineAbortSignals(signals);
    return makeLoad(protyle, state, generation);
};

/** onGet 返回响应时复用当前加载 owner，避免重新推断内容身份。 */
export const currentProtyleContentLoad = (protyle: IProtyle): ProtyleContentLoad | undefined => {
    const state = states.get(protyle);
    if (!state?.controller || !state.signal) {
        return undefined;
    }
    return makeLoad(protyle, state, state.generation);
};

/** 读取构造时固定的内容身份，禁止从响应或 DOM 推断 notebook/document。 */
export const protyleContentIdentity = (protyle: IProtyle): ProtyleContentIdentity => {
    if (protyle.content.mode !== "bound") {
        throw new Error("[protyle.content] local-only Protyle cannot issue content requests");
    }
    return {
        documentId: protyle.block.rootID!,
        notebookId: protyle.content.notebookId,
    };
};

/** 通过绑定 Session 的 transport 发起当前加载代次的读请求。 */
export const requestProtyleContent = <TResponse>(
    protyle: IProtyle,
    path: string,
    body: unknown,
    load: ProtyleContentLoad,
): Promise<TResponse> => {
    const identity = protyleContentIdentity(protyle);
    return protyle.runtime.transport.request<TResponse>(path, body, {
        identity,
        intent: "read",
        signal: load.signal,
    });
};
