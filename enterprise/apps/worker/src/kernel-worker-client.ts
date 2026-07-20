import type { IncomingMessage } from "node:http";

import { Inject, Injectable } from "@nestjs/common";
import {
  KERNEL_BACKUP_MAXIMUM_BYTES_HEADER,
  KERNEL_BACKUP_MAXIMUM_FILES_HEADER,
} from "@singularity/authorization";
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
import {
  BACKUP_REQUEST_TIMEOUT_MILLISECONDS,
  MAXIMUM_BACKUP_BYTES,
  MAXIMUM_BACKUP_FILES,
} from "./tokens.js";

export const WORKER_BACKUP_PATH = "/internal/enterprise/backup";
export const WORKER_OBSERVATION_PATH = "/internal/enterprise/observation";
const MAX_OBSERVATION_BYTES = 64 * 1_024;
const MAXIMUM_OBSERVATION_CLOCK_SKEW_MILLISECONDS = 5 * 60_000;
const POSTGRES_BIGINT_MAXIMUM = 9_223_372_036_854_775_807n;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const observationCountSchema = z
  .string()
  .regex(/^(0|[1-9][0-9]*)$/)
  .refine((value) => BigInt(value) <= POSTGRES_BIGINT_MAXIMUM);
const observationErrorCodeSchema = z
  .string()
  .regex(/^[a-z][a-z0-9-]{0,63}$/);
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

/** 读取受限大小的 Kernel 观测响应；超限、截断或 JSON 无效时销毁流并保留原始 cause。 */
async function readObservation(message: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for await (const chunk of message) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += bytes.byteLength;
      if (size > MAX_OBSERVATION_BYTES) {
        message.destroy();
        throw new WorkerJobError("kernel-response-invalid", null);
      }
      chunks.push(bytes as Buffer<ArrayBufferLike>);
    }
  } catch (error) {
    message.destroy();
    if (error instanceof WorkerJobError) {
      throw error;
    }
    throw new WorkerJobError("kernel-response-invalid", null, {
      cause: error,
    });
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch (error) {
    throw new WorkerJobError("kernel-response-invalid", null, { cause: error });
  }
}

/** 校验观测响应的字段、时间一致性和数值范围，返回可安全写入数据库的快照。 */
export function parseKernelObservationResponse(
  value: unknown,
): Awaited<ReturnType<KernelObservationPort["read"]>>["sample"] {
  const parsed = observationResponseSchema.safeParse(value);
  if (!parsed.success) {
    throw new WorkerJobError("kernel-response-invalid", null);
  }
  const sampledAt = Date.parse(parsed.data.capacity.sampledAt);
  if (
    parsed.data.capacity.sampledAt !== parsed.data.health.sampledAt ||
    sampledAt > Date.now() + MAXIMUM_OBSERVATION_CLOCK_SKEW_MILLISECONDS
  ) {
    throw new WorkerJobError("kernel-response-invalid", null);
  }
  return parsed.data;
}

@Injectable()
export class KernelWorkerClient implements BackupKernelPort, KernelObservationPort {
  constructor(
    private readonly database: DatabaseRuntime,
    private readonly kernel: KernelPrivateClient,
    @Inject(BACKUP_REQUEST_TIMEOUT_MILLISECONDS)
    private readonly backupRequestTimeoutMilliseconds: number,
    @Inject(MAXIMUM_BACKUP_BYTES)
    private readonly maximumBackupBytes: number,
    @Inject(MAXIMUM_BACKUP_FILES)
    private readonly maximumBackupFiles: number,
  ) {}

  /** 以当前空间的 ready 部署生成备份流，并在响应头边界校验元数据后把流所有权交给对象存储。 */
  async createBackup(job: BackupSpaceJob, signal: AbortSignal) {
    const deployment = await this.#deployment(job.spaceId);
    const response = await this.kernel.request({
      deployment,
      headers: {
        [KERNEL_BACKUP_MAXIMUM_BYTES_HEADER]: String(this.maximumBackupBytes),
        [KERNEL_BACKUP_MAXIMUM_FILES_HEADER]: String(this.maximumBackupFiles),
      },
      method: "POST",
      path: WORKER_BACKUP_PATH,
      requestId: job.requestId,
      signal,
      timeoutMilliseconds: this.backupRequestTimeoutMilliseconds,
    });
    if (response.status !== 200) {
      response.message.destroy();
      throw new WorkerJobError("kernel-backup-failed", null);
    }
    try {
      const formatVersion = Number(
        header(response.message, "x-singularity-backup-format-version"),
      );
      const kernelVersion = header(
        response.message,
        "x-singularity-kernel-version",
      );
      const sha256 = header(
        response.message,
        "x-singularity-backup-sha256",
      );
      if (
        !Number.isSafeInteger(formatVersion) ||
        formatVersion < 1 ||
        kernelVersion.trim().length === 0 ||
        !SHA256_PATTERN.test(sha256)
      ) {
        throw new WorkerJobError("kernel-response-invalid", null);
      }
      return {
        body: response.message,
        formatVersion,
        kernelVersion,
        sha256,
      };
    } catch (error) {
      response.message.destroy();
      throw error;
    }
  }

  /** 读取指定 Kernel 的健康与容量样本，返回本次请求实际使用的部署句柄供事务复验。 */
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
      response.message.destroy();
      throw new WorkerJobError("kernel-observation-failed", null);
    }
    return {
      deploymentHandle: deployment.handle,
      sample: parseKernelObservationResponse(
        await readObservation(response.message),
      ),
    };
  }

  /** 从数据库解析当前空间 ready 部署，并可额外锁定预期 Kernel 实例身份。 */
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
