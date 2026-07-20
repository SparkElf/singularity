export interface KernelErrorContext {
  readonly error: Error;
  readonly errorMessage: string;
  readonly errorName: string;
  readonly errorStack?: string;
}

export function kernelErrorContext(
  error: unknown,
  nonErrorMessage: string,
): KernelErrorContext {
  const normalized =
    error instanceof Error
      ? error
      : new Error(nonErrorMessage, { cause: error });
  return {
    error: normalized,
    errorMessage: normalized.message,
    errorName: normalized.name,
    ...(normalized.stack === undefined
      ? {}
      : { errorStack: normalized.stack }),
  };
}
