import {
  apiProblemSchema,
  RUNTIME_ACCESS_LOST_HEADER_NAME,
  RUNTIME_ACCESS_LOST_HEADER_VALUE,
  type ApiProblem,
} from "@singularity/contracts";

interface RuntimeSchema<T> {
  parse(value: unknown): T;
}

export class ApiProblemError extends Error {
  readonly problem: ApiProblem;
  readonly retryAfterSeconds: number | null;
  readonly runtimeAccessLost: boolean;

  constructor(
    problem: ApiProblem,
    retryAfterSeconds: number | null,
    runtimeAccessLost = false,
  ) {
    super(problem.code);
    this.name = "ApiProblemError";
    this.problem = problem;
    this.retryAfterSeconds = retryAfterSeconds;
    this.runtimeAccessLost = runtimeAccessLost;
  }
}

export class NetworkFailureError extends Error {
  constructor(cause: unknown) {
    super("The server could not be reached", { cause });
    this.name = "NetworkFailureError";
    console.error("[http.client]", { phase: "network" }, cause);
  }
}

export class ResponseContractError extends Error {
  constructor(cause: unknown) {
    super("The server response did not match the public contract", { cause });
    this.name = "ResponseContractError";
    console.error("[http.client]", { phase: "response-contract" }, cause);
  }
}

function isAbortError(error: unknown): error is Error {
  return error instanceof Error && error.name === "AbortError";
}

function isTransientFetchFailure(error: unknown): boolean {
  return error instanceof Error &&
    error.name === "TypeError" &&
    error.message === "Failed to fetch";
}

/** 瞬时网络切换只重试一次；取消信号、业务错误和第二次失败保持原始语义。 */
export async function fetchWithNetworkRetry(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  try {
    return await fetch(input, init);
  } catch (error) {
    if (init?.signal?.aborted || !isTransientFetchFailure(error)) {
      throw error;
    }
    console.debug("[http.transport]", { phase: "network-retry", attempt: 1 }, error);
    return await fetch(input, init);
  }
}

function parseRetryAfter(value: string | null): number | null {
  if (value === null || !/^\d+$/.test(value)) {
    return null;
  }

  const seconds = Number(value);
  return Number.isSafeInteger(seconds) && seconds > 0 ? seconds : null;
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch (cause) {
    if (isAbortError(cause)) {
      throw cause;
    }
    throw new ResponseContractError(cause);
  }
}

function parseResponse<T>(schema: RuntimeSchema<T>, value: unknown): T {
  try {
    return schema.parse(value);
  } catch (cause) {
    throw new ResponseContractError(cause);
  }
}

async function send(path: string, init?: RequestInit): Promise<Response> {
  const headers = new Headers(init?.headers);
  if (!headers.has("Accept")) {
    headers.set("Accept", "application/json");
  }

  try {
    return await fetchWithNetworkRetry(path, {
      credentials: "same-origin",
      ...init,
      headers,
    });
  } catch (cause) {
    if (init?.signal?.aborted) {
      throw init.signal.reason ?? cause;
    }
    if (isAbortError(cause)) {
      throw cause;
    }
    throw new NetworkFailureError(cause);
  }
}

async function assertSuccessful(response: Response): Promise<void> {
  if (response.ok) {
    return;
  }

  const problem = parseResponse(apiProblemSchema, await readJson(response));
  if (problem.status !== response.status) {
    throw new ResponseContractError(
      new Error(
        `Problem status ${problem.status} did not match HTTP ${response.status}`,
      ),
    );
  }

  const retryAfterSeconds = parseRetryAfter(response.headers.get("Retry-After"));
  if (response.status === 429 && retryAfterSeconds === null) {
    throw new ResponseContractError(
      new Error("HTTP 429 requires a positive integer Retry-After header"),
    );
  }

  const runtimeAccessLost =
    response.status === 404 &&
    response.headers.get(RUNTIME_ACCESS_LOST_HEADER_NAME) ===
      RUNTIME_ACCESS_LOST_HEADER_VALUE;
  throw new ApiProblemError(problem, retryAfterSeconds, runtimeAccessLost);
}

export async function requestJson<T>(
  schema: RuntimeSchema<T>,
  path: string,
  init?: RequestInit,
): Promise<T> {
  const response = await send(path, init);
  await assertSuccessful(response);
  return parseResponse(schema, await readJson(response));
}

export async function requestNoContent(
  path: string,
  init?: RequestInit,
): Promise<void> {
  const response = await send(path, init);
  await assertSuccessful(response);

  if (response.status !== 204) {
    throw new ResponseContractError(
      new Error(`Expected HTTP 204 but received ${response.status}`),
    );
  }

  const body = await response.arrayBuffer();
  if (body.byteLength !== 0) {
    throw new ResponseContractError(
      new Error("Expected an empty HTTP 204 response body"),
    );
  }
}

export function isApiProblem(
  error: unknown,
  code: ApiProblem["code"],
): error is ApiProblemError {
  return error instanceof ApiProblemError && error.problem.code === code;
}

export function isRuntimeAccessLostProblem(
  error: unknown,
): error is ApiProblemError {
  return error instanceof ApiProblemError && error.runtimeAccessLost;
}
