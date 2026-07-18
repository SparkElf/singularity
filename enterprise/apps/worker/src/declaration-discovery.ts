import { Injectable } from "@nestjs/common";
import { DiscoveryService } from "@nestjs/core";

import {
  HandlesWorkerJob,
  ProducesWorkerJob,
  scheduledWorkerJobKinds,
  type DeclaredWorkerJobProducer,
} from "./job-declarations.js";
import {
  workerJobKinds,
  type DeclaredWorkerJobHandler,
  type WorkerJobKind,
} from "./worker.js";

function isWorkerJobKind(value: unknown): value is WorkerJobKind {
  return workerJobKinds.some((kind) => kind === value);
}

function isScheduledWorkerJobKind(
  value: unknown,
): value is DeclaredWorkerJobProducer["kind"] {
  return scheduledWorkerJobKinds.some((kind) => kind === value);
}

function isHandler(value: unknown): value is DeclaredWorkerJobHandler {
  return (
    typeof value === "object" &&
    value !== null &&
    "kind" in value &&
    isWorkerJobKind(value.kind) &&
    "decode" in value &&
    typeof value.decode === "function" &&
    "execute" in value &&
    typeof value.execute === "function"
  );
}

function isProducer(value: unknown): value is DeclaredWorkerJobProducer {
  return (
    typeof value === "object" &&
    value !== null &&
    "kind" in value &&
    isScheduledWorkerJobKind(value.kind) &&
    "intervalMilliseconds" in value &&
    typeof value.intervalMilliseconds === "number" &&
    "produce" in value &&
    typeof value.produce === "function"
  );
}

@Injectable()
export class WorkerDeclarationDiscovery {
  constructor(private readonly discovery: DiscoveryService) {}

  handlers(): readonly DeclaredWorkerJobHandler[] {
    const discovered = new Map<WorkerJobKind, DeclaredWorkerJobHandler>();
    const providers = this.discovery.getProviders({
      metadataKey: HandlesWorkerJob.KEY,
    });
    for (const provider of providers) {
      const declaration = this.discovery.getMetadataByDecorator(
        HandlesWorkerJob,
        provider,
      );
      const instance: unknown = provider.instance;
      if (
        declaration === undefined ||
        !isWorkerJobKind(declaration.kind) ||
        !isHandler(instance) ||
        instance.kind !== declaration.kind ||
        discovered.has(declaration.kind)
      ) {
        throw new TypeError("Worker handler declarations conflict");
      }
      discovered.set(declaration.kind, instance);
    }
    if (
      discovered.size !== workerJobKinds.length ||
      workerJobKinds.some((kind) => !discovered.has(kind))
    ) {
      throw new TypeError("Worker handler declarations are incomplete");
    }
    return workerJobKinds.map((kind) => discovered.get(kind)!);
  }

  producers(): readonly DeclaredWorkerJobProducer[] {
    const discovered = new Map<
      DeclaredWorkerJobProducer["kind"],
      DeclaredWorkerJobProducer
    >();
    const providers = this.discovery.getProviders({
      metadataKey: ProducesWorkerJob.KEY,
    });
    for (const provider of providers) {
      const declaration = this.discovery.getMetadataByDecorator(
        ProducesWorkerJob,
        provider,
      );
      const instance: unknown = provider.instance;
      if (
        declaration === undefined ||
        !isScheduledWorkerJobKind(declaration.kind) ||
        !isProducer(instance) ||
        instance.kind !== declaration.kind ||
        discovered.has(declaration.kind)
      ) {
        throw new TypeError("Worker producer declarations conflict");
      }
      discovered.set(declaration.kind, instance);
    }
    if (
      discovered.size !== scheduledWorkerJobKinds.length ||
      scheduledWorkerJobKinds.some((kind) => !discovered.has(kind))
    ) {
      throw new TypeError("Worker producer declarations are incomplete");
    }
    return scheduledWorkerJobKinds.map((kind) => discovered.get(kind)!);
  }
}
