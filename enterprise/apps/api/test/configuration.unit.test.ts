import { describe, expect, test } from "vitest";

import {
  ApiConfigurationError,
  parsePublicOrigin,
  parseTrustedProxyCidrs,
} from "../src/configuration.js";

describe("API deployment configuration", () => {
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
