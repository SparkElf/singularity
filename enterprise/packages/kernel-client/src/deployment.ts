import { isIP } from "node:net";

import { z } from "zod";

const HANDLE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const PROFILE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const DNS_NAME_PATTERN =
  /^(?=.{1,253}$)(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)(?:\.(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?))*$/;

const hostnameSchema = z.string().refine(
  (value) => isIP(value) !== 0 || DNS_NAME_PATTERN.test(value),
  "hostname must be an IP address or DNS name",
);

const serverNameSchema = z.string().refine(
  (value) => isIP(value) === 0 && DNS_NAME_PATTERN.test(value),
  "serverName must be a DNS name",
);

export const kernelDeploymentHandleSchema = z
  .string()
  .regex(HANDLE_PATTERN);
export const kernelDeploymentProfileSchema = z
  .string()
  .regex(PROFILE_PATTERN);
export const kernelDeploymentInstanceIdSchema = z
  .string()
  .regex(UUID_PATTERN);

/**
 * The deployment document is the canonical structural contract shared by all
 * processes that consume the deployment file. File paths remain strings here:
 * each process owns its absolute-path, file-read, and TLS-context boundary.
 */
export const kernelDeploymentSchema = z
  .object({
    caCertificateFile: z.string(),
    clientCertificateFile: z.string(),
    clientPrivateKeyFile: z.string(),
    handle: kernelDeploymentHandleSchema,
    hostname: hostnameSchema,
    kernelInstanceId: kernelDeploymentInstanceIdSchema,
    port: z.number().int().min(1).max(65_535),
    serverName: serverNameSchema,
    spaceId: kernelDeploymentInstanceIdSchema,
  })
  .strict();

export const kernelDeploymentsDocumentSchema = z
  .object({ deployments: z.array(kernelDeploymentSchema).min(1) })
  .strict();

export type KernelDeploymentDescriptor = z.infer<
  typeof kernelDeploymentSchema
>;

export type KernelDeploymentEndpoint = Pick<
  KernelDeploymentDescriptor,
  | "handle"
  | "hostname"
  | "kernelInstanceId"
  | "port"
  | "serverName"
  | "spaceId"
>;

/**
 * Persisted endpoint metadata is the cross-process contract for restored
 * Kernels. TLS bytes never cross this boundary; `tlsProfile` selects an
 * explicitly configured profile in the consuming process.
 */
export const kernelRuntimeEndpointSchema = z
  .object({
    handle: kernelDeploymentHandleSchema,
    hostname: hostnameSchema,
    kernelInstanceId: kernelDeploymentInstanceIdSchema,
    port: z.number().int().min(1).max(65_535),
    serverName: serverNameSchema,
    spaceId: kernelDeploymentInstanceIdSchema,
    tlsProfile: kernelDeploymentProfileSchema,
  })
  .strict();

export type KernelRuntimeEndpoint = z.infer<typeof kernelRuntimeEndpointSchema>;

export const KERNEL_DEPLOYMENT_CHANGED_CHANNEL =
  "singularity_kernel_deployment_changed";

export const kernelDeploymentChangedEventSchema = z
  .object({
    deploymentHandle: kernelDeploymentHandleSchema,
    kernelInstanceId: kernelDeploymentInstanceIdSchema,
    kind: z.enum(["upsert", "remove"]),
    requestId: kernelDeploymentInstanceIdSchema,
    spaceId: kernelDeploymentInstanceIdSchema,
  })
  .strict();

export type KernelDeploymentChangedEvent = z.infer<
  typeof kernelDeploymentChangedEventSchema
>;

export function parseKernelDeploymentChangedEvent(
  value: unknown,
): KernelDeploymentChangedEvent {
  return kernelDeploymentChangedEventSchema.parse(value);
}

export type KernelDeploymentsDocument = z.infer<
  typeof kernelDeploymentsDocumentSchema
>;

export class KernelDeploymentConfigurationError extends Error {
  constructor() {
    super("Kernel deployment configuration is unavailable");
    this.name = "KernelDeploymentConfigurationError";
  }
}

/** Parse the external JSON value once at the process configuration boundary. */
export function parseKernelDeploymentsDocument(
  value: unknown,
): KernelDeploymentsDocument {
  const parsed = kernelDeploymentsDocumentSchema.safeParse(value);
  if (!parsed.success) {
    throw new KernelDeploymentConfigurationError();
  }
  return parsed.data;
}

export interface KernelDeploymentTlsIdentity {
  caCertificate: string | Buffer;
  clientCertificate: string | Buffer;
  clientPrivateKey: string | Buffer;
}

export interface KernelDeployment {
  handle: string;
  hostname: string;
  kernelInstanceId: string;
  port: number;
  serverName: string;
  spaceId: string;
  tls: KernelDeploymentTlsIdentity;
}

/**
 * Materialize a deployment endpoint with bytes loaded by the caller's
 * process-specific TLS boundary. A document entry has already been parsed by
 * `parseKernelDeploymentsDocument`, while a restored endpoint has crossed its
 * authenticated readiness boundary; this factory deliberately does not parse
 * or revalidate either input again.
 */
export function createKernelDeployment(
  descriptor: KernelDeploymentEndpoint,
  tls: KernelDeploymentTlsIdentity,
): KernelDeployment {
  return {
    handle: descriptor.handle,
    hostname: descriptor.hostname,
    kernelInstanceId: descriptor.kernelInstanceId,
    port: descriptor.port,
    serverName: descriptor.serverName,
    spaceId: descriptor.spaceId,
    tls,
  };
}

export interface KernelDeploymentIdentity {
  handle: string;
  kernelInstanceId: string;
  spaceId: string;
}

export interface KernelDeploymentRegistry {
  resolve(identity: KernelDeploymentIdentity): KernelDeployment;
}

/**
 * 进程内registry是部署解析的唯一owner。它由已解析配置初始化，只有恢复端点
 * 通过恢复provider的认证运行时边界后才能加入；结构校验仍归canonical schema。
 */
export class RuntimeKernelDeploymentRegistry implements KernelDeploymentRegistry {
  readonly #deployments = new Map<string, KernelDeployment>();

  constructor(deployments: Iterable<KernelDeployment>) {
    for (const deployment of deployments) {
      if (this.#deployments.has(deployment.handle)) {
        throw new Error("Kernel deployment configuration is unavailable");
      }
      this.#deployments.set(deployment.handle, deployment);
    }
  }

  register(deployment: KernelDeployment): void {
    if (this.#deployments.has(deployment.handle)) {
      throw new Error("Kernel deployment registration conflicts");
    }
    this.#deployments.set(deployment.handle, deployment);
  }

  /** Replace an endpoint after its persisted identity has been re-read. */
  replace(deployment: KernelDeployment): void {
    const existing = this.#deployments.get(deployment.handle);
    if (
      existing !== undefined &&
      (existing.kernelInstanceId !== deployment.kernelInstanceId ||
        existing.spaceId !== deployment.spaceId)
    ) {
      throw new Error("Kernel deployment registration conflicts");
    }
    this.#deployments.set(deployment.handle, deployment);
  }

  unregister(identity: KernelDeploymentIdentity): boolean {
    const deployment = this.#deployments.get(identity.handle);
    if (
      deployment === undefined ||
      deployment.kernelInstanceId !== identity.kernelInstanceId ||
      deployment.spaceId !== identity.spaceId
    ) {
      return false;
    }
    return this.#deployments.delete(identity.handle);
  }

  resolve(identity: KernelDeploymentIdentity): KernelDeployment {
    const deployment = this.#deployments.get(identity.handle);
    if (
      deployment === undefined ||
      deployment.kernelInstanceId !== identity.kernelInstanceId ||
      deployment.spaceId !== identity.spaceId
    ) {
      throw new Error("Kernel deployment is unavailable");
    }
    return deployment;
  }
}
