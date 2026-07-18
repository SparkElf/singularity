import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";

const SHARE_TOKEN_DOMAIN = Buffer.from("singularity.document-share.v1", "utf8");
const CHALLENGE_TOKEN_DOMAIN = Buffer.from(
  "singularity.share-challenge.v1",
  "utf8",
);
const DIGEST_SEPARATOR = Buffer.from([0]);
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const CHALLENGE_PATTERN =
  /^([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.([A-Za-z0-9_-]{43})$/i;

function credentialDigest(domain: Buffer, token: string): string {
  return createHash("sha256")
    .update(domain)
    .update(DIGEST_SEPARATOR)
    .update(token, "utf8")
    .digest("hex");
}

export function createShareToken(): { digest: string; value: string } {
  const value = randomBytes(32).toString("base64url");
  return { digest: shareTokenDigest(value), value };
}

export function shareTokenDigest(value: string): string {
  if (!TOKEN_PATTERN.test(value)) {
    throw new TypeError("Share credential is unavailable");
  }
  return credentialDigest(SHARE_TOKEN_DOMAIN, value);
}

export function createShareChallenge(): {
  challengeId: string;
  digest: string;
  value: string;
} {
  const challengeId = randomUUID();
  const secret = randomBytes(32).toString("base64url");
  return {
    challengeId,
    digest: credentialDigest(CHALLENGE_TOKEN_DOMAIN, secret),
    value: `${challengeId}.${secret}`,
  };
}

export function parseShareChallenge(
  value: string | undefined,
): { challengeId: string; digest: string } | null {
  const match = value?.match(CHALLENGE_PATTERN);
  const challengeId = match?.[1];
  const secret = match?.[2];
  if (challengeId === undefined || secret === undefined) {
    return null;
  }
  return {
    challengeId,
    digest: credentialDigest(CHALLENGE_TOKEN_DOMAIN, secret),
  };
}

export function challengeDigestMatches(actual: string, expected: string): boolean {
  if (!/^[a-f0-9]{64}$/.test(actual) || !/^[a-f0-9]{64}$/.test(expected)) {
    return false;
  }
  return timingSafeEqual(Buffer.from(actual, "hex"), Buffer.from(expected, "hex"));
}

export function shareChallengeCookieName(shareId: string): string {
  return `__Host-singularity-share-${shareId}`;
}
