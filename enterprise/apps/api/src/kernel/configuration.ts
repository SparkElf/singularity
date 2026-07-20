import { readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { createSecureContext } from "node:tls";

import {
  createKernelDeployment,
  kernelDeploymentProfileSchema,
  KernelCredentialService,
  parseKernelDeploymentsDocument,
  type KernelDeploymentTlsIdentity,
  RuntimeKernelDeploymentRegistry,
} from "@singularity/kernel-client";

export class KernelGatewayConfigurationError extends Error {
  constructor(options?: ErrorOptions) {
    super("Kernel gateway deployment configuration is unavailable", options);
    this.name = "KernelGatewayConfigurationError";
  }
}

export interface KernelGatewayRuntimeConfiguration {
  readonly credentials: KernelCredentialService;
  readonly deployments: RuntimeKernelDeploymentRegistry;
  readonly runtimeDeployment: {
    readonly tls: KernelDeploymentTlsIdentity;
    readonly tlsProfile: string;
  };
}

export interface KernelGatewayEnvironment {
  readonly SINGULARITY_KERNEL_DEPLOYMENTS_FILE?: string;
  readonly SINGULARITY_KERNEL_RUNTIME_CA_FILE?: string;
  readonly SINGULARITY_KERNEL_RUNTIME_CLIENT_CERTIFICATE_FILE?: string;
  readonly SINGULARITY_KERNEL_RUNTIME_CLIENT_PRIVATE_KEY_FILE?: string;
  readonly SINGULARITY_KERNEL_RUNTIME_TLS_PROFILE?: string;
  readonly SINGULARITY_KERNEL_SERVICE_KEY_ID?: string;
  readonly SINGULARITY_KERNEL_SERVICE_PRIVATE_KEY_FILE?: string;
}

function required(value: string | undefined): string {
  if (value === undefined || value.trim().length === 0) {
    throw new KernelGatewayConfigurationError();
  }
  return value;
}

function requiredFile(value: string | undefined): string {
  const path = required(value);
  if (!isAbsolute(path)) {
    throw new KernelGatewayConfigurationError();
  }
  return path;
}

function readSecret(path: string): Buffer {
  try {
    return readFileSync(path);
  } catch (error) {
    throw new KernelGatewayConfigurationError({ cause: error });
  }
}

function loadTlsIdentity(input: {
  caCertificateFile: string | undefined;
  clientCertificateFile: string | undefined;
  clientPrivateKeyFile: string | undefined;
}): KernelDeploymentTlsIdentity {
  const tls = {
    caCertificate: readSecret(requiredFile(input.caCertificateFile)),
    clientCertificate: readSecret(requiredFile(input.clientCertificateFile)),
    clientPrivateKey: readSecret(requiredFile(input.clientPrivateKeyFile)),
  };
  createSecureContext({
    ca: tls.caCertificate,
    cert: tls.clientCertificate,
    key: tls.clientPrivateKey,
    minVersion: "TLSv1.3",
  });
  return tls;
}

export function loadKernelGatewayConfiguration(
  environment: KernelGatewayEnvironment,
): KernelGatewayRuntimeConfiguration {
  const deploymentsPath = requiredFile(
    environment.SINGULARITY_KERNEL_DEPLOYMENTS_FILE,
  );
  const keyId = required(environment.SINGULARITY_KERNEL_SERVICE_KEY_ID);
  const privateKeyPath = requiredFile(
    environment.SINGULARITY_KERNEL_SERVICE_PRIVATE_KEY_FILE,
  );
  const runtimeTlsProfile = kernelDeploymentProfileSchema.safeParse(
    environment.SINGULARITY_KERNEL_RUNTIME_TLS_PROFILE,
  );
  if (!runtimeTlsProfile.success) {
    throw new KernelGatewayConfigurationError();
  }

  try {
    const parsed = parseKernelDeploymentsDocument(
      JSON.parse(readSecret(deploymentsPath).toString("utf8")),
    );
    return {
      credentials: new KernelCredentialService({
        keyId,
        privateKey: readSecret(privateKeyPath),
      }),
      deployments: new RuntimeKernelDeploymentRegistry(
        parsed.deployments.map((deployment) => {
          const tls = loadTlsIdentity(deployment);
          return createKernelDeployment(deployment, tls);
        }),
      ),
      runtimeDeployment: {
        tls: loadTlsIdentity({
          caCertificateFile:
            environment.SINGULARITY_KERNEL_RUNTIME_CA_FILE,
          clientCertificateFile:
            environment.SINGULARITY_KERNEL_RUNTIME_CLIENT_CERTIFICATE_FILE,
          clientPrivateKeyFile:
            environment.SINGULARITY_KERNEL_RUNTIME_CLIENT_PRIVATE_KEY_FILE,
        }),
        tlsProfile: runtimeTlsProfile.data,
      },
    };
  } catch (error) {
    throw new KernelGatewayConfigurationError({ cause: error });
  }
}
