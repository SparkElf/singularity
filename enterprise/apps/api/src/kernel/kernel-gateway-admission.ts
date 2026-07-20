import type { IncomingHttpHeaders, IncomingMessage } from "node:http";

import { Logger } from "@nestjs/common";
import { KernelRoutePolicyRegistry } from "@singularity/kernel-client";

import {
  type KernelGatewayTarget,
  parseKernelGatewayTarget,
} from "./gateway-path.js";
import { kernelErrorContext } from "./error-context.js";

export class KernelGatewayAdmission {
  readonly #admitted = new WeakMap<IncomingMessage, KernelGatewayTarget>();
  readonly #logger = new Logger("KernelGatewayAdmission");

  constructor(private readonly policies: KernelRoutePolicyRegistry) {}

  /** 在 HTTP 路由进入控制器前解析并缓存唯一 Gateway 目标，后续只消费这份声明。 */
  admit(input: {
    headers: IncomingHttpHeaders;
    method: string;
    rawRequest: IncomingMessage;
    requestId: string;
    url: string;
  }): KernelGatewayTarget | null {
    let target: KernelGatewayTarget | null;
    try {
      target = parseKernelGatewayTarget(
        input.method,
        input.url,
        input.headers,
        this.policies,
      );
    } catch (error) {
      this.#logger.warn({
        ...kernelErrorContext(error, "Kernel Gateway admission failed"),
        event: "kernel.route",
        outcome: "admission-rejected",
        requestId: input.requestId,
      });
      throw error;
    }
    if (target !== null) {
      this.#admitted.set(input.rawRequest, target);
      this.#logger.debug({
        canonicalRoute: target.policy.path,
        event: "kernel.route",
        organizationId: target.organizationId,
        outcome: "admitted",
        requestId: input.requestId,
        spaceId: target.spaceId,
      });
    }
    return target;
  }

  /** 取出并删除请求对应的目标声明，防止同一请求被重复消费或跨请求复用。 */
  consume(rawRequest: IncomingMessage): KernelGatewayTarget {
    const target = this.#admitted.get(rawRequest);
    this.#admitted.delete(rawRequest);
    if (target === undefined) {
      throw new Error("Kernel gateway admission is unavailable");
    }
    return target;
  }

  inspect(rawRequest: IncomingMessage): KernelGatewayTarget | null {
    return this.#admitted.get(rawRequest) ?? null;
  }
}
