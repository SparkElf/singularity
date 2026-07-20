import type { IncomingMessage } from "node:http";

import {
  Body,
  Controller,
  Header,
  Param,
  Post,
  Req,
} from "@nestjs/common";
import {
  ApiBody,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from "@nestjs/swagger";
import {
  ORGANIZATION_SPACE_DISCOVERY_GRAPH_CONTROLLER_PATH,
  ORGANIZATION_SPACE_DISCOVERY_SEARCH_CONTROLLER_PATH,
  SPACE_DISCOVERY_GRAPH_REQUEST_OPENAPI_SCHEMA,
  SPACE_DISCOVERY_GRAPH_RESPONSE_OPENAPI_SCHEMA,
  SPACE_DISCOVERY_SEARCH_REQUEST_OPENAPI_SCHEMA,
  SPACE_DISCOVERY_SEARCH_RESPONSE_OPENAPI_SCHEMA,
  spaceDiscoveryGraphRequestSchema,
  spaceDiscoverySearchRequestSchema,
  spaceRuntimePathParametersSchema,
  type SpaceDiscoveryGraphRequest,
  type SpaceDiscoveryGraphResponse,
  type SpaceDiscoverySearchRequest,
  type SpaceDiscoverySearchResponse,
  type SpaceRuntimePathParameters,
} from "@singularity/contracts";

import type { HttpRequestBoundary } from "../http-boundary.js";
import { bindHttpRequestAbortSignal } from "../http-request-signal.js";
import {
  ApiProblemResponses,
  CurrentSession,
  SessionMutation,
  type AuthenticatedSession,
} from "../identity/http-access.js";
import { ZodValidationPipe } from "../identity/zod-validation.pipe.js";
import { SpaceDiscoveryService } from "./space-discovery.service.js";

interface SpaceDiscoveryHttpRequest extends HttpRequestBoundary {
  readonly raw: IncomingMessage;
}

@ApiTags("space-discovery")
@Controller()
export class SpaceDiscoveryController {
  constructor(private readonly discovery: SpaceDiscoveryService) {}

  @Post(ORGANIZATION_SPACE_DISCOVERY_SEARCH_CONTROLLER_PATH)
  @SessionMutation()
  @Header("Cache-Control", "no-store")
  @ApiProblemResponses(400, 401, 403, 404, 503)
  @ApiOperation({ summary: "Search content in an authorized space" })
  @ApiBody({ schema: SPACE_DISCOVERY_SEARCH_REQUEST_OPENAPI_SCHEMA })
  @ApiOkResponse({ schema: SPACE_DISCOVERY_SEARCH_RESPONSE_OPENAPI_SCHEMA })
  /** 将浏览器搜索请求绑定当前 HTTP 取消信号，交给空间发现服务执行。 */
  search(
    @Param(new ZodValidationPipe(spaceRuntimePathParametersSchema))
    parameters: SpaceRuntimePathParameters,
    @Body(new ZodValidationPipe(spaceDiscoverySearchRequestSchema))
    body: SpaceDiscoverySearchRequest,
    @Req() request: SpaceDiscoveryHttpRequest,
    @CurrentSession() session: AuthenticatedSession,
  ): Promise<SpaceDiscoverySearchResponse> {
    return this.#withRequestSignal(request, (signal) =>
      this.discovery.search({
        actorUserId: session.userId,
        body,
        organizationId: parameters.organizationId,
        requestId: request.id,
        signal,
        spaceId: parameters.spaceId,
      }),
    );
  }

  @Post(ORGANIZATION_SPACE_DISCOVERY_GRAPH_CONTROLLER_PATH)
  @SessionMutation()
  @Header("Cache-Control", "no-store")
  @ApiProblemResponses(400, 401, 403, 404, 503)
  @ApiOperation({ summary: "Read the content graph for an authorized space" })
  @ApiBody({ schema: SPACE_DISCOVERY_GRAPH_REQUEST_OPENAPI_SCHEMA })
  @ApiOkResponse({ schema: SPACE_DISCOVERY_GRAPH_RESPONSE_OPENAPI_SCHEMA })
  /** 将浏览器图谱请求绑定当前 HTTP 取消信号，避免断开后继续占用 Kernel。 */
  graph(
    @Param(new ZodValidationPipe(spaceRuntimePathParametersSchema))
    parameters: SpaceRuntimePathParameters,
    @Body(new ZodValidationPipe(spaceDiscoveryGraphRequestSchema))
    body: SpaceDiscoveryGraphRequest,
    @Req() request: SpaceDiscoveryHttpRequest,
    @CurrentSession() session: AuthenticatedSession,
  ): Promise<SpaceDiscoveryGraphResponse> {
    return this.#withRequestSignal(request, (signal) =>
      this.discovery.graph({
        actorUserId: session.userId,
        body,
        organizationId: parameters.organizationId,
        requestId: request.id,
        signal,
        spaceId: parameters.spaceId,
      }),
    );
  }

  /** 让 Kernel 读取在浏览器断开时取消，并在响应完成后移除底层监听器。 */
  async #withRequestSignal<Result>(
    request: SpaceDiscoveryHttpRequest,
    operation: (signal: AbortSignal) => Promise<Result>,
  ): Promise<Result> {
    const abortScope = bindHttpRequestAbortSignal(request.raw);
    try {
      return await operation(abortScope.signal);
    } finally {
      abortScope.dispose();
    }
  }
}
