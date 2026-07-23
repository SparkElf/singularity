import { Injectable, type OnModuleInit } from "@nestjs/common";
import { DiscoveryService } from "@nestjs/core";
import type {
  CollaborationFeatureMode,
  CollaborationOperationEnvelope,
} from "@singularity/contracts";
import type { CollaborationSubmitResult } from "./realtime-coordinator.js";

import {
  COLLABORATION_OPERATION_HANDLER_METADATA,
  COLLABORATION_OPERATION_HANDLER_PROVIDER_METADATA,
  type CollaborationOperationHandlerDeclaration,
} from "./realtime-handler.decorator.js";

export interface CollaborationOperationHandler {
  execute(input: CollaborationOperationHandlerInput): Promise<CollaborationSubmitResult>;
}

export interface CollaborationOperationHandlerInput {
  readonly actorUserId: string;
  readonly envelope: CollaborationOperationEnvelope;
  readonly featureMode: CollaborationFeatureMode;
  readonly requestId: string;
}

export type CollaborationOperationHandlerRegistry = ReadonlyMap<
  string,
  CollaborationOperationHandler
>;

/**
 * 仅从 CollaborationModule 的 DI providers 读取声明，重复 kind/version 在装配边界失败。
 * 生产协调器消费的是唯一 registry，不维护第二套中央 switch 或文件名列表。
 */
@Injectable()
export class CollaborationOperationDiscovery implements OnModuleInit {
  #handlers!: CollaborationOperationHandlerRegistry;

  constructor(private readonly discovery: DiscoveryService) {}

  /** Nest 启动阶段解析所有声明，提交热路径只读取冻结的唯一 handler 表。 */
  onModuleInit(): void {
    this.#handlers = this.#discover();
  }

  handlers(): CollaborationOperationHandlerRegistry {
    if (this.#handlers === undefined) {
      throw new Error("Collaboration operation handlers are not initialized");
    }
    return this.#handlers;
  }

  #discover(): CollaborationOperationHandlerRegistry {
    const discovered = new Map<string, CollaborationOperationHandler>();
    const providers = this.discovery.getProviders({
      metadataKey: COLLABORATION_OPERATION_HANDLER_PROVIDER_METADATA.KEY,
    });
    for (const provider of providers) {
      const instance = provider.instance as Record<string, unknown> | undefined;
      const declarations = this.discovery.getMetadataByDecorator(
        COLLABORATION_OPERATION_HANDLER_PROVIDER_METADATA,
        provider,
      );
      if (instance === undefined || !Array.isArray(declarations)) {
        throw new TypeError("Collaboration operation handler provider is unavailable");
      }
      for (const declaration of declarations) {
        if (!isDeclaration(declaration)) {
          throw new TypeError("Invalid collaboration operation declarations");
        }
        const methodKind = this.discovery.getMetadataByDecorator(
          COLLABORATION_OPERATION_HANDLER_METADATA,
          provider,
          declaration.methodName,
        );
        const method = instance[declaration.methodName];
        if (
          methodKind !== declaration.kind ||
          typeof method !== "function"
        ) {
          throw new TypeError("Invalid collaboration operation declarations");
        }
        const key = `${declaration.kind}:v${String(declaration.version)}`;
        if (discovered.has(key)) {
          throw new TypeError("Duplicate collaboration operation handler");
        }
        discovered.set(key, {
          execute: method.bind(provider.instance) as CollaborationOperationHandler["execute"],
        });
      }
    }
    return discovered;
  }
}

function isDeclaration(value: unknown): value is CollaborationOperationHandlerDeclaration {
  return (
    typeof value === "object" &&
    value !== null &&
    "kind" in value &&
    "methodName" in value &&
    typeof value.methodName === "string" &&
    "version" in value &&
    typeof value.version === "number" &&
    Number.isInteger(value.version) &&
    value.version > 0
  );
}
