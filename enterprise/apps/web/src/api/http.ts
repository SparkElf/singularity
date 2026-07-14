import { apiProblemSchema, type ApiProblem } from "@singularity/contracts";

interface RuntimeSchema<T> {
  parse(value: unknown): T;
}

export class ApiProblemError extends Error {
  readonly problem: ApiProblem;
  readonly retryAfterSeconds: number | null;

  constructor(problem: ApiProblem, retryAfterSeconds: number | null) {
    super(problem.code);
    this.name = "ApiProblemError";
    this.problem = problem;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export class NetworkFailureError extends Error {
  constructor(cause: unknown) {
    super("The server could not be reached", { cause });
    this.name = "NetworkFailureError";
  }
}

export class ResponseContractError extends Error {
  constructor(cause: unknown) {
    super("The server response did not match the public contract", { cause });
    this.name = "ResponseContractError";
  }
}

function parseRetryAfter(value: string | null): number | null {
  if (value === null || !/^\d+$/.test(value)) {
    return null;
  }

  const seconds = Number(value);
  return Number.isSafeInteger(seconds) ? seconds : null;
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch (cause) {
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
    return await fetch(path, {
      credentials: "same-origin",
      ...init,
      headers,
    });
  } catch (cause) {
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

  throw new ApiProblemError(
    problem,
    parseRetryAfter(response.headers.get("Retry-After")),
  );
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
