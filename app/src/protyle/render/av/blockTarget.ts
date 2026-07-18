export interface AVBlockTarget {
    readonly blockId: string;
    readonly documentId: string;
    readonly notebookId: string;
}

interface AVBlockTargetState {
    readonly referenceByTarget: Map<string, string>;
    readonly targetByReference: Map<string, AVBlockTarget>;
}

const states = new WeakMap<IProtyle, AVBlockTargetState>();

const stateFor = (protyle: IProtyle) => {
    let state = states.get(protyle);
    if (state) {
        return state;
    }
    state = {
        referenceByTarget: new Map(),
        targetByReference: new Map(),
    };
    states.set(protyle, state);
    protyle.requestSignal.addEventListener("abort", () => {
        state!.referenceByTarget.clear();
        state!.targetByReference.clear();
        states.delete(protyle);
    }, {once: true});
    return state;
};

export const registerAVBlockTarget = (protyle: IProtyle, target: AVBlockTarget) => {
    const state = stateFor(protyle);
    const key = JSON.stringify([target.notebookId, target.documentId, target.blockId]);
    let reference = state.referenceByTarget.get(key);
    if (!reference) {
        reference = crypto.randomUUID();
        state.referenceByTarget.set(key, reference);
        state.targetByReference.set(reference, target);
    }
    return reference;
};

export const registerAVBlockValueTarget = (
    protyle: IProtyle,
    block: NonNullable<IAVCellValue["block"]>,
) => registerAVBlockTarget(protyle, {
    blockId: block.id!,
    documentId: block.documentId!,
    notebookId: block.notebookId!,
});

export const resolveAVBlockTarget = (protyle: IProtyle, reference: string) => {
    const target = states.get(protyle)?.targetByReference.get(reference);
    if (!target) {
        throw new Error(`[protyle.av.target] unresolved reference ${reference}`);
    }
    return target;
};

export const setAVBlockIcon = (
    protyle: IProtyle,
    target: AVBlockTarget,
    icon: string,
    signal: AbortSignal,
) => protyle.session!.runtime.transport.request<IWebSocketData>("/api/attr/setBlockAttrs", {
    attrs: {icon},
    id: target.blockId,
}, {
    identity: {
        documentId: target.documentId,
        notebookId: target.notebookId,
    },
    intent: "write",
    signal,
});
