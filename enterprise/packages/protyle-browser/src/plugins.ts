import type { ProtylePluginPort } from "./contracts.ts";

export function createEmptyProtylePluginPort<TOptions, TToolbar, TEditor>(): ProtylePluginPort<
  TOptions,
  TToolbar,
  TEditor
> {
  let disposed = false;

  const assertActive = () => {
    if (disposed) {
      throw new Error("[protyle.plugins] cannot use the plugin port after disposal");
    }
  };

  return {
    extendOptions: (options) => {
      assertActive();
      return options;
    },
    extendToolbar: (toolbar) => {
      assertActive();
      return toolbar;
    },
    emit: () => {
      assertActive();
    },
    runEditorCommand: () => {
      assertActive();
      return false;
    },
    forEachSlashItem: () => {
      assertActive();
    },
    runSlashItem: () => {
      assertActive();
      return false;
    },
    transformPaste: async (_editor, payload) => {
      assertActive();
      return payload;
    },
    dispose: () => {
      disposed = true;
    },
  };
}
