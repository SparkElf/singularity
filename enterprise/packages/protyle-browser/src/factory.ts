import type {
  ProtyleCoreDocumentOptions,
  ProtyleCoreFactory,
  ProtyleFactory,
} from "./contracts.ts";

export function createProtyleFactory<
  TOptions extends ProtyleCoreDocumentOptions,
  TRuntime,
>(
  coreFactory: ProtyleCoreFactory<TOptions, TRuntime>,
  options: Omit<TOptions, "blockId" | "notebookId">,
): ProtyleFactory<TRuntime> {
  return {
    create: ({ documentId, host, notebookId, readOnly, session, signal }) =>
      coreFactory.create({
        content: { mode: "bound", notebookId },
        host,
        options: { ...options, blockId: documentId },
        participation: "live",
        readOnly,
        session,
        signal,
        surface: "workspace",
      }),
  };
}
