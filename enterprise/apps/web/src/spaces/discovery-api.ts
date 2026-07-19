import type {
  ProtyleContentIdentity,
  ProtyleRuntimeErrorEvent,
  ProtyleTransport,
} from "@singularity/protyle-browser";
import {
  buildSpaceDiscoveryGraphPath,
  buildSpaceDiscoverySearchPath,
  CSRF_HEADER_NAME,
  documentDiscoveryBacklinksDataSchema,
  documentDiscoveryGraphDataSchema,
  documentDiscoveryHistoryDataSchema,
  documentDiscoveryOutlineDataSchema,
  spaceDiscoveryGraphResponseSchema,
  spaceDiscoverySearchResponseSchema,
  type DocumentDiscoveryBacklink,
  type DocumentDiscoveryBacklinksData,
  type DocumentDiscoveryGraphData,
  type DocumentDiscoveryGraphLink,
  type DocumentDiscoveryGraphNode,
  type DocumentDiscoveryHistoryData,
  type DocumentDiscoveryOutlineItem,
  type SpaceDiscoveryBlock,
  type SpaceDiscoveryGraphLink,
  type SpaceDiscoveryGraphRequest,
  type SpaceDiscoveryGraphNode,
  type SpaceDiscoveryGraphResponse,
  type SpaceDiscoverySearchMethod,
  type SpaceDiscoverySearchRequest,
  type SpaceDiscoverySearchResponse,
} from "@singularity/contracts";

import {
  isApiProblem,
  NetworkFailureError,
  requestJson,
  ResponseContractError,
} from "@/api/http.ts";
import { getOrFetchCsrfToken } from "@/auth/api.ts";

export type DiscoveryBlock = SpaceDiscoveryBlock;
export type DiscoverySearchResult = SpaceDiscoverySearchResponse;

export type DiscoveryOutlineItem = DocumentDiscoveryOutlineItem;

export type DiscoveryBacklinkItem = DocumentDiscoveryBacklink;

export type DiscoveryBacklinksResult = DocumentDiscoveryBacklinksData;

export type DiscoveryHistoryResult = DocumentDiscoveryHistoryData;

export type DiscoveryGraphNode =
  | DocumentDiscoveryGraphNode
  | SpaceDiscoveryGraphNode;

export type DiscoveryGraphLink =
  | DocumentDiscoveryGraphLink
  | SpaceDiscoveryGraphLink;

export type DiscoveryGraphResult =
  | DocumentDiscoveryGraphData
  | SpaceDiscoveryGraphResponse;

export interface SpaceDiscoveryClient {
  readonly graph: (input: {
    readonly query: string;
    readonly signal: AbortSignal;
  }) => Promise<SpaceDiscoveryGraphResponse>;
  readonly search: (input: {
    readonly method: SpaceDiscoverySearchMethod;
    readonly query: string;
    readonly signal: AbortSignal;
  }) => Promise<DiscoverySearchResult>;
}

type DiscoveryTransport = Pick<ProtyleTransport<unknown>, "request">;

interface KernelResult {
  readonly code: number;
  readonly data: unknown;
}

function contractError(message: string): never {
  throw new ResponseContractError(new Error(message));
}

function objectValue(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return contractError(`Discovery response ${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function kernelData(value: unknown): unknown {
  const result = objectValue(value, "root") as Partial<KernelResult>;
  if (result.code !== 0 || !("data" in result)) {
    return contractError("Discovery response must contain a successful Kernel result");
  }
  return result.data;
}

function requestOptions(identity: ProtyleContentIdentity, signal: AbortSignal) {
  return {
    identity,
    intent: "read" as const,
    signal,
  };
}

function contentIdentity(input: {
  readonly documentId: string;
  readonly notebookId: string;
}): ProtyleContentIdentity {
  return {
    documentId: input.documentId,
    notebookId: input.notebookId,
  };
}

function parseSearchResult(value: unknown): DiscoverySearchResult {
  try {
    return spaceDiscoverySearchResponseSchema.parse(kernelData(value));
  } catch (cause) {
    throw new ResponseContractError(cause);
  }
}

function parseOutlineResult(value: unknown): readonly DiscoveryOutlineItem[] {
  try {
    return documentDiscoveryOutlineDataSchema.parse(kernelData(value));
  } catch (cause) {
    throw new ResponseContractError(cause);
  }
}

function parseBacklinksResult(value: unknown): DiscoveryBacklinksResult {
  try {
    return documentDiscoveryBacklinksDataSchema.parse(kernelData(value));
  } catch (cause) {
    throw new ResponseContractError(cause);
  }
}

function parseHistoryResult(value: unknown): DiscoveryHistoryResult {
  try {
    return documentDiscoveryHistoryDataSchema.parse(kernelData(value));
  } catch (cause) {
    throw new ResponseContractError(cause);
  }
}

function parseDocumentGraphResult(value: unknown): DocumentDiscoveryGraphData {
  try {
    return documentDiscoveryGraphDataSchema.parse(kernelData(value));
  } catch (cause) {
    throw new ResponseContractError(cause);
  }
}

interface DiscoveryResponseSchema<T> {
  parse(value: unknown): T;
}

export function createSpaceDiscoveryClient(input: {
  readonly organizationId: string;
  readonly onRuntimeError: (event: ProtyleRuntimeErrorEvent) => void;
  readonly spaceId: string;
}): SpaceDiscoveryClient {
  const graphPath = buildSpaceDiscoveryGraphPath(input);
  const searchPath = buildSpaceDiscoverySearchPath(input);
  const request = async <T>(
    path: string,
    body: unknown,
    signal: AbortSignal,
    schema: DiscoveryResponseSchema<T>,
  ): Promise<T> => {
    try {
      const csrfToken = await getOrFetchCsrfToken(signal);
      const value = await requestJson(
        schema,
        path,
        {
          body: JSON.stringify(body),
          credentials: "same-origin",
          headers: {
            "Content-Type": "application/json",
            [CSRF_HEADER_NAME]: csrfToken,
          },
          method: "POST",
          redirect: "error",
          signal,
        },
      );
      return value;
    } catch (error) {
      if (signal.aborted) {
        throw error;
      }
      if (isApiProblem(error, "unauthenticated")) {
        input.onRuntimeError({
          category: "unauthenticated",
          triggeringRequestId: error.problem.requestId,
          type: "runtime-error",
        });
      } else if (
        isApiProblem(error, "forbidden") ||
        isApiProblem(error, "not-found")
      ) {
        input.onRuntimeError({
          category: "forbidden",
          triggeringRequestId: error.problem.requestId,
          type: "runtime-error",
        });
      } else if (error instanceof NetworkFailureError) {
        input.onRuntimeError({
          category: "network-failure",
          type: "runtime-error",
        });
      } else if (isApiProblem(error, "service-unavailable")) {
        input.onRuntimeError({
          category: "kernel-unavailable",
          triggeringRequestId: error.problem.requestId,
          type: "runtime-error",
        });
      } else if (error instanceof ResponseContractError) {
        input.onRuntimeError({
          category: "kernel-unavailable",
          type: "runtime-error",
        });
      }
      throw error;
    }
  };
  return {
    graph: ({ query, signal }) => {
      const body = { query } satisfies SpaceDiscoveryGraphRequest;
      return request(
        graphPath,
        body,
        signal,
        spaceDiscoveryGraphResponseSchema,
      );
    },
    search: ({ method, query, signal }) => {
      const body = { method, query } satisfies SpaceDiscoverySearchRequest;
      return request(
        searchPath,
        body,
        signal,
        spaceDiscoverySearchResponseSchema,
      );
    },
  };
}

const GRAPH_TYPES = {
  blockquote: false,
  callout: false,
  code: false,
  heading: false,
  list: false,
  listItem: false,
  math: false,
  paragraph: true,
  super: false,
  table: false,
  tag: true,
} as const;

const GRAPH_D3 = {
  arrow: true,
  centerStrength: 0.01,
  collideRadius: 600,
  collideStrength: 0.08,
  lineOpacity: 0.36,
  linkDistance: 400,
  linkWidth: 8,
  nodeSize: 15,
} as const;

export async function searchDocument(input: {
  readonly documentId: string;
  readonly notebookId: string;
  readonly query: string;
  readonly signal: AbortSignal;
  readonly transport: DiscoveryTransport;
}): Promise<DiscoverySearchResult> {
  const response = await input.transport.request<unknown>(
    "/api/search/fullTextSearchBlock",
    { query: input.query },
    requestOptions(contentIdentity(input), input.signal),
  );
  return parseSearchResult(response);
}

export async function loadDocumentOutline(input: {
  readonly documentId: string;
  readonly notebookId: string;
  readonly preview: boolean;
  readonly signal: AbortSignal;
  readonly transport: DiscoveryTransport;
}): Promise<readonly DiscoveryOutlineItem[]> {
  const response = await input.transport.request<unknown>(
    "/api/outline/getDocOutline",
    { id: input.documentId, preview: input.preview },
    requestOptions(contentIdentity(input), input.signal),
  );
  return parseOutlineResult(response);
}

export async function loadDocumentBacklinks(input: {
  readonly documentId: string;
  readonly notebookId: string;
  readonly signal: AbortSignal;
  readonly transport: DiscoveryTransport;
}): Promise<DiscoveryBacklinksResult> {
  const response = await input.transport.request<unknown>(
    "/api/ref/getBacklink2",
    {
      id: input.documentId,
      k: "",
      mSort: "3",
      mk: "",
      sort: "3",
    },
    requestOptions(contentIdentity(input), input.signal),
  );
  return parseBacklinksResult(response);
}

export async function loadDocumentHistory(input: {
  readonly documentId: string;
  readonly notebookId: string;
  readonly page: number;
  readonly signal: AbortSignal;
  readonly transport: DiscoveryTransport;
}): Promise<DiscoveryHistoryResult> {
  const response = await input.transport.request<unknown>(
    "/api/history/searchHistory",
    {
      op: "all",
      page: input.page,
      query: input.documentId,
      type: 3,
    },
    requestOptions(contentIdentity(input), input.signal),
  );
  return parseHistoryResult(response);
}

export async function loadDocumentGraph(input: {
  readonly documentId: string;
  readonly notebookId: string;
  readonly query: string;
  readonly signal: AbortSignal;
  readonly transport: DiscoveryTransport;
}): Promise<DocumentDiscoveryGraphData> {
  const response = await input.transport.request<unknown>(
    "/api/graph/getLocalGraph",
    {
      conf: {
        d3: GRAPH_D3,
        dailyNote: false,
        type: GRAPH_TYPES,
      },
      id: input.documentId,
      k: input.query,
      type: "local",
    },
    requestOptions(contentIdentity(input), input.signal),
  );
  return parseDocumentGraphResult(response);
}
