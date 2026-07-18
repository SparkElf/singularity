import { DiscoveryService } from "@nestjs/core";

import type {
  ArchiveAuditJob,
  ClaimedWorkerJob,
  SampleKernelJob,
  WorkerJobKind,
} from "./worker.js";

export interface WorkerJobHandlerDeclaration {
  readonly kind: WorkerJobKind;
}

export const HandlesWorkerJob =
  DiscoveryService.createDecorator<WorkerJobHandlerDeclaration>();

export type ScheduledWorkerJob = ArchiveAuditJob | SampleKernelJob;

export const scheduledWorkerJobKinds = [
  "archive-audit",
  "sample-kernel",
] as const satisfies readonly ScheduledWorkerJob["kind"][];

export type ScheduledWorkerJobKind =
  (typeof scheduledWorkerJobKinds)[number];

export interface WorkerJobProducerDeclaration {
  readonly kind: ScheduledWorkerJobKind;
}

export const ProducesWorkerJob =
  DiscoveryService.createDecorator<WorkerJobProducerDeclaration>();

export interface WorkerJobProducer<Job extends ScheduledWorkerJob> {
  readonly intervalMilliseconds: number;
  readonly kind: Job["kind"];
  produce(now: Date): Promise<number>;
}

export type DeclaredWorkerJobProducer = {
  [Kind in ScheduledWorkerJobKind]: WorkerJobProducer<
    Extract<ClaimedWorkerJob, { kind: Kind }>
  >;
}[ScheduledWorkerJobKind];
