import { describe, expect, test } from "vitest";

import {
  ApiConfigurationError,
  parseAuditConfiguration,
  parseOidcClientSecretFiles,
  parsePublicOrigin,
  parseTrustedProxyCidrs,
} from "../src/configuration.js";

describe("API deployment configuration", () => {
  test("accepts an explicit audit HMAC key and key version", () => {
    const key = Buffer.alloc(32, 0x41);
    const configuration = parseAuditConfiguration({
      SINGULARITY_AUDIT_HMAC_KEY: key.toString("base64url"),
      SINGULARITY_AUDIT_KEY_VERSION: "audit-2026-07",
    });

    expect(configuration.hmacKey.export()).toEqual(key);
    expect(configuration.keyVersion).toBe("audit-2026-07");
  });

  test.each([
    {},
    { SINGULARITY_AUDIT_HMAC_KEY: Buffer.alloc(31).toString("base64url") },
    {
      SINGULARITY_AUDIT_HMAC_KEY: Buffer.alloc(32).toString("base64url"),
      SINGULARITY_AUDIT_KEY_VERSION: " ",
    },
    {
      SINGULARITY_AUDIT_HMAC_KEY: "not+base64url",
      SINGULARITY_AUDIT_KEY_VERSION: "audit-v1",
    },
  ])("rejects incomplete audit configuration: %o", (environment) => {
    expect(() => parseAuditConfiguration(environment)).toThrow(
      ApiConfigurationError,
    );
  });

  test("parses the OIDC secret mapping at the application boundary", () => {
    expect(parseOidcClientSecretFiles(JSON.stringify({
      "organization-oidc": "/run/secrets/organization-oidc",
    }))).toEqual({
      "organization-oidc": "/run/secrets/organization-oidc",
    });
    expect(parseOidcClientSecretFiles(undefined)).toEqual({});
  });

  test.each([
    "[]",
    JSON.stringify({ "organization-oidc": "relative-secret" }),
    JSON.stringify({ "invalid reference": "/run/secrets/oidc" }),
  ])("rejects an unsafe OIDC secret mapping: %s", (value) => {
    expect(() => parseOidcClientSecretFiles(value)).toThrow(
      ApiConfigurationError,
    );
  });

  test("accepts one explicit HTTPS origin and returns its header value", () => {
    expect(parsePublicOrigin("https://knowledge.example.com:8443/")).toBe(
      "https://knowledge.example.com:8443",
    );
    expect(parsePublicOrigin("https://KNOWLEDGE.example.com")).toBe(
      "https://knowledge.example.com",
    );
  });

  test.each([
    undefined,
    "",
    "http://knowledge.example.com/",
    "https://user@knowledge.example.com/",
    "https://knowledge.example.com/path",
    "https://knowledge.example.com/?source=proxy",
    "https://knowledge.example.com/#fragment",
  ])("rejects an unsafe public origin: %s", (value) => {
    expect(() => parsePublicOrigin(value)).toThrow(ApiConfigurationError);
  });

  test("accepts explicit unique proxy addresses and CIDRs", () => {
    expect(
      parseTrustedProxyCidrs("127.0.0.1, 10.42.0.0/16, 2001:db8::/48"),
    ).toEqual(["127.0.0.1", "10.42.0.0/16", "2001:db8::/48"]);
  });

  test.each([
    "0.0.0.0/0",
    "::/0",
    "10.0.0.0/33",
    "2001:db8::/129",
    "127.0.0.1,127.0.0.1",
    "127.0.0.1,",
    "true",
  ])("rejects an unsafe trusted proxy list: %s", (value) => {
    expect(() => parseTrustedProxyCidrs(value)).toThrow(ApiConfigurationError);
  });
});
