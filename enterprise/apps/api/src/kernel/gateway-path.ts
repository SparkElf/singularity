import type { IncomingHttpHeaders } from "node:http";

import type { ResolvedKernelRoutePolicy } from "@singularity/kernel-client";
import {
  canonicalKernelPath,
  KERNEL_DOCUMENT_ID_HEADER,
  KERNEL_NOTEBOOK_ID_HEADER,
  KernelRoutePolicyRegistry,
} from "@singularity/kernel-client";

export const NOTEBOOK_ID_HEADER = KERNEL_NOTEBOOK_ID_HEADER;
export const DOCUMENT_ID_HEADER = KERNEL_DOCUMENT_ID_HEADER;

const UUID =
  "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}";
const SPACE_PREFIX = new RegExp(
  `^/api/v1/organizations/(${UUID})/spaces/(${UUID})(/.*)$`,
);
const CONTENT_ID = /^\d{14}-[0-9a-z]{7}$/;

export type KernelGatewaySurface = "api" | "asset" | "upload" | "export";

export interface KernelContentIdentity {
  readonly documentId: string;
  readonly notebookId: string;
}

export interface KernelGatewayTarget {
  readonly identity: KernelContentIdentity;
  readonly organizationId: string;
  readonly policy: ResolvedKernelRoutePolicy;
  readonly spaceId: string;
  readonly surface: KernelGatewaySurface;
  readonly upstreamPath: string;
}

export interface KernelWebSocketTarget {
  readonly identity: KernelContentIdentity;
  readonly organizationId: string;
  readonly spaceId: string;
  readonly upstreamPath: string;
}

export class KernelGatewayAdmissionError extends Error {
  constructor(readonly status: 400 | 403) {
    super("Kernel gateway request is unavailable");
    this.name = "KernelGatewayAdmissionError";
  }
}

function singleHeader(
  headers: IncomingHttpHeaders,
  name: string,
): string | undefined {
  const value = headers[name];
  return typeof value === "string" ? value : undefined;
}

function parseContentIdentity(
  notebookId: string | undefined,
  documentId: string | undefined,
): KernelContentIdentity {
  if (
    notebookId === undefined ||
    documentId === undefined ||
    !CONTENT_ID.test(notebookId) ||
    !CONTENT_ID.test(documentId)
  ) {
    throw new KernelGatewayAdmissionError(400);
  }
  return { documentId, notebookId };
}

function onlyParameters(
  parameters: URLSearchParams,
  names: readonly string[],
): boolean {
  const expected = new Set(names);
  const actual = [...parameters.keys()];
  return (
    actual.length === names.length &&
    actual.every(
      (name) => expected.has(name) && parameters.getAll(name).length === 1,
    )
  );
}

function parseSpaceRoute(rawUrl: string): {
  organizationId: string;
  remainder: string;
  spaceId: string;
  url: URL;
} | null {
  let canonicalPath: `/${string}`;
  try {
    canonicalPath = canonicalKernelPath(rawUrl);
  } catch {
    throw new KernelGatewayAdmissionError(400);
  }
  const match = canonicalPath.match(SPACE_PREFIX);
  if (match === null) {
    return null;
  }
  const organizationId = match[1];
  const spaceId = match[2];
  const remainder = match[3];
  if (
    organizationId === undefined ||
    spaceId === undefined ||
    remainder === undefined
  ) {
    throw new KernelGatewayAdmissionError(400);
  }
  return {
    organizationId,
    remainder,
    spaceId,
    url: new URL(rawUrl, "https://gateway.invalid"),
  };
}

function resourceIdentity(parameters: URLSearchParams): KernelContentIdentity {
  return parseContentIdentity(
    parameters.get("notebookId") ?? undefined,
    parameters.get("documentId") ?? undefined,
  );
}

export function parseKernelGatewayTarget(
  method: string,
  rawUrl: string,
  headers: IncomingHttpHeaders,
  policies: KernelRoutePolicyRegistry,
): KernelGatewayTarget | null {
  const route = parseSpaceRoute(rawUrl);
  if (route === null) {
    return null;
  }

  let identity: KernelContentIdentity;
  let surface: KernelGatewaySurface;
  let upstreamPath: string;
  if (route.remainder.startsWith("/kernel/api/")) {
    if ([...route.url.searchParams.keys()].length > 0) {
      throw new KernelGatewayAdmissionError(400);
    }
    identity = parseContentIdentity(
      singleHeader(headers, NOTEBOOK_ID_HEADER),
      singleHeader(headers, DOCUMENT_ID_HEADER),
    );
    surface = "api";
    upstreamPath = route.remainder.slice("/kernel/api".length);
  } else if (route.remainder.startsWith("/emojis/")) {
    if (
      !onlyParameters(route.url.searchParams, ["notebookId", "documentId"])
    ) {
      throw new KernelGatewayAdmissionError(400);
    }
    identity = resourceIdentity(route.url.searchParams);
    surface = "asset";
    upstreamPath = route.remainder;
  } else if (route.remainder.startsWith("/assets/")) {
    const allowedParameters = route.url.searchParams.has("download")
      ? ["notebookId", "documentId", "download"]
      : ["notebookId", "documentId"];
    if (
      !onlyParameters(route.url.searchParams, allowedParameters) ||
      (route.url.searchParams.has("download") &&
        route.url.searchParams.get("download") !== "true")
    ) {
      throw new KernelGatewayAdmissionError(400);
    }
    identity = resourceIdentity(route.url.searchParams);
    surface = "asset";
    const upstream = new URL(
      route.remainder,
      "https://kernel.invalid",
    );
    upstream.searchParams.set("box", identity.notebookId);
    if (route.url.searchParams.get("download") === "true") {
      upstream.searchParams.set("download", "true");
    }
    upstreamPath = `${upstream.pathname}${upstream.search}`;
  } else if (route.remainder === "/upload") {
    if ([...route.url.searchParams.keys()].length > 0) {
      throw new KernelGatewayAdmissionError(400);
    }
    identity = parseContentIdentity(
      singleHeader(headers, NOTEBOOK_ID_HEADER),
      singleHeader(headers, DOCUMENT_ID_HEADER),
    );
    surface = "upload";
    upstreamPath = `/upload?notebook=${encodeURIComponent(identity.notebookId)}&documentId=${encodeURIComponent(identity.documentId)}`;
  } else if (route.remainder.startsWith("/exports/")) {
    if (
      !onlyParameters(route.url.searchParams, [
        "notebookId",
        "documentId",
        "download",
      ]) ||
      route.url.searchParams.get("download") !== "true"
    ) {
      throw new KernelGatewayAdmissionError(400);
    }
    identity = resourceIdentity(route.url.searchParams);
    surface = "export";
    const upstream = new URL(
      `/export/${route.remainder.slice("/exports/".length)}`,
      "https://kernel.invalid",
    );
    upstream.searchParams.set("download", "true");
    upstreamPath = `${upstream.pathname}${upstream.search}`;
  } else {
    return null;
  }

  let policy: ResolvedKernelRoutePolicy;
  try {
    policy = policies.resolve(method, upstreamPath);
  } catch {
    throw new KernelGatewayAdmissionError(403);
  }
  const expectedContentMode = surface === "api" ? "json" : surface;
  if (
    policy.identity !== "content" ||
    policy.contentMode !== expectedContentMode
  ) {
    throw new KernelGatewayAdmissionError(403);
  }
  return {
    identity,
    organizationId: route.organizationId,
    policy,
    spaceId: route.spaceId,
    surface,
    upstreamPath,
  };
}

export function parseKernelWebSocketTarget(rawUrl: string): KernelWebSocketTarget | null {
  const route = parseSpaceRoute(rawUrl);
  if (route === null || route.remainder !== "/kernel/ws") {
    return null;
  }
  if (
    !onlyParameters(route.url.searchParams, [
      "notebookId",
      "documentId",
      "type",
    ]) ||
    route.url.searchParams.get("type") !== "protyle"
  ) {
    throw new KernelGatewayAdmissionError(400);
  }
  const identity = resourceIdentity(route.url.searchParams);
  const upstreamParameters = new URLSearchParams({
    documentId: identity.documentId,
    notebookId: identity.notebookId,
    type: "protyle",
  });
  return {
    identity,
    organizationId: route.organizationId,
    spaceId: route.spaceId,
    upstreamPath: `/ws?${upstreamParameters.toString()}`,
  };
}
