import {
  lstatSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import { isIP } from "node:net";
import { isAbsolute, resolve } from "node:path";
import { createSecureContext } from "node:tls";

import { kernelRoutePolicies } from "@singularity/authorization";
import {
  createKernelDeployment,
  KernelCredentialService,
  kernelDeploymentProfileSchema,
  KernelRoutePolicyRegistry,
  parseKernelDeploymentsDocument,
  RuntimeKernelDeploymentRegistry,
} from "@singularity/kernel-client";

import {
  WORKER_BACKUP_PATH,
  WORKER_OBSERVATION_PATH,
} from "./kernel-worker-client.js";
import { MAXIMUM_AUDIT_ARCHIVE_EVENTS } from "./worker.js";

const DEFAULT_ARCHIVE_AUDIT_INTERVAL_MILLISECONDS = 5 * 60_000;
const DEFAULT_CLAIM_BATCH_SIZE = 16;
const DEFAULT_LEASE_DURATION_MILLISECONDS = 30_000;
const DEFAULT_LEASE_RENEWAL_MILLISECONDS = 10_000;
const DEFAULT_MAXIMUM_AUDIT_ARCHIVE_BYTES = 256 * 1_024 * 1_024;
const DEFAULT_MAXIMUM_BACKUP_BYTES = 8 * 1_024 * 1_024 * 1_024;
const DEFAULT_MAXIMUM_CONCURRENT_JOBS = 4;
const DEFAULT_MAXIMUM_OBJECT_BYTES = DEFAULT_MAXIMUM_BACKUP_BYTES;
const DEFAULT_POLL_INTERVAL_MILLISECONDS = 1_000;
const DEFAULT_SAMPLE_KERNEL_INTERVAL_MILLISECONDS = 60_000;

export class WorkerConfigurationError extends Error {
  constructor() {
    super("Worker deployment configuration is unavailable");
    this.name = "WorkerConfigurationError";
  }
}

export interface WorkerConfiguration {
  readonly archiveAuditIntervalMilliseconds: number;
  readonly claimBatchSize: number;
  readonly credentials: KernelCredentialService;
  readonly deployments: RuntimeKernelDeploymentRegistry;
  readonly leaseDurationMilliseconds: number;
  readonly leaseRenewalMilliseconds: number;
  readonly maximumAuditArchiveBytes: number;
  readonly maximumAuditArchiveEvents: number;
  readonly maximumBackupBytes: number;
  readonly maximumConcurrentJobs: number;
  readonly maximumObjectBytes: number;
  readonly objectStoreRootDirectory: string;
  readonly policies: KernelRoutePolicyRegistry;
  readonly pollIntervalMilliseconds: number;
  readonly restore: RestoreDeploymentConfiguration;
  readonly sampleKernelIntervalMilliseconds: number;
  readonly workerId: string;
}

export interface RestoreDeploymentTlsConfiguration {
  readonly caCertificate: Buffer;
  readonly clientCertificate: Buffer;
  readonly clientPrivateKey: Buffer;
  readonly deploymentProfile: string;
  readonly clientCaCertificateFile: string;
  readonly gatewayClientDnsName: string;
  readonly serverCertificateFile: string;
  readonly serverName: string;
  readonly serverPrivateKeyFile: string;
  readonly servicePublicKeysFile: string;
}

export interface RestoreDeploymentConfiguration {
  readonly archiveToolPath: string;
  readonly credentials: KernelCredentialService;
  readonly gatewayHostname: string;
  readonly handlePrefix: string;
  readonly kernelBinaryPath: string;
  readonly kernelWorkingDirectory: string;
  readonly maximumArchiveBytes: number;
  readonly maximumEntryBytes: number;
  readonly maximumFiles: number;
  readonly maximumTotalBytes: number;
  readonly portRange: {
    readonly first: number;
    readonly last: number;
  };
  readonly readinessPollMilliseconds: number;
  readonly runtimeRootDirectory: string;
  readonly startupTimeoutMilliseconds: number;
  readonly tls: RestoreDeploymentTlsConfiguration;
}

export interface WorkerEnvironment {
  readonly SINGULARITY_KERNEL_DEPLOYMENTS_FILE?: string;
  readonly SINGULARITY_KERNEL_SERVICE_KEY_ID?: string;
  readonly SINGULARITY_KERNEL_SERVICE_PRIVATE_KEY_FILE?: string;
  readonly SINGULARITY_WORKER_ARCHIVE_AUDIT_INTERVAL_MS?: string;
  readonly SINGULARITY_WORKER_CLAIM_BATCH_SIZE?: string;
  readonly SINGULARITY_WORKER_ID?: string;
  readonly SINGULARITY_WORKER_LEASE_DURATION_MS?: string;
  readonly SINGULARITY_WORKER_LEASE_RENEWAL_MS?: string;
  readonly SINGULARITY_WORKER_MAXIMUM_AUDIT_ARCHIVE_BYTES?: string;
  readonly SINGULARITY_WORKER_MAXIMUM_AUDIT_ARCHIVE_EVENTS?: string;
  readonly SINGULARITY_WORKER_MAXIMUM_BACKUP_BYTES?: string;
  readonly SINGULARITY_WORKER_MAXIMUM_CONCURRENT_JOBS?: string;
  readonly SINGULARITY_WORKER_MAXIMUM_OBJECT_BYTES?: string;
  readonly SINGULARITY_WORKER_OBJECT_STORE_ROOT?: string;
  readonly SINGULARITY_WORKER_POLL_INTERVAL_MS?: string;
  readonly SINGULARITY_WORKER_RESTORE_ARCHIVE_TOOL?: string;
  readonly SINGULARITY_WORKER_RESTORE_CLIENT_CA_FILE?: string;
  readonly SINGULARITY_WORKER_RESTORE_CLIENT_CERT_FILE?: string;
  readonly SINGULARITY_WORKER_RESTORE_CLIENT_KEY_FILE?: string;
  readonly SINGULARITY_WORKER_RESTORE_GATEWAY_CLIENT_DNS_NAME?: string;
  readonly SINGULARITY_WORKER_RESTORE_GATEWAY_HOSTNAME?: string;
  readonly SINGULARITY_WORKER_RESTORE_HANDLE_PREFIX?: string;
  readonly SINGULARITY_WORKER_RESTORE_KERNEL_BINARY?: string;
  readonly SINGULARITY_WORKER_RESTORE_KERNEL_WORKING_DIRECTORY?: string;
  readonly SINGULARITY_WORKER_RESTORE_MAXIMUM_ARCHIVE_BYTES?: string;
  readonly SINGULARITY_WORKER_RESTORE_MAXIMUM_ENTRY_BYTES?: string;
  readonly SINGULARITY_WORKER_RESTORE_MAXIMUM_FILES?: string;
  readonly SINGULARITY_WORKER_RESTORE_MAXIMUM_TOTAL_BYTES?: string;
  readonly SINGULARITY_WORKER_RESTORE_PORT_FIRST?: string;
  readonly SINGULARITY_WORKER_RESTORE_PORT_LAST?: string;
  readonly SINGULARITY_WORKER_RESTORE_READINESS_POLL_MS?: string;
  readonly SINGULARITY_WORKER_RESTORE_RUNTIME_ROOT?: string;
  readonly SINGULARITY_WORKER_RESTORE_SERVER_CERT_FILE?: string;
  readonly SINGULARITY_WORKER_RESTORE_SERVER_KEY_FILE?: string;
  readonly SINGULARITY_WORKER_RESTORE_SERVICE_KEYS_FILE?: string;
  readonly SINGULARITY_WORKER_RESTORE_SERVER_NAME?: string;
  readonly SINGULARITY_WORKER_RESTORE_TLS_PROFILE?: string;
  readonly SINGULARITY_WORKER_RESTORE_STARTUP_TIMEOUT_MS?: string;
  readonly SINGULARITY_WORKER_SAMPLE_KERNEL_INTERVAL_MS?: string;
}

function required(value: string | undefined): string {
  if (value === undefined || value.trim().length === 0) {
    throw new WorkerConfigurationError();
  }
  return value;
}

const DNS_NAME_PATTERN =
  /^(?=.{1,253}$)(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)(?:\.(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?))*$/;

function requiredHostname(value: string | undefined): string {
  const hostname = required(value);
  if (isIP(hostname) === 0 && !DNS_NAME_PATTERN.test(hostname)) {
    throw new WorkerConfigurationError();
  }
  return hostname;
}

function requiredAbsolutePath(value: string | undefined): string {
  const path = required(value);
  if (!isAbsolute(path)) {
    throw new WorkerConfigurationError();
  }
  return path;
}

function requiredRegularFile(
  value: string | undefined,
  executable: boolean,
): string {
  const path = requiredAbsolutePath(value);
  try {
    const link = lstatSync(path);
    const file = statSync(path);
    if (!link.isFile() || !file.isFile() || realpathSync(path) !== resolve(path)) {
      throw new WorkerConfigurationError();
    }
    if (executable && (file.mode & 0o111) === 0) {
      throw new WorkerConfigurationError();
    }
    return resolve(path);
  } catch (error) {
    if (error instanceof WorkerConfigurationError) {
      throw error;
    }
    throw new WorkerConfigurationError();
  }
}

function requiredDirectory(value: string | undefined): string {
  const path = requiredAbsolutePath(value);
  try {
    const link = lstatSync(path);
    const directory = statSync(path);
    if (
      !link.isDirectory() ||
      !directory.isDirectory() ||
      realpathSync(path) !== resolve(path)
    ) {
      throw new WorkerConfigurationError();
    }
    return resolve(path);
  } catch (error) {
    if (error instanceof WorkerConfigurationError) {
      throw error;
    }
    throw new WorkerConfigurationError();
  }
}

function integer(value: string | undefined, fallback: number): number {
  const text = value ?? String(fallback);
  if (!/^[1-9][0-9]*$/.test(text)) {
    throw new WorkerConfigurationError();
  }
  const parsed = Number(text);
  if (!Number.isSafeInteger(parsed)) {
    throw new WorkerConfigurationError();
  }
  return parsed;
}

function requiredInteger(value: string | undefined): number {
  if (value === undefined || !/^[1-9][0-9]*$/.test(value)) {
    throw new WorkerConfigurationError();
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new WorkerConfigurationError();
  }
  return parsed;
}

function readSecret(path: string): Buffer {
  try {
    return readFileSync(path);
  } catch {
    throw new WorkerConfigurationError();
  }
}

export function loadWorkerConfiguration(
  environment: WorkerEnvironment,
): WorkerConfiguration {
  const deploymentsPath = requiredAbsolutePath(
    environment.SINGULARITY_KERNEL_DEPLOYMENTS_FILE,
  );
  const keyId = required(environment.SINGULARITY_KERNEL_SERVICE_KEY_ID);
  const privateKeyPath = requiredAbsolutePath(
    environment.SINGULARITY_KERNEL_SERVICE_PRIVATE_KEY_FILE,
  );
  const objectStoreRootDirectory = requiredAbsolutePath(
    environment.SINGULARITY_WORKER_OBJECT_STORE_ROOT,
  );
  const workerId = required(environment.SINGULARITY_WORKER_ID);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(workerId)) {
    throw new WorkerConfigurationError();
  }

  const maximumAuditArchiveBytes = integer(
    environment.SINGULARITY_WORKER_MAXIMUM_AUDIT_ARCHIVE_BYTES,
    DEFAULT_MAXIMUM_AUDIT_ARCHIVE_BYTES,
  );
  const maximumBackupBytes = integer(
    environment.SINGULARITY_WORKER_MAXIMUM_BACKUP_BYTES,
    DEFAULT_MAXIMUM_BACKUP_BYTES,
  );
  const maximumObjectBytes = integer(
    environment.SINGULARITY_WORKER_MAXIMUM_OBJECT_BYTES,
    DEFAULT_MAXIMUM_OBJECT_BYTES,
  );
  const maximumAuditArchiveEvents = integer(
    environment.SINGULARITY_WORKER_MAXIMUM_AUDIT_ARCHIVE_EVENTS,
    MAXIMUM_AUDIT_ARCHIVE_EVENTS,
  );
  if (
    maximumObjectBytes < maximumAuditArchiveBytes ||
    maximumObjectBytes < maximumBackupBytes ||
    maximumAuditArchiveEvents > MAXIMUM_AUDIT_ARCHIVE_EVENTS
  ) {
    throw new WorkerConfigurationError();
  }

  try {
    const parsedDeployments = parseKernelDeploymentsDocument(
      JSON.parse(readSecret(deploymentsPath).toString("utf8")),
    );
    const credentials = new KernelCredentialService({
      keyId,
      privateKey: readSecret(privateKeyPath),
    });
    const deployments = new RuntimeKernelDeploymentRegistry(
      parsedDeployments.deployments.map((deployment) => {
        const tls = {
          caCertificate: readSecret(
            requiredAbsolutePath(deployment.caCertificateFile),
          ),
          clientCertificate: readSecret(
            requiredAbsolutePath(deployment.clientCertificateFile),
          ),
          clientPrivateKey: readSecret(
            requiredAbsolutePath(deployment.clientPrivateKeyFile),
          ),
        };
        createSecureContext({
          ca: tls.caCertificate,
          cert: tls.clientCertificate,
          key: tls.clientPrivateKey,
          minVersion: "TLSv1.3",
        });
        return createKernelDeployment(deployment, tls);
      }),
    );
    const policies = new KernelRoutePolicyRegistry(kernelRoutePolicies);
    policies.resolve("POST", WORKER_BACKUP_PATH);
    policies.resolve("GET", WORKER_OBSERVATION_PATH);
    const archiveToolPath = requiredRegularFile(
      environment.SINGULARITY_WORKER_RESTORE_ARCHIVE_TOOL,
      true,
    );
    const kernelBinaryPath = requiredRegularFile(
      environment.SINGULARITY_WORKER_RESTORE_KERNEL_BINARY,
      true,
    );
    const runtimeRootDirectory = requiredDirectory(
      environment.SINGULARITY_WORKER_RESTORE_RUNTIME_ROOT,
    );
    const kernelWorkingDirectory = requiredDirectory(
      environment.SINGULARITY_WORKER_RESTORE_KERNEL_WORKING_DIRECTORY,
    );
    const portFirst = requiredInteger(
      environment.SINGULARITY_WORKER_RESTORE_PORT_FIRST,
    );
    const portLast = requiredInteger(
      environment.SINGULARITY_WORKER_RESTORE_PORT_LAST,
    );
    if (portFirst > portLast || portLast > 65_535) {
      throw new WorkerConfigurationError();
    }
    const maximumRestoreArchiveBytes = integer(
      environment.SINGULARITY_WORKER_RESTORE_MAXIMUM_ARCHIVE_BYTES,
      maximumBackupBytes,
    );
    const maximumRestoreEntryBytes = integer(
      environment.SINGULARITY_WORKER_RESTORE_MAXIMUM_ENTRY_BYTES,
      maximumBackupBytes,
    );
    const maximumRestoreFiles = integer(
      environment.SINGULARITY_WORKER_RESTORE_MAXIMUM_FILES,
      100_000,
    );
    const maximumRestoreTotalBytes = integer(
      environment.SINGULARITY_WORKER_RESTORE_MAXIMUM_TOTAL_BYTES,
      maximumBackupBytes,
    );
    if (
      maximumRestoreArchiveBytes > maximumBackupBytes ||
      maximumRestoreEntryBytes > maximumRestoreTotalBytes ||
      maximumRestoreTotalBytes < 1
    ) {
      throw new WorkerConfigurationError();
    }
    const startupTimeoutMilliseconds = integer(
      environment.SINGULARITY_WORKER_RESTORE_STARTUP_TIMEOUT_MS,
      60_000,
    );
    const readinessPollMilliseconds = integer(
      environment.SINGULARITY_WORKER_RESTORE_READINESS_POLL_MS,
      250,
    );
    if (
      startupTimeoutMilliseconds > 300_000 ||
      readinessPollMilliseconds > startupTimeoutMilliseconds
    ) {
      throw new WorkerConfigurationError();
    }
    const handlePrefix =
      environment.SINGULARITY_WORKER_RESTORE_HANDLE_PREFIX ?? "restore";
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/.test(handlePrefix)) {
      throw new WorkerConfigurationError();
    }
    const gatewayHostname = requiredHostname(
      environment.SINGULARITY_WORKER_RESTORE_GATEWAY_HOSTNAME,
    );
    const deploymentProfile = kernelDeploymentProfileSchema.safeParse(
      environment.SINGULARITY_WORKER_RESTORE_TLS_PROFILE,
    );
    if (!deploymentProfile.success) {
      throw new WorkerConfigurationError();
    }
    const clientCaCertificateFile = requiredRegularFile(
      environment.SINGULARITY_WORKER_RESTORE_CLIENT_CA_FILE,
      false,
    );
    const clientCertificateFile = requiredRegularFile(
      environment.SINGULARITY_WORKER_RESTORE_CLIENT_CERT_FILE,
      false,
    );
    const clientPrivateKeyFile = requiredRegularFile(
      environment.SINGULARITY_WORKER_RESTORE_CLIENT_KEY_FILE,
      false,
    );
    const serverCertificateFile = requiredRegularFile(
      environment.SINGULARITY_WORKER_RESTORE_SERVER_CERT_FILE,
      false,
    );
    const serverPrivateKeyFile = requiredRegularFile(
      environment.SINGULARITY_WORKER_RESTORE_SERVER_KEY_FILE,
      false,
    );
    const servicePublicKeysFile = requiredRegularFile(
      environment.SINGULARITY_WORKER_RESTORE_SERVICE_KEYS_FILE,
      false,
    );
    const gatewayClientDnsName = required(
      environment.SINGULARITY_WORKER_RESTORE_GATEWAY_CLIENT_DNS_NAME,
    );
    const serverName = required(
      environment.SINGULARITY_WORKER_RESTORE_SERVER_NAME,
    );
    return {
      archiveAuditIntervalMilliseconds: integer(
        environment.SINGULARITY_WORKER_ARCHIVE_AUDIT_INTERVAL_MS,
        DEFAULT_ARCHIVE_AUDIT_INTERVAL_MILLISECONDS,
      ),
      claimBatchSize: integer(
        environment.SINGULARITY_WORKER_CLAIM_BATCH_SIZE,
        DEFAULT_CLAIM_BATCH_SIZE,
      ),
      credentials,
      deployments,
      leaseDurationMilliseconds: integer(
        environment.SINGULARITY_WORKER_LEASE_DURATION_MS,
        DEFAULT_LEASE_DURATION_MILLISECONDS,
      ),
      leaseRenewalMilliseconds: integer(
        environment.SINGULARITY_WORKER_LEASE_RENEWAL_MS,
        DEFAULT_LEASE_RENEWAL_MILLISECONDS,
      ),
      maximumAuditArchiveBytes,
      maximumAuditArchiveEvents,
      maximumBackupBytes,
      maximumConcurrentJobs: integer(
        environment.SINGULARITY_WORKER_MAXIMUM_CONCURRENT_JOBS,
        DEFAULT_MAXIMUM_CONCURRENT_JOBS,
      ),
      maximumObjectBytes,
      objectStoreRootDirectory,
      policies,
      pollIntervalMilliseconds: integer(
        environment.SINGULARITY_WORKER_POLL_INTERVAL_MS,
        DEFAULT_POLL_INTERVAL_MILLISECONDS,
      ),
      restore: {
        archiveToolPath,
        credentials,
        gatewayHostname,
        handlePrefix,
        kernelBinaryPath,
        kernelWorkingDirectory,
        maximumArchiveBytes: maximumRestoreArchiveBytes,
        maximumEntryBytes: maximumRestoreEntryBytes,
        maximumFiles: maximumRestoreFiles,
        maximumTotalBytes: maximumRestoreTotalBytes,
        portRange: { first: portFirst, last: portLast },
        readinessPollMilliseconds,
        runtimeRootDirectory,
        startupTimeoutMilliseconds,
        tls: {
          caCertificate: readSecret(clientCaCertificateFile),
          clientCertificate: readSecret(clientCertificateFile),
          clientPrivateKey: readSecret(clientPrivateKeyFile),
          clientCaCertificateFile,
          deploymentProfile: deploymentProfile.data,
          gatewayClientDnsName,
          serverCertificateFile,
          serverName,
          serverPrivateKeyFile,
          servicePublicKeysFile,
        },
      },
      sampleKernelIntervalMilliseconds: integer(
        environment.SINGULARITY_WORKER_SAMPLE_KERNEL_INTERVAL_MS,
        DEFAULT_SAMPLE_KERNEL_INTERVAL_MILLISECONDS,
      ),
      workerId,
    };
  } catch (error) {
    if (error instanceof WorkerConfigurationError) {
      throw error;
    }
    throw new WorkerConfigurationError();
  }
}
