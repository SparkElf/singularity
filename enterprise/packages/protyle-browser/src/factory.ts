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
  options: Omit<TOptions, "blockId">,
): ProtyleFactory<TRuntime> {
  return {
    create: ({ documentId, host, readOnly, session, signal }) =>
      coreFactory.create({
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
