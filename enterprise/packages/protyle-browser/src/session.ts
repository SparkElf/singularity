import type {
  CreateProtyleSessionOptions,
  ProtyleSession,
  ProtyleSessionRuntime,
} from "./contracts.ts";

export function createProtyleSession<TRuntime extends ProtyleSessionRuntime>(
  options: CreateProtyleSessionOptions<TRuntime>,
): ProtyleSession<TRuntime> {
  let disposed = false;
  let disposePromise: Promise<void> | undefined;

  return {
    spaceId: options.spaceId,
    runtime: options.runtime,
    retrySubmission: async () => {
      if (disposed) {
        throw new Error("[protyle.session] cannot retry submission after disposal");
      }
      await options.retrySubmission();
    },
    dispose: () => {
      if (disposePromise) {
        return disposePromise;
      }

      disposed = true;
      disposePromise = (async () => {
        options.runtime.transport.dispose();
        options.runtime.overlays.dispose();
        options.runtime.menu.dispose();
        options.runtime.editors.dispose();
        await options.runtime.plugins.dispose();
      })();
      return disposePromise;
    },
  };
}
