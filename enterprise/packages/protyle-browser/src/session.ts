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
        const errors: unknown[] = [];
        const disposeCapability = (dispose: () => void) => {
          try {
            dispose();
          } catch (error) {
            errors.push(error);
          }
        };

        disposeCapability(() => options.runtime.editors.seal());
        disposeCapability(() => options.runtime.transport.dispose());
        disposeCapability(() => options.runtime.overlays.dispose());
        disposeCapability(() => options.runtime.menu.dispose());
        disposeCapability(() => options.runtime.editors.forEach((editor) => {
          disposeCapability(() => editor.destroy());
        }));
        disposeCapability(() => options.runtime.editors.dispose());
        try {
          await options.runtime.plugins.dispose();
        } catch (error) {
          errors.push(error);
        }

        if (errors.length === 1) {
          throw errors[0];
        }
        if (errors.length > 1) {
          throw new AggregateError(errors, "[protyle.session] capability disposal failed");
        }
      })();
      return disposePromise;
    },
  };
}
