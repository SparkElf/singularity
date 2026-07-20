interface RuntimeSession<TRuntime> {
    readonly runtime: TRuntime;
}

export type ExplicitProtyleRuntimeBinding<TSession extends RuntimeSession<unknown>, TLocalRuntime> =
    | {readonly session: TSession}
    | {readonly upstreamLocalRuntime: TLocalRuntime};

/** 解析显式企业 Session 或上游本地 Runtime；不允许通过缺失 Session 走隐式 fallback。 */
export const resolveProtyleRuntimeBinding = <
    TSession extends RuntimeSession<unknown>,
    TLocalRuntime,
>(binding: ExplicitProtyleRuntimeBinding<TSession, TLocalRuntime>): {
    readonly runtime: TSession["runtime"] | TLocalRuntime;
    readonly session: TSession | undefined;
} => {
    if ("upstreamLocalRuntime" in binding) {
        return {runtime: binding.upstreamLocalRuntime, session: undefined};
    }
    if (!binding.session) {
        throw new Error("[protyle.runtime] Core requires an explicit Session or upstream local Runtime");
    }
    return {runtime: binding.session.runtime, session: binding.session};
};
