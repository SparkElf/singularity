import { Injectable } from "@nestjs/common";
import {
  type CollaborationOperationEnvelope,
  type CollaborationFeatureMode,
} from "@singularity/contracts";

import {
  HandlesCollaborationOperation,
} from "./realtime-handler.decorator.js";
import type {
  CollaborationOperationHandlerInput,
} from "./realtime-handler-discovery.js";
import type {
  CollaborationSubmitResult,
  KernelCollaborationPort,
} from "./realtime-coordinator.js";
import { KERNEL_COLLABORATION_PORT } from "./realtime-coordinator.js";
import { Inject } from "@nestjs/common";

/** 将声明式操作 kind 绑定到同一个 Kernel canonical apply 边界，避免协调器维护中央 kind 分支。 */
@Injectable()
export class RealtimeOperationHandlers {
  constructor(@Inject(KERNEL_COLLABORATION_PORT) private readonly kernel: KernelCollaborationPort) {}

  @HandlesCollaborationOperation("text.insert")
  private textInsert(input: CollaborationOperationHandlerInput): Promise<CollaborationSubmitResult> {
    return this.apply(input);
  }

  @HandlesCollaborationOperation("text.delete")
  private textDelete(input: CollaborationOperationHandlerInput): Promise<CollaborationSubmitResult> {
    return this.apply(input);
  }

  @HandlesCollaborationOperation("block.insert")
  private blockInsert(input: CollaborationOperationHandlerInput): Promise<CollaborationSubmitResult> {
    return this.apply(input);
  }

  @HandlesCollaborationOperation("block.move")
  private blockMove(input: CollaborationOperationHandlerInput): Promise<CollaborationSubmitResult> {
    return this.apply(input);
  }

  @HandlesCollaborationOperation("block.delete")
  private blockDelete(input: CollaborationOperationHandlerInput): Promise<CollaborationSubmitResult> {
    return this.apply(input);
  }

  @HandlesCollaborationOperation("reference.update")
  private referenceUpdate(input: CollaborationOperationHandlerInput): Promise<CollaborationSubmitResult> {
    return this.apply(input);
  }

  @HandlesCollaborationOperation("embed.update")
  private embedUpdate(input: CollaborationOperationHandlerInput): Promise<CollaborationSubmitResult> {
    return this.apply(input);
  }

  @HandlesCollaborationOperation("attribute-view.cell-set")
  private attributeViewCellSet(input: CollaborationOperationHandlerInput): Promise<CollaborationSubmitResult> {
    return this.apply(input);
  }

  /** 所有 operation handler 共用 Kernel 的唯一内容事实源，不在 API 进程复制 reducer 或正文。 */
  private apply(input: {
    readonly actorUserId: string;
    readonly envelope: CollaborationOperationEnvelope;
    readonly featureMode: CollaborationFeatureMode;
    readonly requestId: string;
  }): Promise<CollaborationSubmitResult> {
    return this.kernel.apply(input);
  }
}
