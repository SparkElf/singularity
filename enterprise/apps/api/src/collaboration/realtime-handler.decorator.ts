import { DiscoveryService } from "@nestjs/core";
import type { CollaborationOperationKind } from "@singularity/contracts";

export interface CollaborationOperationHandlerDeclaration {
  readonly kind: CollaborationOperationKind;
  readonly methodName: string;
  readonly version: number;
}

export const COLLABORATION_OPERATION_HANDLER_METADATA =
  DiscoveryService.createDecorator<CollaborationOperationKind>();
export const COLLABORATION_OPERATION_HANDLER_PROVIDER_METADATA =
  DiscoveryService.createDecorator<readonly CollaborationOperationHandlerDeclaration[]>();

/** 声明一个语义操作处理器；只写 metadata，不在装饰器工厂中执行 I/O 或业务分支。 */
export function HandlesCollaborationOperation(
  kind: CollaborationOperationKind,
  version = 1,
): MethodDecorator {
  if (!Number.isInteger(version) || version < 1) {
    throw new TypeError("Collaboration operation handler version is invalid");
  }
  return (target, propertyKey, descriptor) => {
    if (typeof propertyKey !== "string") {
      throw new TypeError("Collaboration operation handler method name is invalid");
    }
    COLLABORATION_OPERATION_HANDLER_METADATA(kind)(target, propertyKey, descriptor);
    const previous = Reflect.getOwnMetadata(
      COLLABORATION_OPERATION_HANDLER_PROVIDER_METADATA.KEY,
      target.constructor,
    ) as readonly CollaborationOperationHandlerDeclaration[] | undefined;
    COLLABORATION_OPERATION_HANDLER_PROVIDER_METADATA([
      ...(previous ?? []),
      { kind, methodName: propertyKey, version },
    ])(target.constructor);
  };
}
