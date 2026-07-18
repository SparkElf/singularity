import {
  createKernelDeployment,
  kernelRuntimeEndpointSchema,
  parseKernelDeploymentChangedEvent,
  parseKernelDeploymentsDocument,
  RuntimeKernelDeploymentRegistry,
} from "@singularity/kernel-client";
import { describe, expect, test } from "vitest";

const firstDescriptor = {
  caCertificateFile: "/run/singularity/kernel-ca.pem",
  clientCertificateFile: "/run/singularity/kernel-client.pem",
  clientPrivateKeyFile: "/run/singularity/kernel-client.key",
  handle: "kernel-primary",
  hostname: "127.0.0.1",
  kernelInstanceId: "11111111-1111-4111-8111-111111111111",
  port: 443,
  serverName: "kernel.example.com",
  spaceId: "22222222-2222-4222-8222-222222222222",
};

const tls = {
  caCertificate: Buffer.from("ca"),
  clientCertificate: Buffer.from("certificate"),
  clientPrivateKey: Buffer.from("private-key"),
};

describe("Kernel deployment contract", () => {
  test("parses the canonical document and materializes a resolvable deployment", () => {
    const document = parseKernelDeploymentsDocument({
      deployments: [firstDescriptor],
    });
    const deployment = createKernelDeployment(document.deployments[0]!, tls);
    const registry = new RuntimeKernelDeploymentRegistry([deployment]);

    expect(
      registry.resolve({
        handle: firstDescriptor.handle,
        kernelInstanceId: firstDescriptor.kernelInstanceId,
        spaceId: firstDescriptor.spaceId,
      }),
    ).toBe(deployment);
  });

  test.each([
    { hostname: "not a hostname" },
    { serverName: "127.0.0.1" },
    { port: 65_536 },
  ])("rejects malformed structural fields at the canonical parser: %o", (patch) => {
    expect(() =>
      parseKernelDeploymentsDocument({
        deployments: [{ ...firstDescriptor, ...patch }],
      }),
    ).toThrow("Kernel deployment configuration is unavailable");
  });

  test("keeps duplicate-handle rejection and identity matching in the registry", () => {
    const secondDocument = parseKernelDeploymentsDocument({
      deployments: [
        firstDescriptor,
        {
          ...firstDescriptor,
          kernelInstanceId: "33333333-3333-4333-8333-333333333333",
          spaceId: "44444444-4444-4444-8444-444444444444",
        },
      ],
    });
    const deployments = secondDocument.deployments.map((descriptor) =>
      createKernelDeployment(descriptor, tls),
    );

    expect(() => new RuntimeKernelDeploymentRegistry(deployments)).toThrow(
      "Kernel deployment configuration is unavailable",
    );

    const registry = new RuntimeKernelDeploymentRegistry([deployments[0]!]);
    expect(() =>
      registry.resolve({
        handle: firstDescriptor.handle,
        kernelInstanceId: firstDescriptor.kernelInstanceId,
        spaceId: "44444444-4444-4444-8444-444444444444",
      }),
    ).toThrow("Kernel deployment is unavailable");
  });

  test("registers and unregisters a restored endpoint through the same registry owner", () => {
    const registry = new RuntimeKernelDeploymentRegistry([]);
    const restored = {
      handle: "restore-33333333-3333-4333-8333-333333333333",
      hostname: "127.0.0.1",
      kernelInstanceId: "33333333-3333-4333-8333-333333333333",
      port: 8443,
      serverName: "kernel.example.com",
      spaceId: "44444444-4444-4444-8444-444444444444",
      tls,
    };
    const identity = {
      handle: restored.handle,
      kernelInstanceId: restored.kernelInstanceId,
      spaceId: restored.spaceId,
    };

    registry.register(restored);
    expect(registry.resolve(identity)).toBe(restored);
    expect(
      registry.unregister({ ...identity, spaceId: firstDescriptor.spaceId }),
    ).toBe(false);
    expect(registry.resolve(identity)).toBe(restored);
    expect(registry.unregister(identity)).toBe(true);
    expect(() => registry.resolve(identity)).toThrow(
      "Kernel deployment is unavailable",
    );
  });

  test("accepts only explicit persisted endpoint identity and profile", () => {
    const endpoint = kernelRuntimeEndpointSchema.parse({
      handle: "restore-33333333-3333-4333-8333-333333333333",
      hostname: "worker.internal",
      kernelInstanceId: "33333333-3333-4333-8333-333333333333",
      port: 8443,
      serverName: "kernel.example.com",
      spaceId: "44444444-4444-4444-8444-444444444444",
      tlsProfile: "restore-v1",
    });
    expect(endpoint.tlsProfile).toBe("restore-v1");
    expect(() =>
      kernelRuntimeEndpointSchema.parse({ ...endpoint, tlsProfile: "" }),
    ).toThrow();
  });

  test("parses deployment notifications at their event boundary", () => {
    expect(
      parseKernelDeploymentChangedEvent({
        deploymentHandle: "restore-kernel",
        kernelInstanceId: firstDescriptor.kernelInstanceId,
        kind: "upsert",
        requestId: "33333333-3333-4333-8333-333333333333",
        spaceId: firstDescriptor.spaceId,
      }).kind,
    ).toBe("upsert");
  });
});
