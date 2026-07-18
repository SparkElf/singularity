import { DiscoveryService } from "@nestjs/core";
import type { AccessOperationName } from "@singularity/contracts";

export interface AccessOperationHandlerDeclaration {
  readonly methodName: string;
  readonly operation: AccessOperationName;
}

export const ACCESS_OPERATION_HANDLER_METADATA =
  DiscoveryService.createDecorator<AccessOperationName>();
export const ACCESS_OPERATION_HANDLER_PROVIDER_METADATA =
  DiscoveryService.createDecorator<
    readonly AccessOperationHandlerDeclaration[]
  >();

export function HandlesAccessOperation(
  operation: AccessOperationName,
): MethodDecorator {
  return (target, propertyKey, descriptor) => {
    if (typeof propertyKey !== "string") {
      throw new TypeError("Access operation handler method name is invalid");
    }
    ACCESS_OPERATION_HANDLER_METADATA(operation)(
      target,
      propertyKey,
      descriptor,
    );
    const previous = Reflect.getOwnMetadata(
      ACCESS_OPERATION_HANDLER_PROVIDER_METADATA.KEY,
      target.constructor,
    ) as readonly AccessOperationHandlerDeclaration[] | undefined;
    ACCESS_OPERATION_HANDLER_PROVIDER_METADATA([
      ...(previous ?? []),
      { methodName: propertyKey, operation },
    ])(target.constructor);
  };
}
