import { describe, expect, test } from "vitest";
import {
  AuditConfigurationError,
  parseAuditConfiguration,
} from "@singularity/database";

import {
  ApiConfigurationError,
  DEFAULT_CONTENT_AUDIT_INDETERMINATE_AFTER_MILLISECONDS,
  parseContentAuditIndeterminateAfterMilliseconds,
  parseOidcClientSecretBindings,
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
      AuditConfigurationError,
    );
  });

  test("owns the content audit indeterminate deadline at the API boundary", () => {
    expect(parseContentAuditIndeterminateAfterMilliseconds(undefined)).toBe(
      DEFAULT_CONTENT_AUDIT_INDETERMINATE_AFTER_MILLISECONDS,
    );
    expect(parseContentAuditIndeterminateAfterMilliseconds("45000")).toBe(
      45_000,
    );
    expect(parseContentAuditIndeterminateAfterMilliseconds("1")).toBe(1);
  });

  test.each(["0", "-1", "9007199254740992", "1.5", "unknown"])(
    "rejects an invalid content audit deadline: %s",
    (value) => {
      expect(() =>
        parseContentAuditIndeterminateAfterMilliseconds(value),
      ).toThrow(ApiConfigurationError);
    },
  );

  test("binds each OIDC secret to one deployment-approved client tuple", () => {
    expect(parseOidcClientSecretBindings(JSON.stringify([
      {
        clientId: "singularity-enterprise",
        issuer: "https://IDENTITY.example.test/tenant",
        organizationId: "11111111-1111-4111-8111-111111111111",
        reference: "organization-oidc",
        secretFile: "/run/secrets/organization-oidc",
      },
    ]))).toEqual([
      {
        clientId: "singularity-enterprise",
        issuer: "https://identity.example.test/tenant",
        organizationId: "11111111-1111-4111-8111-111111111111",
        reference: "organization-oidc",
        secretFile: "/run/secrets/organization-oidc",
      },
    ]);
    expect(parseOidcClientSecretBindings(undefined)).toEqual([]);
  });

  test.each([
    "{}",
    JSON.stringify([{
      clientId: "client",
      issuer: "https://identity.example.test",
      organizationId: "11111111-1111-4111-8111-111111111111",
      reference: "organization-oidc",
      secretFile: "relative-secret",
    }]),
    JSON.stringify([{
      clientId: "client",
      issuer: "http://identity.example.test",
      organizationId: "11111111-1111-4111-8111-111111111111",
      reference: "organization-oidc",
      secretFile: "/run/secrets/oidc",
    }]),
    JSON.stringify([
      {
        clientId: "first",
        issuer: "https://first.example.test",
        organizationId: "11111111-1111-4111-8111-111111111111",
        reference: "duplicate",
        secretFile: "/run/secrets/first",
      },
      {
        clientId: "second",
        issuer: "https://second.example.test",
        organizationId: "22222222-2222-4222-8222-222222222222",
        reference: "duplicate",
        secretFile: "/run/secrets/second",
      },
    ]),
  ])("rejects an unsafe OIDC secret binding: %s", (value) => {
    expect(() => parseOidcClientSecretBindings(value)).toThrow(
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
