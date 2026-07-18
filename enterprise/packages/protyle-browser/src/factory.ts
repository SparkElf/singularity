import type {
  ProtyleCoreDocumentOptions,
  ProtyleCoreFactory,
  ProtyleFactory,
  ProtyleWorkspaceCoreCreateOptions,
  ProtyleWorkspaceCoreFactory,
} from "./contracts.ts";

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
