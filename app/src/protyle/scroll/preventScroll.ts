export const preventScroll = (
    protyle: IProtyle,
    scrollTop = 0,
    timeout = 1000,
    signal: AbortSignal = protyle.requestSignal,
) => {
    // 防止滚动条滚动后调用 get 请求
    protyle.scroll.lastScrollTop = -1;
    setTimeout(() => {
        if (!signal.aborted) {
            protyle.scroll.lastScrollTop = scrollTop;
        }
    }, timeout);
};
