import { createPrivateKey, KeyObject, sign } from "node:crypto";

const SERVICE_TOKEN_ISSUER = "singularity-api";
const MAX_TOKEN_LIFETIME_SECONDS = 30;
const KEY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function encodeBase64Url(value: string | Uint8Array): string {
  return Buffer.from(value).toString("base64url");
}

export interface KernelServiceTokenInput {
  kernelInstanceId: string;
  requestId: string;
  spaceId: string;
}

export interface KernelCredentialServiceOptions {
  keyId: string;
  lifetimeSeconds?: number;
  now?: () => Date;
  privateKey: string | Buffer | KeyObject;
}

export class KernelCredentialService {
  readonly #keyId: string;
  readonly #lifetimeSeconds: number;
  readonly #now: () => Date;
  readonly #privateKey: KeyObject;

  constructor(options: KernelCredentialServiceOptions) {
    const lifetimeSeconds = options.lifetimeSeconds ?? MAX_TOKEN_LIFETIME_SECONDS;
    if (
      !KEY_ID_PATTERN.test(options.keyId) ||
      !Number.isInteger(lifetimeSeconds) ||
      lifetimeSeconds < 1 ||
      lifetimeSeconds > MAX_TOKEN_LIFETIME_SECONDS
    ) {
      throw new Error("Kernel credential configuration is unavailable");
    }

    const privateKey =
      options.privateKey instanceof KeyObject
        ? options.privateKey
        : createPrivateKey(options.privateKey);
    if (privateKey.type !== "private" || privateKey.asymmetricKeyType !== "ed25519") {
      throw new Error("Kernel credential configuration is unavailable");
    }

    this.#keyId = options.keyId;
    this.#lifetimeSeconds = lifetimeSeconds;
    this.#now = options.now ?? (() => new Date());
    this.#privateKey = privateKey;
  }

  sign(input: KernelServiceTokenInput): string {
    if (
      !UUID_PATTERN.test(input.kernelInstanceId) ||
      !UUID_PATTERN.test(input.requestId) ||
      !UUID_PATTERN.test(input.spaceId)
    ) {
      throw new Error("Kernel service identity is unavailable");
    }

    const issuedAt = Math.floor(this.#now().getTime() / 1_000);
    const header = encodeBase64Url(
      JSON.stringify({ alg: "EdDSA", kid: this.#keyId, typ: "JWT" }),
    );
    const payload = encodeBase64Url(
      JSON.stringify({
        aud: input.kernelInstanceId,
        exp: issuedAt + this.#lifetimeSeconds,
        iat: issuedAt,
        iss: SERVICE_TOKEN_ISSUER,
        jti: input.requestId,
        spaceId: input.spaceId,
      }),
    );
    const signingInput = `${header}.${payload}`;
    const signature = sign(null, Buffer.from(signingInput), this.#privateKey);
    return `${signingInput}.${encodeBase64Url(signature)}`;
  }
}
