import type {
  ProtyleCoreDocumentOptions,
  ProtyleCoreFactory,
  ProtyleFactory,
  ProtyleWorkspaceCoreCreateOptions,
  ProtyleWorkspaceCoreFactory,
} from "./contracts.ts";

/** 创建绑定 notebook/document 身份的编辑器工厂，禁止调用方通过默认选项绕过身份合同。 */
export function createProtyleFactory<
  TOptions extends ProtyleCoreDocumentOptions,
  TRuntime,
>(
  coreFactory:
    | ProtyleCoreFactory<TOptions, TRuntime>
    | ProtyleWorkspaceCoreFactory<TOptions, TRuntime>,
  options: Omit<TOptions, "blockId" | "notebookId"> & {
    readonly blockId?: never;
    readonly notebookId?: never;
  },
): ProtyleFactory<TRuntime> {
  return {
    create: ({ documentId, host, notebookId, readOnly, session, signal }) => {
      const coreOptions: ProtyleWorkspaceCoreCreateOptions<TOptions, TRuntime> = {
        content: { mode: "bound", notebookId },
        host,
        initialLoad: "automatic",
        options: { ...options, blockId: documentId },
        participation: "live",
        readOnly,
        session,
        signal,
        surface: "workspace",
      };
      return coreFactory.create(coreOptions);
    },
  };
}
