import type { IncomingMessage } from "node:http";
import { performance } from "node:perf_hooks";

import { Injectable, Logger } from "@nestjs/common";
import {
  spaceDiscoveryGraphResponseSchema,
  spaceDiscoverySearchResponseSchema,
  type SpaceDiscoveryGraphRequest,
  type SpaceDiscoveryGraphResponse,
  type SpaceDiscoverySearchRequest,
  type SpaceDiscoverySearchResponse,
} from "@singularity/contracts";
import {
  KernelPrivateClient,
  type KernelPrivateResponse,
} from "@singularity/kernel-client";

import { ApiProblemError, notFound, serviceUnavailable } from "../problem.js";
import {
  type AuthorizedKernelTarget,
  KernelAccessService,
} from "./kernel-access.service.js";

const SPACE_DISCOVERY_SEARCH_PATH =
  "/internal/enterprise/discovery/search";
const SPACE_DISCOVERY_GRAPH_PATH = "/internal/enterprise/discovery/graph";
const MAX_SPACE_DISCOVERY_RESPONSE_BYTES = 2 * 1024 * 1024;

interface SpaceDiscoveryRequestContext {
  readonly actorUserId: string;
  readonly organizationId: string;
  readonly requestId: string;
  readonly signal: AbortSignal;
  readonly spaceId: string;
}

function jsonContentType(message: IncomingMessage): boolean {
  const value = message.headers["content-type"];
  return (
    typeof value === "string" &&
    value.split(";", 1)[0]?.trim().toLowerCase() === "application/json"
  );
}

async function readDiscoveryJson(message: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let sizeBytes = 0;
  try {
    for await (const chunk of message) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      sizeBytes += bytes.byteLength;
      if (sizeBytes > MAX_SPACE_DISCOVERY_RESPONSE_BYTES) {
        message.destroy();
        throw serviceUnavailable();
      }
      chunks.push(bytes);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch (error) {
    if (error instanceof ApiProblemError) {
      throw error;
    }
    throw serviceUnavailable();
  }
}

@Injectable()
export class SpaceDiscoveryService {
  readonly #logger = new Logger("SpaceDiscoveryService");

  constructor(
    private readonly access: KernelAccessService,
    private readonly kernel: KernelPrivateClient,
  ) {}

  search(
    input: SpaceDiscoveryRequestContext & {
      readonly body: SpaceDiscoverySearchRequest;
    },
  ): Promise<SpaceDiscoverySearchResponse> {
    return this.#observe(input, "search", async () => {
      const value = await this.#requestJson(
        input,
        SPACE_DISCOVERY_SEARCH_PATH,
        input.body,
      );
      const parsed = spaceDiscoverySearchResponseSchema.safeParse(value);
      if (!parsed.success) {
        throw serviceUnavailable();
      }
      return parsed.data;
    });
  }

  graph(
    input: SpaceDiscoveryRequestContext & {
      readonly body: SpaceDiscoveryGraphRequest;
    },
  ): Promise<SpaceDiscoveryGraphResponse> {
    return this.#observe(input, "graph", async () => {
      const value = await this.#requestJson(
        input,
        SPACE_DISCOVERY_GRAPH_PATH,
        input.body,
      );
      const parsed = spaceDiscoveryGraphResponseSchema.safeParse(value);
      if (!parsed.success) {
        throw serviceUnavailable();
      }
      return parsed.data;
    });
  }

  async #requestJson(
    input: SpaceDiscoveryRequestContext,
    path: string,
    body: SpaceDiscoverySearchRequest | SpaceDiscoveryGraphRequest,
  ): Promise<unknown> {
    let authorized: AuthorizedKernelTarget;
    try {
      authorized = await this.access.authorizeHttp({
        action: "read",
        organizationId: input.organizationId,
        requestId: input.requestId,
        spaceId: input.spaceId,
        userId: input.actorUserId,
      });
    } catch (error) {
      if (error instanceof ApiProblemError && error.code === "forbidden") {
        throw notFound();
      }
      throw error;
    }

    const serializedBody = JSON.stringify(body);
    let response: KernelPrivateResponse;
    try {
      response = await this.kernel.request({
        body: serializedBody,
        deployment: authorized.deployment,
        headers: {
          accept: "application/json",
          "content-length": String(Buffer.byteLength(serializedBody)),
          "content-type": "application/json",
        },
        method: "POST",
        path,
        requestId: input.requestId,
        signal: input.signal,
      });
    } catch {
      throw serviceUnavailable();
    }

    if (response.status !== 200 || !jsonContentType(response.message)) {
      response.message.resume();
      throw serviceUnavailable();
    }
    return readDiscoveryJson(response.message);
  }

  async #observe<Result>(
    input: SpaceDiscoveryRequestContext & { readonly body: { query: string } },
    operation: "graph" | "search",
    work: () => Promise<Result>,
  ): Promise<Result> {
    const startedAt = performance.now();
    try {
      const result = await work();
      this.#logger.log({
        durationMilliseconds: performance.now() - startedAt,
        event: "content.discovery",
        operation,
        organizationId: input.organizationId,
        queryLength: input.body.query.length,
        requestId: input.requestId,
        outcome: "succeeded",
        spaceId: input.spaceId,
      });
      return result;
    } catch (error) {
      this.#logger.warn({
        durationMilliseconds: performance.now() - startedAt,
        event: "content.discovery",
        operation,
        organizationId: input.organizationId,
        queryLength: input.body.query.length,
        requestId: input.requestId,
        outcome: "failed",
        spaceId: input.spaceId,
      });
      throw error;
    }
  }
}
