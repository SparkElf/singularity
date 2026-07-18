export type KernelTransportFailure = "timeout" | "unavailable";

export class KernelTransportError extends Error {
  constructor(
    readonly failure: KernelTransportFailure,
    options?: ErrorOptions,
  ) {
    super("Kernel transport is unavailable", options);
    this.name = "KernelTransportError";
  }
}
