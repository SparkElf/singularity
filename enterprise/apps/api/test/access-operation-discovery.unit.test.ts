import "reflect-metadata";

import {
  Injectable,
  Module,
  type INestApplicationContext,
  type OnModuleInit,
  type Provider,
  type Type,
} from "@nestjs/common";
import { DiscoveryModule, NestFactory } from "@nestjs/core";
import {
  accessOperationNames,
  type AccessOperationName,
} from "@singularity/contracts";
import { describe, expect, test } from "vitest";

import { AccessOperationDiscovery } from "../src/operations/access-operation-discovery.js";
import { HandlesAccessOperation } from "../src/operations/access-operation-handler.decorator.js";

@Injectable()
class DiscoveryInitializationProbe implements OnModuleInit {
  constructor(private readonly discovery: AccessOperationDiscovery) {}

  onModuleInit(): void {
    this.discovery.handlers();
  }
}

function handlerProvider(
  operations: readonly AccessOperationName[],
): Type<unknown> {
  @Injectable()
  class DeclaredHandlers {}

  for (const [index, operation] of operations.entries()) {
    const methodName = `handle${index}`;
    Object.defineProperty(DeclaredHandlers.prototype, methodName, {
      configurable: true,
      value: function execute(): void {},
    });
    const descriptor = Object.getOwnPropertyDescriptor(
      DeclaredHandlers.prototype,
      methodName,
    );
    if (descriptor === undefined) {
      throw new Error("Declared handler descriptor is unavailable");
    }
    HandlesAccessOperation(operation)(
      DeclaredHandlers.prototype,
      methodName,
      descriptor,
    );
  }

  return DeclaredHandlers;
}

function nonFunctionHandlerProvider(): Type<unknown> {
  const provider = handlerProvider(["initialize"]);
  Object.defineProperty(provider.prototype, "handle0", {
    configurable: true,
    value: {},
  });
  return provider;
}

async function initializeDiscovery(
  declaredProviders: readonly Provider[],
): Promise<void> {
  @Module({
    imports: [DiscoveryModule],
    providers: [
      AccessOperationDiscovery,
      DiscoveryInitializationProbe,
      ...declaredProviders,
    ],
  })
  class DiscoveryTestModule {}

  let context: INestApplicationContext | undefined;
  try {
    context = await NestFactory.createApplicationContext(DiscoveryTestModule, {
      abortOnError: false,
      logger: false,
    });
  } finally {
    await context?.close();
  }
}

describe("access operation declaration discovery", () => {
  test("fails Nest initialization when one public operation declaration is missing", async () => {
    const incompleteOperations = accessOperationNames.filter(
      (operation) => operation !== "revoke-user-sessions",
    );

    await expect(
      initializeDiscovery([handlerProvider(incompleteOperations)]),
    ).rejects.toThrow("Incomplete access operation handler declarations");
  });

  test("fails Nest initialization when an operation is declared twice", async () => {
    await expect(
      initializeDiscovery([
        handlerProvider(accessOperationNames),
        handlerProvider(["initialize"]),
      ]),
    ).rejects.toThrow("Invalid access operation handler declarations");
  });

  test("fails Nest initialization when a provider declares an unknown operation", async () => {
    await expect(
      initializeDiscovery([
        handlerProvider(accessOperationNames),
        handlerProvider(["unknown-operation" as AccessOperationName]),
      ]),
    ).rejects.toThrow("Invalid access operation handler declarations");
  });

  test("fails Nest initialization when a declared handler is not a function", async () => {
    await expect(
      initializeDiscovery([
        handlerProvider(accessOperationNames),
        nonFunctionHandlerProvider(),
      ]),
    ).rejects.toThrow("Invalid access operation handler declarations");
  });
});
