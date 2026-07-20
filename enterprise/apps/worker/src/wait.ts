const abortError = (reason: unknown): Error => {
  if (reason instanceof Error) {
    return reason;
  }
  const error = new Error(typeof reason === "string" ? reason : "The operation was aborted");
  error.name = "AbortError";
  return error;
};

// 统一延迟与取消语义，让生产运行时和测试使用同一个可观测的计时器边界。
export function waitForDelay(
  milliseconds: number,
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(abortError(signal.reason));
  }

  return new Promise<void>((resolve, reject) => {
    let settled = false;

    const cleanup = (): void => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
    };
    const settle = (callback: () => void): void => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      callback();
    };
    const onAbort = (): void => {
      settle(() => reject(abortError(signal?.reason)));
    };

    const timeout = setTimeout(() => settle(resolve), milliseconds);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) {
      onAbort();
    }
  });
}
