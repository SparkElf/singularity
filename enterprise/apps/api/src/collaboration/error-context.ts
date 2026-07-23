export interface CollaborationErrorContext {
  readonly causes?: readonly {
    readonly name: string;
    readonly message: string;
    readonly stack?: string;
  }[];
  readonly name: string;
  readonly message: string;
  readonly stack: string | undefined;
}

/** 统一保留协作跨边界异常的原始堆栈和 cause 链，避免各入口各自截断诊断信息。 */
export function collaborationErrorContext(error: unknown): CollaborationErrorContext {
  if (!(error instanceof Error)) {
    return { name: "UnknownError", message: String(error), stack: undefined };
  }
  const causes: Array<{ readonly name: string; readonly message: string; readonly stack?: string }> = [];
  const visited = new Set<Error>([error]);
  let cause = error.cause;
  while (cause instanceof Error && !visited.has(cause)) {
    visited.add(cause);
    causes.push({
      message: cause.message,
      name: cause.name,
      ...(cause.stack === undefined ? {} : { stack: cause.stack }),
    });
    cause = cause.cause;
  }
  return {
    ...(causes.length === 0 ? {} : { causes }),
    name: error.name,
    message: error.message,
    stack: error.stack,
  };
}
