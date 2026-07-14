import { describe, expect, test } from "vitest";

import {
  decodeOpaqueToken,
  isMatchingDigest,
  isValidCsrfToken,
  sessionTokenFromBytes,
  sessionTokenFromValue,
} from "../src/identity/session-crypto.js";

describe("session token byte contract", () => {
  test("matches the fixed token, digest, and CSRF vectors", () => {
    const result = sessionTokenFromBytes(
      Buffer.from(Array.from({ length: 32 }, (_, index) => index)),
    );

    expect(result.tokenValue).toBe(
      "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8",
    );
    expect(result.tokenDigest).toBe(
      "95f5b49bf0b5b93ba0680e050d3370f7e83c88400b15b96c568db8c175ef772c",
    );
    expect(result.csrfToken).toBe(
      "J1m2dlx7QQilSXFU7X1kZQrf26a8y5xRYS8_BRrAH1E",
    );
    expect(result.csrfDigest).toBe(
      "026127a821dba7a1da08358f7f72d0716e4c680e95a4f6335c39d6573289c89c",
    );
    expect(sessionTokenFromValue(result.tokenValue)).toEqual(result);
  });

  test.each([
    "",
    "a".repeat(42),
    "a".repeat(44),
    "a".repeat(42) + "=",
    "a".repeat(42) + "+",
    "汉字",
  ])("rejects malformed opaque input without throwing: %s", (value) => {
    expect(decodeOpaqueToken(value)).toBeUndefined();
    expect(sessionTokenFromValue(value)).toBeUndefined();
    expect(isValidCsrfToken(value)).toBe(false);
  });

  test("compares only canonical fixed-length lowercase digests", () => {
    const digest = "a".repeat(64);
    expect(isMatchingDigest(digest, digest)).toBe(true);
    expect(isMatchingDigest(digest, "b".repeat(64))).toBe(false);
    expect(isMatchingDigest(digest.toUpperCase(), digest)).toBe(false);
    expect(isMatchingDigest("a".repeat(63), digest)).toBe(false);
  });
});
