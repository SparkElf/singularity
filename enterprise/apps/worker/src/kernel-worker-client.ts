import type { IncomingMessage } from "node:http";

import { Injectable } from "@nestjs/common";
import { DatabaseRuntime } from "@singularity/database";
import {
  KernelPrivateClient,
  type KernelDeploymentIdentity,
} from "@singularity/kernel-client";
import { z } from "zod";

import type {
  BackupKernelPort,
  KernelObservationPort,
} from "./l1-handlers.js";
import type { BackupSpaceJob, SampleKernelJob } from "./worker.js";
import { WorkerJobError } from "./worker.js";

export const WORKER_BACKUP_PATH = "/internal/enterprise/backup";
export const WORKER_OBSERVATION_PATH = "/internal/enterprise/observation";
const MAX_OBSERVATION_BYTES = 64 * 1_024;
const POSTGRES_BIGINT_MAXIMUM = 9_223_372_036_854_775_807n;
const observationCountSchema = z
  .string()
  .regex(/^(0|[1-9][0-9]*)$/)
  .refine((value) => BigInt(value) <= POSTGRES_BIGINT_MAXIMUM);
const observationErrorCodeSchema = z
  .string()
  .refine((value) => value.trim().length > 0);
const observationDateTimeSchema = z.string().datetime({ offset: true });
const observationResponseSchema = z
  .object({
    capacity: z
      .object({
        assetBytes: observationCountSchema,
        dataBytes: observationCountSchema,
        errorCode: observationErrorCodeSchema.optional(),
        fileCount: observationCountSchema,
        sampleDurationMilliseconds: z
          .number()
          .int()
          .min(0)
          .max(2_147_483_647),
        sampledAt: observationDateTimeSchema,
      })
      .strict(),
    health: z
      .object({
        errorCode: observationErrorCodeSchema.optional(),
        kernelVersion: z.string().refine((value) => value.trim().length > 0),
        sampledAt: observationDateTimeSchema,
        status: z.enum(["ready", "unavailable"]),
      })
      .strict(),
  })
  .strict();

function header(message: IncomingMessage, name: string): string {
  const value = message.headers[name];
  if (typeof value !== "string" || value.length === 0) {
    throw new WorkerJobError("kernel-response-invalid", null);
  }
  return value;
}

async function readObservation(message: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of message) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.byteLength;
    if (size > MAX_OBSERVATION_BYTES) {
      message.destroy();
      throw new WorkerJobError("kernel-response-invalid", null);
    }
    chunks.push(bytes);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new WorkerJobError("kernel-response-invalid", null);
  }
}

function observation(
  value: unknown,
): Awaited<ReturnType<KernelObservationPort["read"]>> {
  const parsed = observationResponseSchema.safeParse(value);
  if (!parsed.success) {
    throw new WorkerJobError("kernel-response-invalid", null);
  }
  return parsed.data;
}

@Injectable()
export class KernelWorkerClient implements BackupKernelPort, KernelObservationPort {
  constructor(
    private readonly database: DatabaseRuntime,
    private readonly kernel: KernelPrivateClient,
  ) {}

  async createBackup(job: BackupSpaceJob, signal: AbortSignal) {
    const deployment = await this.#deployment(job.spaceId);
    const response = await this.kernel.request({
      deployment,
      headers: {},
      method: "POST",
      path: WORKER_BACKUP_PATH,
      requestId: job.requestId,
      signal,
    });
    if (response.status !== 200) {
      response.message.resume();
      throw new WorkerJobError("kernel-backup-failed", null);
    }
    const formatVersion = Number(
      header(response.message, "x-singularity-backup-format-version"),
    );
    if (!Number.isSafeInteger(formatVersion) || formatVersion < 1) {
      response.message.resume();
      throw new WorkerJobError("kernel-response-invalid", null);
    }
    return {
      body: response.message,
      formatVersion,
      kernelVersion: header(response.message, "x-singularity-kernel-version"),
      sha256: header(response.message, "x-singularity-backup-sha256"),
    };
  }

  async read(job: SampleKernelJob, signal: AbortSignal) {
    const deployment = await this.#deployment(job.spaceId, job.kernelInstanceId);
    const response = await this.kernel.request({
      deployment,
      headers: {},
      method: "GET",
      path: WORKER_OBSERVATION_PATH,
      requestId: job.requestId,
      signal,
    });
    if (response.status !== 200) {
      response.message.resume();
      throw new WorkerJobError("kernel-observation-failed", null);
    }
    return observation(await readObservation(response.message));
  }

  async #deployment(
    spaceId: string,
    expectedKernelInstanceId?: string,
  ): Promise<KernelDeploymentIdentity> {
    const instance = await this.database.client.kernelInstance.findFirst({
      where: {
        ...(expectedKernelInstanceId === undefined
          ? {}
          : { id: expectedKernelInstanceId }),
        spaceId,
        status: "ready",
      },
      select: { deploymentHandle: true, id: true },
    });
    if (instance === null || instance.deploymentHandle === null) {
      throw new WorkerJobError("kernel-unavailable", null);
    }
    return {
      handle: instance.deploymentHandle,
      kernelInstanceId: instance.id,
      spaceId,
    };
  }
}
