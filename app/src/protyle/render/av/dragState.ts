interface AVDragState {
    element?: HTMLElement;
}

const states = new WeakMap<IProtyle, AVDragState>();

const stateFor = (protyle: IProtyle) => {
    let state = states.get(protyle);
    if (state) {
        return state;
    }
    state = {};
    states.set(protyle, state);
    protyle.requestSignal.addEventListener("abort", () => {
        if (state.element) {
            state.element.style.opacity = "";
            state.element = undefined;
        }
    }, {once: true});
    return state;
};

export const beginAVDrag = (protyle: IProtyle, element: HTMLElement, opacity?: string) => {
    const state = stateFor(protyle);
    if (state.element && state.element !== element) {
        state.element.style.opacity = "";
    }
    state.element = element;
    if (opacity) {
        element.style.opacity = opacity;
    }
    return element;
};

export const currentAVDrag = (protyle: IProtyle) => stateFor(protyle).element;

export const endAVDrag = (protyle: IProtyle) => {
    const state = stateFor(protyle);
    const element = state.element;
    if (element) {
        element.style.opacity = "";
        state.element = undefined;
    }
    return element;
};
