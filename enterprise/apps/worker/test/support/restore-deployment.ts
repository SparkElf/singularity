import { generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { KernelCredentialService } from "@singularity/kernel-client";

import type { RestoreDeploymentConfiguration } from "../../src/configuration.js";
import type { WorkerJobLogger } from "../../src/worker.js";

const certificateFile = fileURLToPath(
  new URL("../../../api/test/fixtures/kernel-gateway.crt", import.meta.url),
);
const privateKeyFile = fileURLToPath(
  new URL("../../../api/test/fixtures/kernel-gateway.key", import.meta.url),
);

export class CapturingWorkerLogger implements WorkerJobLogger {
  readonly entries: Readonly<Record<string, unknown>>[] = [];

  debug(context: Readonly<Record<string, unknown>>): void {
    this.entries.push(context);
  }

  error(context: Readonly<Record<string, unknown>>): void {
    this.entries.push(context);
  }

  info(context: Readonly<Record<string, unknown>>): void {
    this.entries.push(context);
  }

  warn(context: Readonly<Record<string, unknown>>): void {
    this.entries.push(context);
  }
}

export function restoreDeploymentConfiguration(
  rootDirectory: string,
): RestoreDeploymentConfiguration {
  const { privateKey } = generateKeyPairSync("ed25519");
  const certificate = readFileSync(certificateFile);
  const tlsPrivateKey = readFileSync(privateKeyFile);
  return {
    archiveTimeoutMilliseconds: 1_000,
    archiveToolPath: process.execPath,
    credentials: new KernelCredentialService({
      keyId: "restore-test",
      privateKey,
    }),
    gatewayHostname: "127.0.0.1",
    handlePrefix: "restore-test",
    kernelBinaryPath: process.execPath,
    kernelListenAddress: "127.0.0.1",
    kernelWorkingDirectory: rootDirectory,
    maximumArchiveBytes: 1_024,
    maximumEntryBytes: 1_024,
    maximumFiles: 10,
    maximumTotalBytes: 1_024,
    portRange: { first: 49_152, last: 65_535 },
    readinessPollMilliseconds: 10,
    runtimeRootDirectory: rootDirectory,
    runtimeOwner: "restore-test-worker",
    startupTimeoutMilliseconds: 100,
    tls: {
      caCertificate: certificate,
      clientCaCertificateFile: certificateFile,
      clientCertificate: certificate,
      clientPrivateKey: tlsPrivateKey,
      deploymentProfile: "restore-test",
      gatewayClientDnsName: "gateway.test",
      serverCertificateFile: certificateFile,
      serverName: "kernel.test",
      serverPrivateKeyFile: privateKeyFile,
      servicePublicKeysFile: certificateFile,
    },
  };
}
