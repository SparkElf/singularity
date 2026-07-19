import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  constants,
  link,
  lstat,
  mkdtemp,
  open,
  opendir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
  type FileHandle,
} from "node:fs/promises";
import { request as requestHttps } from "node:https";
import { createServer } from "node:net";
import { join, relative, resolve, sep } from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import { createSecureContext } from "node:tls";

import type {
  OnApplicationShutdown,
  OnModuleInit,
} from "@nestjs/common";
import { Inject, Injectable } from "@nestjs/common";
import { DatabaseRuntime, Prisma } from "@singularity/database";
import {
  createKernelDeployment,
  KERNEL_DEPLOYMENT_CHANGED_CHANNEL,
  kernelDeploymentInstanceIdSchema,
  kernelRuntimeEndpointSchema,
  RuntimeKernelDeploymentRegistry,
  type KernelDeploymentChangedEvent,
  type KernelRuntimeEndpoint,
} from "@singularity/kernel-client";
import { z } from "zod";

import type { RestoreDeploymentConfiguration } from "./configuration.js";
import type { RestoreDeploymentPort } from "./l1-handlers.js";
import { WORKER_JOB_LOGGER } from "./tokens.js";
import type { RestoreSpaceJob, WorkerJobLogger } from "./worker.js";

export const RESTORE_PLATFORM_CONFIGURATION = Symbol(
  "RESTORE_PLATFORM_CONFIGURATION",
);

const READY_PATH = "/internal/readyz";
const RESTORE_ARCHIVE_COMMAND = "restore-archive";
const RESTORE_ARCHIVE_FORMAT_VERSION = 1;
const RESTORE_KERNEL_HOSTNAME = "127.0.0.1";
const MAXIMUM_PROCESS_OUTPUT_BYTES = 64 * 1_024;
const MAXIMUM_READY_BODY_BYTES = 64 * 1_024;
const PROCESS_TERMINATION_GRACE_MILLISECONDS = 5_000;
const PROCESS_TERMINATION_POLL_MILLISECONDS = 50;

const restoreToolResultSchema = z
  .object({
    fileCount: z.number().int().min(0),
    formatVersion: z.literal(RESTORE_ARCHIVE_FORMAT_VERSION),
    kernelVersion: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9.+_-]{0,63}$/),
    sourceSpaceId: z.string().uuid(),
    totalSizeBytes: z.number().int().min(0),
  })
  .strict();

const readyResponseSchema = z
  .object({
    kernelInstanceId: z.string().uuid(),
    status: z.literal("ready"),
    version: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9.+_-]{0,63}$/),
  })
  .strict();

const runtimeMetadataSchema = kernelRuntimeEndpointSchema
  .extend({
    pid: z.number().int().positive().nullable(),
    state: z.enum(["ready", "starting"]),
    workspaceDirectoryName: z
      .string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/),
  })
  .strict();

export type RestoreDeploymentErrorCode =
  | "archive-digest-mismatch"
  | "archive-source-mismatch"
  | "archive-staging-failed"
  | "configuration-invalid"
  | "kernel-exited"
  | "kernel-readiness-failed"
  | "kernel-start-failed"
  | "port-unavailable"
  | "restore-aborted"
  | "restore-tool-failed"
  | "restore-tool-result-invalid"
  | "target-already-exists"
  | "target-cleanup-failed"
  | "target-identity-invalid"
  | "target-runtime-invalid"
  | "workspace-invalid";

export class RestoreDeploymentError extends Error {
  constructor(
    readonly code: RestoreDeploymentErrorCode,
    readonly diagnostic?: string,
    options?: ErrorOptions,
  ) {
    super(
      diagnostic === undefined
        ? `Restore deployment failed: ${code}`
        : `Restore deployment failed: ${code} (${diagnostic})`,
      options,
    );
    this.name = "RestoreDeploymentError";
  }
}

interface StagedArchive {
  readonly archivePath: string;
  readonly directory: string;
}

interface ProcessResult {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stderr: string;
  readonly stdout: string;
}

interface ReadyResponse {
  readonly kernelInstanceId: string;
  readonly status: "ready";
  readonly version: string;
}

interface RuntimeEndpointRow {
  handle: string;
  hostname: string;
  kernelInstanceId: string;
  port: number;
  serverName: string;
  spaceId: string;
  tlsProfile: string;
}

interface TargetRuntime {
  readonly deploymentHandle: string;
  readonly hostname: string;
  readonly kernelInstanceId: string;
  readonly metadataPath: string;
  readonly port: number;
  process: ChildProcess | undefined;
  persistedPid: number | undefined;
  cleanupPromise: Promise<void> | undefined;
  lifecyclePromise: Promise<void>;
  removed: boolean;
  registered: boolean;
  readonly spaceId: string;
  readonly serverName: string;
  readonly tlsProfile: string;
  state: "ready" | "starting";
  stderrTail: string;
  readonly workspaceDirectory: string;
  readonly workspaceDirectoryName: string;
}

interface PersistedProcessIdentity {
  readonly kernelInstanceId: string;
  readonly port?: number;
  readonly spaceId?: string;
  readonly workspaceDirectory: string;
}

function diagnosticText(value: string): string | undefined {
  const normalized = value
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (normalized.length === 0) {
    return undefined;
  }
  return normalized.slice(-512);
}

function isMissing(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

function isAddressInUse(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "EADDRINUSE"
  );
}

function isProcessMissing(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ESRCH"
  );
}

function isProcessInspectionUnavailable(error: unknown): boolean {
  return (
    isMissing(error) ||
    (typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error.code === "EACCES" || error.code === "EPERM"))
  );
}

function errorCause(error: unknown): ErrorOptions | undefined {
  return error === undefined ? undefined : { cause: error };
}

function processArgument(
  arguments_: readonly string[],
  name: string,
): string | undefined {
  let count = 0;
  let value: string | undefined;
  for (let index = 0; index < arguments_.length; index += 1) {
    if (arguments_[index] !== name) {
      continue;
    }
    count += 1;
    const next = arguments_[index + 1];
    if (next === undefined || next.startsWith("-")) {
      return undefined;
    }
    value = next;
  }
  return count === 1 ? value : undefined;
}

function processEnvironmentValue(
  entries: readonly string[],
  name: string,
): string | undefined {
  let count = 0;
  let value: string | undefined;
  for (const entry of entries) {
    const separator = entry.indexOf("=");
    const key = separator < 0 ? entry : entry.slice(0, separator);
    if (key !== name) {
      continue;
    }
    count += 1;
    value = separator < 0 ? undefined : entry.slice(separator + 1);
  }
  return count === 1 ? value : undefined;
}

function childPath(root: string, name: string): string {
  const target = resolve(root, name);
  const path = relative(root, target);
  if (path === "" || path === ".." || path.startsWith(`..${sep}`)) {
    throw new RestoreDeploymentError("target-identity-invalid");
  }
  return target;
}

@Injectable()
export class ProcessRestoreDeployment
  implements RestoreDeploymentPort, OnApplicationShutdown, OnModuleInit
{
  readonly #allocatedPorts = new Set<number>();
  readonly #configuration: RestoreDeploymentConfiguration;
  #portLock: Promise<void> = Promise.resolve();
  readonly #targets = new Map<string, TargetRuntime>();

  constructor(
    @Inject(RESTORE_PLATFORM_CONFIGURATION)
    configuration: RestoreDeploymentConfiguration,
    private readonly database: DatabaseRuntime,
    @Inject(RuntimeKernelDeploymentRegistry)
    private readonly deployments: RuntimeKernelDeploymentRegistry,
    @Inject(WORKER_JOB_LOGGER)
    private readonly logger: WorkerJobLogger,
  ) {
    this.#configuration = configuration;
  }

  // ready目标的进程和工作区属于恢复实例，不随Worker控制面进程关闭而删除；启动中的目标必须收敛为失败清理。
  async onApplicationShutdown(): Promise<void> {
    const results = await Promise.allSettled(
      [...this.#targets.values()]
        .filter(
          (target) =>
            target.state === "starting" || !target.registered || target.removed,
        )
        .map((target) => this.#removeTarget(target)),
    );
    if (results.some((result) => result.status === "rejected")) {
      throw new RestoreDeploymentError("target-cleanup-failed");
    }
  }

  async onModuleInit(): Promise<void> {
    await this.#assertPlatformConfiguration();
    await this.#sweepOrphanArtifacts();
    await this.#adoptPersistedTargets();
    await this.#reconcilePersistedTargets();
  }

  async restore(
    input: {
      archive: AsyncIterable<Uint8Array>;
      expectedSha256: string;
      job: RestoreSpaceJob;
    },
    signal: AbortSignal,
  ): Promise<{ endpoint: KernelRuntimeEndpoint; kernelVersion: string }> {
    signal.throwIfAborted();

    const target = await this.#createTarget(input.job);
    let staged: StagedArchive | undefined;
    try {
      await this.#writeRuntimeMetadata(target, false);
      staged = await this.#stageArchive(
        input.archive,
        input.expectedSha256,
        input.job,
        signal,
      );
      const manifest = await this.#extractArchive(
        staged.archivePath,
        input.expectedSha256,
        target.workspaceDirectory,
        signal,
      );
      if (manifest.sourceSpaceId !== input.job.sourceSpaceId) {
        throw new RestoreDeploymentError("archive-source-mismatch");
      }
      await this.#verifyWorkspace(target.workspaceDirectory);
      signal.throwIfAborted();
      if (target.removed) {
        throw new RestoreDeploymentError("restore-aborted");
      }

      await this.#startKernel(target, input.job);
      const ready = await this.#waitForKernel(
        target,
        input.job,
        manifest.kernelVersion,
        signal,
      );
      await this.#withTargetLifecycle(target, async () => {
        signal.throwIfAborted();
        if (target.removed) {
          throw new RestoreDeploymentError("restore-aborted");
        }
        target.state = "ready";
        await this.#writeRuntimeMetadata(target, true);
        signal.throwIfAborted();
        if (target.removed) {
          throw new RestoreDeploymentError("restore-aborted");
        }
        try {
          this.deployments.register(this.#deployment(target));
          target.registered = true;
        } catch (error) {
          throw new RestoreDeploymentError(
            "target-runtime-invalid",
            undefined,
            errorCause(error),
          );
        }
        target.process?.stderr?.destroy();
        target.process?.unref();
      });
      return {
        endpoint: this.#endpoint(target),
        kernelVersion: ready.version,
      };
    } catch (error) {
      let cleanupError: unknown;
      try {
        await this.#removeTarget(target);
      } catch (failure) {
        cleanupError = failure;
      }
      if (cleanupError !== undefined) {
        throw new RestoreDeploymentError(
          "target-cleanup-failed",
          undefined,
          errorCause(cleanupError),
        );
      }
      if (signal.aborted) {
        throw new RestoreDeploymentError(
          "restore-aborted",
          undefined,
          errorCause(signal.reason),
        );
      }
      if (error instanceof RestoreDeploymentError) {
        throw error;
      }
      throw new RestoreDeploymentError(
        "kernel-start-failed",
        undefined,
        errorCause(error),
      );
    } finally {
      if (staged !== undefined) {
        await rm(staged.directory, { force: true, recursive: true });
      }
    }
  }

  async destroyTarget(job: RestoreSpaceJob): Promise<void> {
    const active = this.#targets.get(job.targetKernelInstanceId);
    if (active !== undefined) {
      if (active.spaceId !== job.targetSpaceId) {
        throw new RestoreDeploymentError("target-runtime-invalid");
      }
      await this.#removeTarget(active);
      return;
    }

    const metadataPath = this.#metadataPath(job.targetKernelInstanceId);
    const workspaceDirectory = childPath(
      this.#configuration.runtimeRootDirectory,
      this.#workspaceDirectoryName(job),
    );
    let metadata: z.infer<typeof runtimeMetadataSchema>;
    try {
      metadata = await this.#readRuntimeMetadata(metadataPath);
    } catch (error) {
      if (isMissing(error)) {
        const identity: PersistedProcessIdentity = {
          kernelInstanceId: job.targetKernelInstanceId,
          spaceId: job.targetSpaceId,
          workspaceDirectory,
        };
        await this.#terminatePersistedTargetProcesses(null, identity);
        await this.#removeWorkspaceAndMetadata(workspaceDirectory, metadataPath);
        return;
      }
      if (error instanceof RestoreDeploymentError) {
        throw error;
      }
      throw new RestoreDeploymentError(
        "target-runtime-invalid",
        undefined,
        errorCause(error),
      );
    }
    if (
      metadata.kernelInstanceId !== job.targetKernelInstanceId ||
      metadata.spaceId !== job.targetSpaceId ||
      metadata.handle !== this.#deploymentHandle(job) ||
      metadata.hostname !== this.#configuration.gatewayHostname ||
      metadata.serverName !== this.#configuration.tls.serverName ||
      metadata.tlsProfile !== this.#configuration.tls.deploymentProfile ||
      metadata.port < this.#configuration.portRange.first ||
      metadata.port > this.#configuration.portRange.last ||
      metadata.workspaceDirectoryName !== this.#workspaceDirectoryName(job)
    ) {
      throw new RestoreDeploymentError("target-runtime-invalid");
    }
    this.deployments.unregister({
      handle: metadata.handle,
      kernelInstanceId: metadata.kernelInstanceId,
      spaceId: metadata.spaceId,
    });
    const identity: PersistedProcessIdentity = {
      kernelInstanceId: metadata.kernelInstanceId,
      port: metadata.port,
      spaceId: metadata.spaceId,
      workspaceDirectory,
    };
    await this.#terminatePersistedTargetProcesses(metadata.pid, identity);
    await this.#removeWorkspaceAndMetadata(workspaceDirectory, metadataPath);
    this.#allocatedPorts.delete(metadata.port);
  }

  async #createTarget(job: RestoreSpaceJob): Promise<TargetRuntime> {
    if (this.#targets.has(job.targetKernelInstanceId)) {
      throw new RestoreDeploymentError("target-already-exists");
    }
    const workspaceDirectoryName = this.#workspaceDirectoryName(job);
    const workspaceDirectory = childPath(
      this.#configuration.runtimeRootDirectory,
      workspaceDirectoryName,
    );
    const metadataPath = this.#metadataPath(job.targetKernelInstanceId);
    for (const path of [workspaceDirectory, metadataPath]) {
      try {
        await lstat(path);
        throw new RestoreDeploymentError("target-already-exists");
      } catch (error) {
        if (!isMissing(error)) {
          throw error;
        }
      }
    }
    const target: TargetRuntime = {
      deploymentHandle: this.#deploymentHandle(job),
      hostname: this.#configuration.gatewayHostname,
      kernelInstanceId: job.targetKernelInstanceId,
      metadataPath,
      port: await this.#allocatePort(),
      process: undefined,
      persistedPid: undefined,
      cleanupPromise: undefined,
      lifecyclePromise: Promise.resolve(),
      removed: false,
      registered: false,
      spaceId: job.targetSpaceId,
      serverName: this.#configuration.tls.serverName,
      tlsProfile: this.#configuration.tls.deploymentProfile,
      state: "starting",
      stderrTail: "",
      workspaceDirectory,
      workspaceDirectoryName,
    };
    this.#targets.set(job.targetKernelInstanceId, target);
    return target;
  }

  #workspaceDirectoryName(job: RestoreSpaceJob): string {
    return `${this.#configuration.handlePrefix}-${job.targetKernelInstanceId}`;
  }

  #deploymentHandle(job: RestoreSpaceJob): string {
    return `${this.#configuration.handlePrefix}-${job.targetKernelInstanceId}`;
  }

  #endpoint(target: TargetRuntime): KernelRuntimeEndpoint {
    return {
      handle: target.deploymentHandle,
      hostname: target.hostname,
      kernelInstanceId: target.kernelInstanceId,
      port: target.port,
      serverName: target.serverName,
      spaceId: target.spaceId,
      tlsProfile: target.tlsProfile,
    };
  }

  #deployment(target: TargetRuntime) {
    return createKernelDeployment(
      this.#endpoint(target),
      {
        caCertificate: this.#configuration.tls.caCertificate,
        clientCertificate: this.#configuration.tls.clientCertificate,
        clientPrivateKey: this.#configuration.tls.clientPrivateKey,
      },
    );
  }

  #metadataPath(kernelInstanceId: string): string {
    return childPath(
      this.#configuration.runtimeRootDirectory,
      `.${this.#configuration.handlePrefix}-${kernelInstanceId}.json`,
    );
  }

  async #stageArchive(
    source: AsyncIterable<Uint8Array>,
    expectedSha256: string,
    job: RestoreSpaceJob,
    signal: AbortSignal,
  ): Promise<StagedArchive> {
    await this.#assertTrustedDirectory(
      this.#configuration.runtimeRootDirectory,
    );
    const directory = await mkdtemp(
      join(
        this.#configuration.runtimeRootDirectory,
        `.${this.#configuration.handlePrefix}-${job.targetKernelInstanceId}-`,
      ),
    );
    const archivePath = join(directory, "archive.zip");
    let handle: FileHandle | undefined;
    try {
      handle = await open(
        archivePath,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
        0o600,
      );
      const digest = createHash("sha256");
      let sizeBytes = 0;
      for await (const rawChunk of source) {
        signal.throwIfAborted();
        const chunk = Buffer.from(
          rawChunk.buffer,
          rawChunk.byteOffset,
          rawChunk.byteLength,
        );
        sizeBytes += chunk.byteLength;
        if (sizeBytes > this.#configuration.maximumArchiveBytes) {
          throw new RestoreDeploymentError("archive-staging-failed");
        }
        digest.update(chunk);
        await this.#writeAll(handle, chunk);
      }
      await handle.sync();
      await handle.close();
      handle = undefined;
      if (digest.digest("hex") !== expectedSha256) {
        throw new RestoreDeploymentError("archive-digest-mismatch");
      }
      return { archivePath, directory };
    } catch (error) {
      if (handle !== undefined) {
        await handle.close();
      }
      await rm(directory, { force: true, recursive: true });
      if (error instanceof RestoreDeploymentError) {
        throw error;
      }
      throw new RestoreDeploymentError(
        "archive-staging-failed",
        undefined,
        errorCause(error),
      );
    }
  }

  async #writeAll(handle: FileHandle, bytes: Buffer): Promise<void> {
    let offset = 0;
    while (offset < bytes.byteLength) {
      const { bytesWritten } = await handle.write(
        bytes,
        offset,
        bytes.byteLength - offset,
        null,
      );
      if (bytesWritten < 1) {
        throw new RestoreDeploymentError("archive-staging-failed");
      }
      offset += bytesWritten;
    }
  }

  async #extractArchive(
    archivePath: string,
    expectedSha256: string,
    workspaceDirectory: string,
    signal: AbortSignal,
  ): Promise<z.infer<typeof restoreToolResultSchema>> {
    const result = await this.#runProcess(
      this.#configuration.archiveToolPath,
      [
        "workspace",
        RESTORE_ARCHIVE_COMMAND,
        "--archive",
        archivePath,
        "--destination",
        workspaceDirectory,
        "--expected-sha256",
        expectedSha256,
        "--maximum-archive-bytes",
        String(this.#configuration.maximumArchiveBytes),
        "--maximum-entry-bytes",
        String(this.#configuration.maximumEntryBytes),
        "--maximum-files",
        String(this.#configuration.maximumFiles),
        "--maximum-total-bytes",
        String(this.#configuration.maximumTotalBytes),
        "--output",
        "json",
      ],
      signal,
    );
    if (result.code !== 0) {
      throw new RestoreDeploymentError(
        "restore-tool-failed",
        diagnosticText(result.stderr) ?? `exit=${result.code ?? result.signal}`,
      );
    }
    let value: unknown;
    try {
      value = JSON.parse(result.stdout) as unknown;
    } catch (error) {
      throw new RestoreDeploymentError(
        "restore-tool-result-invalid",
        undefined,
        errorCause(error),
      );
    }
    const parsed = restoreToolResultSchema.safeParse(value);
    if (
      !parsed.success ||
      parsed.data.fileCount > this.#configuration.maximumFiles ||
      parsed.data.totalSizeBytes > this.#configuration.maximumTotalBytes
    ) {
      throw new RestoreDeploymentError("restore-tool-result-invalid");
    }
    return parsed.data;
  }

  async #runProcess(
    executable: string,
    arguments_: readonly string[],
    signal: AbortSignal,
  ): Promise<ProcessResult> {
    await Promise.all([
      this.#assertTrustedExecutable(executable),
      this.#assertTrustedDirectory(this.#configuration.kernelWorkingDirectory),
    ]);
    const child = spawn(executable, arguments_, {
      cwd: this.#configuration.kernelWorkingDirectory,
      env: this.#childEnvironment(),
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let interrupt = (_reason: "abort" | "output-limit" | "timeout"): void => {
      return;
    };
    const interrupted = new Promise<
      "abort" | "output-limit" | "timeout"
    >((resolveInterrupt) => {
      interrupt = resolveInterrupt;
    });
    let stderr: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let stdout: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    const append = (
      current: Buffer<ArrayBufferLike>,
      raw: unknown,
    ): Buffer<ArrayBufferLike> => {
      const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw));
      const next = Buffer.concat([current, chunk]);
      if (next.byteLength > MAXIMUM_PROCESS_OUTPUT_BYTES) {
        interrupt("output-limit");
        return next.subarray(next.byteLength - MAXIMUM_PROCESS_OUTPUT_BYTES);
      }
      return next;
    };
    child.stdout?.on("data", (chunk: unknown) => {
      stdout = append(stdout, chunk);
    });
    child.stderr?.on("data", (chunk: unknown) => {
      stderr = append(stderr, chunk);
    });
    const timeout = setTimeout(() => {
      interrupt("timeout");
    }, this.#configuration.startupTimeoutMilliseconds);
    timeout.unref();
    const abort = (): void => {
      interrupt("abort");
    };
    if (signal.aborted) {
      abort();
    } else {
      signal.addEventListener("abort", abort, { once: true });
    }
    try {
      const closed = new Promise<ProcessResult>((resolveProcess, rejectProcess) => {
        child.once("error", rejectProcess);
        child.once("close", (code, closeSignal) => {
          resolveProcess({
            code,
            signal: closeSignal,
            stderr: stderr.toString("utf8"),
            stdout: stdout.toString("utf8"),
          });
        });
      });
      const outcome = await Promise.race([
        closed.then((result) => ({ result, type: "closed" as const })),
        interrupted.then((reason) => ({ reason, type: "interrupted" as const })),
      ]);
      if (outcome.type === "interrupted") {
        await this.#terminateProcess(child);
        if (outcome.reason === "abort") {
          throw new RestoreDeploymentError("restore-aborted");
        }
        throw new RestoreDeploymentError(
          "restore-tool-failed",
          outcome.reason,
        );
      }
      return outcome.result;
    } catch (error) {
      await this.#terminateProcess(child);
      if (error instanceof RestoreDeploymentError) {
        throw error;
      }
      throw new RestoreDeploymentError(
        "restore-tool-failed",
        diagnosticText(stderr.toString("utf8")),
        errorCause(error),
      );
    } finally {
      clearTimeout(timeout);
      signal.removeEventListener("abort", abort);
    }
  }

  async #verifyWorkspace(workspaceDirectory: string): Promise<void> {
    const root = await lstat(workspaceDirectory);
    if (!root.isDirectory() || root.isSymbolicLink()) {
      throw new RestoreDeploymentError("workspace-invalid");
    }
    if ((await realpath(workspaceDirectory)) !== workspaceDirectory) {
      throw new RestoreDeploymentError("workspace-invalid");
    }
    const data = await lstat(join(workspaceDirectory, "data"));
    if (!data.isDirectory() || data.isSymbolicLink()) {
      throw new RestoreDeploymentError("workspace-invalid");
    }
  }

  async #assertPlatformConfiguration(): Promise<void> {
    try {
      await Promise.all([
        this.#assertTrustedExecutable(this.#configuration.archiveToolPath),
        this.#assertKernelLaunchConfiguration(),
      ]);
      const { first, last } = this.#configuration.portRange;
      if (
        !Number.isInteger(first) ||
        !Number.isInteger(last) ||
        first < 1 ||
        last > 65_535 ||
        first > last
      ) {
        throw new RestoreDeploymentError("configuration-invalid");
      }
    } catch (error) {
      if (
        error instanceof RestoreDeploymentError &&
        error.code === "configuration-invalid"
      ) {
        throw error;
      }
      throw new RestoreDeploymentError(
        "configuration-invalid",
        undefined,
        errorCause(error),
      );
    }
  }

  async #assertKernelLaunchConfiguration(): Promise<void> {
    try {
      await Promise.all([
        this.#assertTrustedExecutable(this.#configuration.kernelBinaryPath),
        this.#assertTrustedDirectory(
          this.#configuration.kernelWorkingDirectory,
        ),
        this.#assertTrustedDirectory(this.#configuration.runtimeRootDirectory),
        this.#assertTrustedFile(
          this.#configuration.tls.clientCaCertificateFile,
        ),
        this.#assertTrustedFile(
          this.#configuration.tls.serverCertificateFile,
        ),
        this.#assertTrustedFile(this.#configuration.tls.serverPrivateKeyFile),
        this.#assertTrustedFile(this.#configuration.tls.servicePublicKeysFile),
      ]);
      const [serverCertificate, serverPrivateKey] = await Promise.all([
        readFile(this.#configuration.tls.serverCertificateFile),
        readFile(this.#configuration.tls.serverPrivateKeyFile),
      ]);
      createSecureContext({
        ca: this.#configuration.tls.caCertificate,
        cert: this.#configuration.tls.clientCertificate,
        key: this.#configuration.tls.clientPrivateKey,
        minVersion: "TLSv1.3",
      });
      createSecureContext({
        cert: serverCertificate,
        key: serverPrivateKey,
        minVersion: "TLSv1.3",
      });
    } catch (error) {
      if (
        error instanceof RestoreDeploymentError &&
        error.code === "configuration-invalid"
      ) {
        throw error;
      }
      throw new RestoreDeploymentError(
        "configuration-invalid",
        undefined,
        errorCause(error),
      );
    }
  }

  async #startKernel(
    target: TargetRuntime,
    job: RestoreSpaceJob,
  ): Promise<void> {
    await this.#assertKernelLaunchConfiguration();
    const child = spawn(
      this.#configuration.kernelBinaryPath,
      [
        "serve",
        "--workspace",
        target.workspaceDirectory,
        "--wd",
        this.#configuration.kernelWorkingDirectory,
        "--port",
        String(target.port),
        "--mode",
        "prod",
        "--readonly",
        "false",
      ],
      {
        cwd: this.#configuration.kernelWorkingDirectory,
        detached: true,
        env: {
          ...this.#childEnvironment(),
          SINGULARITY_KERNEL_CLIENT_CA_FILE:
            this.#configuration.tls.clientCaCertificateFile,
          SINGULARITY_KERNEL_ENTERPRISE: "1",
          SINGULARITY_KERNEL_GATEWAY_CLIENT_DNS_NAME:
            this.#configuration.tls.gatewayClientDnsName,
          SINGULARITY_KERNEL_INSTANCE_ID: job.targetKernelInstanceId,
          SINGULARITY_KERNEL_LISTEN_ADDRESS: RESTORE_KERNEL_HOSTNAME,
          SINGULARITY_KERNEL_SERVICE_KEYS_FILE:
            this.#configuration.tls.servicePublicKeysFile,
          SINGULARITY_KERNEL_SPACE_ID: job.targetSpaceId,
          SINGULARITY_KERNEL_TLS_CERT_FILE:
            this.#configuration.tls.serverCertificateFile,
          SINGULARITY_KERNEL_TLS_KEY_FILE:
            this.#configuration.tls.serverPrivateKeyFile,
          SIYUAN_WORKSPACE_PATH: target.workspaceDirectory,
        },
        shell: false,
        stdio: ["ignore", "ignore", "pipe"],
        windowsHide: true,
      },
    );
    target.process = child;
    child.stderr?.on("data", (raw: unknown) => {
      const chunk = Buffer.isBuffer(raw) ? raw.toString("utf8") : String(raw);
      target.stderrTail = (target.stderrTail + chunk).slice(
        -MAXIMUM_PROCESS_OUTPUT_BYTES,
      );
    });
  }

  async #waitForKernel(
    target: TargetRuntime,
    job: RestoreSpaceJob,
    expectedKernelVersion: string,
    signal: AbortSignal,
  ): Promise<ReadyResponse> {
    const child = target.process;
    if (child === undefined) {
      throw new RestoreDeploymentError("kernel-start-failed");
    }
    let spawnFailure: unknown;
    child.once("error", (error) => {
      spawnFailure = error;
    });
    const deadline = Date.now() + this.#configuration.startupTimeoutMilliseconds;
    let lastDiagnostic: string | undefined;
    while (Date.now() < deadline) {
      signal.throwIfAborted();
      if (spawnFailure !== undefined) {
        throw new RestoreDeploymentError(
          "kernel-start-failed",
          undefined,
          errorCause(spawnFailure),
        );
      }
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new RestoreDeploymentError(
          "kernel-exited",
          this.#processDiagnostic(target),
        );
      }
      try {
        const ready = await this.#readReady(target.port, job, signal);
        if (ready !== null) {
          if (
            ready.kernelInstanceId !== job.targetKernelInstanceId ||
            ready.version !== expectedKernelVersion
          ) {
            throw new RestoreDeploymentError("kernel-readiness-failed");
          }
          return ready;
        }
      } catch (error) {
        if (error instanceof RestoreDeploymentError) {
          throw error;
        }
        lastDiagnostic =
          error instanceof Error ? diagnosticText(error.message) : undefined;
      }
      await wait(this.#configuration.readinessPollMilliseconds, undefined, {
        signal,
      });
    }
    throw new RestoreDeploymentError(
      "kernel-readiness-failed",
      lastDiagnostic ?? this.#processDiagnostic(target),
    );
  }

  async #readReady(
    port: number,
    job: RestoreSpaceJob,
    signal: AbortSignal,
  ): Promise<ReadyResponse | null> {
    const token = this.#configuration.credentials.sign({
      kernelInstanceId: job.targetKernelInstanceId,
      requestId: job.requestId,
      spaceId: job.targetSpaceId,
    });
    return new Promise<ReadyResponse | null>((resolveReady, rejectReady) => {
      let settled = false;
      let responseEnded = false;
      let responseReceived = false;
      let abort = (): void => undefined;
      const settle = (callback: () => void): void => {
        if (settled) {
          return;
        }
        settled = true;
        signal.removeEventListener("abort", abort);
        callback();
      };
      const resolve = (value: ReadyResponse | null): void => {
        settle(() => resolveReady(value));
      };
      const reject = (error: unknown): void => {
        settle(() => rejectReady(error));
      };
      const request = requestHttps(
        {
          agent: false,
          ca: this.#configuration.tls.caCertificate,
          cert: this.#configuration.tls.clientCertificate,
          headers: {
            "x-singularity-request-id": job.requestId,
            "x-singularity-service-token": token,
          },
          hostname: RESTORE_KERNEL_HOSTNAME,
          key: this.#configuration.tls.clientPrivateKey,
          method: "GET",
          minVersion: "TLSv1.3",
          path: READY_PATH,
          port,
          rejectUnauthorized: true,
          servername: this.#configuration.tls.serverName,
        },
        (response) => {
          responseReceived = true;
          if (response.statusCode !== 200) {
            response.resume();
            resolve(null);
            return;
          }
          const chunks: Buffer[] = [];
          let sizeBytes = 0;
          response.on("data", (raw: unknown) => {
            if (settled) {
              return;
            }
            const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw));
            sizeBytes += chunk.byteLength;
            if (sizeBytes > MAXIMUM_READY_BODY_BYTES) {
              reject(new RestoreDeploymentError("kernel-readiness-failed"));
              response.destroy();
              return;
            }
            chunks.push(chunk);
          });
          response.once("aborted", () => {
            reject(new RestoreDeploymentError("kernel-readiness-failed"));
          });
          response.once("error", reject);
          response.once("close", () => {
            if (!responseEnded) {
              reject(new RestoreDeploymentError("kernel-readiness-failed"));
            }
          });
          response.once("end", () => {
            responseEnded = true;
            if (settled) {
              return;
            }
            if (sizeBytes > MAXIMUM_READY_BODY_BYTES) {
              reject(new RestoreDeploymentError("kernel-readiness-failed"));
              return;
            }
            try {
              const parsed = readyResponseSchema.safeParse(
                JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown,
              );
              if (!parsed.success) {
                throw new RestoreDeploymentError("kernel-readiness-failed");
              }
              resolve(parsed.data);
            } catch (error) {
              reject(error);
            }
          });
        },
      );
      request.once("error", reject);
      request.once("close", () => {
        if (!settled && !responseReceived) {
          reject(new RestoreDeploymentError("kernel-readiness-failed"));
        }
      });
      const timeout = Math.min(
        2_000,
        Math.max(250, this.#configuration.readinessPollMilliseconds * 2),
      );
      request.setTimeout(timeout, () => request.destroy(new Error("timeout")));
      abort = (): void => {
        request.destroy(
          signal.reason instanceof Error
            ? signal.reason
            : new Error("aborted"),
        );
        reject(new RestoreDeploymentError("restore-aborted"));
      };
      if (signal.aborted) {
        abort();
      } else {
        signal.addEventListener("abort", abort, { once: true });
      }
      if (!settled) {
        request.end();
      }
    });
  }

  async #writeRuntimeMetadata(
    target: TargetRuntime,
    replace: boolean,
  ): Promise<void> {
    const pid = target.process?.pid ?? target.persistedPid ?? null;
    if (pid !== null && pid < 1) {
      throw new RestoreDeploymentError("target-runtime-invalid");
    }
    const temporaryPath = `${target.metadataPath}.partial`;
    const metadata = JSON.stringify({
      handle: target.deploymentHandle,
      hostname: target.hostname,
      kernelInstanceId: target.kernelInstanceId,
      pid,
      port: target.port,
      serverName: target.serverName,
      state: target.state,
      spaceId: target.spaceId,
      tlsProfile: target.tlsProfile,
      workspaceDirectoryName: target.workspaceDirectoryName,
    });
    await writeFile(temporaryPath, metadata, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    try {
      if (replace) {
        await rename(temporaryPath, target.metadataPath);
      } else {
        await link(temporaryPath, target.metadataPath);
        await unlink(temporaryPath);
      }
    } catch (error) {
      await rm(temporaryPath, { force: true });
      throw new RestoreDeploymentError(
        "target-runtime-invalid",
        undefined,
        errorCause(error),
      );
    }
  }

  async #removeTarget(target: TargetRuntime): Promise<void> {
    if (target.cleanupPromise !== undefined) {
      return target.cleanupPromise;
    }
    const cleanupPromise = this.#removeTargetInternal(target);
    target.cleanupPromise = cleanupPromise;
    try {
      await cleanupPromise;
    } finally {
      if (target.cleanupPromise === cleanupPromise) {
        target.cleanupPromise = undefined;
      }
    }
  }

  async #removeTargetInternal(target: TargetRuntime): Promise<void> {
    target.removed = true;
    await this.#withTargetLifecycle(target, async () => {
      if (target.registered) {
        this.deployments.unregister({
          handle: target.deploymentHandle,
          kernelInstanceId: target.kernelInstanceId,
          spaceId: target.spaceId,
        });
        target.registered = false;
      }
      if (target.process !== undefined) {
        await this.#terminateProcess(target.process);
      } else if (target.persistedPid !== undefined) {
        await this.#terminatePersistedProcess(target.persistedPid, {
          kernelInstanceId: target.kernelInstanceId,
          port: target.port,
          spaceId: target.spaceId,
          workspaceDirectory: target.workspaceDirectory,
        });
      }
      await this.#removeWorkspaceAndMetadata(
        target.workspaceDirectory,
        target.metadataPath,
      );
      this.#allocatedPorts.delete(target.port);
      this.#targets.delete(target.kernelInstanceId);
    });
  }

  async #withTargetLifecycle<T>(
    target: TargetRuntime,
    operation: () => Promise<T>,
  ): Promise<T> {
    const predecessor = target.lifecyclePromise;
    let release!: () => void;
    target.lifecyclePromise = new Promise<void>((resolveLifecycle) => {
      release = resolveLifecycle;
    });
    await predecessor;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  async #adoptPersistedTargets(): Promise<void> {
    const directory = await opendir(this.#configuration.runtimeRootDirectory);
    for await (const entry of directory) {
      const metadataName = `.${this.#configuration.handlePrefix}-`;
      if (
        !entry.name.startsWith(metadataName) ||
        !entry.name.endsWith(".json")
      ) {
        continue;
      }
      if (!entry.isFile()) {
        throw new RestoreDeploymentError("target-runtime-invalid");
      }
      const metadataPath = join(
        this.#configuration.runtimeRootDirectory,
        entry.name,
      );
      let parsed: z.infer<typeof runtimeMetadataSchema>;
      try {
        parsed = await this.#readRuntimeMetadata(metadataPath);
      } catch (error) {
        if (error instanceof RestoreDeploymentError) {
          throw error;
        }
        throw new RestoreDeploymentError(
          "target-runtime-invalid",
          undefined,
          errorCause(error),
        );
      }
      if (
        entry.name !==
          `.${this.#configuration.handlePrefix}-${parsed.kernelInstanceId}.json` ||
        parsed.handle !==
          `${this.#configuration.handlePrefix}-${parsed.kernelInstanceId}` ||
        parsed.hostname !== this.#configuration.gatewayHostname ||
        parsed.serverName !== this.#configuration.tls.serverName ||
        parsed.tlsProfile !== this.#configuration.tls.deploymentProfile ||
        parsed.workspaceDirectoryName !==
          `${this.#configuration.handlePrefix}-${parsed.kernelInstanceId}` ||
        parsed.port < this.#configuration.portRange.first ||
        parsed.port > this.#configuration.portRange.last ||
        (parsed.state === "ready" && parsed.pid === null) ||
        this.#targets.has(parsed.kernelInstanceId) ||
        this.#allocatedPorts.has(parsed.port)
      ) {
        throw new RestoreDeploymentError("target-runtime-invalid");
      }
      const workspaceDirectory = childPath(
        this.#configuration.runtimeRootDirectory,
        parsed.workspaceDirectoryName,
      );
      if (parsed.state === "starting") {
        if (await this.#hasActiveRestoreClaim(parsed.kernelInstanceId)) {
          continue;
        }
        const identity: PersistedProcessIdentity = {
          kernelInstanceId: parsed.kernelInstanceId,
          port: parsed.port,
          spaceId: parsed.spaceId,
          workspaceDirectory,
        };
        await this.#terminatePersistedTargetProcesses(parsed.pid, identity);
        await this.#removeWorkspaceAndMetadata(
          workspaceDirectory,
          metadataPath,
        );
        continue;
      }
      const workspaceValid = await this.#isTrustedPersistedWorkspace(
        workspaceDirectory,
      );
      if (!workspaceValid) {
        await this.#removeWorkspaceAndMetadata(
          workspaceDirectory,
          metadataPath,
        );
        continue;
      }
      if (parsed.pid === null) {
        throw new RestoreDeploymentError("target-runtime-invalid");
      }
      const processValid = await this.#assertPersistedProcessIdentity(parsed.pid, {
        kernelInstanceId: parsed.kernelInstanceId,
        port: parsed.port,
        spaceId: parsed.spaceId,
        workspaceDirectory,
      });
      if (!processValid) {
        await this.#removeWorkspaceAndMetadata(
          workspaceDirectory,
          metadataPath,
        );
        continue;
      }
      const target: TargetRuntime = {
        deploymentHandle: parsed.handle,
        hostname: parsed.hostname,
        kernelInstanceId: parsed.kernelInstanceId,
        metadataPath,
        port: parsed.port,
        persistedPid: parsed.pid ?? undefined,
        process: undefined,
        cleanupPromise: undefined,
        lifecyclePromise: Promise.resolve(),
        removed: false,
        registered: false,
        spaceId: parsed.spaceId,
        serverName: parsed.serverName,
        tlsProfile: parsed.tlsProfile,
        state: "ready",
        stderrTail: "",
        workspaceDirectory,
        workspaceDirectoryName: parsed.workspaceDirectoryName,
      };
      this.#targets.set(parsed.kernelInstanceId, target);
      this.#allocatedPorts.add(parsed.port);
    }
  }

  async #reconcilePersistedTargets(): Promise<void> {
    const rows = await this.database.client.$queryRaw<RuntimeEndpointRow[]>(
      Prisma.sql`
        SELECT
          kernel."deployment_handle" AS "handle",
          endpoint."hostname",
          endpoint."kernel_instance_id" AS "kernelInstanceId",
          endpoint."port",
          endpoint."server_name" AS "serverName",
          endpoint."space_id" AS "spaceId",
          endpoint."tls_profile" AS "tlsProfile"
        FROM "kernel_runtime_endpoints" AS endpoint
        INNER JOIN "kernel_instances" AS kernel
          ON kernel."id" = endpoint."kernel_instance_id"
          AND kernel."space_id" = endpoint."space_id"
        WHERE kernel."status" = 'ready'::"kernel_instance_status"
          AND kernel."deployment_handle" IS NOT NULL
      `,
    );
    const endpoints = rows.map((row) =>
      kernelRuntimeEndpointSchema.parse(row),
    );
    const byKernel = new Map(
      endpoints.map((endpoint) => [endpoint.kernelInstanceId, endpoint]),
    );
    const remove: TargetRuntime[] = [];
    for (const target of this.#targets.values()) {
      const endpoint = byKernel.get(target.kernelInstanceId);
      if (endpoint === undefined || !this.#sameEndpoint(endpoint, target)) {
        remove.push(target);
        continue;
      }
      this.deployments.register(this.#deployment(target));
      target.registered = true;
    }
    for (const target of remove) {
      await this.#removeTarget(target);
    }
    for (const endpoint of endpoints) {
      if (!this.#targets.has(endpoint.kernelInstanceId)) {
        await this.#removeStaleEndpoint(endpoint);
      }
    }
  }

  async #removeStaleEndpoint(endpoint: KernelRuntimeEndpoint): Promise<void> {
    const startedAt = performance.now();
    const requestId = randomUUID();
    const reconciliation = await this.database.client.$transaction(
      async (transaction) => {
        // Target lifecycle owners serialize on the space row.
        const spaces = await transaction.$queryRaw<
          Array<{ organizationId: string }>
        >(
          Prisma.sql`
            SELECT "organization_id" AS "organizationId"
            FROM "spaces"
            WHERE "id" = ${endpoint.spaceId}::uuid
            FOR UPDATE
          `,
        );
        const current = spaces[0];
        if (current === undefined) {
          return null;
        }
        const runtimes = await transaction.$queryRaw<
          Array<{ kernelInstanceId: string }>
        >(
          Prisma.sql`
            SELECT endpoint."kernel_instance_id" AS "kernelInstanceId"
            FROM "kernel_runtime_endpoints" AS endpoint
            INNER JOIN "kernel_instances" AS kernel
              ON kernel."id" = endpoint."kernel_instance_id"
              AND kernel."space_id" = endpoint."space_id"
            WHERE endpoint."kernel_instance_id" = ${endpoint.kernelInstanceId}::uuid
              AND endpoint."space_id" = ${endpoint.spaceId}::uuid
              AND kernel."deployment_handle" = ${endpoint.handle}
              AND kernel."status" = 'ready'::"kernel_instance_status"
            FOR UPDATE OF endpoint, kernel
          `,
        );
        if (runtimes[0] === undefined) {
          return null;
        }
        await transaction.$executeRaw(
          Prisma.sql`
            DELETE FROM "kernel_runtime_endpoints"
            WHERE "kernel_instance_id" = ${endpoint.kernelInstanceId}::uuid
              AND "space_id" = ${endpoint.spaceId}::uuid
          `,
        );
        await transaction.$executeRaw(
          Prisma.sql`
            UPDATE "kernel_instances"
            SET "status" = 'unavailable'::"kernel_instance_status"
            WHERE "id" = ${endpoint.kernelInstanceId}::uuid
              AND "space_id" = ${endpoint.spaceId}::uuid
              AND "deployment_handle" = ${endpoint.handle}
              AND "status" = 'ready'::"kernel_instance_status"
          `,
        );
        const failedRestores = await transaction.$queryRaw<
          Array<{ restoreId: string; sourceSpaceId: string }>
        >(
          Prisma.sql`
            UPDATE "space_restore_jobs"
            SET "status" = 'failed'::"space_restore_status",
                "target_space_id" = NULL,
                "completed_at" = CURRENT_TIMESTAMP,
                "failure_code" = 'restore-runtime-lost'
            WHERE "target_space_id" = ${endpoint.spaceId}::uuid
              AND "status" = 'ready-for-activation'::"space_restore_status"
            RETURNING
              "id" AS "restoreId",
              "source_space_id" AS "sourceSpaceId"
          `,
        );
        const failedRestore = failedRestores[0];
        if (failedRestore !== undefined) {
          await transaction.$executeRaw(
            Prisma.sql`
              DELETE FROM "space_capacity_observations"
              WHERE "space_id" = ${endpoint.spaceId}::uuid
            `,
          );
          await transaction.$executeRaw(
            Prisma.sql`
              DELETE FROM "kernel_health_observations"
              WHERE "kernel_instance_id" = ${endpoint.kernelInstanceId}::uuid
            `,
          );
          await transaction.$executeRaw(
            Prisma.sql`
              DELETE FROM "space_memberships"
              WHERE "space_id" = ${endpoint.spaceId}::uuid
            `,
          );
          await transaction.$executeRaw(
            Prisma.sql`
              DELETE FROM "space_group_grants"
              WHERE "organization_id" = ${current.organizationId}::uuid
                AND "space_id" = ${endpoint.spaceId}::uuid
            `,
          );
          await transaction.$executeRaw(
            Prisma.sql`
              DELETE FROM "document_shares"
              WHERE "organization_id" = ${current.organizationId}::uuid
                AND "space_id" = ${endpoint.spaceId}::uuid
            `,
          );
          await transaction.$executeRaw(
            Prisma.sql`
              DELETE FROM "kernel_instances"
              WHERE "id" = ${endpoint.kernelInstanceId}::uuid
                AND "space_id" = ${endpoint.spaceId}::uuid
            `,
          );
          await transaction.$executeRaw(
            Prisma.sql`
              DELETE FROM "spaces"
              WHERE "id" = ${endpoint.spaceId}::uuid
                AND "organization_id" = ${current.organizationId}::uuid
            `,
          );
        }
        const event = {
          kernelInstanceId: endpoint.kernelInstanceId,
          kind: "remove",
          requestId,
          spaceId: endpoint.spaceId,
        } satisfies KernelDeploymentChangedEvent;
        await transaction.$executeRaw(
          Prisma.sql`SELECT pg_notify(
            ${KERNEL_DEPLOYMENT_CHANGED_CHANNEL},
            ${JSON.stringify(event)}
          )`,
        );
        return { failedRestore };
      },
    );
    if (reconciliation === null) {
      return;
    }
    const elapsedMs = performance.now() - startedAt;
    const failedRestore = reconciliation.failedRestore;
    if (failedRestore !== undefined) {
      this.logger.warn({
        elapsedMs,
        event: "backup.job",
        objectKey: null,
        reason: "restore-runtime-lost",
        requestId,
        spaceId: failedRestore.sourceSpaceId,
        status: "failed",
        targetSpaceId: endpoint.spaceId,
        taskId: failedRestore.restoreId,
        taskKind: "restore",
        validationResult: "passed",
      });
    }
    this.logger.warn({
      elapsedMs,
      event: "kernel.lifecycle",
      fromState: "ready",
      kernelInstanceId: endpoint.kernelInstanceId,
      reason: "restore-runtime-lost",
      requestId,
      spaceId: endpoint.spaceId,
      toState: failedRestore === undefined ? "unavailable" : "removed",
    });
  }

  async #hasActiveRestoreClaim(kernelInstanceId: string): Promise<boolean> {
    const rows = await this.database.client.$queryRaw<Array<{ active: boolean }>>(
      Prisma.sql`
        SELECT EXISTS (
          SELECT 1
          FROM "space_restore_jobs" AS restore
          INNER JOIN "worker_jobs" AS claim
            ON claim."id" = restore."worker_job_id"
            AND claim."attempt" = restore."worker_attempt"
          INNER JOIN "spaces" AS target_space
            ON target_space."id" = restore."target_space_id"
          INNER JOIN "kernel_instances" AS kernel
            ON kernel."space_id" = target_space."id"
          WHERE kernel."id" = ${kernelInstanceId}::uuid
            AND restore."status" = 'restoring'::"space_restore_status"
            AND claim."status" = 'running'::"worker_job_status"
            AND claim."lease_expires_at" > CURRENT_TIMESTAMP
        ) AS "active"
      `,
    );
    return rows[0]?.active === true;
  }

  async #sweepOrphanArtifacts(): Promise<void> {
    const directory = await opendir(this.#configuration.runtimeRootDirectory);
    const metadataPrefix = `.${this.#configuration.handlePrefix}-`;
    const workspacePrefix = `${this.#configuration.handlePrefix}-`;
    for await (const entry of directory) {
      const isMetadata =
        entry.name.startsWith(metadataPrefix) && entry.name.endsWith(".json");
      if (isMetadata) {
        continue;
      }
      const isStaging = entry.name.startsWith(metadataPrefix);
      const isWorkspace = entry.name.startsWith(workspacePrefix);
      if (!isStaging && !isWorkspace) {
        continue;
      }
      if (!entry.isDirectory() || entry.isSymbolicLink()) {
        throw new RestoreDeploymentError("target-runtime-invalid");
      }
      const remainder = entry.name.slice(
        (isStaging ? metadataPrefix : workspacePrefix).length,
      );
      const candidate = remainder.slice(0, 36);
      if (!kernelDeploymentInstanceIdSchema.safeParse(candidate).success) {
        continue;
      }
      const metadataPath = this.#metadataPath(candidate);
      let metadataExists = true;
      try {
        await lstat(metadataPath);
      } catch (error) {
        if (!isMissing(error)) {
          throw error;
        }
        metadataExists = false;
      }
      if (metadataExists || (await this.#hasActiveRestoreClaim(candidate))) {
        continue;
      }
      const artifactPath = childPath(
        this.#configuration.runtimeRootDirectory,
        entry.name,
      );
      if (isWorkspace) {
        for (const pid of await this.#findPersistedProcesses({
          kernelInstanceId: candidate,
          workspaceDirectory: artifactPath,
        })) {
          await this.#terminatePersistedProcess(pid, {
            kernelInstanceId: candidate,
            workspaceDirectory: artifactPath,
          });
        }
      }
      await this.#removeTrustedDirectory(artifactPath);
    }
  }

  async #removeTrustedDirectory(path: string): Promise<void> {
    const entry = await lstat(path);
    if (
      entry.isSymbolicLink() ||
      !entry.isDirectory() ||
      (await realpath(path)) !== path
    ) {
      throw new RestoreDeploymentError("target-runtime-invalid");
    }
    await rm(path, { force: true, recursive: true });
  }

  #sameEndpoint(endpoint: KernelRuntimeEndpoint, target: TargetRuntime): boolean {
    return (
      endpoint.handle === target.deploymentHandle &&
      endpoint.hostname === target.hostname &&
      endpoint.kernelInstanceId === target.kernelInstanceId &&
      endpoint.port === target.port &&
      endpoint.serverName === target.serverName &&
      endpoint.spaceId === target.spaceId &&
      endpoint.tlsProfile === target.tlsProfile
    );
  }

  async #removeWorkspaceAndMetadata(
    workspaceDirectory: string,
    metadataPath: string,
  ): Promise<void> {
    const root = this.#configuration.runtimeRootDirectory;
    childPath(root, relative(root, workspaceDirectory));
    childPath(root, relative(root, metadataPath));
    try {
      const workspace = await lstat(workspaceDirectory);
      if (
        workspace.isSymbolicLink() ||
        !workspace.isDirectory() ||
        (await realpath(workspaceDirectory)) !== workspaceDirectory
      ) {
        throw new RestoreDeploymentError("target-runtime-invalid");
      }
    } catch (error) {
      if (!isMissing(error)) {
        throw error;
      }
    }
    try {
      const metadata = await lstat(metadataPath);
      if (
        metadata.isSymbolicLink() ||
        !metadata.isFile() ||
        (metadata.mode & 0o777) !== 0o600 ||
        metadata.nlink !== 1 ||
        (await realpath(metadataPath)) !== metadataPath
      ) {
        throw new RestoreDeploymentError("target-runtime-invalid");
      }
    } catch (error) {
      if (!isMissing(error)) {
        throw error;
      }
    }
    await rm(workspaceDirectory, { force: true, recursive: true });
    await rm(metadataPath, { force: true });
    await rm(`${metadataPath}.partial`, { force: true });
  }

  /** The persisted metadata file is one boundary; all consumers use this parser. */
  async #readRuntimeMetadata(
    metadataPath: string,
  ): Promise<z.infer<typeof runtimeMetadataSchema>> {
    let metadata: Awaited<ReturnType<typeof lstat>>;
    try {
      metadata = await lstat(metadataPath);
    } catch (error) {
      if (isMissing(error)) {
        throw error;
      }
      throw new RestoreDeploymentError(
        "target-runtime-invalid",
        undefined,
        errorCause(error),
      );
    }
    if (
      metadata.isSymbolicLink() ||
      !metadata.isFile() ||
      (metadata.mode & 0o777) !== 0o600 ||
      metadata.nlink !== 1 ||
      (await realpath(metadataPath)) !== metadataPath
    ) {
      throw new RestoreDeploymentError("target-runtime-invalid");
    }
    let value: unknown;
    try {
      value = JSON.parse(await readFile(metadataPath, "utf8")) as unknown;
    } catch (error) {
      if (isMissing(error)) {
        throw error;
      }
      throw new RestoreDeploymentError(
        "target-runtime-invalid",
        undefined,
        errorCause(error),
      );
    }
    const parsed = runtimeMetadataSchema.safeParse(value);
    if (!parsed.success) {
      throw new RestoreDeploymentError("target-runtime-invalid");
    }
    return parsed.data;
  }

  async #isTrustedPersistedWorkspace(
    workspaceDirectory: string,
  ): Promise<boolean> {
    try {
      const workspace = await lstat(workspaceDirectory);
      if (
        workspace.isSymbolicLink() ||
        !workspace.isDirectory() ||
        (await realpath(workspaceDirectory)) !== workspaceDirectory
      ) {
        throw new RestoreDeploymentError("target-runtime-invalid");
      }
      const data = await lstat(join(workspaceDirectory, "data"));
      if (
        data.isSymbolicLink() ||
        !data.isDirectory() ||
        (await realpath(join(workspaceDirectory, "data"))) !==
          join(workspaceDirectory, "data")
      ) {
        throw new RestoreDeploymentError("target-runtime-invalid");
      }
      return true;
    } catch (error) {
      if (isMissing(error)) {
        return false;
      }
      if (error instanceof RestoreDeploymentError) {
        throw error;
      }
      throw new RestoreDeploymentError(
        "target-runtime-invalid",
        undefined,
        errorCause(error),
      );
    }
  }

  async #assertPersistedProcessIdentity(
    pid: number,
    identity: PersistedProcessIdentity,
  ): Promise<boolean> {
    if (!this.#processExists(pid)) {
      return false;
    }
    let matches: boolean;
    try {
      matches = await this.#persistedProcessMatchesIdentity(pid, identity);
    } catch (error) {
      throw new RestoreDeploymentError(
        "target-cleanup-failed",
        undefined,
        errorCause(error),
      );
    }
    if (!matches) {
      throw new RestoreDeploymentError("target-runtime-invalid");
    }
    return true;
  }

  async #persistedProcessMatchesIdentity(
    pid: number,
    identity: PersistedProcessIdentity,
  ): Promise<boolean> {
    const [commandLine, environment] = await Promise.all([
      readFile(`/proc/${pid}/cmdline`, "utf8"),
      readFile(`/proc/${pid}/environ`, "utf8"),
    ]);
    const arguments_ = commandLine.split("\u0000").filter(Boolean);
    const environmentEntries = environment.split("\u0000").filter(Boolean);
    return (
      arguments_[0] === this.#configuration.kernelBinaryPath &&
      processArgument(arguments_, "--workspace") ===
        identity.workspaceDirectory &&
      (identity.port === undefined ||
        processArgument(arguments_, "--port") === String(identity.port)) &&
      processEnvironmentValue(
        environmentEntries,
        "SINGULARITY_KERNEL_INSTANCE_ID",
      ) === identity.kernelInstanceId &&
      processEnvironmentValue(
        environmentEntries,
        "SINGULARITY_KERNEL_LISTEN_ADDRESS",
      ) === RESTORE_KERNEL_HOSTNAME &&
      (identity.spaceId === undefined ||
        processEnvironmentValue(
          environmentEntries,
          "SINGULARITY_KERNEL_SPACE_ID",
        ) === identity.spaceId)
    );
  }

  async #findPersistedProcesses(
    identity: PersistedProcessIdentity,
  ): Promise<readonly number[]> {
    let directory: Awaited<ReturnType<typeof opendir>>;
    try {
      directory = await opendir("/proc");
    } catch (error) {
      // Worker 仅在 Linux 运行；无法打开 /proc 时不能证明目标进程已退出。
      throw new RestoreDeploymentError(
        "target-cleanup-failed",
        undefined,
        errorCause(error),
      );
    }
    const processes: number[] = [];
    for await (const entry of directory) {
      if (!entry.isDirectory() || !/^[0-9]+$/.test(entry.name)) {
        continue;
      }
      const pid = Number(entry.name);
      try {
        if (await this.#persistedProcessMatchesIdentity(pid, identity)) {
          processes.push(pid);
        }
      } catch (error) {
        if (!isProcessInspectionUnavailable(error)) {
          throw new RestoreDeploymentError(
            "target-runtime-invalid",
            undefined,
            errorCause(error),
          );
        }
      }
    }
    return processes;
  }

  async #terminateProcess(child: ChildProcess): Promise<void> {
    if (child.exitCode !== null || child.signalCode !== null) {
      return;
    }
    const exited = new Promise<void>((resolveExit) => {
      child.once("close", () => resolveExit());
    });
    try {
      child.kill("SIGTERM");
    } catch (error) {
      if (isProcessMissing(error)) {
        return;
      }
      throw error;
    }
    const graceful = await Promise.race([
      exited.then(() => true),
      wait(PROCESS_TERMINATION_GRACE_MILLISECONDS).then(() => false),
    ]);
    if (!graceful) {
      try {
        child.kill("SIGKILL");
      } catch (error) {
        if (isProcessMissing(error)) {
          return;
        }
        throw error;
      }
      const forced = await Promise.race([
        exited.then(() => true),
        wait(PROCESS_TERMINATION_GRACE_MILLISECONDS).then(() => false),
      ]);
      if (!forced) {
        throw new RestoreDeploymentError("target-cleanup-failed");
      }
    }
  }

  async #terminatePersistedProcess(
    pid: number,
    identity: PersistedProcessIdentity,
  ): Promise<void> {
    if (!(await this.#assertPersistedProcessIdentity(pid, identity))) {
      return;
    }
    try {
      process.kill(pid, "SIGTERM");
    } catch (error) {
      if (isProcessMissing(error)) {
        return;
      }
      throw new RestoreDeploymentError(
        "target-cleanup-failed",
        undefined,
        errorCause(error),
      );
    }
    if (await this.#waitForPidExit(pid)) {
      return;
    }
    try {
      process.kill(pid, "SIGKILL");
    } catch (error) {
      if (isProcessMissing(error)) {
        return;
      }
      throw new RestoreDeploymentError(
        "target-cleanup-failed",
        undefined,
        errorCause(error),
      );
    }
    if (!(await this.#waitForPidExit(pid))) {
      throw new RestoreDeploymentError("target-cleanup-failed");
    }
  }

  async #terminatePersistedTargetProcesses(
    persistedPid: number | null,
    identity: PersistedProcessIdentity,
  ): Promise<void> {
    if (persistedPid !== null) {
      await this.#terminatePersistedProcess(persistedPid, identity);
      return;
    }
    for (const pid of await this.#findPersistedProcesses(identity)) {
      await this.#terminatePersistedProcess(pid, identity);
    }
  }

  #processExists(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      if (isProcessMissing(error)) {
        return false;
      }
      throw new RestoreDeploymentError(
        "target-runtime-invalid",
        undefined,
        errorCause(error),
      );
    }
  }

  async #waitForPidExit(pid: number): Promise<boolean> {
    const deadline = Date.now() + PROCESS_TERMINATION_GRACE_MILLISECONDS;
    while (Date.now() < deadline) {
      if (!this.#processExists(pid)) {
        return true;
      }
      await wait(PROCESS_TERMINATION_POLL_MILLISECONDS);
    }
    return !this.#processExists(pid);
  }

  async #assertTrustedExecutable(path: string): Promise<void> {
    const [link, file, canonical] = await Promise.all([
      lstat(path),
      stat(path),
      realpath(path),
    ]);
    if (
      !link.isFile() ||
      link.isSymbolicLink() ||
      !file.isFile() ||
      (file.mode & 0o111) === 0 ||
      canonical !== path
    ) {
      throw new RestoreDeploymentError("configuration-invalid");
    }
  }

  #childEnvironment(): NodeJS.ProcessEnv {
    const environment: NodeJS.ProcessEnv = {
      HOME: process.env.HOME,
      LANG: "C",
      LC_ALL: "C",
      PATH: process.env.PATH,
      TMPDIR: process.env.TMPDIR,
      TZ: process.env.TZ,
    };
    if (process.env.LD_LIBRARY_PATH !== undefined) {
      environment.LD_LIBRARY_PATH = process.env.LD_LIBRARY_PATH;
    }
    return environment;
  }

  async #assertTrustedFile(path: string): Promise<void> {
    const [link, file, canonical] = await Promise.all([
      lstat(path),
      stat(path),
      realpath(path),
    ]);
    if (
      !link.isFile() ||
      link.isSymbolicLink() ||
      !file.isFile() ||
      file.size < 1 ||
      canonical !== path
    ) {
      throw new RestoreDeploymentError("configuration-invalid");
    }
  }

  async #assertTrustedDirectory(path: string): Promise<void> {
    const [link, directory, canonical] = await Promise.all([
      lstat(path),
      stat(path),
      realpath(path),
    ]);
    if (
      !link.isDirectory() ||
      link.isSymbolicLink() ||
      !directory.isDirectory() ||
      canonical !== path
    ) {
      throw new RestoreDeploymentError("configuration-invalid");
    }
  }

  async #allocatePort(): Promise<number> {
    return this.#withPortLock(async () => {
      for (
        let port = this.#configuration.portRange.first;
        port <= this.#configuration.portRange.last;
        port++
      ) {
        if (this.#allocatedPorts.has(port)) {
          continue;
        }
        if (await this.#portIsAvailable(port)) {
          this.#allocatedPorts.add(port);
          return port;
        }
      }
      throw new RestoreDeploymentError("port-unavailable");
    });
  }

  async #withPortLock<T>(operation: () => Promise<T>): Promise<T> {
    const predecessor = this.#portLock;
    let release = (): void => {
      throw new RestoreDeploymentError("port-unavailable");
    };
    this.#portLock = new Promise<void>((resolveLock) => {
      release = resolveLock;
    });
    await predecessor;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  async #portIsAvailable(port: number): Promise<boolean> {
    const server = createServer();
    try {
      await new Promise<void>((resolveListen, rejectListen) => {
        server.once("error", rejectListen);
        server.listen(port, RESTORE_KERNEL_HOSTNAME, () => {
          server.off("error", rejectListen);
          resolveListen();
        });
      });
      return true;
    } catch (error) {
      if (isAddressInUse(error)) {
        return false;
      }
      throw new RestoreDeploymentError(
        "port-unavailable",
        undefined,
        errorCause(error),
      );
    } finally {
      if (server.listening) {
        await new Promise<void>((resolveClose, rejectClose) => {
          server.close((error) => {
            if (error === undefined) {
              resolveClose();
            } else {
              rejectClose(error);
            }
          });
        });
      }
    }
  }

  #processDiagnostic(target: TargetRuntime): string | undefined {
    return diagnosticText(target.stderrTail);
  }
}
