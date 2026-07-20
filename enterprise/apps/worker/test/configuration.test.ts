import { generateKeyPairSync } from "node:crypto";
import { copyFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import {
  loadWorkerConfiguration,
  WorkerConfigurationError,
  type WorkerEnvironment,
} from "../src/configuration.js";

const certificatePath = fileURLToPath(
  new URL("../../api/test/fixtures/kernel-gateway.crt", import.meta.url),
);
const certificateKeyPath = fileURLToPath(
  new URL("../../api/test/fixtures/kernel-gateway.key", import.meta.url),
);

describe("Worker configuration", () => {
  let environment: WorkerEnvironment;
  let rootDirectory: string;

  beforeEach(async () => {
    rootDirectory = await mkdtemp(join(tmpdir(), "worker-configuration-"));
    const deploymentPath = join(rootDirectory, "deployments.json");
    const servicePrivateKeyPath = join(rootDirectory, "service-private.pem");
    const executablePath = join(rootDirectory, "restore-tool");
    const serviceKeysPath = join(rootDirectory, "service-keys.json");
    const { privateKey } = generateKeyPairSync("ed25519");
    await Promise.all([
      writeFile(
        deploymentPath,
        JSON.stringify({
          deployments: [
            {
              caCertificateFile: certificatePath,
              clientCertificateFile: certificatePath,
              clientPrivateKeyFile: certificateKeyPath,
              handle: "configured-kernel",
              hostname: "127.0.0.1",
              kernelInstanceId: "11111111-1111-4111-8111-111111111111",
              port: 8443,
              serverName: "kernel.test",
              spaceId: "22222222-2222-4222-8222-222222222222",
            },
          ],
        }),
        { mode: 0o600 },
      ),
      writeFile(
        servicePrivateKeyPath,
        privateKey.export({ format: "pem", type: "pkcs8" }),
        { mode: 0o600 },
      ),
      writeFile(executablePath, "#!/bin/sh\nexit 0\n", { mode: 0o700 }),
      copyFile(certificatePath, serviceKeysPath),
    ]);
    environment = {
      SINGULARITY_AUDIT_HMAC_KEY: Buffer.alloc(32, 7).toString("base64url"),
      SINGULARITY_AUDIT_KEY_VERSION: "worker-test-v1",
      SINGULARITY_KERNEL_DEPLOYMENTS_FILE: deploymentPath,
      SINGULARITY_KERNEL_SERVICE_KEY_ID: "worker-test",
      SINGULARITY_KERNEL_SERVICE_PRIVATE_KEY_FILE: servicePrivateKeyPath,
      SINGULARITY_WORKER_ID: "worker-a",
      SINGULARITY_WORKER_OBJECT_STORE_ROOT: join(rootDirectory, "objects"),
      SINGULARITY_WORKER_RESTORE_ARCHIVE_TOOL: executablePath,
      SINGULARITY_WORKER_RESTORE_CLIENT_CA_FILE: certificatePath,
      SINGULARITY_WORKER_RESTORE_CLIENT_CERT_FILE: certificatePath,
      SINGULARITY_WORKER_RESTORE_CLIENT_KEY_FILE: certificateKeyPath,
      SINGULARITY_WORKER_RESTORE_GATEWAY_CLIENT_DNS_NAME: "gateway.test",
      SINGULARITY_WORKER_RESTORE_GATEWAY_HOSTNAME: "127.0.0.1",
      SINGULARITY_WORKER_RESTORE_KERNEL_BINARY: executablePath,
      SINGULARITY_WORKER_RESTORE_KERNEL_LISTEN_ADDRESS: "127.0.0.1",
      SINGULARITY_WORKER_RESTORE_KERNEL_WORKING_DIRECTORY: rootDirectory,
      SINGULARITY_WORKER_RESTORE_PORT_FIRST: "49152",
      SINGULARITY_WORKER_RESTORE_PORT_LAST: "49162",
      SINGULARITY_WORKER_RESTORE_RUNTIME_ROOT: rootDirectory,
      SINGULARITY_WORKER_RESTORE_SERVER_CERT_FILE: certificatePath,
      SINGULARITY_WORKER_RESTORE_SERVER_KEY_FILE: certificateKeyPath,
      SINGULARITY_WORKER_RESTORE_SERVER_NAME: "kernel.test",
      SINGULARITY_WORKER_RESTORE_SERVICE_KEYS_FILE: serviceKeysPath,
      SINGULARITY_WORKER_RESTORE_TLS_PROFILE: "restore-test",
    };
  });

  afterEach(async () => {
    await rm(rootDirectory, { force: true, recursive: true });
  });

  test("separates advertised and listen addresses and derives the runtime owner", () => {
    const configuration = loadWorkerConfiguration(environment);

    expect(configuration.backupRequestTimeoutMilliseconds).toBe(21_600_000);
    expect(configuration.restore).toMatchObject({
      archiveTimeoutMilliseconds: 21_600_000,
      gatewayHostname: "127.0.0.1",
      kernelListenAddress: "127.0.0.1",
      runtimeOwner: "worker-a",
      startupTimeoutMilliseconds: 60_000,
    });
  });

  test.each([
    [
      "Kernel listen DNS name",
      "SINGULARITY_WORKER_RESTORE_KERNEL_LISTEN_ADDRESS",
      "kernel.internal",
    ],
    [
      "advertised hostname",
      "SINGULARITY_WORKER_RESTORE_GATEWAY_HOSTNAME",
      "not a hostname",
    ],
    [
      "Gateway client IP server name",
      "SINGULARITY_WORKER_RESTORE_GATEWAY_CLIENT_DNS_NAME",
      "127.0.0.1",
    ],
    [
      "Kernel IP server name",
      "SINGULARITY_WORKER_RESTORE_SERVER_NAME",
      "127.0.0.1",
    ],
    [
      "backup timeout above 24 hours",
      "SINGULARITY_WORKER_BACKUP_REQUEST_TIMEOUT_MS",
      "86400001",
    ],
    [
      "restore archive timeout above 24 hours",
      "SINGULARITY_WORKER_RESTORE_ARCHIVE_TIMEOUT_MS",
      "86400001",
    ],
    [
      "backup size above 8 GiB",
      "SINGULARITY_WORKER_MAXIMUM_BACKUP_BYTES",
      "8589934593",
    ],
    [
      "restore file count above 100,000",
      "SINGULARITY_WORKER_RESTORE_MAXIMUM_FILES",
      "100001",
    ],
    [
      "restore total above the backup limit",
      "SINGULARITY_WORKER_RESTORE_MAXIMUM_TOTAL_BYTES",
      "8589934593",
    ],
  ] as const)("rejects %s", (_label, name, value) => {
    expect(() =>
      loadWorkerConfiguration({ ...environment, [name]: value }),
    ).toThrow(WorkerConfigurationError);
  });
});
