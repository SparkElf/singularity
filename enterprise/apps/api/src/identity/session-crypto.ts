import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { AUTH_SESSION_COOKIE_NAME } from "@singularity/contracts";

export const SESSION_COOKIE_NAME = AUTH_SESSION_COOKIE_NAME;
export const SESSION_TOKEN_BYTES = 32;
export const SESSION_TOKEN_LENGTH = 43;
export const SESSION_IDLE_MILLISECONDS = 30 * 60 * 1_000;
export const SESSION_ABSOLUTE_MILLISECONDS = 12 * 60 * 60 * 1_000;

export const SESSION_COOKIE_OPTIONS = {
  httpOnly: true,
  path: "/",
  sameSite: "lax",
  secure: true,
} as const;

const SESSION_DIGEST_DOMAIN = Buffer.from("singularity.session.v1", "utf8");
const CSRF_DOMAIN = Buffer.from("singularity.csrf.v1", "utf8");
const CSRF_DIGEST_DOMAIN = Buffer.from(
  "singularity.csrf-digest.v1",
  "utf8",
);
const DIGEST_SEPARATOR = Buffer.from([0]);
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const HEX_DIGEST_PATTERN = /^[0-9a-f]{64}$/;

function domainSeparatedDigest(domain: Buffer, value: Buffer): string {
  return createHash("sha256")
    .update(domain)
    .update(DIGEST_SEPARATOR)
    .update(value)
    .digest("hex");
}

export function decodeOpaqueToken(value: string): Buffer | undefined {
  if (!BASE64URL_PATTERN.test(value)) {
    return undefined;
  }

  const decoded = Buffer.from(value, "base64url");
  if (
    decoded.length !== SESSION_TOKEN_BYTES ||
    decoded.toString("base64url") !== value
  ) {
    return undefined;
  }

  return decoded;
}

export function createSessionToken(): {
  csrfDigest: string;
  csrfToken: string;
  tokenBytes: Buffer;
  tokenDigest: string;
  tokenValue: string;
} {
  const tokenBytes = randomBytes(SESSION_TOKEN_BYTES);
  return sessionTokenFromBytes(tokenBytes);
}

export function sessionTokenFromBytes(tokenBytes: Buffer): {
  csrfDigest: string;
  csrfToken: string;
  tokenBytes: Buffer;
  tokenDigest: string;
  tokenValue: string;
} {
  if (tokenBytes.length !== SESSION_TOKEN_BYTES) {
    throw new TypeError("Session tokens must contain exactly 32 bytes");
  }

  const csrfBytes = createHmac("sha256", tokenBytes)
    .update(CSRF_DOMAIN)
    .digest();
  return {
    csrfDigest: domainSeparatedDigest(CSRF_DIGEST_DOMAIN, csrfBytes),
    csrfToken: csrfBytes.toString("base64url"),
    tokenBytes,
    tokenDigest: domainSeparatedDigest(SESSION_DIGEST_DOMAIN, tokenBytes),
    tokenValue: tokenBytes.toString("base64url"),
  };
}

export function sessionTokenFromValue(value: string):
  | {
      csrfDigest: string;
      csrfToken: string;
      tokenBytes: Buffer;
      tokenDigest: string;
      tokenValue: string;
    }
  | undefined {
  const tokenBytes = decodeOpaqueToken(value);
  return tokenBytes === undefined ? undefined : sessionTokenFromBytes(tokenBytes);
}

export function isMatchingDigest(actual: string, expected: string): boolean {
  if (!HEX_DIGEST_PATTERN.test(actual) || !HEX_DIGEST_PATTERN.test(expected)) {
    return false;
  }

  return timingSafeEqual(Buffer.from(actual, "hex"), Buffer.from(expected, "hex"));
}

export function isValidCsrfToken(value: string | undefined): boolean {
  return value !== undefined && decodeOpaqueToken(value) !== undefined;
}

export function isMatchingOpaqueToken(
  actual: string | undefined,
  expected: string,
): boolean {
  if (actual === undefined) {
    return false;
  }

  const actualBytes = decodeOpaqueToken(actual);
  const expectedBytes = decodeOpaqueToken(expected);
  return (
    actualBytes !== undefined &&
    expectedBytes !== undefined &&
    timingSafeEqual(actualBytes, expectedBytes)
  );
}
