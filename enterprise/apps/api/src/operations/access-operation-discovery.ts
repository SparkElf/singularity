import { Injectable } from "@nestjs/common";
import { DiscoveryService } from "@nestjs/core";
import {
  accessOperationNames,
  type AccessOperation,
  type AccessOperationName,
  type AccessOperationResult,
} from "@singularity/contracts";

import {
  ACCESS_OPERATION_HANDLER_METADATA,
  ACCESS_OPERATION_HANDLER_PROVIDER_METADATA,
  type AccessOperationHandlerDeclaration,
} from "./access-operation-handler.decorator.js";

export interface AccessOperationHandler {
  execute(
    operationId: string,
    command: AccessOperation,
  ): Promise<AccessOperationResult>;
}

export type AccessOperationHandlerRegistry = ReadonlyMap<
  AccessOperationName,
  AccessOperationHandler
>;

function isAccessOperationName(value: unknown): value is AccessOperationName {
  return (
    typeof value === "string" &&
    (accessOperationNames as readonly string[]).includes(value)
  );
}

@Injectable()
export class AccessOperationDiscovery {
  constructor(private readonly discovery: DiscoveryService) {}

  handlers(): AccessOperationHandlerRegistry {
    const discovered = new Map<
      AccessOperationName,
      AccessOperationHandler
    >();
    const providers = this.discovery.getProviders({
      metadataKey: ACCESS_OPERATION_HANDLER_PROVIDER_METADATA.KEY,
    });

    for (const provider of providers) {
      const instance = provider.instance as Record<string, unknown> | undefined;
      const declarations = this.discovery.getMetadataByDecorator(
        ACCESS_OPERATION_HANDLER_PROVIDER_METADATA,
        provider,
      );
      if (instance === undefined || !Array.isArray(declarations)) {
        throw new TypeError("Access operation handler provider is unavailable");
      }

      for (const declaration of declarations) {
        if (!isDeclaration(declaration)) {
          throw new TypeError("Invalid access operation handler declarations");
        }
        const { methodName } = declaration;
        const methodOperation = this.discovery.getMetadataByDecorator(
          ACCESS_OPERATION_HANDLER_METADATA,
          provider,
          methodName,
        );
        if (methodOperation !== declaration.operation) {
          throw new TypeError("Invalid access operation handler declarations");
        }
        const method = instance[methodName];
        if (
          !isAccessOperationName(declaration.operation) ||
          typeof method !== "function" ||
          discovered.has(declaration.operation)
        ) {
          throw new TypeError("Invalid access operation handler declarations");
        }
        discovered.set(declaration.operation, {
          execute: method.bind(provider.instance) as AccessOperationHandler["execute"],
        });
      }
    }

    if (
      discovered.size !== accessOperationNames.length ||
      accessOperationNames.some(
        (operation) => !discovered.has(operation),
      )
    ) {
      throw new TypeError("Incomplete access operation handler declarations");
    }

    return discovered;
  }
}

function isDeclaration(
  value: unknown,
): value is AccessOperationHandlerDeclaration {
  return (
    typeof value === "object" &&
    value !== null &&
    "methodName" in value &&
    typeof value.methodName === "string" &&
    "operation" in value
  );
}
