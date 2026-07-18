export const combineAbortSignals = (signals: readonly AbortSignal[]): AbortSignal => {
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
